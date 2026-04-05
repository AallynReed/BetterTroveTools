document.addEventListener('trovesaurus_loaded', () => {
    console.log("Trovesaurus Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

            const isLoading = ref(true);
            const error = ref("");
            const mods = ref([]);
            
            const currentPage = ref(1);
            const maxPages = ref(1);

            const searchQuery = ref("");
            const selectedCategory = ref("");
            const selectedSort = ref("hot");
            
            const games = ref([]);
            const selectedGame = ref("");

            const modal = reactive({ show: false, src: "", caption: "", modId: null });

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

            const fetchMods = (page = 1) => {
                if (isLoading.value && page !== 1) return;
                isLoading.value = true;
                error.value = "";
                eel.get_trovesaurus_mods(page, searchQuery.value.trim(), selectedCategory.value, selectedSort.value, selectedGame.value)();
                
                const vc = document.getElementById('view-container');
                if (vc && page !== currentPage.value) vc.scrollTo({top: 0, behavior: 'smooth'});
            };

            window._tsAppHandleMods = (response) => {
                if (response && response.success) {
                    mods.value = response.mods.map(m => ({
                        ...m,
                        is_installing: false
                    }));
                    currentPage.value = response.page;
                    maxPages.value = response.max_pages;
                    error.value = "";
                } else {
                    mods.value = [];
                    error.value = response?.error || t('Unknown error occurred');
                }
                isLoading.value = false;
            };

            window._tsAppHandleInstall = (response) => {
                const targetMod = mods.value.find(m => m.id === parseInt(response.mod_id));
                if (!targetMod) return;

                targetMod.is_installing = false;
                if (response.success) {
                    targetMod.is_installed = true;
                    targetMod.needs_update = false;
                    window.showToast(t("Installed"));
                } else {
                    window.showToast(t("Error: {error}").replace("{error}", response?.error || t('Unknown error occurred')), true);
                }
            };

            const installMod = (mod) => {
                if (mod.is_installing || (mod.is_installed && !mod.needs_update)) return;
                if (!selectedGame.value) return window.showToast(t("Could not automatically detect your Trove installation folder! Please check your game install."), true);
                
                mod.is_installing = true;
                eel.install_trovesaurus_mod(selectedGame.value, mod.id)();
            };

            const openUrl = (url) => eel.open_url_in_browser(url)();

            const showContextMenu = (e, mod) => {
                if (!window.ContextMenu) return;
                let items = [];
                
                if (!mod.is_installed || mod.needs_update) {
                    items.push({
                        label: mod.needs_update ? 'Update Mod' : 'Install Mod',
                        icon: mod.needs_update ? 'fa-rotate' : 'fa-download',
                        action: () => installMod(mod)
                    });
                    items.push({ separator: true });
                }
                
                items.push({ label: 'View on Trovesaurus', icon: 'fa-arrow-up-right-from-square', action: () => openUrl(`https://trovesaurus.com/mod=${mod.id}`) });
                items.push({ label: 'Copy Mod Name', icon: 'fa-copy', action: () => navigator.clipboard.writeText(mod.name).then(() => window.showToast(t("Copied to clipboard!"))) });
                
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
            const closeImageModal = () => { modal.show = false; setTimeout(() => modal.src = "", 200); };

            watch([selectedCategory, selectedSort], () => {
                fetchMods(1);
            });

            onMounted(async () => {
                const response = await eel.get_detected_game_paths()();
                const settings = await eel.get_settings()();
                
                if (response.success && response.paths.length > 0) {
                    games.value = response.paths;
                    const lastPath = settings.last_game_path;
                    
                    if (lastPath && response.paths.some(p => p.path === lastPath)) selectedGame.value = lastPath;
                    else {
                        const liveInstall = response.paths.find(p => p.name.toLowerCase().includes('live'));
                        selectedGame.value = liveInstall ? liveInstall.path : response.paths[0].path;
                    }
                }
                
                watch(selectedGame, async (newVal) => {
                    if (!newVal) return;
                    settings.last_game_path = newVal;
                    await eel.save_settings(settings)();
                    fetchMods(1);
                });

                fetchMods(1);
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
            });

            return {
                t, isLoading, error, mods, currentPage, maxPages,
                searchQuery, selectedCategory, selectedSort, selectedGame,
                categoryOptions, sortOptions, gameOptions,
                modal, openImageModal, closeImageModal,
                fetchMods, installMod, openUrl, showContextMenu
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