document.addEventListener('steam_workshop_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error('Vue.js failed to load!');
        return;
    }

    const { createApp, ref, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;
    const PREF_STATE_KEY = 'state_steam_workshop';
    const PER_PAGE = 24;
    const STEAM_ITEM_URL = 'https://steamcommunity.com/sharedfiles/filedetails/?id=';

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
                return Number.isFinite(num) ? Math.trunc(num).toLocaleString(getLocale()) : '0';
            };
            const uiState = readUiState();

            const installPath = ref(window.getSteamTabInstall ? window.getSteamTabInstall() : '');
            const items = ref([]);
            const isLoading = ref(true);
            const isRefreshing = ref(false);
            const error = ref('');
            const searchQuery = ref(uiState.searchQuery || '');
            const selectedSort = ref(uiState.selectedSort || 'popular');
            const currentPage = ref(1);

            const sortOptions = computed(() => [
                [t('steam_workshop.sort_popular'), 'popular'],
                [t('modpacks.sort_new'), 'new'],
                [t('steam_workshop.sort_updated'), 'updated'],
                [t('file_manager.name'), 'name']
            ]);

            const persistUiState = () => {
                if (!window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    searchQuery: searchQuery.value,
                    selectedSort: selectedSort.value
                });
            };

            const filteredItems = computed(() => {
                const query = searchQuery.value.trim().toLowerCase();
                const list = query
                    ? items.value.filter(i => [i.title, i.creator_name, i.published_file_id]
                        .some(v => String(v || '').toLowerCase().includes(query)))
                    : items.value.slice();
                const by = {
                    popular: (a, b) => b.subscriptions - a.subscriptions,
                    new: (a, b) => b.created - a.created,
                    updated: (a, b) => b.updated - a.updated,
                    name: (a, b) => String(a.title).localeCompare(String(b.title), getLocale())
                }[selectedSort.value] || (() => 0);
                return list.sort(by);
            });

            const maxPages = computed(() => Math.max(1, Math.ceil(filteredItems.value.length / PER_PAGE)));
            const pagedItems = computed(() => {
                const start = (currentPage.value - 1) * PER_PAGE;
                return filteredItems.value.slice(start, start + PER_PAGE);
            });

            const goToPage = (page) => {
                currentPage.value = Math.min(Math.max(1, page), maxPages.value);
                const vc = document.getElementById('view-container');
                if (vc) vc.scrollTo({ top: 0, behavior: 'smooth' });
            };

            const load = async (force = false) => {
                error.value = '';
                const response = await window.callBackend(
                    eel.get_steam_workshop_catalog(installPath.value, force)(),
                    'Failed to load the Steam Workshop'
                );
                if (response.success) {
                    const subscribing = new Set(items.value.filter(i => i.isSubscribing).map(i => i.published_file_id));
                    items.value = (response.data.items || []).map(i => ({
                        ...i,
                        isSubscribing: subscribing.has(i.published_file_id)
                    }));
                } else {
                    error.value = t('steam_workshop.unavailable');
                }
                isLoading.value = false;
                if (currentPage.value > maxPages.value) currentPage.value = maxPages.value;
            };

            const refresh = async () => {
                isRefreshing.value = true;
                try { await load(true); } finally { isRefreshing.value = false; }
            };

            const subscribe = async (item) => {
                if (item.isSubscribing || item.installed) return;
                item.isSubscribing = true;
                const response = await window.JobQueue.run({
                    label: t('steam_workshop.subscribe_name').replace('{name}', item.title),
                    task: async () => window.callBackend(eel.subscribe_workshop_item(item.published_file_id)(), 'Failed to subscribe')
                });
                item.isSubscribing = false;
                if (response && response.success) {
                    item.installed = true;
                    window.showToast(t('steam_workshop.subscribed_name').replace('{name}', item.title));
                    return;
                }
                const message = response && response.code === 'STEAM_UNAVAILABLE'
                    ? t('mod_manager.unsubscribe_steam_unavailable')
                    : t('steam_workshop.subscribe_failed_error').replace('{error}', (response && response.error) || t('common.unknown_error_occurred'));
                window.showToast(message, true);
            };

            const openUrl = (url) => eel.open_url_in_browser(url)();
            const openItem = (item) => openUrl(STEAM_ITEM_URL + encodeURIComponent(item.published_file_id));
            const openAuthor = (item) => openUrl(`https://steamcommunity.com/profiles/${encodeURIComponent(item.creator)}/myworkshopfiles/?appid=304050`);

            const onInstallChanged = (e) => {
                installPath.value = (e && e.detail && e.detail.path) || '';
                if (installPath.value) load(false);
            };

            watch(searchQuery, () => { currentPage.value = 1; persistUiState(); });
            watch(selectedSort, () => { currentPage.value = 1; persistUiState(); });

            onMounted(() => {
                document.addEventListener('mm_steam_install_changed', onInstallChanged);
                load(false);
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
            });
            onBeforeUnmount(() => document.removeEventListener('mm_steam_install_changed', onInstallChanged));

            return {
                t, formatCount, items, isLoading, isRefreshing, error, searchQuery, selectedSort,
                sortOptions, filteredItems, pagedItems, currentPage, maxPages, goToPage,
                refresh, subscribe, openItem, openAuthor
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);

    if (window._steamWorkshopApp) window._steamWorkshopApp.unmount();
    window._steamWorkshopApp = app;
    app.mount('#steam-workshop-vue-app');
});
