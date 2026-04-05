document.addEventListener('trovesaurus_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error('Vue.js failed to load!');
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;
    const PREF_STATE_KEY = 'state_trovesaurus';

    const readUiState = () => {
        const state = window.AppSettings ? window.AppSettings.getPref(PREF_STATE_KEY, {}) : {};
        return state && typeof state === 'object' ? state : {};
    };

    const app = createApp({
        setup() {
            const t = (str) => (window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str);
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
            const activeRequestToken = ref(0);
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
                [t('All Categories'), ''],
                [t('UI & HUD'), 'ui'],
                [t('VFX'), 'vfx'],
                [t('Mounts'), 'mount'],
                [t('Allies'), 'ally'],
                [t('Costumes'), 'costume'],
                [t('Dragons'), 'dragon']
            ]);

            const sortOptions = computed(() => [
                [t('Hot Mods (Default)'), 'hot'],
                [t('Most Liked'), 'likes_desc'],
                [t('Most Downloaded'), 'downloads_desc'],
                [t('Newest First'), 'date_desc'],
                [t('Oldest First'), 'date_asc']
            ]);

            const gameOptions = computed(() => {
                if (games.value.length === 0) return [[t('Auto-detecting...'), '']];
                return games.value.map(g => [`${g.name} - ${g.path}`, g.path]);
            });

            const fetchMods = (page = 1, force = false) => {
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

                const vc = document.getElementById('view-container');
                if (vc && page !== currentPage.value) vc.scrollTo({ top: 0, behavior: 'smooth' });
            };

            window._tsAppHandleMods = (response) => {
                if (response?.request_token && response.request_token !== activeRequestToken.value) {
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
                    error.value = response?.error || t('Unknown error occurred');
                }
                isLoading.value = false;
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
                    window.showToast(t('Installed'));
                } else {
                    window.showToast(t('Error: {error}').replace('{error}', response?.error || t('Unknown error occurred')), true);
                }
            };

            const runInstallJob = async (mod) => {
                const modId = String(mod.id);
                await window.JobQueue.run({
                    label: mod.needs_update
                        ? t("Update mod '{name}'").replace('{name}', mod.name)
                        : t("Install mod '{name}'").replace('{name}', mod.name),
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
                    window.showToast(t('Could not automatically detect your Trove installation folder! Please check your game install.'), true);
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
                    window.showToast(t('This mod is not installed.'), true);
                    return;
                }
                if (!selectedGame.value) {
                    window.showToast(t('Select a game installation first.'), true);
                    return;
                }

                const confirmed = await window.showConfirmModal({
                    title: t('Delete Mod'),
                    message: t("Are you sure you want to permanently delete '{name}'?").replace('{name}', mod.name),
                    confirmLabel: t('Delete'),
                    cancelLabel: t('Cancel'),
                    danger: true
                });
                if (!confirmed) return;

                mod.is_deleting = true;
                const response = await window.callBackend(
                    eel.delete_trovesaurus_installed_mod(selectedGame.value, mod.id)(),
                    'Failed to delete installed mod'
                );
                mod.is_deleting = false;

                if (!response.success) {
                    window.showToast(t('Failed to delete mod: {error}').replace('{error}', response.error || t('Unknown error occurred')), true);
                    return;
                }

                const undoToken = response.data.undo_token || response.raw?.undo_token;
                mod.is_installed = false;
                mod.needs_update = false;

                if (undoToken) {
                    window.showUndoToast(
                        t("Deleted '{name}'").replace('{name}', mod.name),
                        8,
                        async () => {
                            const undoResp = await window.callBackend(eel.undo_delete_mod(undoToken)(), 'Failed to undo delete');
                            if (!undoResp.success) {
                                window.showToast(t('Undo failed: {error}').replace('{error}', undoResp.error || t('Unknown error occurred')), true);
                                return;
                            }
                            mod.is_installed = true;
                            window.showToast(t('Deletion undone.'));
                        }
                    );
                } else {
                    window.showToast(t("Deleted '{name}'").replace('{name}', mod.name));
                }
            };

            const refreshMods = async () => {
                if (!selectedGame.value) return;
                isRefreshing.value = true;
                fetchMods(currentPage.value, true);
                isRefreshing.value = false;
            };

            const clearCache = async () => {
                const confirmed = await window.showConfirmModal({
                    title: t('Clear Cache'),
                    message: t('Clear Trovesaurus cache and reload?'),
                    confirmLabel: t('Clear'),
                    cancelLabel: t('Cancel'),
                    danger: false
                });
                if (!confirmed) return;

                isClearingCache.value = true;
                const response = await window.callBackend(eel.clear_trovesaurus_cache()(), 'Failed to clear Trovesaurus cache');
                if (!response.success) {
                    window.showToast(t('Failed to clear cache: {error}').replace('{error}', response.error || t('Unknown error occurred')), true);
                } else {
                    window.showToast(t('Cache cleared.'));
                    fetchMods(1, true);
                }
                isClearingCache.value = false;
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
                items.push({ label: 'Copy Mod Name', icon: 'fa-copy', action: () => navigator.clipboard.writeText(mod.name).then(() => window.showToast(t('Copied to clipboard!'))) });
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
                    window.showToast(t('Game path detection failed: {error}').replace('{error}', response.error), true);
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
                openImageModal,
                closeImageModal,
                fetchMods,
                refreshMods,
                clearCache,
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
