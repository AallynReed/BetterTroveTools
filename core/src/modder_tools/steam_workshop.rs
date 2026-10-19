//! backend/modder_tools/steam_workshop.py: publish `.tmod`s to the Trove Steam Workshop
//! without launching the game, through the flat C API of the Steam copy's
//! `steam_api64.dll`.
//!
//! What the code relies on (each cost real time to establish):
//! - The DLL must come from the Steam install of Trove; Steam does not own the Glyph copy.
//! - `SteamAppId` is set in the environment before `SteamAPI_Init`, and
//!   `SteamAPI_RestartAppIfNecessary` is never called (it relaunches through Steam).
//! - A workshop item is a folder: the `.tmod` is staged as `<temp>/<Title>/<Title>.tmod`,
//!   and the folder must outlive the submit (Steam reads it asynchronously).
//! - Calls are polled with `IsAPICallCompleted`; `SteamAPI_RunCallbacks` is never called.
//! - The shipped SDK is ~1.36 (ISteamUGC 005): there is no `DeleteItem`.

use std::ffi::{c_char, c_void, CStr, CString, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use crate::args::Args;
use crate::py::{self, display, file_name, file_suffix, int_lenient, str_of, strip, truthy};
use crate::modfile::TroveMod;

pub const APP_ID: u32 = 304050;
pub const LEGAL_AGREEMENT_URL: &str = "https://steamcommunity.com/sharedfiles/workshoplegalagreement";

const CB_QUERY_COMPLETED: i32 = 3401;
const CB_CREATE_ITEM: i32 = 3403;
const CB_SUBMIT_ITEM_UPDATE: i32 = 3404;
const CB_SUBSCRIBE: i32 = 1313;
const CB_UNSUBSCRIBE: i32 = 1315;

const VIS_PUBLIC: i64 = 0;
const VIS_FRIENDS: i64 = 1;
const VIS_PRIVATE: i64 = 2;

const MAX_TITLE: usize = 128;
const MAX_DESCRIPTION: usize = 8000;
const MAX_PREVIEW_BYTES: u64 = 1024 * 1024;

const INVALID_HANDLE: u64 = u64::MAX;

pub fn item_url(id: impl std::fmt::Display) -> String {
    format!("https://steamcommunity.com/sharedfiles/filedetails/?id={}", id)
}

/// EItemUpdateStatus as the stage keys the page translates.
fn update_status(status: i32) -> &'static str {
    match status {
        1 => "preparing_config",
        2 => "preparing_content",
        3 => "uploading_content",
        4 => "uploading_preview",
        5 => "committing",
        _ => "invalid",
    }
}

fn eresult(code: i32) -> String {
    let known = match code {
        1 => "OK",
        2 => "Generic failure",
        3 => "No connection to Steam",
        8 => "Invalid parameter",
        9 => "File not found",
        15 => "Access denied",
        16 => "Timed out",
        21 => "Not logged on",
        25 => "Limit exceeded",
        26 => "Revoked",
        27 => "Expired",
        66 => "File too large",
        _ => return format!("EResult {}", code),
    };
    known.to_string()
}

/// A failure the user can act on, shown verbatim.
#[derive(Debug)]
pub struct SteamError(pub String);

impl std::fmt::Display for SteamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SteamError {}

fn steam_err<T>(msg: impl Into<String>) -> Result<T> {
    Err(SteamError(msg.into()).into())
}

// --- structs (#pragma pack(8) on the C side, which is natural alignment here) ------------

