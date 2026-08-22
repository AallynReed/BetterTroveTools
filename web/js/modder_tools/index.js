document.addEventListener('modder_tools_loaded', () => {
    console.log("Modder Tools Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, watch, onMounted, onUnmounted } = Vue;

    const app = createApp({
        setup() {
            const { store, t } = window.ModderTools;
            const PREF_STATE_KEY = 'state_modder_tools';
            let hydratingState = false;

            // Web build (BTT_WEB_MODE && !BTT_NATIVE) only exposes the Extract
            // tab — every other tab needs the desktop eel bridge for filesystem
            // I/O, mod-tree scanning, or shelling out to external tools.
            const isWebMode = !!window.BTT_WEB_MODE;
            const activeTab = ref(isWebMode ? 'extract' : 'build');
            // Legacy "Projects" tab is hidden by default; opt back in via
            // Settings -> Legacy Features (enable_legacy_projects). Read in
            // onMounted from the persisted settings.
            const legacyProjectsEnabled = ref(false);
            // The Steam Workshop tab needs steam_api64.dll from a Steam install
            // of Trove, so it's Windows-only. The backend is the source of
            // truth; the tab body explains itself when no Steam copy is found.
            const steamSupported = ref(false);

            // Online management tabs (Mods / Modpacks) only exist while the user is
            // signed in (window.BTTAccount is the source of truth). Kept reactive so
            // the tabs appear/disappear live on login/logout.
            const loggedIn = ref(!!(window.BTTAccount && window.BTTAccount.state.authenticated));
            let unsubAccount = null;

            // Tabs that can actually be shown right now (web mode = extract only;
            // projects only when the legacy toggle is on; manage tabs only when
            // signed in). Used to coerce stale/unavailable saved tabs back to a
            // valid tab (e.g. the relocated file_explorer/update_tracker).
            const isTabAvailable = (tabName) => {
                if (isWebMode) return tabName === 'extract';
                if (tabName === 'projects') return legacyProjectsEnabled.value;
                if (tabName === 'manage_mods' || tabName === 'manage_modpacks') return loggedIn.value;
                if (tabName === 'steam') return steamSupported.value;
                return ['build', 'extract', 'edit_tmod', 'qb_editor', 'software'].includes(tabName);
            };

            // Signed-out pseudo-tab → take the user to the Account view to sign in.
            const promptManageLogin = () => {
                if (window.loadView) window.loadView('account');
            };

            const setActiveTab = (tabName) => {
                if (!isTabAvailable(tabName)) return;
                activeTab.value = tabName;
            };

            const applyStateSnapshot = (saved) => {
                if (!saved || typeof saved !== 'object') return;
                if (typeof saved.activeTab === 'string') {
                    // Honor the saved tab only if it's still available: web mode
                    // coerces to extract, the relocated file_explorer/update_tracker
                    // and the gated-off projects tab fall back to the default.
                    activeTab.value = isTabAvailable(saved.activeTab)
                        ? saved.activeTab
                        : (isWebMode ? 'extract' : 'build');
                }
                if (typeof saved.selectedGamePath === 'string') store.selectedGamePath = saved.selectedGamePath;
            };

            const persistState = () => {
                if (hydratingState || !window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    activeTab: activeTab.value,
                    selectedGamePath: store.selectedGamePath
                });
            };

            const scanForGames = async () => {
                try {
                    const response = await eel.get_detected_game_paths()();
                    const settings = await window.ModderTools.readSettings();
                    const paths = window.ModderTools.unwrapResponse(response, 'paths', []);
                    const safePaths = Array.isArray(paths) ? paths : [];

                    if (safePaths.length > 0) {
                        store.installs = safePaths;
                        if (settings.last_game_path && store.installs.some(p => p.path === settings.last_game_path)) {
                            store.selectedGamePath = settings.last_game_path;
                        } else {
                            store.selectedGamePath = store.installs[0].path;
                        }
                        return;
                    }

                    store.installs = [];
                    store.selectedGamePath = '';
                    if (response && response.error) {
                        window.showToast(t('common.game_path_detection_failed_error').replace('{error}', response.error), true);
                    }
                } catch (error) {
                    store.installs = [];
                    store.selectedGamePath = '';
                    window.showToast(t('common.game_path_detection_failed'), true);
                }
            };

            watch(() => store.selectedGamePath, async (newVal) => {
                if (!newVal) return;
                const settings = await window.ModderTools.readSettings();
                settings.last_game_path = newVal;
                await eel.save_settings(settings)();
            });

            watch([activeTab, () => store.selectedGamePath], persistState, { deep: true });

            const loadSubviewContent = async () => {
                // Fetch each per-tab sub-view in parallel and inject it into its
                // host div. Mirrors the gems_and_builds orchestrator pattern.
                // Web mode only ships Extract — skipping the rest avoids fetching
                // sub-views whose JS would crash trying to call the eel bridge.
                const subviews = isWebMode
                    ? [{ url: 'views/modder_tools/extract.html', host: 'modder-extract-vue-app-inner' }]
                    : [
                        { url: 'views/modder_tools/build.html', host: 'modder-build-vue-app-inner' },
                        { url: 'views/modder_tools/extract.html', host: 'modder-extract-vue-app-inner' },
                        { url: 'views/modder_tools/edit_tmod.html', host: 'modder-edit-tmod-vue-app-inner' },
                        ...(steamSupported.value ? [{ url: 'views/modder_tools/steam.html', host: 'modder-steam-vue-app-inner' }] : []),
                        // Projects only fetched when the legacy toggle is on.
                        ...(legacyProjectsEnabled.value ? [{ url: 'views/modder_tools/projects.html', host: 'modder-projects-vue-app-inner' }] : []),
                        { url: 'views/modder_tools/qb_editor.html', host: 'modder-qb-editor-vue-app-inner' },
                        { url: 'views/modder_tools/software.html', host: 'modder-software-vue-app-inner' },
                    ];
                const fetched = await Promise.all(subviews.map(async ({ url, host }) => {
                    try {
                        // no-store: these sub-view files are new (added by the modder
                        // split); a default-cache fetch can return a stale 404 that
                        // WebView2 cached from before the file existed, leaving the tab
                        // blank. The embedded file_manager already uses no-store.
                        const response = await fetch(url, { cache: 'no-store' });
                        if (!response.ok) return null;
                        return { host, html: await response.text() };
                    } catch (e) {
                        console.error(`Failed to fetch ${url}:`, e);
                        return null;
                    }
                }));
                fetched.forEach((entry) => {
                    if (!entry) return;
                    const el = document.getElementById(entry.host);
                    if (el) el.innerHTML = entry.html;
                });
            };

            // The two online-management tabs are login-gated and heavier, so they
            // mount lazily the first time they're opened (fetch html + load js +
            // dispatch the loaded event), mirroring the old file-manager embed.
            const MANAGE_SUBVIEWS = {
                manage_mods: { url: 'views/modder_tools/manage_mods.html', host: 'modder-manage-mods-vue-app-inner', script: 'js/modder_tools/manage_mods.js' },
                manage_modpacks: { url: 'views/modder_tools/manage_modpacks.html', host: 'modder-manage-modpacks-vue-app-inner', script: 'js/modder_tools/manage_modpacks.js' },
            };
            const manageMounted = { manage_mods: false, manage_modpacks: false };
            const ensureManageMounted = async (tabName) => {
                const cfg = MANAGE_SUBVIEWS[tabName];
                if (!cfg || manageMounted[tabName]) return;
                manageMounted[tabName] = true;
                try {
                    const res = await fetch(cfg.url, { cache: 'no-store' });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const host = document.getElementById(cfg.host);
                    if (host) host.innerHTML = await res.text();
                    if (window.loadScript) await window.loadScript(cfg.script);
                    document.dispatchEvent(new CustomEvent(`modder_${tabName}_loaded`));
                } catch (e) {
                    console.error(`Failed to load ${tabName}:`, e);
                    manageMounted[tabName] = false;  // allow a retry on next open
                }
            };

            watch(activeTab, (newTab) => {
                persistState();
                if (newTab === 'build') {
                    document.dispatchEvent(new CustomEvent('modder_build_shown'));
                } else if (newTab === 'extract') {
                    document.dispatchEvent(new CustomEvent('modder_extract_shown'));
                } else if (newTab === 'edit_tmod') {
                    document.dispatchEvent(new CustomEvent('modder_edit_tmod_shown'));
                } else if (newTab === 'steam') {
                    document.dispatchEvent(new CustomEvent('modder_steam_shown'));
                } else if (newTab === 'projects') {
                    document.dispatchEvent(new CustomEvent('modder_projects_shown'));
                } else if (newTab === 'qb_editor') {
                    document.dispatchEvent(new CustomEvent('modder_qb_editor_shown'));
                } else if (newTab === 'software') {
                    document.dispatchEvent(new CustomEvent('modder_software_shown'));
                } else if (newTab === 'manage_mods' || newTab === 'manage_modpacks') {
                    ensureManageMounted(newTab).then(() => {
                        document.dispatchEvent(new CustomEvent(`modder_${newTab}_shown`));
                    });
                }
            });

            onMounted(async () => {
                hydratingState = true;
                // Sync login state BEFORE restoring the saved tab so a saved manage
                // tab coerces correctly when signed out, and subscribe so the tabs
                // appear/disappear live on login/logout.
                if (window.BTTAccount) {
                    loggedIn.value = !!window.BTTAccount.state.authenticated;
                    unsubAccount = window.BTTAccount.onChange((s) => {
                        loggedIn.value = !!s.authenticated;
                        if (!s.authenticated && (activeTab.value === 'manage_mods' || activeTab.value === 'manage_modpacks')) {
                            activeTab.value = isWebMode ? 'extract' : 'build';
                        }
                    });
                    window.BTTAccount.refresh().then((s) => { loggedIn.value = !!s.authenticated; }).catch(() => {});
                }
                try {
                    const steamStatus = await eel.steam_workshop_status()();
                    const payload = window.ModderTools.unwrapResponse(steamStatus, null, {}) || {};
                    steamSupported.value = payload.supported === true;
                } catch (e) {
                    steamSupported.value = false;
                }
                if (window.AppSettings) {
                    try {
                        await window.AppSettings.load();
                        // Read the legacy-projects opt-in BEFORE restoring the saved
                        // tab so a saved 'projects' tab coerces correctly when off.
                        legacyProjectsEnabled.value = window.AppSettings.get('enable_legacy_projects', false) === true;
                        applyStateSnapshot(window.AppSettings.getPref(PREF_STATE_KEY, null));
                    } catch (e) {
                        console.error('modder_tools: failed to restore state', e);
                    }
                }
                const applyPendingModderTab = () => {
                    if (window.pendingModderToolsTab && isTabAvailable(window.pendingModderToolsTab)) {
                        activeTab.value = window.pendingModderToolsTab;
                    }
                    window.pendingModderToolsTab = null;
                };
                applyPendingModderTab();
                // Deep-link into a sub-tab of the already-cached view arrives via
                // modder_tools_shown (no rebuild); honor it in place. Remove any
                // prior handler first so a rebuild (e.g. language change) can't
                // leave two racing to null window.pendingModderToolsTab.
                if (window._modderToolsShownHandler) {
                    document.removeEventListener('modder_tools_shown', window._modderToolsShownHandler);
                }
                window._modderToolsShownHandler = applyPendingModderTab;
                document.addEventListener('modder_tools_shown', applyPendingModderTab);

                // Mount every per-tab app NOW. This must not wait on the game-path
                // scan (registry/Steam detection can be slow or hang), otherwise the
                // tabs render blank. The tabs read store.selectedGamePath reactively,
                // so they update once the background scan resolves.
                await loadSubviewContent();
                const tabsToMount = isWebMode
                    ? ['extract']
                    : ['build', 'extract', 'edit_tmod', ...(steamSupported.value ? ['steam'] : []),
                       ...(legacyProjectsEnabled.value ? ['projects'] : []), 'qb_editor', 'software'];
                tabsToMount.forEach((tab) => {
                    document.dispatchEvent(new CustomEvent(`modder_${tab}_loaded`));
                });
                hydratingState = false;

                // Detect game installs in the background (fire-and-forget).
                scanForGames();
            });

            onUnmounted(() => { if (unsubAccount) unsubAccount(); });

            return {
                t, activeTab, setActiveTab, isWebMode, legacyProjectsEnabled, steamSupported,
                loggedIn, promptManageLogin
            };
        }
    });

    if (window._modderToolsApp) window._modderToolsApp.unmount();
    window._modderToolsApp = app;
    app.mount('#modder-tools-vue-app');
});
