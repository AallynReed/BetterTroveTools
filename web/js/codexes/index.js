document.addEventListener('codexes_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const root = document.getElementById('codexes-vue-app');
    if (!root || root.dataset.codexesInitializing === '1') return;
    root.dataset.codexesInitializing = '1';

    const { createApp, ref, reactive, onMounted, onBeforeUnmount, watch } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
            const PREF_STATE_KEY = 'state_codexes';
            const activeTab = ref('allies');
            const installs = ref([]);
            const selectedGamePath = ref('');
            const loadedTabs = reactive({
                allies: false,
                mounts: false,
                dragons: false,
                mementos: false,
                recipes: false,
                items: false,
                fish: false,
                badges: false,
            });
            const pendingTabAbortControllers = new Map();
            const pendingTabLoads = new Map();
            let disposed = false;
            let hydratingState = false;

            const unwrapResponse = (resp, key = null, fallback = null) => {
                if (key) {
                    if (resp && Object.prototype.hasOwnProperty.call(resp, key)) return resp[key];
                    if (resp && resp.data && Object.prototype.hasOwnProperty.call(resp.data, key)) return resp.data[key];
                }
                if (resp && resp.data !== undefined && resp.success !== undefined) return resp.data;
                return resp ?? fallback;
            };

            const readSettings = async () => {
                const settingsResp = await eel.get_settings()();
                return unwrapResponse(settingsResp, null, {}) || {};
            };

            const persistState = () => {
                if (hydratingState || !window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    activeTab: activeTab.value,
                    selectedGamePath: selectedGamePath.value,
                });
            };

            const setActiveTab = (tabName) => {
                activeTab.value = tabName;
                persistState();
            };

            const formatInstalls = (entries) => (Array.isArray(entries) ? entries : []).map(entry => ({
                ...entry,
                label: `${entry.name} - ${entry.path}`
            }));

            const emitGamePathChanged = () => {
                window.getSelectedCodexGamePath = () => selectedGamePath.value || '';
                document.dispatchEvent(new CustomEvent('codex_game_path_changed', {
                    detail: { gamePath: selectedGamePath.value || '' }
                }));
            };

            const restoreState = async () => {
                if (!window.AppSettings) return;
                await window.AppSettings.load();
                const saved = window.AppSettings.getPref(PREF_STATE_KEY, null);
                if (saved && typeof saved === 'object') {
                    if (typeof saved.activeTab === 'string') activeTab.value = saved.activeTab;
                    if (typeof saved.selectedGamePath === 'string') selectedGamePath.value = saved.selectedGamePath;
                }
            };

            const scanForGames = async (forceRefresh = false) => {
                try {
                    // forceRefresh=true is reserved for the explicit "refresh game paths"
                    // button in each codex sub-view -- it tells the backend to bust the
                    // cached registry scan and walk it again.
                    const response = await eel.get_detected_game_paths(!!forceRefresh)();
                    const settings = await readSettings();
                    installs.value = formatInstalls(unwrapResponse(response, 'paths', []));

                    if (!installs.value.length) {
                        selectedGamePath.value = '';
                        return { installs: [], installOptions: [], selectedGamePath: '' };
                    }

                    const preferred = [
                        selectedGamePath.value,
                        settings.last_game_path,
                        installs.value[0] && installs.value[0].path,
                    ].find(path => path && installs.value.some(entry => entry.path === path));

                    selectedGamePath.value = preferred || installs.value[0].path;
                    return {
                        installs: installs.value.slice(),
                        installOptions: installs.value.map(install => [install.label, install.path]),
                        selectedGamePath: selectedGamePath.value || ''
                    };
                } catch (error) {
                    installs.value = [];
                    selectedGamePath.value = '';
                    window.showToast?.(t('common.game_path_detection_failed'), true);
                    return { installs: [], installOptions: [], selectedGamePath: '' };
                }
            };

            const openSelectedGamePath = async (path = '') => {
                const targetPath = path || selectedGamePath.value;
                if (!targetPath) return;
                const result = await eel.open_path_in_explorer(targetPath)();
                if (!result || !result.success) {
                    window.showToast?.(t('codexes.failed_to_open_folder'), true);
                }
            };

            const setSelectedGamePath = async (path) => {
                const normalized = String(path || '').trim();
                selectedGamePath.value = normalized;
                if (normalized) {
                    try {
                        const settings = await readSettings();
                        settings.last_game_path = normalized;
                        await eel.save_settings(settings)();
                    } catch (_err) {}
                }
                emitGamePathChanged();
                return {
                    installs: installs.value.slice(),
                    installOptions: installs.value.map(install => [install.label, install.path]),
                    selectedGamePath: selectedGamePath.value || ''
                };
            };

            const loadSubview = async (tabName, targetId, viewPath, rootSelector, eventName) => {
                if (disposed || loadedTabs[tabName]) return;
                if (pendingTabLoads.has(tabName)) return pendingTabLoads.get(tabName);

                const host = document.getElementById(targetId);
                if (!host) return;
                if (host.childElementCount > 0) {
                    loadedTabs[tabName] = true;
                    return;
                }

                const controller = new AbortController();
                pendingTabAbortControllers.set(tabName, controller);
                const loadPromise = (async () => {
                    const response = await fetch(viewPath, { signal: controller.signal });
                    if (!response.ok) throw new Error(`Failed to load ${viewPath}`);
                    const html = await response.text();
                    if (disposed) return;

                    const latestHost = document.getElementById(targetId);
                    if (!latestHost) return;
                    if (latestHost.childElementCount > 0) {
                        loadedTabs[tabName] = true;
                        return;
                    }

                    const parsed = new DOMParser().parseFromString(html, 'text/html');
                    const rootNode = parsed.querySelector(rootSelector);
                    if (!rootNode) throw new Error(`Failed to find ${rootSelector} in ${viewPath}`);
                    latestHost.innerHTML = '';
                    latestHost.appendChild(rootNode);

                    const subviewScript = window.BTT_CODEX_SUBVIEW_SCRIPTS && window.BTT_CODEX_SUBVIEW_SCRIPTS[tabName];
                    if (subviewScript && window.loadScript) {
                        try { await window.loadScript(subviewScript); } catch (e) { console.error(`Failed to lazy-load codex sub-view script for ${tabName}:`, e); }
                        if (disposed) return;
                    }

                    loadedTabs[tabName] = true;
                    document.dispatchEvent(new CustomEvent(eventName));
                })()
                    .catch((error) => {
                        if (!disposed && error?.name !== 'AbortError') {
                            console.error(`Failed to load codex subview ${tabName}:`, error);
                        }
                    })
                    .finally(() => {
                        pendingTabAbortControllers.delete(tabName);
                        pendingTabLoads.delete(tabName);
                    });

                pendingTabLoads.set(tabName, loadPromise);
                return loadPromise;
            };

            const ensureActiveTabLoaded = async (tabName = activeTab.value) => {
                const loaders = {
                    allies: () => loadSubview('allies', 'codexes-allies-host', 'views/codexes/allies.html', '#allies-vue-app', 'allies_loaded'),
                    mounts: async () => {
                        await Promise.all([
                            loadSubview('mounts', 'codexes-mounts-host', 'views/codexes/mounts.html', '#mounts-vue-app', 'mounts_loaded'),
                            loadSubview('dragons', 'codexes-dragons-host', 'views/codexes/dragons.html', '#dragons-vue-app', 'dragons_loaded'),
                        ]);
                    },
                    dragons: async () => {
                        await Promise.all([
                            loadSubview('dragons', 'codexes-dragons-host', 'views/codexes/dragons.html', '#dragons-vue-app', 'dragons_loaded'),
                            loadSubview('mounts', 'codexes-mounts-host', 'views/codexes/mounts.html', '#mounts-vue-app', 'mounts_loaded'),
                        ]);
                    },
                    mementos: () => loadSubview('mementos', 'codexes-mementos-host', 'views/codexes/mementos.html', '#mementos-vue-app', 'mementos_loaded'),
                    recipes: () => loadSubview('recipes', 'codexes-recipes-host', 'views/codexes/recipes.html', '#recipes-vue-app', 'recipes_loaded'),
                    items: () => loadSubview('items', 'codexes-items-host', 'views/codexes/items.html', '#items-vue-app', 'items_loaded'),
                    fish: () => loadSubview('fish', 'codexes-fish-host', 'views/codexes/fish.html', '#fish-vue-app', 'fish_loaded'),
                    badges: () => loadSubview('badges', 'codexes-badges-host', 'views/codexes/badges.html', '#badges-vue-app', 'badges_loaded'),
                };
                const loader = loaders[tabName];
                if (loader) await loader();
            };

            watch([activeTab, selectedGamePath], persistState, { deep: true });
            watch(activeTab, (tabName) => {
                void ensureActiveTabLoaded(tabName);
            });


            onMounted(async () => {
                hydratingState = true;
                await restoreState();
                await scanForGames();
                if (window.pendingCodexTab) {
                    activeTab.value = window.pendingCodexTab;
                    window.pendingCodexTab = null;
                }

                window.getSelectedCodexGamePath = () => selectedGamePath.value || '';
                window.CodexGamePathApi = {
                    getState: async () => ({
                        installs: installs.value.slice(),
                        installOptions: installs.value.map(install => [install.label, install.path]),
                        selectedGamePath: selectedGamePath.value || ''
                    }),
                    refresh: async () => {
                        const state = await scanForGames(true);
                        emitGamePathChanged();
                        return state;
                    },
                    setSelectedPath: async (path) => setSelectedGamePath(path),
                    openSelectedPath: async (path = '') => openSelectedGamePath(path),
                };

                hydratingState = false;
                void ensureActiveTabLoaded(activeTab.value);
            });

            onBeforeUnmount(() => {
                disposed = true;
                pendingTabAbortControllers.forEach((controller) => {
                    try { controller.abort(); } catch {}
                });
                pendingTabAbortControllers.clear();
                pendingTabLoads.clear();
            });

            return {
                activeTab,
                loadedTabs,
                setActiveTab,
                t,
            };
        }
    });

    try {
        if (window._codexesApp) window._codexesApp.unmount();
        window._codexesApp = app;
        app.mount('#codexes-vue-app');
    } finally {
        delete root.dataset.codexesInitializing;
    }
});

// Auto-dispatch removed: window.loadView() now dispatches `codexes_loaded`
// after this script finishes loading, so the listener above is guaranteed
// to be in place when the event fires.
