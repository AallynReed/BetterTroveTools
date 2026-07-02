document.addEventListener('trovesaurus_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error('Vue.js failed to load!');
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;
    const PREF_STATE_KEY = 'state_trovesaurus';
    const PREF_HUB_PROMO_KEY = 'promo_mods_hub_from_trovesaurus_v1';

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
            const selectedCategory = ref(uiState.selectedCategory || '');
            const selectedSort = ref(uiState.selectedSort || 'hot');

            const games = ref([]);
            const selectedGame = ref(uiState.selectedGame || '');

            const isRefreshing = ref(false);
            const isClearingCache = ref(false);

            const modal = reactive({ show: false, src: '', caption: '', modId: null });

            // Mods Hub promo: nudge Trovesaurus browsers toward the first-party hub.
            // Shows once per app launch until permanently dismissed. "Don't show
            // again" persists; "Maybe later" only hides it for this session so the
            // nudge keeps surfacing on future launches.
            const hubPromo = reactive({ show: false });
            const goToModsHub = () => {
                hubPromo.show = false;
                if (window.setModManagerSection) window.setModManagerSection('mods_hub');
            };
            const dismissHubPromo = () => { hubPromo.show = false; };
            const dismissHubPromoForever = () => {
                hubPromo.show = false;
                if (window.AppSettings) window.AppSettings.setPrefSync(PREF_HUB_PROMO_KEY, 'dismissed');
            };

            const activeRequestToken = ref(0);
            const fetchResolvers = new Map();
            const installResolvers = new Map();

            const persistUiState = () => {
                if (!window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    currentPage: currentPage.value,
                    searchQuery: searchQuery.value,
                    selectedCategory: selectedCategory.value,
                    selectedSort: selectedSort.value,
                    selectedGame: selectedGame.value
                });
            };

            const categoryOptions = computed(() => [
                [t('trovesaurus.all_categories'), ''],
                [t('UI & HUD'), 'ui'],
                [t('trovesaurus.vfx'), 'vfx'],
                [t('common.mounts'), 'mount'],
                [t('common.allies'), 'ally'],
                [t('trovesaurus.costumes'), 'costume'],
                [t('common.dragons'), 'dragon']
            ]);

            const sortOptions = computed(() => [
                [t('trovesaurus.hot_mods_default'), 'hot'],
                [t('trovesaurus.most_liked'), 'likes_desc'],
                [t('trovesaurus.most_downloaded'), 'downloads_desc'],
                [t('trovesaurus.newest_first'), 'date_desc'],
                [t('trovesaurus.oldest_first'), 'date_asc']
            ]);

            const gameOptions = computed(() => {
                if (games.value.length === 0) return [[t('trovesaurus.auto_detecting'), '']];
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

                eel.get_trovesaurus_mods(
                    page,
                    searchQuery.value.trim(),
                    selectedCategory.value,
                    selectedSort.value,
                    selectedGame.value,
                    token
                )();

                if (options.awaitResult) {
                    return new Promise((resolve, reject) => {
                        fetchResolvers.set(token, { resolve, reject });
                    });
                }

                const vc = document.getElementById('view-container');
                if (vc && page !== currentPage.value) vc.scrollTo({ top: 0, behavior: 'smooth' });
            };

            window._tsAppHandleMods = (response) => {
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
                    else pending.reject(new Error(response?.error || 'Failed to load Trovesaurus mods'));
                }
            };

            window._tsAppHandleInstall = (response) => {
                const responseId = String(response?.mod_id ?? '').trim();
                const targetMod = mods.value.find(m => String(m.id ?? '').trim() === responseId);

                if (targetMod) {
                    targetMod.is_installing = false;
                    if (response.success) {
                        targetMod.is_installed = true;
                        targetMod.needs_update = false;
                    }
                }

                const pending = installResolvers.get(responseId);
                if (pending) {
                    installResolvers.delete(responseId);
                    if (response.success) pending.resolve(response);
                    else pending.reject(new Error(response?.error || 'Install failed'));
                }

                if (response.success) {
                    window.showToast(t('common.installed'));
                } else {
                    window.showToast(t('trovesaurus.error_error').replace('{error}', response?.error || t('common.unknown_error_occurred')), true);
                }
            };

            const runInstallJob = async (mod) => {
                const modId = String(mod.id);
                await window.JobQueue.run({
                    label: mod.needs_update
                        ? t("common.update_mod_name").replace('{name}', mod.name)
                        : t("trovesaurus.install_mod_name").replace('{name}', mod.name),
                    task: async () => {
                        await new Promise((resolve, reject) => {
                            installResolvers.set(modId, { resolve, reject });
                            eel.install_trovesaurus_mod(selectedGame.value, mod.id)();
                        });
                    },
                    retryTask: async () => {
                        await new Promise((resolve, reject) => {
                            installResolvers.set(modId, { resolve, reject });
                            eel.install_trovesaurus_mod(selectedGame.value, mod.id)();
                        });
                    }
                });
            };

            const installMod = async (mod) => {
                if (mod.is_installing || (mod.is_installed && !mod.needs_update)) return;
                if (!selectedGame.value) {
                    window.showToast(t('trovesaurus.could_not_automatically_detect_your_trov_34717f'), true);
                    return;
                }

                mod.is_installing = true;
                try {
                    await runInstallJob(mod);
                } catch {
                    mod.is_installing = false;
                }
            };

            const deleteInstalledMod = async (mod) => {
                if (mod.is_deleting) return;
                if (!mod.is_installed) {
                    window.showToast(t('trovesaurus.this_mod_is_not_installed'), true);
                    return;
                }
                if (!selectedGame.value) {
                    window.showToast(t('trovesaurus.select_a_game_installation_first'), true);
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
                        eel.delete_trovesaurus_installed_mod(selectedGame.value, mod.id)(),
                        'Failed to delete installed mod'
                    ),
                    retryTask: async () => window.callBackend(
                        eel.delete_trovesaurus_installed_mod(selectedGame.value, mod.id)(),
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
                        label: t('trovesaurus.refresh_trovesaurus_results'),
                        task: async () => {
                            await fetchMods(currentPage.value, true, { awaitResult: true });
                        },
                        retryTask: async () => {
                            await fetchMods(currentPage.value, true, { awaitResult: true });
                        }
                    });
                    window.showToast(t('trovesaurus.refreshed_trovesaurus_results'));
                } finally {
                    isRefreshing.value = false;
                }
            };

            const clearCache = async () => {
                const confirmed = await window.showConfirmModal({
                    title: t('common.clear_cache'),
                    message: t('trovesaurus.clear_trovesaurus_cache_and_reload'),
                    confirmLabel: t('common.clear'),
                    cancelLabel: t('common.cancel'),
                    danger: false
                });
                if (!confirmed) return;

                isClearingCache.value = true;
                try {
                    const response = await window.JobQueue.run({
                        label: t('common.clear_trovesaurus_cache'),
                        task: async () => window.callBackend(eel.clear_trovesaurus_cache()(), 'Failed to clear Trovesaurus cache'),
                        retryTask: async () => window.callBackend(eel.clear_trovesaurus_cache()(), 'Failed to clear Trovesaurus cache')
                    });
                    if (!response.success) {
                        window.showToast(t('common.failed_to_clear_cache_error').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                    } else {
                        window.showToast(t('trovesaurus.trovesaurus_cache_cleared'));
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

            const showContextMenu = (e, mod) => {
                if (!window.ContextMenu) return;
                const items = [];

                if (!mod.is_installed || mod.needs_update) {
                    items.push({
                        label: mod.needs_update ? 'Update Mod' : 'Install Mod',
                        icon: mod.needs_update ? 'fa-rotate' : 'fa-download',
                        action: () => installMod(mod)
                    });
                    items.push({ separator: true });
                }

                items.push({ label: 'View on Trovesaurus', icon: 'fa-arrow-up-right-from-square', action: () => openUrl(`https://trovesaurus.com/mod=${mod.id}`) });
                items.push({ label: 'Copy Mod Name', icon: 'fa-copy', action: () => navigator.clipboard.writeText(mod.name).then(() => window.showToast(t('common.copied_to_clipboard'))) });
                window.ContextMenu.show(e, items);
            };

            const openImageModal = (mod) => {
                if (mod.image) {
                    modal.src = mod.image;
                    modal.caption = mod.name;
                    modal.modId = mod.id;
                    modal.show = true;
                }
            };

            const closeImageModal = () => {
                modal.show = false;
                setTimeout(() => {
                    modal.src = '';
                }, 200);
            };

            watch([selectedCategory, selectedSort], () => {
                currentPage.value = 1;
                fetchMods(1, true);
            });

            watch([searchQuery, selectedCategory, selectedSort, currentPage, selectedGame], persistUiState);

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
                    fetchMods(1, true);
                });

                if (selectedGame.value) fetchMods(currentPage.value || 1, true);
                nextTick(() => {
                    if (window.applyCustomDropdowns) window.applyCustomDropdowns();
                });

                // Surface the Mods Hub nudge shortly after the tab settles, unless
                // the user has opted out for good.
                const promoDismissed = window.AppSettings
                    ? window.AppSettings.getPref(PREF_HUB_PROMO_KEY, '') === 'dismissed'
                    : false;
                if (!promoDismissed) {
                    setTimeout(() => { hubPromo.show = true; }, 600);
                }
            });

            return {
                t,
                isLoading,
                error,
                mods,
                currentPage,
                maxPages,
                searchQuery,
                selectedCategory,
                selectedSort,
                selectedGame,
                categoryOptions,
                sortOptions,
                gameOptions,
                isRefreshing,
                isClearingCache,
                modal,
                hubPromo,
                goToModsHub,
                dismissHubPromo,
                dismissHubPromoForever,
                openImageModal,
                closeImageModal,
                fetchMods,
                refreshMods,
                clearCache,
                openSelectedGameFolder,
                installMod,
                deleteInstalledMod,
                openUrl,
                showContextMenu,
                formatCount
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);

    if (window._trovesaurusApp) window._trovesaurusApp.unmount();
    window._trovesaurusApp = app;
    app.mount('#trovesaurus-vue-app');
});

eel.expose(receive_trovesaurus_mods, 'receive_trovesaurus_mods');
function receive_trovesaurus_mods(response) {
    if (window._tsAppHandleMods) window._tsAppHandleMods(response);
}

eel.expose(receive_install_result, 'receive_install_result');
function receive_install_result(response) {
    if (window._tsAppHandleInstall) window._tsAppHandleInstall(response);
}