#[repr(C)]
#[derive(Clone, Copy)]
struct CreateItemResult {
    result: i32,
    published_file_id: u64,
    needs_legal_agreement: u8,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SubmitItemUpdateResult {
    result: i32,
    needs_legal_agreement: u8,
}

/// `RemoteStorageSubscribe/UnsubscribePublishedFileResult_t`.
#[repr(C)]
#[derive(Clone, Copy)]
struct SubscribeResult {
    result: i32,
    published_file_id: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SteamUGCQueryCompleted {
    handle: u64,
    result: i32,
    num_results_returned: u32,
    total_matching_results: u32,
    cached_data: u8,
}

/// Version 005 of `SteamUGCDetails_t`; the fixed char arrays make the layout.
#[repr(C)]
#[derive(Clone, Copy)]
struct SteamUGCDetails {
    published_file_id: u64,
    result: i32,
    file_type: i32,
    creator_app_id: u32,
    consumer_app_id: u32,
    title: [u8; 129],
    description: [u8; 8000],
    steam_id_owner: u64,
    time_created: u32,
    time_updated: u32,
    time_added_to_user_list: u32,
    visibility: i32,
    banned: u8,
    accepted_for_use: u8,
    tags_truncated: u8,
    tags: [u8; 1025],
    file_handle: u64,
    preview_file_handle: u64,
    file_name: [u8; 260],
    file_size: i32,
    preview_file_size: i32,
    url: [u8; 256],
    votes_up: u32,
    votes_down: u32,
    score: f32,
    num_children: u32,
}

#[repr(C)]
struct SteamParamStringArray {
    strings: *const *const c_char,
    count: i32,
}

// The layouts every read depends on, as steam_workshop.py's `_check_layout` asserted.
const _: () = {
    assert!(std::mem::size_of::<CreateItemResult>() == 24);
    assert!(std::mem::size_of::<SubmitItemUpdateResult>() == 8);
    assert!(std::mem::size_of::<SubscribeResult>() == 16);
    assert!(std::mem::size_of::<SteamUGCQueryCompleted>() == 24);
    assert!(std::mem::size_of::<SteamUGCDetails>() == 9776);
    assert!(std::mem::offset_of!(SteamUGCDetails, steam_id_owner) == 8160);
    assert!(std::mem::offset_of!(SteamUGCDetails, file_handle) == 9216);
};

// --- the DLL ----------------------------------------------------------------------------

type Iface = *mut c_void;

/// The flat API functions, resolved once per load. The pointers stay valid while `_lib`
/// is loaded.
struct Api {
    _lib: libloading::Library,
    init: unsafe extern "C" fn() -> bool,
    shutdown: unsafe extern "C" fn(),
    is_steam_running: unsafe extern "C" fn() -> bool,
    steam_ugc: unsafe extern "C" fn() -> Iface,
    steam_utils: unsafe extern "C" fn() -> Iface,
    steam_user: unsafe extern "C" fn() -> Iface,
    steam_friends: unsafe extern "C" fn() -> Iface,
    get_steam_id: unsafe extern "C" fn(Iface) -> u64,
    logged_on: unsafe extern "C" fn(Iface) -> bool,
    persona_name: unsafe extern "C" fn(Iface) -> *const c_char,
    #[allow(dead_code)]
    app_id: unsafe extern "C" fn(Iface) -> u32,
    call_completed: unsafe extern "C" fn(Iface, u64, *mut u8) -> bool,
    call_result: unsafe extern "C" fn(Iface, u64, *mut c_void, i32, i32, *mut u8) -> bool,
    create_item: unsafe extern "C" fn(Iface, u32, i32) -> u64,
    start_item_update: unsafe extern "C" fn(Iface, u32, u64) -> u64,
    set_title: unsafe extern "C" fn(Iface, u64, *const c_char) -> bool,
    set_description: unsafe extern "C" fn(Iface, u64, *const c_char) -> bool,
    set_tags: unsafe extern "C" fn(Iface, u64, *const SteamParamStringArray) -> bool,
    set_content: unsafe extern "C" fn(Iface, u64, *const c_char) -> bool,
    set_preview: unsafe extern "C" fn(Iface, u64, *const c_char) -> bool,
    set_visibility: unsafe extern "C" fn(Iface, u64, i32) -> bool,
    submit_item_update: unsafe extern "C" fn(Iface, u64, *const c_char) -> u64,
    update_progress: unsafe extern "C" fn(Iface, u64, *mut u64, *mut u64) -> i32,
    create_user_query: unsafe extern "C" fn(Iface, u32, i32, i32, i32, u32, u32, u32) -> u64,
    send_query: unsafe extern "C" fn(Iface, u64) -> u64,
    query_result: unsafe extern "C" fn(Iface, u64, u32, *mut SteamUGCDetails) -> bool,
    release_query: unsafe extern "C" fn(Iface, u64) -> bool,
    unsubscribe_item: unsafe extern "C" fn(Iface, u64) -> u64,
    subscribe_item: unsafe extern "C" fn(Iface, u64) -> u64,
}

/// `ctypes.CDLL(path)`: on Windows with the same search flags ctypes uses.
fn load_library(path: &Path) -> Result<libloading::Library> {
    #[cfg(windows)]
    {
        use libloading::os::windows::{Library, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR};
        // SAFETY: steam_api64.dll's initializers only set up its own state.
        let lib = unsafe { Library::load_with_flags(path, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR) }.map_err(|e| anyhow!("{}", e))?;
        Ok(lib.into())
    }
    #[cfg(not(windows))]
    {
        // SAFETY: as above.
        unsafe { libloading::Library::new(path) }.map_err(|e| anyhow!("{}", e))
    }
}

macro_rules! sym {
    ($lib:expr, $name:literal) => {
        // SAFETY: the type matches the flat API's C signature for this export.
        *unsafe { $lib.get(concat!($name, "\0").as_bytes()) }.map_err(|_| anyhow!("function '{}' not found", $name))?
    };
}

impl Api {
    fn load(path: &Path) -> Result<Api> {
        let lib = load_library(path)?;
        Ok(Api {
            init: sym!(lib, "SteamAPI_Init"),
            shutdown: sym!(lib, "SteamAPI_Shutdown"),
            is_steam_running: sym!(lib, "SteamAPI_IsSteamRunning"),
            steam_ugc: sym!(lib, "SteamUGC"),
            steam_utils: sym!(lib, "SteamUtils"),
            steam_user: sym!(lib, "SteamUser"),
            steam_friends: sym!(lib, "SteamFriends"),
            get_steam_id: sym!(lib, "SteamAPI_ISteamUser_GetSteamID"),
            logged_on: sym!(lib, "SteamAPI_ISteamUser_BLoggedOn"),
            persona_name: sym!(lib, "SteamAPI_ISteamFriends_GetPersonaName"),
            app_id: sym!(lib, "SteamAPI_ISteamUtils_GetAppID"),
            call_completed: sym!(lib, "SteamAPI_ISteamUtils_IsAPICallCompleted"),
            call_result: sym!(lib, "SteamAPI_ISteamUtils_GetAPICallResult"),
            create_item: sym!(lib, "SteamAPI_ISteamUGC_CreateItem"),
            start_item_update: sym!(lib, "SteamAPI_ISteamUGC_StartItemUpdate"),
            set_title: sym!(lib, "SteamAPI_ISteamUGC_SetItemTitle"),
            set_description: sym!(lib, "SteamAPI_ISteamUGC_SetItemDescription"),
            set_tags: sym!(lib, "SteamAPI_ISteamUGC_SetItemTags"),
            set_content: sym!(lib, "SteamAPI_ISteamUGC_SetItemContent"),
            set_preview: sym!(lib, "SteamAPI_ISteamUGC_SetItemPreview"),
            set_visibility: sym!(lib, "SteamAPI_ISteamUGC_SetItemVisibility"),
            submit_item_update: sym!(lib, "SteamAPI_ISteamUGC_SubmitItemUpdate"),
            update_progress: sym!(lib, "SteamAPI_ISteamUGC_GetItemUpdateProgress"),
            create_user_query: sym!(lib, "SteamAPI_ISteamUGC_CreateQueryUserUGCRequest"),
            send_query: sym!(lib, "SteamAPI_ISteamUGC_SendQueryUGCRequest"),
            query_result: sym!(lib, "SteamAPI_ISteamUGC_GetQueryUGCResult"),
            release_query: sym!(lib, "SteamAPI_ISteamUGC_ReleaseQueryUGCRequest"),
            unsubscribe_item: sym!(lib, "SteamAPI_ISteamUGC_UnsubscribeItem"),
            subscribe_item: sym!(lib, "SteamAPI_ISteamUGC_SubscribeItem"),
            _lib: lib,
        })
    }
}

/// `(dll, install)` for the first Steam copy of Trove that ships `steam_api64.dll`.
pub fn find_steam_api_dll() -> Option<(PathBuf, PathBuf)> {
    if !cfg!(windows) {
        return None;
    }
    crate::game::registry::get_trove_locations().into_iter().filter(|g| g.is_steam()).find_map(|g| {
        let dll = g.path.join("steam_api64.dll");
        dll.exists().then(|| (dll, g.path.clone()))
    })
}

/// `str(value or "").encode()`, cut at a NUL like the C side would read it.
fn cstr(value: &str) -> CString {
    let bytes = value.as_bytes();
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    CString::new(&bytes[..end]).unwrap_or_default()
}

fn c_field(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// Upload progress: (stage key, bytes done, bytes total).
type OnProgress<'a> = &'a mut dyn FnMut(&str, u64, u64);

/// Fields of one `SubmitItemUpdate`; `None` leaves that part of the item alone.
#[derive(Default)]
pub struct ItemUpdate<'a> {
    pub title: Option<&'a str>,
    pub description: Option<&'a str>,
    pub tags: Option<&'a [String]>,
    pub content_dir: Option<&'a Path>,
    pub preview: Option<&'a Path>,
    pub visibility: Option<i32>,
    pub change_note: &'a str,
}

struct Session {
    api: Option<Api>,
    dll_path: Option<PathBuf>,
    game_path: Option<PathBuf>,
    ugc: usize,
    utils: usize,
    user: usize,
    friends: usize,
    saved_env: Vec<(&'static str, Option<OsString>)>,
}

/// Set while a session is up. Status polls read it (and [`ACCOUNT`]) without the
/// session lock, so they never wait on an upload.
static CONNECTED: AtomicBool = AtomicBool::new(false);
static ACCOUNT: Mutex<Option<Value>> = Mutex::new(None);
static SESSION: Mutex<Session> = Mutex::new(Session { api: None, dll_path: None, game_path: None, ugc: 0, utils: 0, user: 0, friends: 0, saved_env: Vec::new() });
static BUSY: AtomicBool = AtomicBool::new(false);

impl Session {
    fn connected(&self) -> bool {
        self.api.is_some() && self.ugc != 0
    }

