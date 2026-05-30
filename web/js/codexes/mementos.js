function initMementosView() {
    const root = document.getElementById('mementos-vue-app');
    if (!root || root.dataset.mementosInitializing === '1') return;
    root.dataset.mementosInitializing = '1';

    if (typeof Vue === 'undefined') {
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Vue failed to load for Memento Codex.</div>`;
        return;
    }

    const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick, watch } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
            const PREF_STATE_KEY = 'state_mementos';
            let hydratingState = false;

            const isLoading = ref(true);
            const loadError = ref('');
            const mementosData = ref([]);
            const dataSourceText = ref('');
            const categoryOptions = ref([]);
            const searchQuery = ref('');
            const selectedCategory = ref('All');
            const currentPage = ref(1);
            const pageSize = ref(36);

            const resetFilters = () => {
                searchQuery.value = '';
                selectedCategory.value = 'All';
                currentPage.value = 1;
            };

            const applyStateSnapshot = (saved) => {
                if (!saved || typeof saved !== 'object') return;
                if (typeof saved.searchQuery === 'string') searchQuery.value = saved.searchQuery;
                if (typeof saved.selectedCategory === 'string') selectedCategory.value = saved.selectedCategory;
                if (saved.currentPage !== undefined) {
                    const parsedPage = parseInt(saved.currentPage, 10);
                    currentPage.value = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
                }
            };

            const persistState = () => {
                if (hydratingState || !window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    searchQuery: searchQuery.value,
                    selectedCategory: selectedCategory.value,
                    currentPage: currentPage.value
                });
            };



            const getSelectedGamePath = () => window.getSelectedCodexGamePath ? window.getSelectedCodexGamePath() : '';
            const installOptions = ref([]);
            const selectedGamePath = ref('');
            let syncingGamePath = false;

            const applyGamePathState = (state) => {
                syncingGamePath = true;
                installOptions.value = Array.isArray(state && state.installOptions) ? state.installOptions : [];
                selectedGamePath.value = String((state && state.selectedGamePath) || getSelectedGamePath() || '');
                syncingGamePath = false;
            };

            const syncGamePathPicker = async () => {
                if (!window.CodexGamePathApi || !window.CodexGamePathApi.getState) {
                    applyGamePathState({ installOptions: [], selectedGamePath: getSelectedGamePath() });
                    return;
                }
                const state = await window.CodexGamePathApi.getState();
                applyGamePathState(state || {});
            };

            const refreshGamePaths = async () => {
                if (!window.CodexGamePathApi || !window.CodexGamePathApi.refresh) return;
                const state = await window.CodexGamePathApi.refresh();
                applyGamePathState(state || {});
            };

            const openSelectedGamePath = async () => {
                if (!window.CodexGamePathApi || !window.CodexGamePathApi.openSelectedPath) return;
                await window.CodexGamePathApi.openSelectedPath(selectedGamePath.value);
            };

            const handleCodexGamePathChanged = async () => {
                try {
                    isLoading.value = true;
                    await syncGamePathPicker();
                    await loadMementos(false);
                } catch (err) {
                    loadError.value = String((err && err.message) || err || 'Failed to load data from game files.');
                } finally {
                    isLoading.value = false;
                    nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                }
            };

            const escapeHtml = (text) => String(text || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');

            const normalizeCatalogImageId = (value) => String(value || '')
                .replace(/\.blueprint$/i, '')
                .replace(/\\/g, '/')
                .replace(/^\$+/, '')
                .replace(/^\/+/, '')
                .replace(/^[^a-z0-9_/]+/i, '')
                .trim()
                .toLowerCase();

            const stripMementoPrefix = (value) => String(value || '').replace(/^\s*Memento:\s*/i, '').trim();

            const highlightSearch = (text) => {
                const q = searchQuery.value.trim();
                const safe = escapeHtml(text || '');
                if (!q) return safe;
                const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(`(${escaped})`, 'ig');
                return safe.replace(re, '<mark>$1</mark>');
            };

            const filteredMementos = computed(() => {
                let result = mementosData.value.filter(m => {
                    const category = m.category || 'Unknown';
                    return category !== 'Unknown'
                        && category !== 'InProgress'
                        && category !== 'ReadyForGame'
                        && category !== 'Hidden'
                        && !!String(m.source_name || '').trim();
                });

                const sq = searchQuery.value.toLowerCase().trim();
                if (sq.length >= 3) {
                    let generalSearch = sq;
                    const filters = { author: null, name: null, category: null, source: null };
                    const regex = /(author|designer|name|category|source):("([^"]+)"|([^\s]+))/g;
                    let match;
                    while ((match = regex.exec(sq)) !== null) {
                        const key = match[1] === 'designer' ? 'author' : match[1];
                        filters[key] = match[3] || match[4];
                        generalSearch = generalSearch.replace(match[0], '');
                    }
                    generalSearch = generalSearch.trim();

                    result = result.filter(m => {
                        const name = (m.name || m.fallbackName || '').toLowerCase();
                        const source = (m.source_name || '').toLowerCase();
                        const category = (m.category || '').toLowerCase();
                        const designer = (m.designer || '').toLowerCase();

                        if (filters.author && !designer.includes(filters.author)) return false;
                        if (filters.name && !name.includes(filters.name)) return false;
                        if (filters.category && !category.includes(filters.category)) return false;
                        if (filters.source && !source.includes(filters.source)) return false;
                        if (generalSearch.length > 0 && !(name.includes(generalSearch) || source.includes(generalSearch) || category.includes(generalSearch) || designer.includes(generalSearch))) return false;
                        return true;
                    });
                }

                if (selectedCategory.value && selectedCategory.value !== 'All') {
                    result = result.filter(m => m.category === selectedCategory.value);
                }

                return [...result].sort((a, b) => (a.name || a.fallbackName || '').localeCompare(b.name || b.fallbackName || ''));
            });

            const totalPages = computed(() => Math.max(1, Math.ceil(filteredMementos.value.length / pageSize.value)));
            const paginatedMementos = computed(() => filteredMementos.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
            const visibleStart = computed(() => filteredMementos.value.length === 0 ? 0 : (currentPage.value - 1) * pageSize.value + 1);
            const visibleEnd = computed(() => filteredMementos.value.length === 0 ? 0 : Math.min(currentPage.value * pageSize.value, filteredMementos.value.length));
            const pageNumbers = computed(() => {
                const total = totalPages.value;
                const current = currentPage.value;
                const pages = new Set([1, total, current - 1, current, current + 1]);
                return Array.from(pages).filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
            });

            const setPage = (page) => {
                currentPage.value = Math.min(totalPages.value, Math.max(1, page));
            };
            const nextPage = () => setPage(currentPage.value + 1);
            const prevPage = () => setPage(currentPage.value - 1);

            watch([searchQuery, selectedCategory], () => {
                currentPage.value = 1;
            });
            watch([searchQuery, selectedCategory, currentPage], persistState, { deep: true });


            watch(selectedGamePath, async (newVal, oldVal) => {
                if (syncingGamePath || !window.CodexGamePathApi || !window.CodexGamePathApi.setSelectedPath || newVal === oldVal) return;
                const state = await window.CodexGamePathApi.setSelectedPath(newVal);
                applyGamePathState(state || {});
            });

            const loadMementos = async (forceRefresh = false) => {
                loadError.value = '';
                let data = null;
                let response = null;
                if (window.eel && eel.get_mementos_data) {
                    response = await eel.get_mementos_data(forceRefresh, getSelectedGamePath())();
                    if (!response || response.success === false) {
                        throw new Error((response && response.error) || 'Failed to retrieve memento data from backend');
                    }
                    const cacheUrl = String(
                        (response && response.cache_file)
                        || (response && response.meta && response.meta.cache && response.meta.cache.cache_url)
                        || ''
                    ).trim();
                    if (cacheUrl) {
                        const cacheResp = await fetch(cacheUrl, { cache: 'no-store' });
                        if (!cacheResp.ok) throw new Error(`Failed to load memento cache file (${cacheResp.status})`);
                        data = await cacheResp.json();
                    } else {
                        data = (response && response.data && typeof response.data === 'object') ? response.data : response;
                    }
                } else {
                    throw new Error('Backend mementos endpoint is unavailable');
                }

                const uniqueCategories = new Set();
                const parsed = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.category) uniqueCategories.add(row.category);
                    const fallbackName = key.split('/').slice(-1)[0].replaceAll('_', ' ');
                    const imagePath = `https://trovesaurus.com/data/catalog/${normalizeCatalogImageId(row.blueprint || '')}.png`;
                    const hasSourceContext = !!(row.source_label && row.source_name);
                    const displayName = hasSourceContext ? (row.name || fallbackName) : (stripMementoPrefix(row.name || '') || fallbackName);
                    return {
                        id: key,
                        ...row,
                        fallbackName,
                        imagePath,
                        displayName
                    };
                });
                mementosData.value = parsed;

                const catOpts = [['All Categories', 'All']];
                Array.from(uniqueCategories).sort().forEach(c => catOpts.push([c, c]));
                categoryOptions.value = catOpts;

                const source = (response && response.source) || '';
                const cacheMeta = (response && response.meta && response.meta.cache) || {};
                if (source === 'game-cache') dataSourceText.value = t('mementos.loaded_memento_data_from_cached_game_fil_232003');
                else if (source === 'game-cache-stale') dataSourceText.value = t('mementos.loaded_memento_data_from_cache_refreshin_0ef26a');
                else if (source === 'game-live') dataSourceText.value = t('mementos.loaded_memento_data_from_live_game_files');
                else dataSourceText.value = '';
                if (source && cacheMeta && cacheMeta.age_seconds !== undefined && source === 'game-cache') {
                    const hours = Math.floor((cacheMeta.age_seconds || 0) / 3600);
                    if (hours > 0) dataSourceText.value += ` ${t('common.cache_age')}: ${hours}h.`;
                }
            };

            const clearCacheAndReload = async () => {
                try {
                    isLoading.value = true;
                    if (window.eel && eel.clear_mementos_cache) await eel.clear_mementos_cache()();
                    await loadMementos(true);
                } finally {
                    isLoading.value = false;
                    nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                }
            };

            const sourceRowClass = (label) => {
                switch (String(label || '').toLowerCase()) {
                    case 'biome':
                        return 'memento-meta-row-biome';
                    case 'boss':
                        return 'memento-meta-row-boss';
                    case 'creature':
                        return 'memento-meta-row-creature';
                    default:
                        return '';
                }
            };

            onMounted(async () => {
                hydratingState = true;
                if (window.AppSettings) {
                    await window.AppSettings.load();
                    const saved = window.AppSettings.getPref(PREF_STATE_KEY, null);
                    applyStateSnapshot(saved);
                }
                await syncGamePathPicker();
                try {
                    await loadMementos(false);
                } catch (err) {
                    loadError.value = String((err && err.message) || err || 'Failed to load mementos from game files.');
                }
                isLoading.value = false;
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                hydratingState = false;
                document.addEventListener('codex_game_path_changed', handleCodexGamePathChanged);
            });

            onBeforeUnmount(() => {
                document.removeEventListener('codex_game_path_changed', handleCodexGamePathChanged);
            });

            return {
                t, isLoading, loadError, mementosData, filteredMementos, paginatedMementos,
                searchQuery, selectedCategory, categoryOptions,
                currentPage, totalPages, pageNumbers, visibleStart, visibleEnd,
                setPage, nextPage, prevPage,
                selectedGamePath, installOptions, openSelectedGamePath, refreshGamePaths,
                resetFilters, highlightSearch, clearCacheAndReload, dataSourceText, sourceRowClass
            };
        }
    });

    try {
        if (window.CustomVueSelect) app.component('custom-vue-select', window.CustomVueSelect);
        if (window._mementosApp) window._mementosApp.unmount();
        window._mementosApp = app;
        app.mount('#mementos-vue-app');
    } catch (err) {
        console.error("Failed to initialize Memento Codex app:", err);
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Failed to initialize Memento Codex: ${String((err && err.message) || err)}</div>`;
    } finally {
        delete root.dataset.mementosInitializing;
    }
}

document.addEventListener('mementos_loaded', initMementosView);
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initMementosView, 0);
});
