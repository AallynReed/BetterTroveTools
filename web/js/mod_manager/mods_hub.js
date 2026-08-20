document.addEventListener('mods_hub_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error('Vue.js failed to load!');
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;
    const PREF_STATE_KEY = 'state_mods_hub';
    const HUB_BASE = 'https://trove.aallyn.net/mods';

    const readUiState = () => {
        const state = window.AppSettings ? window.AppSettings.getPref(PREF_STATE_KEY, {}) : {};
        return state && typeof state === 'object' ? state : {};
    };

    const app = createApp({
        setup() {
            const t = (str, p) => (window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str);
            const getLocale = () => (window.I18nManager && window.I18nManager.currentLocale
                ? window.I18nManager.currentLocale.replace('_', '-')
                : undefined);
            const formatCount = (value) => {
                const num = Number(value);
                if (!Number.isFinite(num)) return '0';
                return Math.trunc(num).toLocaleString(getLocale());
            };
            const uiState = readUiState();

            const isLoading = ref(true);
            const error = ref('');
            const mods = ref([]);

            const currentPage = ref(uiState.currentPage || 1);
            const maxPages = ref(1);

            const searchQuery = ref(uiState.searchQuery || '');
            // Always start with no category filter on a fresh app launch — a
            // persisted filter is easy to forget and can make the hub look empty.
            const selectedTag = ref('');
            const selectedSort = ref(uiState.selectedSort || 'popular');

            const categories = ref([]);
            const games = ref([]);
            const selectedGame = ref(uiState.selectedGame || '');

            const isRefreshing = ref(false);
            const isClearingCache = ref(false);

            const modal = reactive({ show: false, src: '', caption: '', pageUrl: null });
            // Variant picker — populated when a mod has more than one variant (branch).
            const variantPicker = reactive({ show: false, mod: null, name: '', variants: [], installedBranch: null, loading: false });
            const activeRequestToken = ref(0);
            const fetchResolvers = new Map();
            const installResolvers = new Map();

            const formatBytes = (bytes) => {
                const n = Number(bytes);
                if (!Number.isFinite(n) || n <= 0) return '';
                const units = ['B', 'KB', 'MB', 'GB'];
                let i = 0, v = n;
                while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
                return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
            };

            const persistUiState = () => {
                if (!window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    currentPage: currentPage.value,
                    searchQuery: searchQuery.value,
                    selectedTag: selectedTag.value,
                    selectedSort: selectedSort.value,
                    selectedGame: selectedGame.value
                });
            };

            const tagOptions = computed(() => {
                const opts = [[t('mods_hub.all_categories'), '']];
                categories.value.forEach((c) => {
                    const name = typeof c === 'string' ? c : (c && c.name);
                    if (name) opts.push([name, name]);
                });
                return opts;
            });

            const sortOptions = computed(() => [
                [t('mods_hub.sort_popular'), 'popular'],
                [t('mods_hub.sort_downloads'), 'downloads'],
                [t('mods_hub.sort_stars'), 'stars'],
                [t('mods_hub.sort_recent'), 'recent'],
                [t('mods_hub.sort_new'), 'new'],
                [t('mods_hub.sort_title'), 'title']
            ]);

            const gameOptions = computed(() => {
                if (games.value.length === 0) return [[t('mods_hub.auto_detecting'), '']];
                return games.value.map(g => [
                    t('common.name_path')
                        .replace('{name}', t(g.name))
                        .replace('{path}', g.path),
                    g.path
                ]);
            });

            const fetchMods = (page = 1, force = false, options = {}) => {
                if (isLoading.value && !force && page !== 1) return;
                if (!selectedGame.value) return;

                isLoading.value = true;
                error.value = '';

                const token = Date.now() + Math.random();
                activeRequestToken.value = token;

                eel.get_mods_hub_mods(
                    page,
                    searchQuery.value.trim(),
                    selectedTag.value,
                    selectedSort.value,
                    selectedGame.value,
                    token,
                    !!options.forceRefresh
                )();

                if (options.awaitResult) {
                    return new Promise((resolve, reject) => {
                        fetchResolvers.set(token, { resolve, reject });
                    });
                }

                const vc = document.getElementById('view-container');
                if (vc && page !== currentPage.value) vc.scrollTo({ top: 0, behavior: 'smooth' });
            };

            window._modsHubHandleMods = (response) => {
                const responseToken = response?.request_token;
                if (responseToken && responseToken !== activeRequestToken.value) {
                    const pending = fetchResolvers.get(responseToken);
                    if (pending) {
                        fetchResolvers.delete(responseToken);
                        pending.reject(new Error('Stale request'));
                    }
                    return;
                }

                if (response && response.success) {
                    mods.value = (response.mods || []).map(m => ({
                        ...m,
                        is_installing: false,
                        is_deleting: false
                    }));
                    currentPage.value = response.page;
                    maxPages.value = response.max_pages;
                    error.value = '';
                } else {
                    mods.value = [];
                    error.value = response?.error || t('common.unknown_error_occurred');
                }
                isLoading.value = false;

                const pending = fetchResolvers.get(responseToken);
                if (pending) {
                    fetchResolvers.delete(responseToken);
                    if (response?.success) pending.resolve(response);
                    else pending.reject(new Error(response?.error || 'Failed to load mods'));
                }
            };

            window._modsHubHandleInstall = (response) => {
                const responseRef = String(response?.ref ?? '').trim();
                const targetMod = mods.value.find(m => String(m.ref ?? '').trim() === responseRef);

                if (targetMod) {
                    targetMod.is_installing = false;
                    if (response.success) {
                        targetMod.is_installed = true;
                        targetMod.needs_update = false;
                        if (response.branch) targetMod.installed_branch = response.branch;
                    }
                }

                const pending = installResolvers.get(responseRef);
                if (pending) {
                    installResolvers.delete(responseRef);
                    if (response.success) pending.resolve(response);
                    else pending.reject(new Error(response?.error || 'Install failed'));
                }

                if (response.success) {
                    window.showToast(t('common.installed'));
                } else {
                    window.showToast(t('mods_hub.error_error').replace('{error}', response?.error || t('common.unknown_error_occurred')), true);
                }
            };

            const runInstall = async (mod, branch = null) => {
                const ref = String(mod.ref);
                const fire = (resolve, reject) => {
                    installResolvers.set(ref, { resolve, reject });
                    // branch null -> newest overall; set -> that variant.
                    eel.install_mods_hub_mod(selectedGame.value, mod.ref, branch || null)();
                };
                mod.is_installing = true;
                try {
                    await window.JobQueue.run({
                        label: mod.needs_update
                            ? t("common.update_mod_name").replace('{name}', mod.name)
                            : t("mods_hub.install_mod_name").replace('{name}', mod.name),
                        task: async () => new Promise(fire),
                        retryTask: async () => new Promise(fire)
                    });
                } catch {
                    mod.is_installing = false;
                }
            };

            // Entry point for the card's Install/Update button.
            //  - installed + outdated -> update in place on the SAME variant
            //  - otherwise -> resolve the mod's variants; one variant installs
            //    straight away, several open the picker.
            const installMod = async (mod) => {
                if (mod.is_installing) return;
                if (!selectedGame.value) {
                    window.showToast(t('mods_hub.could_not_detect_game'), true);
                    return;
                }
                if (mod.is_installed && mod.needs_update) {
                    await runInstall(mod, mod.installed_branch || null);
                    return;
                }
                if (mod.is_installed && !mod.needs_update) return;
                await chooseVariant(mod);
            };

            const fetchVariants = async (mod) => {
                const resp = await window.callBackend(eel.get_mods_hub_variants(mod.ref)(), 'Failed to load variants');
                if (!resp.success) {
                    window.showToast(t('mods_hub.error_error').replace('{error}', resp.error || t('common.unknown_error_occurred')), true);
                    return null;
                }
                return resp.data?.variants || resp.raw?.variants || [];
            };

            // Resolve variants, then either install the only one or open the picker.
            // `force` always opens the picker (used by the "Choose variant" action).
            const chooseVariant = async (mod, { force = false } = {}) => {
                if (mod.is_installing) return;
                if (!selectedGame.value) {
                    window.showToast(t('mods_hub.could_not_detect_game'), true);
                    return;
                }
                mod.is_installing = true;
                let variants;
                try {
                    variants = await fetchVariants(mod);
                } finally {
                    mod.is_installing = false;
                }
                if (!variants) return;
                if (variants.length === 0) {
                    window.showToast(t('mods_hub.no_releases'), true);
                    return;
                }
                if (variants.length === 1 && !force) {
                    await runInstall(mod, variants[0].branch);
                    return;
                }
                variantPicker.mod = mod;
                variantPicker.name = mod.name;
                variantPicker.variants = variants;
                variantPicker.installedBranch = mod.is_installed ? (mod.installed_branch || null) : null;
                variantPicker.show = true;
            };

            const installVariant = async (branch) => {
                const mod = variantPicker.mod;
                variantPicker.show = false;
                if (mod) await runInstall(mod, branch);
            };

            const closeVariantPicker = () => {
                variantPicker.show = false;
                variantPicker.mod = null;
                variantPicker.variants = [];
            };

            const deleteInstalledMod = async (mod) => {
                if (mod.is_deleting) return;
                if (!mod.is_installed) {
                    window.showToast(t('mods_hub.this_mod_is_not_installed'), true);
                    return;
                }
                if (!selectedGame.value) {
                    window.showToast(t('mods_hub.select_game_first'), true);
                    return;
                }

                const confirmed = await window.showConfirmModal({
                    title: t('common.delete_mod'),
                    message: t("common.are_you_sure_you_want_to_permanently_del_7a0256").replace('{name}', mod.name),
                    confirmLabel: t('common.delete'),
                    cancelLabel: t('common.cancel'),
                    danger: true
                });
                if (!confirmed) return;

                mod.is_deleting = true;
                const response = await window.JobQueue.run({
                    label: t("common.delete_mod_name").replace('{name}', mod.name),
                    task: async () => window.callBackend(
                        eel.delete_mods_hub_installed_mod(selectedGame.value, mod.ref)(),
                        'Failed to delete installed mod'
                    ),
                    retryTask: async () => window.callBackend(
                        eel.delete_mods_hub_installed_mod(selectedGame.value, mod.ref)(),
                        'Failed to delete installed mod'
                    )
                });
                mod.is_deleting = false;

                if (!response.success) {
                    window.showToast(t('common.failed_to_delete_mod_error').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                    return;
                }

                const undoToken = response.data.undo_token || response.raw?.undo_token;
                mod.is_installed = false;
                mod.needs_update = false;

                if (undoToken) {
                    window.showUndoToast(
                        t("common.deleted_name").replace('{name}', mod.name),
                        8,
                        async () => {
                            const undoResp = await window.callBackend(eel.undo_delete_mod(undoToken)(), 'Failed to undo delete');
                            if (!undoResp.success) {
                                window.showToast(t('common.undo_failed_error').replace('{error}', undoResp.error || t('common.unknown_error_occurred')), true);
                                return;
                            }
                            mod.is_installed = true;
                            window.showToast(t('common.deletion_undone'));
                        }
                    );
                } else {
                    window.showToast(t("common.deleted_name").replace('{name}', mod.name));
                }
            };

            const refreshMods = async () => {
                if (!selectedGame.value) return;
                isRefreshing.value = true;
                try {
                    await window.JobQueue.run({
                        label: t('mods_hub.refresh_results'),
                        task: async () => {
                            await fetchMods(currentPage.value, true, { awaitResult: true, forceRefresh: true });
                        },
                        retryTask: async () => {
                            await fetchMods(currentPage.value, true, { awaitResult: true, forceRefresh: true });
                        }
                    });
                    window.showToast(t('mods_hub.refreshed_results'));
                } finally {
                    isRefreshing.value = false;
                }
            };

            const clearCache = async () => {
                const confirmed = await window.showConfirmModal({
                    title: t('common.clear_cache'),
                    message: t('mods_hub.clear_cache_confirm'),
                    confirmLabel: t('common.clear'),
                    cancelLabel: t('common.cancel'),
                    danger: false
                });
                if (!confirmed) return;

                isClearingCache.value = true;
                try {
                    const response = await window.JobQueue.run({
                        label: t('mods_hub.clear_cache'),
                        task: async () => window.callBackend(eel.clear_mods_hub_cache()(), 'Failed to clear cache'),
                        retryTask: async () => window.callBackend(eel.clear_mods_hub_cache()(), 'Failed to clear cache')
                    });
                    if (!response.success) {
                        window.showToast(t('common.failed_to_clear_cache_error').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                    } else {
                        window.showToast(t('mods_hub.cache_cleared'));
                        fetchMods(1, true);
                    }
                } finally {
                    isClearingCache.value = false;
                }
            };

            const openSelectedGameFolder = async () => {
                if (!selectedGame.value) {
                    window.showToast(t('common.no_path_selected'), true);
                    return;
                }
                const response = await eel.open_path_in_explorer(selectedGame.value)();
                if (!response || !response.success) {
                    window.showToast(t('common.failed_to_open_folder_error').replace('{error}', response?.error || t('common.unknown_error_occurred')), true);
                }
            };

            const openUrl = (url) => eel.open_url_in_browser(url)();

            // The author's hub page: trove.aallyn.net/mods/<handle>.
            const authorUrl = (mod) => {
                const handle = String(mod && mod.handle || '').trim();
                return handle ? `${HUB_BASE}/${encodeURIComponent(handle)}` : HUB_BASE;
            };

            const showContextMenu = (e, mod) => {
                if (!window.ContextMenu) return;
                const items = [];

                if (!mod.is_installed || mod.needs_update) {
                    items.push({
                        label: mod.needs_update ? 'Update Mod' : 'Install Mod',
                        icon: mod.needs_update ? 'fa-rotate' : 'fa-download',
                        action: () => installMod(mod)
                    });
                }
                // Always offer the variant chooser — lets an installed user switch
                // variants, and a not-yet-installed user preview the options.
                items.push({
                    label: mod.is_installed ? 'Switch Variant…' : 'Choose Variant…',
                    icon: 'fa-code-branch',
                    action: () => chooseVariant(mod, { force: true })
                });
                items.push({ separator: true });

                items.push({ label: 'View in Mod Hub', icon: 'fa-arrow-up-right-from-square', action: () => openUrl(mod.page_url) });
                items.push({ label: 'Copy Mod Name', icon: 'fa-copy', action: () => navigator.clipboard.writeText(mod.name).then(() => window.showToast(t('common.copied_to_clipboard'))) });
                window.ContextMenu.show(e, items);
            };

            const openImageModal = (mod) => {
                if (mod.image) {
                    modal.src = mod.image;
                    modal.caption = mod.name;
                    modal.pageUrl = mod.page_url;
                    modal.show = true;
                }
            };

            const closeImageModal = () => {
                modal.show = false;
                setTimeout(() => {
                    modal.src = '';
                }, 200);
            };

            watch([selectedTag, selectedSort], () => {
                currentPage.value = 1;
                fetchMods(1, true);
            });

            watch([searchQuery, selectedTag, selectedSort, currentPage, selectedGame], persistUiState);

            // A `btt://mods` deep link (a mod page on the site handing off to the
            // app) parks the mod's title in window.pendingSearch and switches to
            // this tab. main.js can't fill the box for us — this tab is lazy, so on
            // a cold link the app isn't mounted yet — so we claim it ourselves.
            const applyPendingSearch = () => {
                if (!window.pendingSearch) return false;
                searchQuery.value = window.pendingSearch;
                window.pendingSearch = null;
                currentPage.value = 1;
                return true;
            };

            // Re-entry: a second link while the tab is already built. `_shown` covers
            // arriving from another view, `section_changed` a switch in place.
            const onReentry = () => {
                if (window.getModManagerSection && window.getModManagerSection() !== 'mods_hub') return;
                if (applyPendingSearch()) fetchMods(1, true);
            };
            document.addEventListener('mod_manager_shown', onReentry);
            document.addEventListener('mod_manager_section_changed', (e) => {
                if (e.detail?.currentSection === 'mods_hub') onReentry();
            });

            const loadCategories = async () => {
                try {
                    const resp = await window.callBackend(eel.get_mods_hub_categories()(), 'Failed to load categories');
                    const cats = resp.data?.categories || resp.raw?.categories || [];
                    if (Array.isArray(cats)) categories.value = cats;
                } catch {
                    categories.value = [];
                }
            };

            onMounted(async () => {
                // Before the first fetch below, so a deep-linked search rides along
                // with it instead of costing a second round trip.
                applyPendingSearch();
                loadCategories();
                const response = await window.callBackend(eel.get_detected_game_paths()(), 'Failed to detect game paths');
                const settingsResp = await window.callBackend(eel.get_settings()(), 'Failed to load settings');
                const settings = settingsResp.data || settingsResp.raw || {};
                const paths = response.data.paths || response.raw?.paths || [];

                if (paths.length > 0) {
                    games.value = paths;
                    const lastPath = selectedGame.value || settings.last_game_path;
                    if (lastPath && paths.some(p => p.path === lastPath)) {
                        selectedGame.value = lastPath;
                    } else {
                        const liveInstall = paths.find(p => p.name.toLowerCase().includes('live'));
                        selectedGame.value = liveInstall ? liveInstall.path : paths[0].path;
                    }
                } else if (!response.success && response.error) {
                    window.showToast(t('common.game_path_detection_failed_error').replace('{error}', response.error), true);
                }

                watch(selectedGame, async (newVal) => {
                    if (!newVal) return;
                    const latestSettingsResp = await window.callBackend(eel.get_settings()(), 'Failed to load settings');
                    const latestSettings = latestSettingsResp.data || latestSettingsResp.raw || {};
                    latestSettings.last_game_path = newVal;
                    await eel.save_settings(latestSettings)();
                    fetchMods(1, true);
                });

                if (selectedGame.value) fetchMods(currentPage.value || 1, true);
                nextTick(() => {
                    if (window.applyCustomDropdowns) window.applyCustomDropdowns();
                });
            });

            return {
                t,
                hubBase: HUB_BASE,
                isLoading,
                error,
                mods,
                currentPage,
                maxPages,
                searchQuery,
                selectedTag,
                selectedSort,
                selectedGame,
                tagOptions,
                sortOptions,
                gameOptions,
                isRefreshing,
                isClearingCache,
                modal,
                openImageModal,
                closeImageModal,
                fetchMods,
                refreshMods,
                clearCache,
                openSelectedGameFolder,
                installMod,
                chooseVariant,
                installVariant,
                closeVariantPicker,
                variantPicker,
                formatBytes,
                deleteInstalledMod,
                openUrl,
                authorUrl,
                showContextMenu,
                formatCount
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);

    if (window._modsHubApp) window._modsHubApp.unmount();
    window._modsHubApp = app;
    app.mount('#mods-hub-vue-app');
});

eel.expose(receive_mods_hub_mods, 'receive_mods_hub_mods');
function receive_mods_hub_mods(response) {
    if (window._modsHubHandleMods) window._modsHubHandleMods(response);
}

eel.expose(receive_mods_hub_install_result, 'receive_mods_hub_install_result');
function receive_mods_hub_install_result(response) {
    if (window._modsHubHandleInstall) window._modsHubHandleInstall(response);
}