    fn api(&self) -> &Api {
        self.api.as_ref().expect("connected")
    }

    fn connect(&mut self) -> Result<()> {
        if self.connected() {
            return Ok(());
        }
        if !cfg!(windows) {
            return steam_err("Steam Workshop uploads are Windows-only.");
        }
        let Some((dll_path, game_path)) = find_steam_api_dll() else {
            return steam_err(
                "No Steam copy of Trove was found. Publishing needs steam_api64.dll from the Steam install -- Glyph installs ship the same file, but Steam does not own them.",
            );
        };
        let api = Api::load(&dll_path)?;
        // SAFETY: plain flat-API calls with no arguments.
        if !unsafe { (api.is_steam_running)() } {
            return steam_err("Steam is not running. Start Steam, sign in, and try again.");
        }
        for key in ["SteamAppId", "SteamGameId"] {
            self.saved_env.push((key, std::env::var_os(key)));
            std::env::set_var(key, APP_ID.to_string());
        }
        // Deliberately not SteamAPI_RestartAppIfNecessary (see the module docs).
        if !unsafe { (api.init)() } {
            self.restore_env();
            return steam_err("Steam refused the connection. Make sure Steam is running and signed in to an account that owns Trove.");
        }
        // SAFETY: SteamAPI_Init succeeded, so the accessors may be called.
        let (ugc, utils, user, friends) = unsafe { ((api.steam_ugc)(), (api.steam_utils)(), (api.steam_user)(), (api.steam_friends)()) };
        self.api = Some(api);
        self.dll_path = Some(dll_path);
        self.game_path = Some(game_path);
        (self.ugc, self.utils, self.user, self.friends) = (ugc as usize, utils as usize, user as usize, friends as usize);
        if ugc.is_null() || utils.is_null() {
            self.disconnect();
            return steam_err("Steam returned no UGC interface (unexpected SDK version).");
        }
        CONNECTED.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn disconnect(&mut self) {
        let api = self.api.take();
        (self.ugc, self.utils, self.user, self.friends) = (0, 0, 0, 0);
        self.dll_path = None;
        self.game_path = None;
        *ACCOUNT.lock() = None;
        CONNECTED.store(false, Ordering::SeqCst);
        let Some(api) = api else { return };
        // SAFETY: the session was initialised by this load of the DLL.
        unsafe { (api.shutdown)() };
        self.restore_env();
        drop(api);
    }

    fn restore_env(&mut self) {
        for (key, value) in self.saved_env.drain(..) {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }

    fn iface(p: usize) -> Iface {
        p as Iface
    }

    fn steam_id(&self) -> u64 {
        if self.user == 0 {
            return 0;
        }
        // SAFETY: a live ISteamUser from this session.
        unsafe { (self.api().get_steam_id)(Self::iface(self.user)) }
    }

    fn account(&self) -> Value {
        let steam_id = self.steam_id();
        let persona = if self.friends != 0 {
            // SAFETY: a live ISteamFriends; Steam owns the returned string.
            let raw = unsafe { (self.api().persona_name)(Self::iface(self.friends)) };
            if raw.is_null() {
                String::new()
            } else {
                unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned()
            }
        } else {
            String::new()
        };
        let logged_on = self.user != 0 && unsafe { (self.api().logged_on)(Self::iface(self.user)) };
        let account = json!({
            "persona": persona,
            "steam_id": steam_id.to_string(),
            "account_id": steam_id & 0xffff_ffff,
            "logged_on": logged_on,
            "profile_url": if steam_id != 0 { format!("https://steamcommunity.com/profiles/{}", steam_id) } else { String::new() },
        });
        *ACCOUNT.lock() = Some(account.clone());
        account
    }

    /// Polls a `SteamAPICall_t` to completion and reads its result struct.
    fn wait<T: Copy>(&self, call: u64, callback_id: i32, timeout: f64, mut on_tick: Option<&mut dyn FnMut(&Session)>) -> Result<T> {
        if call == 0 {
            return steam_err("Steam did not return a call handle.");
        }
        let api = self.api();
        let utils = Self::iface(self.utils);
        let mut failed = 0u8;
        let deadline = Instant::now() + Duration::from_secs_f64(timeout);
        // SAFETY: a live ISteamUtils; `failed` outlives each call.
        while !unsafe { (api.call_completed)(utils, call, &mut failed) } {
            if Instant::now() > deadline {
                return steam_err("Timed out waiting on Steam.");
            }
            if let Some(tick) = on_tick.as_mut() {
                tick(self);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if failed != 0 {
            return steam_err("Steam reported the call as failed.");
        }
        // SAFETY: every T here is a plain C struct for which all-zero bytes are valid.
        let mut result: T = unsafe { std::mem::zeroed() };
        let ok = unsafe { (api.call_result)(utils, call, &mut result as *mut T as *mut c_void, std::mem::size_of::<T>() as i32, callback_id, &mut failed) };
        if !ok || failed != 0 {
            return steam_err("Could not read the result of the Steam call.");
        }
        Ok(result)
    }

    /// Every item this account published for Trove (also the duplicate guard: Steam has
    /// no lookup by title).
    fn published_items(&self, max_pages: u32) -> Result<Vec<Value>> {
        let api = self.api();
        let ugc = Self::iface(self.ugc);
        let account_id = (self.steam_id() & 0xffff_ffff) as u32;
        let mut items = Vec::new();
        for page in 1..=max_pages {
            // 0, 0, 0: Published, Items, CreationOrderDesc.
            let handle = unsafe { (api.create_user_query)(ugc, account_id, 0, 0, 0, APP_ID, APP_ID, page) };
            if handle == 0 || handle == INVALID_HANDLE {
                return steam_err("Steam refused the workshop query.");
            }
            let outcome = (|| -> Result<(u32, u32)> {
                let call = unsafe { (api.send_query)(ugc, handle) };
                let completed: SteamUGCQueryCompleted = self.wait(call, CB_QUERY_COMPLETED, 60.0, None)?;
                if completed.result != 1 {
                    return steam_err(format!("Workshop query failed: {}", eresult(completed.result)));
                }
                // SAFETY: all-zero is a valid SteamUGCDetails; one buffer is reused like Python's.
                let mut details: Box<SteamUGCDetails> = Box::new(unsafe { std::mem::zeroed() });
                for index in 0..completed.num_results_returned {
                    if unsafe { (api.query_result)(ugc, handle, index, &mut *details) } {
                        items.push(details_to_value(&details));
                    }
                }
                Ok((completed.total_matching_results, completed.num_results_returned))
            })();
            unsafe { (api.release_query)(ugc, handle) };
            let (total, returned) = outcome?;
            if returned == 0 || items.len() >= total as usize {
                break;
            }
        }
        Ok(items)
    }

    fn subscription_call(&self, item_id: u64, subscribe: bool) -> Result<bool> {
        let api = self.api();
        let ugc = Self::iface(self.ugc);
        let (call, cb) = if subscribe {
            (unsafe { (api.subscribe_item)(ugc, item_id) }, CB_SUBSCRIBE)
        } else {
            (unsafe { (api.unsubscribe_item)(ugc, item_id) }, CB_UNSUBSCRIBE)
        };
        let result: SubscribeResult = self.wait(call, cb, 30.0, None)?;
        Ok(result.result == 1)
    }

    fn create_item(&self) -> Result<CreateItemResult> {
        // 0: k_EWorkshopFileTypeCommunity.
        let call = unsafe { (self.api().create_item)(Self::iface(self.ugc), APP_ID, 0) };
        let result: CreateItemResult = self.wait(call, CB_CREATE_ITEM, 120.0, None)?;
        if result.result != 1 {
            return steam_err(format!("Steam would not create the item: {}", eresult(result.result)));
        }
        Ok(result)
    }

    fn submit_update(&self, item_id: u64, update: &ItemUpdate, mut on_progress: Option<OnProgress>) -> Result<SubmitItemUpdateResult> {
        let api = self.api();
        let ugc = Self::iface(self.ugc);
        let handle = unsafe { (api.start_item_update)(ugc, APP_ID, item_id) };
        if handle == 0 || handle == INVALID_HANDLE {
            return steam_err("Steam would not start an item update.");
        }
        // SAFETY: every pointer passed below outlives its call.
        unsafe {
            if let Some(title) = update.title {
                (api.set_title)(ugc, handle, cstr(title).as_ptr());
            }
            if let Some(description) = update.description {
                (api.set_description)(ugc, handle, cstr(description).as_ptr());
            }
            if let Some(tags) = update.tags {
                let owned: Vec<CString> = tags.iter().map(|t| cstr(t)).collect();
                let mut ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
                // ctypes allocated at least one (null) slot for an empty list.
                ptrs.push(std::ptr::null());
                let param = SteamParamStringArray { strings: ptrs.as_ptr(), count: owned.len() as i32 };
                (api.set_tags)(ugc, handle, &param);
            }
            if let Some(dir) = update.content_dir {
                (api.set_content)(ugc, handle, cstr(&display(dir)).as_ptr());
            }
            if let Some(preview) = update.preview {
                (api.set_preview)(ugc, handle, cstr(&display(preview)).as_ptr());
            }
            if let Some(vis) = update.visibility {
                (api.set_visibility)(ugc, handle, vis);
            }
        }
        let call = unsafe { (api.submit_item_update)(ugc, handle, cstr(update.change_note).as_ptr()) };
        let mut tick = |s: &Session| {
            if let Some(report) = on_progress.as_mut() {
                let (mut done, mut total) = (0u64, 0u64);
                let status = unsafe { (s.api().update_progress)(Self::iface(s.ugc), handle, &mut done, &mut total) };
                report(update_status(status), done, total);
            }
        };
        let result: SubmitItemUpdateResult = self.wait(call, CB_SUBMIT_ITEM_UPDATE, 300.0, Some(&mut tick))?;
        if result.result != 1 {
            return steam_err(format!("Steam rejected the upload: {}", eresult(result.result)));
        }
        Ok(result)
    }
}

fn details_to_value(d: &SteamUGCDetails) -> Value {
    let tags: Vec<String> = c_field(&d.tags).split(',').map(strip).filter(|t| !t.is_empty()).map(String::from).collect();
    json!({
        "id": d.published_file_id.to_string(),
        "title": c_field(&d.title),
        "description": c_field(&d.description),
        "tags": tags,
        "visibility": d.visibility,
        "banned": d.banned != 0,
        "file_size": d.file_size,
        "preview_file_size": d.preview_file_size,
        "time_created": d.time_created,
        "time_updated": d.time_updated,
        "url": item_url(d.published_file_id),
    })
}

fn parse_item_id(item_id: &str) -> Result<u64> {
    let id = int_lenient(&Value::String(item_id.to_string()))?;
    Ok(id as u64)
}

/// Runs `body` on a session, opening one for the call if none is up.
fn with_session<T>(body: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
    let mut session = SESSION.lock();
    let opened = !session.connected();
    let result = session.connect().and_then(|_| body(&mut session));
    if opened {
        session.disconnect();
    }
    result
}

/// Subscribes the signed-in account to one Trove workshop item (Steam then downloads
/// it). A [`SteamError`] when Steam can't be reached.
pub fn subscribe_item(item_id: &str) -> Result<bool> {
    with_session(|s| s.subscription_call(parse_item_id(item_id)?, true))
}

/// Unsubscribes from one item. A [`SteamError`] when Steam can't be reached, so callers
/// can tell "Steam is closed" from "Steam said no".
pub fn unsubscribe_item(item_id: &str) -> Result<bool> {
    with_session(|s| s.subscription_call(parse_item_id(item_id)?, false))
}

/// Unsubscribes from each item, silently and best effort. The ids that went.
pub fn unsubscribe_items(item_ids: &[String]) -> Vec<String> {
    let mut done = Vec::new();
    let _ = with_session(|s| {
        for id in item_ids {
            if let Ok(true) = parse_item_id(id).and_then(|id| s.subscription_call(id, false)) {
                done.push(id.clone());
            }
        }
        Ok(())
    });
    done
}

// --- .tmod metadata ---------------------------------------------------------------------

/// A title safe as a Windows folder/file name.
fn safe_name(value: &str) -> String {
    let cleaned: String = value.chars().filter(|&c| !"<>:\"/\\|?*".contains(c) && (c as u32) >= 0x20).collect();
    let cleaned = strip(&cleaned).trim_end_matches('.').to_string();
    if cleaned.is_empty() {
        "Trove Mod".into()
    } else {
        cleaned
    }
}

/// Everything the publish form needs, out of the archive.
pub fn read_tmod_metadata(tmod_path: &Path) -> Result<Value> {
    let m = TroveMod::read_tmod(tmod_path, py::read_bytes(tmod_path)?, false)?;
    let preview_path = m.preview_path();
    let (mut preview, mut preview_name): (Option<&[u8]>, String) = (None, String::new());
    if let Some(pp) = &preview_path {
        if let Some(f) = m.files.iter().find(|f| &f.trove_path == pp) {
            preview = Some(f.data()?);
            preview_name = py::name_of(&f.trove_path);
        }
    }
    let title = m.name().filter(|n| !n.is_empty()).map(String::from).unwrap_or_else(|| py::file_stem(tmod_path));
    let mut tags = m.tags();
    let subtype = m.subtype();
    if !subtype.is_empty() && !tags.contains(&subtype) {
        tags.push(subtype.clone());
    }
    let size = std::fs::metadata(tmod_path).map_err(|e| py::os_error(e, tmod_path, None))?.len();
    let preview = preview.filter(|p| !p.is_empty());
    Ok(json!({
        "path": display(tmod_path),
        "fileName": file_name(tmod_path),
        "fileSize": size,
        "fileCount": m.files.len(),
        "title": title,
        "author": m.author().unwrap_or(""),
        "description": m.notes().unwrap_or(""),
        "tags": tags,
        "subtype": subtype,
        "modVersion": m.get_property_value("modVersion").unwrap_or(""),
        "gameVersion": m.game_version().unwrap_or(""),
        "steamId": strip(m.steam_id().unwrap_or("")),
        "previewBase64": preview.map(|p| format!("data:image/png;base64,{}", py::b64encode(p))),
        "previewName": preview_name,
        "previewSize": preview.map(|p| p.len()).unwrap_or(0),
        "previewTooLarge": preview.map(|p| p.len() as u64 > MAX_PREVIEW_BYTES).unwrap_or(false),
    }))
}

// --- publishing ---------------------------------------------------------------------------

/// One progress frame for the Steam tab.
fn emit(stage: &str, fields: Value) {
    let mut payload = Map::new();
    payload.insert("stage".into(), json!(stage));
    if let Value::Object(f) = fields {
        payload.extend(f);
    }
    if let Some(c) = crate::ctx::try_ctx() {
        c.js("receive_steam_workshop_progress", vec![Value::Object(payload)]);
    }
}

/// `tempfile.mkdtemp(prefix=...)`.
fn mkdtemp(prefix: &str) -> Result<PathBuf> {
    use rand::Rng;
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789_";
    let base = std::env::temp_dir();
    let mut rng = rand::thread_rng();
    for _ in 0..100 {
        let name: String = (0..8).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect();
        let dir = base.join(format!("{}{}", prefix, name));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(py::os_error(e, &dir, None)),
        }
    }
    Err(anyhow!("No usable temporary directory name found"))
}

/// `<temp>/<Title>/<Title>.tmod`, plus the preview beside (not inside) the content folder.
fn stage_upload(tmod_path: &Path, title: &str, preview_source: Option<&Path>) -> Result<(PathBuf, PathBuf, Option<PathBuf>)> {
    let root = mkdtemp("troveworkshop-upload-")?;
    let safe = safe_name(title);
    let content_dir = root.join(&safe);
    std::fs::create_dir(&content_dir).map_err(|e| py::os_error(e, &content_dir, None))?;
    py::copy2(tmod_path, &content_dir.join(format!("{}.tmod", safe)))?;
    let preview = match preview_source {
        Some(src) => {
            let suffix = file_suffix(src).to_lowercase();
            let suffix = if suffix.is_empty() { ".png".to_string() } else { suffix };
            let dest = root.join(format!("{}-Preview{}", safe, suffix));
            py::copy2(src, &dest)?;
            Some(dest)
        }
        None => None,
    };
    Ok((root, content_dir, preview))
}

fn extract_preview(tmod_path: &Path, root: &Path) -> Result<Option<PathBuf>> {
    let m = TroveMod::read_tmod(tmod_path, py::read_bytes(tmod_path)?, false)?;
    let Some(pp) = m.preview_path() else { return Ok(None) };
    let Some(f) = m.files.iter().find(|f| f.trove_path == pp) else { return Ok(None) };
    let suffix = py::suffix_of(&f.trove_path).to_lowercase();
    let out = root.join(format!("embedded-preview{}", if suffix.is_empty() { ".png" } else { &suffix }));
    py::write_bytes(&out, f.data()?)?;
    Ok(Some(out))
}

fn payload_str(payload: &Map<String, Value>, key: &str) -> String {
    payload.get(key).filter(|v| truthy(v)).map(str_of).unwrap_or_default()
}

fn publish(payload: &Map<String, Value>, scratch: &mut Option<PathBuf>, staging: &mut Option<PathBuf>) -> Result<()> {
    let tmod_path = py::py_path(strip(&payload_str(payload, "tmodPath")));
    if !tmod_path.is_file() {
        return steam_err("That .tmod file no longer exists.");
    }
    let title = py::char_prefix(strip(&payload_str(payload, "title")), MAX_TITLE);
    if title.is_empty() {
        return steam_err("A title is required.");
    }
    let description = py::char_prefix(&payload_str(payload, "description"), MAX_DESCRIPTION);
    let tags: Vec<String> = match payload.get("tags").filter(|v| truthy(v)) {
        Some(v) => py::iterate(v)?.iter().map(|t| strip(&str_of(t)).to_string()).filter(|t| !t.is_empty()).collect(),
        None => Vec::new(),
    };
    let mut visibility = match payload.get("visibility") {
        Some(v) => int_lenient(v)?,
        None => VIS_PRIVATE,
    };
    if ![VIS_PUBLIC, VIS_FRIENDS, VIS_PRIVATE].contains(&visibility) {
        visibility = VIS_PRIVATE;
    }
    let change_note = payload_str(payload, "changeNote");
    let existing_id = strip(&payload_str(payload, "itemId")).to_string();

    emit("staging", json!({}));
    *scratch = Some(mkdtemp("troveworkshop-preview-")?);
    let preview_override = strip(&payload_str(payload, "previewPath")).to_string();
    let preview_source = if !preview_override.is_empty() {
        let src = py::py_path(&preview_override);
        if !src.is_file() {
            return steam_err("The chosen preview image no longer exists.");
        }
        Some(src)
    } else {
        extract_preview(&tmod_path, scratch.as_ref().unwrap())?
    };
    if let Some(src) = &preview_source {
        let size = std::fs::metadata(src).map_err(|e| py::os_error(e, src, None))?.len();
        if size > MAX_PREVIEW_BYTES {
            return steam_err(format!("Steam caps workshop preview images at 1 MB; this one is {:.0} KB. Pick a smaller image.", size as f64 / 1024.0));
        }
    }
    let (root, content_dir, preview_path) = stage_upload(&tmod_path, &title, preview_source.as_deref())?;
    *staging = Some(root);

    let (item_id, created, needs_legal, published) = {
        let mut session = SESSION.lock();
        session.connect()?;
        emit("connected", json!({"account": session.account()}));
        let (item_id, created, mut needs_legal) = if !existing_id.is_empty() {
            (parse_item_id(&existing_id)?, false, false)
        } else {
            emit("creating", json!({}));
            let result = session.create_item()?;
            let id = result.published_file_id;
            emit("created", json!({"itemId": id.to_string(), "url": item_url(id)}));
            (id, true, result.needs_legal_agreement != 0)
        };
        let mut on_progress = |status: &str, done: u64, total: u64| {
            emit("uploading", json!({"itemId": item_id.to_string(), "status": status, "done": done, "total": total}));
        };
        // A new item goes up private first: committing it public in the same submit
        // would publish it before anyone has seen the page.
        let first_visibility = if created { VIS_PRIVATE } else { visibility };
        let update = ItemUpdate {
            title: Some(&title),
            description: Some(&description),
            tags: Some(&tags),
            content_dir: Some(&content_dir),
            preview: preview_path.as_deref(),
            visibility: Some(first_visibility as i32),
            change_note: &change_note,
        };
        let submitted = session.submit_update(item_id, &update, Some(&mut on_progress))?;
        needs_legal = needs_legal || submitted.needs_legal_agreement != 0;
        if created && visibility != VIS_PRIVATE {
            emit("visibility", json!({}));
            session.submit_update(item_id, &ItemUpdate { visibility: Some(visibility as i32), change_note: &change_note, ..Default::default() }, None)?;
        }
        emit("verifying", json!({"itemId": item_id.to_string()}));
        let published = session.published_items(10)?.into_iter().find(|i| i["id"] == json!(item_id.to_string()));
        (item_id, created, needs_legal, published)
    };

    // Steam's "success" is not proof the bytes landed: compare with what it was given.
    let size_of = |p: &Path| std::fs::metadata(p).map(|m| m.len()).map_err(|e| py::os_error(e, p, None));
    let expected_content = size_of(&tmod_path)?;
    let expected_preview = match &preview_path {
        Some(p) => size_of(p)?,
        None => 0,
    };
    let verified = published.as_ref().map(|p| p["file_size"] == json!(expected_content) && p["preview_file_size"] == json!(expected_preview)).unwrap_or(false);
    emit(
        "done",
        json!({
            "ok": true, "finished": true, "created": created, "itemId": item_id.to_string(), "url": item_url(item_id),
            "item": published, "verified": verified, "expectedFileSize": expected_content,
            "expectedPreviewSize": expected_preview, "needsLegalAgreement": needs_legal,
            "legalAgreementUrl": LEGAL_AGREEMENT_URL, "visibility": visibility,
        }),
    );
    Ok(())
}

fn run_publish(payload: Map<String, Value>) {
    let (mut scratch, mut staging) = (None, None);
    if let Err(e) = publish(&payload, &mut scratch, &mut staging) {
        emit("error", json!({"ok": false, "finished": true, "error": e.to_string()}));
    }
    // Only now: the content is read asynchronously.
    for dir in [staging, scratch].into_iter().flatten() {
        let _ = std::fs::remove_dir_all(dir);
    }
    BUSY.store(false, Ordering::SeqCst);
}

// --- endpoints ----------------------------------------------------------------------------

pub fn steam_workshop_status(_: &Args) -> Result<Value> {
    let found = find_steam_api_dll();
    let connected = CONNECTED.load(Ordering::SeqCst);
    let steam_running = connected
        || found.as_ref().is_some_and(|(dll, _)| {
            // A cheap probe that doesn't initialise a session.
            load_library(dll)
                .ok()
                .and_then(|lib| unsafe { lib.get::<unsafe extern "C" fn() -> bool>(b"SteamAPI_IsSteamRunning\0") }.ok().map(|f| unsafe { f() }))
                .unwrap_or(false)
        });
    Ok(json!({
        "supported": cfg!(windows),
        "dllPath": found.as_ref().map(|(d, _)| display(d)).unwrap_or_default(),
        "gamePath": found.as_ref().map(|(_, g)| display(g)).unwrap_or_default(),
        "steamRunning": steam_running,
        "connected": connected,
        "busy": BUSY.load(Ordering::SeqCst),
        "account": ACCOUNT.lock().clone(),
    }))
}

pub fn steam_workshop_connect(_: &Args) -> Result<Value> {
    let mut s = SESSION.lock();
    s.connect()?;
    Ok(json!({
        "connected": true,
        "account": s.account(),
        "dllPath": s.dll_path.as_deref().map(display).unwrap_or_default(),
        "gamePath": s.game_path.as_deref().map(display).unwrap_or_default(),
    }))
}

pub fn steam_workshop_disconnect(_: &Args) -> Result<Value> {
    SESSION.lock().disconnect();
    Ok(json!({"connected": false}))
}

pub fn steam_workshop_read_tmod(a: &Args) -> Result<Value> {
    let raw = if truthy(a.get(0)) { str_of(a.get(0)) } else { String::new() };
    let path = py::py_path(strip(&raw));
    if !path.is_file() {
        return Ok(json!({"success": false, "error": "That .tmod file does not exist."}));
    }
    read_tmod_metadata(&path)
}

pub fn steam_workshop_list_items(_: &Args) -> Result<Value> {
    let mut s = SESSION.lock();
    s.connect()?;
    let items = s.published_items(10)?;
    Ok(json!({"items": items, "account": s.account()}))
}

pub fn steam_workshop_set_visibility(a: &Args) -> Result<Value> {
    let mut s = SESSION.lock();
    s.connect()?;
    let item_id = int_lenient(a.get(0))?;
    let visibility = int_lenient(a.get(1))?;
    s.submit_update(item_id as u64, &ItemUpdate { visibility: Some(visibility as i32), ..Default::default() }, None)?;
    Ok(json!({"itemId": str_of(a.get(0)), "visibility": visibility}))
}

pub fn steam_workshop_publish(a: &Args) -> Result<Value> {
    if BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Ok(json!({"success": false, "error": "An upload is already running."}));
    }
    // `dict(payload or {})`: as in Python, a payload that fails here leaves the flag set.
    let payload = if truthy(a.get(0)) { py_dict(a.get(0))? } else { Map::new() };
    std::thread::Builder::new().name("steam-workshop-publish".into()).spawn(move || run_publish(payload))?;
    Ok(json!({"started": true}))
}

/// `dict(value)`.
fn py_dict(v: &Value) -> Result<Map<String, Value>> {
    let items = match v {
        Value::Object(m) => return Ok(m.clone()),
        Value::Array(items) => items,
        Value::String(_) => return Err(anyhow!("dictionary update sequence element #0 has length 1; 2 is required")),
        other => return Err(anyhow!("'{}' object is not iterable", py::type_name(other))),
    };
    let mut out = Map::new();
    for (i, item) in items.iter().enumerate() {
        let pair: Vec<Value> = match item {
            Value::Array(p) => p.clone(),
            Value::String(s) => s.chars().map(|c| json!(c.to_string())).collect(),
            Value::Object(m) => m.keys().map(|k| json!(k)).collect(),
            _ => return Err(anyhow!("cannot convert dictionary update sequence element #{} to a sequence", i)),
        };
        if pair.len() != 2 {
            return Err(anyhow!("dictionary update sequence element #{} has length {}; 2 is required", i, pair.len()));
        }
        if matches!(pair[0], Value::Array(_) | Value::Object(_)) {
            return Err(anyhow!("unhashable type: '{}'", py::type_name(&pair[0])));
        }
        out.insert(str_of(&pair[0]), pair[1].clone());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_names_and_results() {
        assert_eq!(safe_name(" My: Mod?. "), "My Mod");
        assert_eq!(safe_name("..."), "Trove Mod");
        assert_eq!(safe_name("a\u{1}b"), "ab");
        assert_eq!(eresult(16), "Timed out");
        assert_eq!(eresult(99), "EResult 99");
        assert_eq!(update_status(3), "uploading_content");
        assert_eq!(format!("{:.0}", 1536.0f64), "1536");
        assert_eq!(format!("{:.0}", 2.5f64), "2");
        assert_eq!(format!("{:.0}", 1024.5f64), "1024");
    }

    /// Loads the real `steam_api64.dll` and resolves every export the session uses.
    #[test]
    #[ignore]
    fn steam_dll_loads_and_exports_resolve() {
        let (dll, _) = find_steam_api_dll().expect("a Steam install of Trove");
        assert!(Api::load(&dll).is_ok());
    }

    /// Prints `steam_workshop_status` (probes `SteamAPI_IsSteamRunning` only) to diff
    /// against Python's.
    #[test]
    #[ignore]
    fn steam_status_probe() {
        for name in ["steam_workshop_status", "steam_workshop_connect", "steam_workshop_list_items", "steam_workshop_disconnect"] {
            println!("{}", crate::json::dumps(&crate::call(name, Vec::new()).unwrap().unwrap()));
        }
        println!("{:?}", subscribe_item("123").map_err(|e| e.is::<SteamError>()));
        if let Ok(tmod) = std::env::var("BTT_PUBLISH_TMOD") {
            let host = crate::ctx::testing::init();
            let payload = json!({"tmodPath": tmod, "title": "T", "tags": ["UI"], "visibility": "1"});
            println!("{}", crate::json::dumps(&crate::call("steam_workshop_publish", vec![payload]).unwrap().unwrap()));
            while BUSY.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(50));
            }
            for (name, args) in host.calls.lock().iter() {
                println!("{} {}", name, crate::json::dumps(&Value::Array(args.clone())));
            }
        }
    }

    /// Needs Steam running and signed in to an account that owns Trove.
    #[test]
    #[ignore]
    fn steam_session_connects_and_lists_items() {
        let mut s = SESSION.lock();
        s.connect().unwrap();
        let account = s.account();
        assert!(account["steam_id"].as_str().unwrap() != "0");
        let items = s.published_items(1).unwrap();
        eprintln!("{} published items", items.len());
        s.disconnect();
    }
}
