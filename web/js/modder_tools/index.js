document.addEventListener('modder_tools_loaded', () => {
    console.log("Modder Tools Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, watch, onMounted, onBeforeUnmount } = Vue;

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
            let embeddedFileManagerLoaded = false;
            let embeddedFileManagerLoading = null;

            const setActiveTab = (tabName) => {
                if (isWebMode && tabName !== 'extract') return;
                activeTab.value = tabName;
            };

            const applyStateSnapshot = (saved) => {
                if (!saved || typeof saved !== 'object') return;
                if (typeof saved.activeTab === 'string') {
                    // Honor saved tab, but in web mode coerce anything other
                    // than 'extract' back to 'extract' so a desktop-only saved
                    // state doesn't render a blank tab body here.
                    activeTab.value = (isWebMode && saved.activeTab !== 'extract') ? 'extract' : saved.activeTab;
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
                        { url: 'views/modder_tools/projects.html', host: 'modder-projects-vue-app-inner' },
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

            const ensureEmbeddedFileManagerLoaded = async () => {
                if (embeddedFileManagerLoaded) return;
                if (embeddedFileManagerLoading) {
                    await embeddedFileManagerLoading;
                    return;
                }

                embeddedFileManagerLoading = (async () => {
                    const host = document.getElementById('modder-tools-file-manager-host');
                    if (!host) return;

                    const response = await fetch('views/modder_tools/file_manager.html', { cache: 'no-store' });
                    if (!response.ok) throw new Error(`Failed to load file manager view (${response.status})`);

                    const html = await response.text();
                    const parsed = new DOMParser().parseFromString(html, 'text/html');
                    const root = parsed.querySelector('#file-manager-vue-app');
                    if (!root) throw new Error('File Manager root element not found');

                    host.innerHTML = '';
                    host.appendChild(root);

                    if (window.loadScript) {
                        try { await window.loadScript('js/modder_tools/file_manager.js'); } catch (e) { console.error('Failed to lazy-load file_manager.js:', e); }
                    }

                    document.dispatchEvent(new CustomEvent('file_manager_loaded'));
                    embeddedFileManagerLoaded = true;
                })();

                try {
                    await embeddedFileManagerLoading;
                } finally {
                    embeddedFileManagerLoading = null;
                }
            };

            const syncEmbeddedFileManagerTab = (tabName) => {
                document.dispatchEvent(new CustomEvent('file_manager_set_tab', { detail: { tab: tabName } }));
            };

            const handleEmbeddedTabSelection = async (newTab) => {
                if (newTab !== 'file_explorer' && newTab !== 'update_tracker') return;
                await ensureEmbeddedFileManagerLoaded();
                syncEmbeddedFileManagerTab(newTab === 'file_explorer' ? 'tab-explorer' : 'tab-tracker');
            };

            watch(activeTab, (newTab) => {
                persistState();
                if (newTab === 'build') {
                    document.dispatchEvent(new CustomEvent('modder_build_shown'));
                } else if (newTab === 'extract') {
                    document.dispatchEvent(new CustomEvent('modder_extract_shown'));
                } else if (newTab === 'edit_tmod') {
                    document.dispatchEvent(new CustomEvent('modder_edit_tmod_shown'));
                } else if (newTab === 'projects') {
                    document.dispatchEvent(new CustomEvent('modder_projects_shown'));
                } else if (newTab === 'qb_editor') {
                    document.dispatchEvent(new CustomEvent('modder_qb_editor_shown'));
                } else if (newTab === 'software') {
                    document.dispatchEvent(new CustomEvent('modder_software_shown'));
                }
                handleEmbeddedTabSelection(newTab).catch((e) => {
                    console.error('Failed to load embedded File Manager:', e);
                    window.showToast(t('modder_tools.failed_to_load_game_file_manager_inside_754ac4'), true);
                });
            });

            onMounted(async () => {
                hydratingState = true;
                if (window.AppSettings) {
                    try {
                        await window.AppSettings.load();
                        applyStateSnapshot(window.AppSettings.getPref(PREF_STATE_KEY, null));
                    } catch (e) {
                        console.error('modder_tools: failed to restore state', e);
                    }
                }
                if (window.pendingModderToolsTab) {
                    activeTab.value = window.pendingModderToolsTab;
                    window.pendingModderToolsTab = null;
                }

                // Mount every per-tab app NOW. This must not wait on the game-path
                // scan (registry/Steam detection can be slow or hang), otherwise the
                // tabs render blank. The tabs read store.selectedGamePath reactively,
                // so they update once the background scan resolves.
                await loadSubviewContent();
                const tabsToMount = isWebMode
                    ? ['extract']
                    : ['build', 'extract', 'edit_tmod', 'projects', 'qb_editor', 'software'];
                tabsToMount.forEach((tab) => {
                    document.dispatchEvent(new CustomEvent(`modder_${tab}_loaded`));
                });
                await handleEmbeddedTabSelection(activeTab.value);
                hydratingState = false;

                // Detect game installs in the background (fire-and-forget).
                scanForGames();
            });

            onBeforeUnmount(() => {
                if (window._fileManagerApp && typeof window._fileManagerApp.unmount === 'function') {
                    window._fileManagerApp.unmount();
                    window._fileManagerApp = null;
                }
            });

            return {
                t, activeTab, setActiveTab, isWebMode
            };
        }
    });

    if (window._modderToolsApp) window._modderToolsApp.unmount();
    window._modderToolsApp = app;
    app.mount('#modder-tools-vue-app');
});
