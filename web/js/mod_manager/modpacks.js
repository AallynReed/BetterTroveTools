document.addEventListener('modpacks_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error('Vue.js failed to load!');
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;
    const PREF_STATE_KEY = 'state_modpacks';
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
            const modpacks = ref([]);

            const currentPage = ref(uiState.currentPage || 1);
            const maxPages = ref(1);

            const searchQuery = ref(uiState.searchQuery || '');
            const selectedSort = ref(uiState.selectedSort || 'recent');

            const games = ref([]);
            const selectedGame = ref(uiState.selectedGame || '');

            const isRefreshing = ref(false);

            const modal = reactive({ show: false, src: '', caption: '', pageUrl: null });
            const variantPicker = reactive({ show: false, pack: null, name: '', variants: [] });
            const activeRequestToken = ref(0);
            const fetchResolvers = new Map();

            const persistUiState = () => {
                if (!window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    currentPage: currentPage.value,
                    searchQuery: searchQuery.value,
                    selectedSort: selectedSort.value,
                    selectedGame: selectedGame.value
                });
            };

            const sortOptions = computed(() => [
                [t('modpacks.sort_recent'), 'recent'],
                [t('modpacks.sort_downloads'), 'downloads'],
                [t('modpacks.sort_new'), 'new'],
                [t('modpacks.sort_title'), 'title']
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

            const authorUrl = (pack) => {
                const handle = String(pack && pack.handle || '').trim();
                return handle ? `${HUB_BASE}/${encodeURIComponent(handle)}` : HUB_BASE;
            };

            const fetchModpacks = (page = 1, force = false, options = {}) => {
                if (isLoading.value && !force && page !== 1) return;

                isLoading.value = true;
                error.value = '';

                const token = Date.now() + Math.random();
                activeRequestToken.value = token;

                eel.get_modpacks(page, searchQuery.value.trim(), selectedSort.value, token)();

                if (options.awaitResult) {
                    return new Promise((resolve, reject) => {
                        fetchResolvers.set(token, { resolve, reject });
                    });
                }

                const vc = document.getElementById('view-container');
                if (vc && page !== currentPage.value) vc.scrollTo({ top: 0, behavior: 'smooth' });
            };

            window._modpacksHandleList = (response) => {
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
                    modpacks.value = (response.modpacks || []).map(m => ({ ...m, is_installing: false }));
                    currentPage.value = response.page;
                    maxPages.value = response.max_pages;
                    error.value = '';
                } else {
                    modpacks.value = [];
                    error.value = response?.error || t('common.unknown_error_occurred');
                }
                isLoading.value = false;

                const pending = fetchResolvers.get(responseToken);
                if (pending) {
                    fetchResolvers.delete(responseToken);
                    if (response?.success) pending.resolve(response);
                    else pending.reject(new Error(response?.error || 'Failed to load modpacks'));
                }
            };

            // Download + decompile + install. `variant` null = the pack's default.
            const runInstall = async (pack, variant) => {
                if (!selectedGame.value) {
                    window.showToast(t('mods_hub.could_not_detect_game'), true);
                    return;
                }
                pack.is_installing = true;
                try {
                    const response = await window.JobQueue.run({
                        label: t('modpacks.installing_pack').replace('{name}', pack.name),
                        task: async () => window.callBackend(eel.install_modpack(selectedGame.value, pack.handle, pack.slug, variant || null)(), 'Failed to install modpack'),
                        retryTask: async () => window.callBackend(eel.install_modpack(selectedGame.value, pack.handle, pack.slug, variant || null)(), 'Failed to install modpack')
                    });
                    if (!response.success) {
                        window.showToast(t('mods_hub.error_error').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                        return;
                    }
                    const installed = response.data?.installed ?? response.raw?.installed ?? 0;
                    const quarantined = response.data?.quarantined ?? response.raw?.quarantined ?? [];
                    if (quarantined.length) {
                        window.showToast(t('modpacks.installed_with_quarantine')
                            .replace('{count}', installed)
                            .replace('{disabled}', quarantined.length));
                    } else {
                        window.showToast(t('modpacks.installed_summary').replace('{count}', installed));
                    }
                } finally {
                    pack.is_installing = false;
                }
            };

            // Resolve variants, then install the only one or open the picker.
            const chooseVariant = async (pack, { force = false } = {}) => {
                if (pack.is_installing) return;
                if (!selectedGame.value) {
                    window.showToast(t('mods_hub.could_not_detect_game'), true);
                    return;
                }
                pack.is_installing = true;
                let variants;
                try {
                    const resp = await window.callBackend(eel.get_modpack_variants(pack.handle, pack.slug)(), 'Failed to load variants');
                    if (!resp.success) {
                        window.showToast(t('mods_hub.error_error').replace('{error}', resp.error || t('common.unknown_error_occurred')), true);
                        return;
                    }
                    variants = resp.data?.variants || resp.raw?.variants || [];
                } finally {
                    pack.is_installing = false;
                }
                if (!variants.length) {
                    window.showToast(t('modpacks.empty'), true);
                    return;
                }
                if (variants.length === 1 && !force) {
                    await runInstall(pack, variants[0].name);
                    return;
                }
                variantPicker.pack = pack;
                variantPicker.name = pack.name;
                variantPicker.variants = variants;
                variantPicker.show = true;
            };

            // Entry point for the card's Install button.
            const installModpack = async (pack) => {
                if (pack.is_installing) return;
                if (!selectedGame.value) {
                    window.showToast(t('mods_hub.could_not_detect_game'), true);
                    return;
                }
                if ((pack.variant_count || 1) <= 1) {
                    await runInstall(pack, pack.default_variant || null);
                    return;
                }
                await chooseVariant(pack);
            };

            const installVariant = async (variantName) => {
                const pack = variantPicker.pack;
                variantPicker.show = false;
                if (pack) await runInstall(pack, variantName);
            };

            const closeVariantPicker = () => {
                variantPicker.show = false;
                variantPicker.pack = null;
                variantPicker.variants = [];
            };

            const refreshModpacks = async () => {
                isRefreshing.value = true;
                try {
                    await window.JobQueue.run({
                        label: t('modpacks.refresh_results'),
                        task: async () => { await fetchModpacks(currentPage.value, true, { awaitResult: true }); },
                        retryTask: async () => { await fetchModpacks(currentPage.value, true, { awaitResult: true }); }
                    });
                    window.showToast(t('modpacks.refreshed_results'));
                } finally {
                    isRefreshing.value = false;
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

            const showContextMenu = (e, pack) => {
                if (!window.ContextMenu) return;
                const items = [{ label: 'Install Modpack', icon: 'fa-download', action: () => installModpack(pack) }];
                if ((pack.variant_count || 1) > 1) {
                    items.push({ label: 'Choose Variant…', icon: 'fa-box-open', action: () => chooseVariant(pack, { force: true }) });
                }
                items.push({ separator: true });
                items.push({ label: 'View in Modpacks Hub', icon: 'fa-arrow-up-right-from-square', action: () => openUrl(pack.page_url) });
                items.push({ label: 'Copy Modpack Name', icon: 'fa-copy', action: () => navigator.clipboard.writeText(pack.name).then(() => window.showToast(t('common.copied_to_clipboard'))) });
                window.ContextMenu.show(e, items);
            };

            const openImageModal = (pack) => {
                if (pack.image) {
                    modal.src = pack.image;
                    modal.caption = pack.name;
                    modal.pageUrl = pack.page_url;
                    modal.show = true;
                }
            };

            const closeImageModal = () => {
                modal.show = false;
                setTimeout(() => { modal.src = ''; }, 200);
            };

            watch([selectedSort], () => {
                currentPage.value = 1;
                fetchModpacks(1, true);
            });

            watch([searchQuery, selectedSort, currentPage, selectedGame], persistUiState);

            onMounted(async () => {
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
                });

                fetchModpacks(currentPage.value || 1, true);
                nextTick(() => {
                    if (window.applyCustomDropdowns) window.applyCustomDropdowns();
                });
            });

            return {
                t,
                isLoading,
                error,
                modpacks,
                currentPage,
                maxPages,
                searchQuery,
                selectedSort,
                selectedGame,
                sortOptions,
                gameOptions,
                isRefreshing,
                modal,
                variantPicker,
                openImageModal,
                closeImageModal,
                fetchModpacks,
                refreshModpacks,
                openSelectedGameFolder,
                installModpack,
                chooseVariant,
                installVariant,
                closeVariantPicker,
                openUrl,
                authorUrl,
                showContextMenu,
                formatCount
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);

    if (window._modpacksApp) window._modpacksApp.unmount();
    window._modpacksApp = app;
    app.mount('#modpacks-vue-app');
});

eel.expose(receive_modpacks, 'receive_modpacks');
function receive_modpacks(response) {
    if (window._modpacksHandleList) window._modpacksHandleList(response);
}
