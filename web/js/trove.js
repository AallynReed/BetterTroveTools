// Trove tab — a Glyph-free launcher/updater UI driven by backend/trove.py.
//
// The backend runs update/repair/launch on a worker thread and pushes progress
// frames to the JS-exposed `receive_trove_progress`. We keep a module-level
// dispatcher so the exposed name survives across the keep-alive view lifecycle,
// and point it at the mounted Vue instance's handler in `trove_loaded`.

(function () {
    // Module-level dispatcher: the exposed eel callback forwards to whatever
    // handler the mounted view registered (null before mount / in web mode).
    let _progressHandler = null;
    function receive_trove_progress(payload) {
        if (_progressHandler) _progressHandler(payload);
    }
    if (window.eel && typeof window.eel.expose === 'function') {
        window.eel.expose(receive_trove_progress, 'receive_trove_progress');
    }

    const hasEel = () => !!window.eel;
    const t = (str, p) => (window.I18nManager && window.I18nManager.t)
        ? window.I18nManager.t(str, p) : str;

    // Which update branch a server key syncs (for reading local version state).
    const SERVER_BRANCH = { 'live-na': 'live-us', 'live-eu': 'live-us', 'pts': 'pts' };

    // Classify an install as PTS vs Live from its folder. PTS installs live in a
    // folder literally named "PTS" (e.g. ...\Trove\PTS) and show as "(Glyph) PTS";
    // Live NA/EU share the same Live files (only the auth server differs). Matching
    // a whole path segment (not a substring) avoids false hits like ".../scripts/...".
    const isPtsInstall = (g) => {
        const name = (g && g.name) || '';
        const path = (g && g.path) || '';
        if (/\bpts\b/i.test(name)) return true;
        return String(path).split(/[\\/]+/).some(seg => seg.toLowerCase() === 'pts');
    };

    document.addEventListener('trove_loaded', () => {
        if (typeof Vue === 'undefined') { console.error('Vue.js failed to load!'); return; }
        const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;

        const app = createApp({
            setup() {
                // Launcher | Overlay. The overlay half lives in its own module
                // (js/overlay/editor.js) and is spread into this setup's return;
                // it reports `overlaySupported: false` off Windows desktop, and
                // the tab bar isn't rendered at all in that case.
                const tab = ref('launcher');
                const overlay = window.BTTOverlayEditor
                    ? window.BTTOverlayEditor(Vue)
                    : { overlaySupported: ref(false) };

                const installs = ref([]);
                const servers = ref([
                    { key: 'live-na', label: 'Live (NA)' },
                    { key: 'live-eu', label: 'Live (EU)' },
                    { key: 'pts', label: 'PTS' },
                ]);
                const versions = ref({});
                const gamePath = ref('');
                const server = ref('live-na');
                const email = ref('');
                const password = ref('');
                const rememberEmail = ref(true);
                const rememberPassword = ref(false);
                const hasSavedPassword = ref(false);
                const updateFirst = ref(true);
                const loggedIn = ref(false);

                // Multi-account: saved accounts + which one is active. selectedEmail
                // is '__add__' while entering a brand-new account.
                const accounts = ref([]);            // [{email, name, logged_in, has_saved_password}]
                const selectedEmail = ref('__add__');
                const accountLabel = ref('');        // editable custom label for the selected account
                const revealEmails = ref(false);     // hide emails behind ****@domain until toggled
                const autoRelog = ref(false);
                const running = ref([]);             // [{pid, email, server, auto_relog, uptime, relogs}]
                const isAdding = computed(() => selectedEmail.value === '__add__' || !accounts.value.length);
                const acctEmail = computed(() => isAdding.value ? email.value.trim() : selectedEmail.value);
                // Sign-in needs an address plus *some* secret: a typed password, or
                // one already remembered on this PC for that account.
                const canSignIn = computed(() => {
                    const em = acctEmail.value;
                    if (!em) return false;
                    if (password.value) return true;
                    const acct = accounts.value.find(a => a.email === em);
                    return !!(acct && acct.has_saved_password);
                });

                const busy = ref(false);
                const op = ref(null);
                const message = ref('');
                const progress = reactive({ current: 0, total: 0, downloaded: 0 });
                const logLines = ref([]);
                const notice = reactive({ text: '', kind: 'info' });

                const twofaNeeded = ref(false);
                const twofaCode = ref('');
                const logEl = ref(null);
                const twofaInput = ref(null);

                // 'pts' when the PTS server is selected, else 'live'. Live NA/EU
                // share the same files, so only the Live-vs-PTS split matters here.
                const serverKind = computed(() => server.value === 'pts' ? 'pts' : 'live');

                // Clean, de-duped install list FILTERED to the selected server's kind,
                // so PTS never shows Live folders (and vice versa) — you can't launch
                // or update PTS against Live files. Sanitizing also guards the v-for
                // against stray null/non-object entries.
                const cleanInstalls = computed(() => {
                    const src = Array.isArray(installs.value) ? installs.value : [];
                    const seen = new Set();
                    const out = [];
                    for (const g of src) {
                        if (!g || typeof g !== 'object' || !g.path) continue;
                        const path = String(g.path);
                        if (seen.has(path)) continue;
                        seen.add(path);
                        const name = String(g.name || path);
                        // Custom directories bypass the Live/PTS filter — always shown.
                        out.push({ name, path, kind: isPtsInstall(g) ? 'pts' : 'live', custom: /^\(Custom\)/.test(name) });
                    }
                    return out;
                });
                const installList = computed(() => cleanInstalls.value.filter(g => g.custom || g.kind === serverKind.value));
                // Empty-state label: distinguish "no PTS install" from "no installs at all".
                const noInstallLabel = computed(() => {
                    const hasOtherKind = cleanInstalls.value.some(g => g.kind !== serverKind.value);
                    if (!hasOtherKind) return t('trove.no_installs');
                    return t(serverKind.value === 'pts' ? 'trove.no_pts_install' : 'trove.no_live_install');
                });
                const serverList = computed(() => {
                    const src = Array.isArray(servers.value) ? servers.value : [];
                    return src.filter(s => s && s.key)
                        .map(s => ({ key: String(s.key), label: String(s.label || s.key) }));
                });
                const progressPct = computed(() => progress.total
                    ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0);
                const localVersion = computed(() => {
                    const v = versions.value[SERVER_BRANCH[server.value] || 'live-us'];
                    return v || '';
                });
                const busyLabel = computed(() => {
                    const map = {
                        play: t('trove.launching'), update: t('trove.updating'),
                        repair: t('trove.repairing'), check: t('trove.checking'),
                        signin: t('trove.signing_in'),
                    };
                    return map[op.value] || t('trove.working');
                });

                function setNotice(text, kind) { notice.text = text; notice.kind = kind || 'info'; }
                function pushLog(line) {
                    if (!line) return;
                    logLines.value.push(line);
                    if (logLines.value.length > 300) logLines.value.splice(0, logLines.value.length - 300);
                    nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });
                }
                function resetProgress() { progress.current = 0; progress.total = 0; progress.downloaded = 0; }

                // Incoming progress/status frame from the backend worker thread.
                _progressHandler = (p) => {
                    if (!p || typeof p !== 'object') return;
                    // Running-instances / auto-relog frames are out-of-band: they must
                    // not touch the current operation's op/busy/progress state.
                    if (p.op === 'running') {
                        if (Array.isArray(p.instances)) running.value = p.instances;
                        if (p.message) {
                            pushLog(p.message);
                            if (p.stage === 'relog' || p.stage === 'relogged' || p.stage === 'relog_failed') {
                                setNotice(p.message, p.stage === 'relog_failed' ? 'error' : 'info');
                            }
                        }
                        return;
                    }
                    op.value = p.op || op.value;
                    if (typeof p.current === 'number') progress.current = p.current;
                    if (typeof p.total === 'number') progress.total = p.total;
                    if (typeof p.downloaded === 'number') progress.downloaded = p.downloaded;
                    if (p.message) { message.value = p.message; }
                    if (p.stage === 'log') { pushLog(p.message); return; }
                    if (p.message) pushLog(p.message);

                    if (p.stage === '2fa_required') {
                        twofaNeeded.value = true; twofaCode.value = '';
                        nextTick(() => { if (twofaInput.value) twofaInput.value.focus(); });
                        return;
                    }
                    if (p.stage === 'done' || p.done) {
                        twofaNeeded.value = false;
                        if (p.op === 'check') {
                            const utd = p.up_to_date;
                            setNotice(utd ? t('trove.up_to_date') + ' (' + (p.version || '?') + ')'
                                          : t('trove.update_available') + ' (' + (p.version || '?') + ')',
                                      utd ? 'ok' : 'info');
                        } else if (p.stage === 'signed_in') {
                            setNotice(p.message || t('trove.signed_in'), 'ok');
                            loggedIn.value = true;
                            password.value = '';
                            // Selected only after refreshState lands, so the dropdown
                            // already has the option this value points at.
                            pendingSelect = p.email || null;
                        } else if (p.stage === 'launched') {
                            setNotice(p.message || t('trove.launched'), 'ok');
                            loggedIn.value = true;
                        } else if (p.op === 'repair' || p.op === 'update' || p.op === 'play') {
                            if (p.ok === false) setNotice(t('trove.finished_with_errors') + ' (' + (p.failed || 0) + ')', 'error');
                            else if (p.stage === 'done') setNotice(t('trove.up_to_date') + ' (' + (p.version || '?') + ')', 'ok');
                        }
                        if (p.version) versions.value[SERVER_BRANCH[server.value] || 'live-us'] = p.version;
                        finishOp();
                    }
                    if (p.stage === 'error') {
                        twofaNeeded.value = false;
                        setNotice(p.error || t('trove.error'), 'error');
                        finishOp();
                    }
                };

                // Account to switch the dropdown to once the post-op refresh has
                // repopulated the list (set by the sign-in done frame).
                let pendingSelect = null;
                function finishOp() {
                    busy.value = false; op.value = null;
                    refreshState().then(() => {
                        if (!pendingSelect) return;
                        selectedEmail.value = pendingSelect;
                        pendingSelect = null;
                        onSelectAccount();
                    });
                }

                // Sync account list / running instances / login flags from a state
                // payload. `initial` also seeds the selected account + toggles.
                function applyState(d, initial) {
                    if (Array.isArray(d.accounts)) accounts.value = d.accounts;
                    if (Array.isArray(d.running)) running.value = d.running;
                    if (typeof d.auto_relog === 'boolean' && initial) autoRelog.value = d.auto_relog;
                    loggedIn.value = !!d.logged_in;
                    hasSavedPassword.value = !!d.has_saved_password;
                    if (d.versions) versions.value = d.versions;
                    if (d.servers && d.servers.length) servers.value = d.servers;
                    if (initial) {
                        if (accounts.value.length) selectedEmail.value = d.selected_email || accounts.value[0].email;
                        else selectedEmail.value = '__add__';
                        rememberEmail.value = d.remember_email !== undefined ? !!d.remember_email : !!d.email;
                        rememberPassword.value = !!d.remember_password;
                    }
                }

                async function refreshState() {
                    if (!hasEel()) return;
                    try {
                        const st = await window.callBackend(window.eel.trove_get_state()(), 'state');
                        if (st.success) applyState(st.data || {}, false);
                    } catch (e) { /* non-fatal */ }
                }

                async function loadInstalls(preferred) {
                    if (!hasEel()) return;
                    try {
                        const res = await window.callBackend(window.eel.get_settings()(), 'settings');
                        const d = res.data || {};
                        installs.value = (d.game_installs || []).filter(g => g && g.path);
                        const paths = installs.value.map(g => g.path);
                        const pick = [preferred, d.last_game_path].find(p => p && paths.includes(p));
                        const pickPath = pick || (installs.value[0] ? installs.value[0].path : '');
                        // Align the server's Live/PTS kind to the install we're about to
                        // select, so a remembered PTS install opens on the PTS server
                        // (keeping the Live region choice when it's a Live install).
                        if (pickPath) {
                            const g = installs.value.find(x => x.path === pickPath);
                            if (isPtsInstall(g) && server.value !== 'pts') server.value = 'pts';
                            else if (!isPtsInstall(g) && server.value === 'pts') server.value = 'live-na';
                        }
                        gamePath.value = pickPath;
                    } catch (e) { /* non-fatal */ }
                }

                // Keep the selected install valid for the current server: if switching
                // server (or reloading installs) leaves gamePath pointing at a folder
                // that's no longer in the filtered list, jump to the first match (or
                // clear it, which disables the buttons until a matching install exists).
                function reconcileInstall() {
                    if (!installList.value.some(g => g.path === gamePath.value)) {
                        gamePath.value = installList.value.length ? installList.value[0].path : '';
                    }
                }
                watch(installList, reconcileInstall);

                // -- operations --
                // busy is set synchronously BEFORE the call so a near-instant
                // `done` frame (e.g. already-up-to-date) can't clear it before a
                // slower ack round-trip would have set it — which would wedge the
                // UI as permanently busy. The ack only rolls busy back on failure.
                function beginLocal(startingMsg) {
                    busy.value = true; notice.text = ''; resetProgress();
                    logLines.value = []; message.value = startingMsg || '';
                }
                function ackFailed(res) {
                    if (!res || !res.success) { setNotice((res && res.error) || t('trove.error'), 'error'); busy.value = false; return true; }
                    if (res.data && res.data.started === false) { setNotice(t('trove.busy'), 'info'); busy.value = false; return true; }
                    return false;
                }

                async function check() {
                    if (!hasEel() || busy.value || !gamePath.value) return;
                    beginLocal(t('trove.checking'));
                    const res = await window.callBackend(window.eel.trove_check(gamePath.value, server.value)(), 'check');
                    ackFailed(res);
                }
                async function update() {
                    if (!hasEel() || busy.value || !gamePath.value) return;
                    beginLocal(t('trove.updating'));
                    const res = await window.callBackend(window.eel.trove_update(gamePath.value, server.value)(), 'update');
                    ackFailed(res);
                }
                async function repair() {
                    if (!hasEel() || busy.value || !gamePath.value) return;
                    if (!window.confirm(t('trove.repair_confirm'))) return;
                    beginLocal(t('trove.repairing'));
                    const res = await window.callBackend(window.eel.trove_repair(gamePath.value, server.value)(), 'repair');
                    ackFailed(res);
                }
                async function play() {
                    if (!hasEel() || busy.value || !gamePath.value) return;
                    const em = acctEmail.value;
                    const acct = accounts.value.find(a => a.email === em);
                    const secretReady = (acct && (acct.logged_in || acct.has_saved_password)) || password.value;
                    if (!em || !secretReady) { setNotice(t('trove.need_credentials'), 'error'); return; }
                    beginLocal(t('trove.launching'));
                    const res = await window.callBackend(window.eel.trove_play(
                        gamePath.value, server.value, em, password.value,
                        rememberEmail.value, rememberPassword.value, updateFirst.value, autoRelog.value)(), 'play');
                    if (!ackFailed(res)) {
                        password.value = '';
                        selectedEmail.value = em;  // switch dropdown to the launched account
                    }
                }
                async function signIn() {
                    if (!hasEel() || busy.value) return;
                    if (!canSignIn.value) { setNotice(t('trove.need_credentials'), 'error'); return; }
                    beginLocal(t('trove.signing_in'));
                    op.value = 'signin';
                    const res = await window.callBackend(window.eel.trove_sign_in(
                        acctEmail.value, password.value, accountLabel.value,
                        rememberPassword.value)(), 'signin');
                    // The password stays put until the *auth* succeeds (the
                    // signed_in frame clears it) — a rejected sign-in should not
                    // make the user retype it.
                    ackFailed(res);
                }
                function maskEmail(em) {
                    em = (em || '').trim();
                    if (!em) return 'Trove';
                    const at = em.indexOf('@');
                    return at < 0 ? '****' : '****' + em.slice(at);
                }
                function shownEmail(em) { return revealEmails.value ? (em || '') : maskEmail(em); }
                function aliasOf(em) { const a = accounts.value.find(x => x.email === em); return (a && a.name) || ''; }
                // Dropdown label: alias if set, else masked/revealed email (+ ✓ when signed in).
                function optLabel(a) { return (a.name || shownEmail(a.email)) + (a.logged_in ? '  ✓' : ''); }
                // Running list / generic label: alias if set, else masked/revealed email.
                function labelFor(em) { return aliasOf(em) || shownEmail(em); }
                async function onSelectAccount() {
                    password.value = '';
                    const em = selectedEmail.value;
                    if (em === '__add__') { email.value = ''; accountLabel.value = ''; loggedIn.value = false; hasSavedPassword.value = false; return; }
                    email.value = em;
                    const acct = accounts.value.find(a => a.email === em);
                    accountLabel.value = (acct && acct.name) || '';
                    if (!hasEel()) return;
                    const res = await window.callBackend(window.eel.trove_select_account(em)(), 'select');
                    if (res.success) { loggedIn.value = !!res.data.logged_in; hasSavedPassword.value = !!res.data.has_saved_password; }
                }
                async function renameAccount() {
                    const em = selectedEmail.value;
                    if (!em || em === '__add__' || !hasEel()) return;
                    const res = await window.callBackend(window.eel.trove_rename_account(em, accountLabel.value)(), 'rename');
                    if (res.success) { setNotice(t('trove.renamed'), 'ok'); await refreshState(); }
                }
                async function removeAccount() {
                    const em = selectedEmail.value;
                    if (!em || em === '__add__' || !hasEel()) return;
                    if (!window.confirm(t('trove.remove_confirm'))) return;
                    const res = await window.callBackend(window.eel.trove_remove_account(em)(), 'remove');
                    if (res.success) {
                        await refreshState();
                        selectedEmail.value = accounts.value.length ? accounts.value[0].email : '__add__';
                        await onSelectAccount();
                    }
                }
                async function openFolder(kind) {
                    if (!hasEel()) return;
                    if (kind === 'game' && !gamePath.value) return;
                    const res = await window.callBackend(
                        window.eel.trove_open_folder(kind, gamePath.value)(), 'open_folder');
                    if (!res.success) setNotice(res.error || t('trove.error'), 'error');
                }
                async function toggleRelog(inst) {
                    if (!hasEel() || !inst) return;
                    await window.callBackend(window.eel.trove_set_auto_relog(inst.pid, !inst.auto_relog)(), 'relog');
                }
                async function syncRemember() {
                    if (rememberPassword.value) rememberEmail.value = true;
                    if (!hasEel()) return;
                    const res = await window.callBackend(window.eel.trove_set_remember(
                        rememberEmail.value, rememberPassword.value, acctEmail.value)(), 'remember');
                    if (res.success) hasSavedPassword.value = !!(res.data && res.data.has_saved_password);
                }
                async function submit2fa() {
                    if (!twofaCode.value || !hasEel()) return;
                    await window.callBackend(window.eel.trove_submit_2fa(twofaCode.value)(), '2fa');
                    twofaNeeded.value = false;
                }
                async function cancel2fa() {
                    if (hasEel()) await window.callBackend(window.eel.trove_cancel_2fa()(), '2fa');
                    twofaNeeded.value = false;
                }
                async function logout() {
                    if (!hasEel() || busy.value) return;
                    const res = await window.callBackend(window.eel.trove_logout(acctEmail.value)(), 'logout');
                    if (res.success) {
                        loggedIn.value = false; hasSavedPassword.value = false;
                        rememberPassword.value = false; password.value = '';
                        setNotice(t('trove.signed_out'), 'info');
                        refreshState();
                    }
                }

                // Status polling only runs while the Overlay tab is on screen —
                // there is nothing to watch from the Launcher tab, and the view
                // stays alive in the keep-alive cache after the user navigates
                // away, so an always-on timer would never stop.
                function openOverlayTab() {
                    tab.value = 'overlay';
                    if (overlay.startOverlayPolling) overlay.startOverlayPolling();
                }

                onMounted(async () => {
                    if (overlay.loadOverlay) await overlay.loadOverlay();
                    document.addEventListener('trove_hidden', () => {
                        if (overlay.stopOverlayPolling) overlay.stopOverlayPolling();
                        // The hotkey capture listens on window at capture phase.
                        // Views are keep-alive cached, so leaving the tab mid-
                        // capture would otherwise keep swallowing keystrokes in
                        // whatever view the user went to next.
                        if (overlay.overlayCapturing) overlay.overlayCapturing.value = '';
                    });
                    document.addEventListener('trove_shown', () => {
                        if (tab.value === 'overlay' && overlay.startOverlayPolling) overlay.startOverlayPolling();
                    });

                    if (!hasEel()) { setNotice(t('trove.desktop_only'), 'info'); return; }
                    const st = await window.callBackend(window.eel.trove_get_state()(), 'state');
                    let preferred = null;
                    if (st.success) {
                        const d = st.data || {};
                        applyState(d, true);
                        email.value = (selectedEmail.value && selectedEmail.value !== '__add__')
                            ? selectedEmail.value : (d.email || '');
                        accountLabel.value = (accounts.value.find(a => a.email === selectedEmail.value) || {}).name || '';
                        autoRelog.value = !!d.auto_relog;
                        if (d.server) server.value = d.server;
                        preferred = d.game_path || null;
                    }
                    await loadInstalls(preferred);
                    // Refresh login/version/running state each time the tab is re-entered.
                    document.addEventListener('trove_shown', refreshState);
                });

                return Object.assign({}, overlay, {
                    tab, openOverlayTab,
                    t, installs, installList, noInstallLabel, servers, serverList, versions, gamePath,
                    server, email, password,
                    rememberEmail, rememberPassword, hasSavedPassword, updateFirst,
                    loggedIn, busy, op, message, progress,
                    accounts, selectedEmail, accountLabel, revealEmails, isAdding, canSignIn, autoRelog, running,
                    logLines, notice, twofaNeeded, twofaCode, logEl, twofaInput,
                    progressPct, localVersion, busyLabel, labelFor, shownEmail, optLabel,
                    check, update, repair, play, signIn, submit2fa, cancel2fa, logout, syncRemember,
                    onSelectAccount, removeAccount, renameAccount, toggleRelog, openFolder,
                });
            }
        });

        app.mount('#trove-vue-app');
    });
})();
