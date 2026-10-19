//! Windows-only launch checks from main.py.

/// Points `btt://` links at this executable (HKCU, refreshed every launch).
pub fn register_btt_protocol() {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let Ok(exe) = std::env::current_exe() else { return };
        let hkcu = winreg::RegKey::predef(HKEY_CURRENT_USER);
        let result = (|| -> std::io::Result<()> {
            let (key, _) = hkcu.create_subkey(r"Software\Classes\btt")?;
            key.set_value("", &"URL:btt Protocol")?;
            key.set_value("URL Protocol", &"")?;
            let (cmd, _) = key.create_subkey(r"shell\open\command")?;
            cmd.set_value("", &format!("\"{}\" \"%1\"", exe.display()))?;
            Ok(())
        })();
        if let Err(e) = result {
            eprintln!("Failed to register protocol: {}", e);
        }
    }
}

#[cfg(windows)]
const WEBVIEW2_CLIENT_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// The Evergreen WebView2 runtime registers a version under EdgeUpdate\Clients.
#[cfg(windows)]
pub fn webview2_installed() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    let path = format!(r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{}", WEBVIEW2_CLIENT_GUID);
    let locations = [(HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY), (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY), (HKEY_CURRENT_USER, 0)];
    locations.iter().any(|(root, view)| {
        winreg::RegKey::predef(*root)
            .open_subkey_with_flags(&path, KEY_READ | view)
            .and_then(|k| k.get_value::<String, _>("pv"))
            .map(|v| !v.is_empty() && v != "0.0.0.0")
            .unwrap_or(false)
    })
}

#[cfg(windows)]
pub fn webview2_missing_dialog() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONERROR, MB_SETFOREGROUND, MB_YESNO};
    const URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";
    let text = format!(
        "Better Trove Tools needs the Microsoft Edge WebView2 runtime, but it isn't installed on this PC.\n\nDownload and install it from:\n{}\n\nOpen the download page now?",
        URL
    );
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, caption) = (wide(&text), wide("WebView2 runtime required"));
    let choice = unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), MB_YESNO | MB_ICONERROR | MB_SETFOREGROUND) };
    if choice == IDYES {
        let _ = std::process::Command::new("cmd").args(["/C", "start", "", URL]).spawn();
    }
}
