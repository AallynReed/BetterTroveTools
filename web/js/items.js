function initItemsView() {
    const root = document.getElementById('items-vue-app');
    if (!root || root.dataset.itemsInitializing === '1') return;
    root.dataset.itemsInitializing = '1';

    if (typeof Vue === 'undefined') {
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Vue failed to load for Item Codex.</div>`;
        return;
    }

    const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick, watch } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
            const PREF_STATE_KEY = 'state_items';
            let hydratingState = false;

            const isLoading = ref(true);
            const loadError = ref('');
            const itemsData = ref([]);
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
                    await loadItems(false);
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

            const prettyNameFromPath = (value) => {
                const normalized = String(value || '').replace(/\\/g, '/').replace(/\.binfab$/i, '').trim();
                const tail = normalized.split('/').filter(Boolean).pop() || normalized;
                return tail
                    .replace(/^collections\//i, '')
                    .replace(/^(?:item|placeable|block|collections)\//i, '')
                    .replace(/[_-]+/g, ' ')
                    .trim()
                    .replace(/\b\w/g, (ch) => ch.toUpperCase());
            };

            const normalizeUnlockEntry = (unlock) => {
                if (unlock && typeof unlock === 'object' && !Array.isArray(unlock)) {
                    const path = String(unlock.path || unlock.filename || unlock.id || '').trim();
                    const name = String(unlock.name || '').trim();
                    return {
                        path,
                        name: name || prettyNameFromPath(path),
                    };
                }
                const path = String(unlock || '').trim();
                return {
                    path,
                    name: prettyNameFromPath(path),
                };
            };

            const highlightSearch = (text) => {
                const q = searchQuery.value.trim();
                const safe = escapeHtml(text || '');
                if (!q) return safe;
                const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(`(${escaped})`, 'ig');
                return safe.replace(re, '<mark>$1</mark>');
            };

            const filteredItems = computed(() => {
                let result = itemsData.value.slice();

                const sq = searchQuery.value.toLowerCase().trim();
                if (sq.length >= 3) {
                    let generalSearch = sq;
                    const filters = { name: null, category: null, unlock: null, path: null };
                    const regex = /(name|category|unlock|path):("([^"]+)"|([^\s]+))/g;
                    let match;
                    while ((match = regex.exec(sq)) !== null) {
                        filters[match[1]] = (match[3] || match[4] || '').toLowerCase();
                        generalSearch = generalSearch.replace(match[0], '');
                    }
                    generalSearch = generalSearch.trim();

                    result = result.filter(item => {
                        const name = String(item.name || '').toLowerCase();
                        const category = String(item.category || '').toLowerCase();
                        const path = String(item.filename || '').toLowerCase();
                        const desc = String(item.desc || '').toLowerCase();
                        const unlocks = (item.unlocks || []).map(unlock => {
                            if (unlock && typeof unlock === 'object') {
                                return `${unlock.name || ''} ${unlock.path || ''}`;
                            }
                            return String(unlock || '');
                        }).join(' ').toLowerCase();

                        if (filters.name && !name.includes(filters.name)) return false;
                        if (filters.category && !category.includes(filters.category)) return false;
                        if (filters.unlock && !unlocks.includes(filters.unlock)) return false;
                        if (filters.path && !path.includes(filters.path)) return false;

                        if (generalSearch.length > 0) {
                            const haystack = `${name} ${category} ${path} ${desc} ${unlocks}`;
                            if (!haystack.includes(generalSearch)) return false;
                        }
                        return true;
                    });
                }

                if (selectedCategory.value && selectedCategory.value !== 'All') {
                    result = result.filter(item => item.category === selectedCategory.value);
                }

                return [...result].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            });

            const totalPages = computed(() => Math.max(1, Math.ceil(filteredItems.value.length / pageSize.value)));
            const paginatedItems = computed(() => filteredItems.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
            const visibleStart = computed(() => filteredItems.value.length === 0 ? 0 : (currentPage.value - 1) * pageSize.value + 1);
            const visibleEnd = computed(() => filteredItems.value.length === 0 ? 0 : Math.min(currentPage.value * pageSize.value, filteredItems.value.length));
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

            const loadItems = async (forceRefresh = false) => {
                loadError.value = '';
                let data = null;
                let response = null;
                if (window.eel && eel.get_items_data) {
                    response = await eel.get_items_data(forceRefresh, getSelectedGamePath())();
                    if (!response || response.success === false) {
                        throw new Error((response && response.error) || 'Failed to retrieve item data from backend');
                    }
                    const cacheUrl = String(
                        (response && response.cache_file)
                        || (response && response.meta && response.meta.cache && response.meta.cache.cache_url)
                        || ''
                    ).trim();
                    if (cacheUrl) {
                        const cacheResp = await fetch(cacheUrl, { cache: 'no-store' });
                        if (!cacheResp.ok) throw new Error(`Failed to load item cache file (${cacheResp.status})`);
                        data = await cacheResp.json();
                    } else {
                        data = (response && response.data && typeof response.data === 'object') ? response.data : response;
                    }
                } else {
                    throw new Error('Backend items endpoint is unavailable');
                }

                const uniqueCategories = new Set();
                const parsed = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.category) uniqueCategories.add(row.category);
                    return {
                        id: key,
                        ...row,
                        imagePath: `https://trovesaurus.com/data/catalog/${normalizeCatalogImageId(row.blueprint || row.filename || key)}.png`,
                        unlocks: Array.isArray(row.unlocks) ? row.unlocks.map(normalizeUnlockEntry).filter(unlock => unlock.path) : [],
                    };
                });
                itemsData.value = parsed;

                const catOpts = [['All Categories', 'All']];
                Array.from(uniqueCategories).sort().forEach(c => catOpts.push([c, c]));
                categoryOptions.value = catOpts;

                const source = (response && response.source) || '';
                const cacheMeta = (response && response.meta && response.meta.cache) || {};
                if (source === 'game-cache') dataSourceText.value = t('Loaded item data from cached game-file scan.');
                else if (source === 'game-live') dataSourceText.value = t('Loaded item data from live game files.');
                else dataSourceText.value = '';
                if (source && cacheMeta && cacheMeta.age_seconds !== undefined && source === 'game-cache') {
                    const hours = Math.floor((cacheMeta.age_seconds || 0) / 3600);
                    if (hours > 0) dataSourceText.value += ` ${t('Cache age')}: ${hours}h.`;
                }
            };

            const clearCacheAndReload = async () => {
                try {
                    isLoading.value = true;
                    if (window.eel && eel.clear_items_cache) await eel.clear_items_cache()();
                    await loadItems(true);
                } finally {
                    isLoading.value = false;
                    nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
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
                    await loadItems(false);
                } catch (err) {
                    loadError.value = String((err && err.message) || err || 'Failed to load items from game files.');
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
                t, isLoading, loadError, itemsData, filteredItems, paginatedItems,
                searchQuery, selectedCategory, categoryOptions,
                currentPage, totalPages, pageNumbers, visibleStart, visibleEnd,
                setPage, nextPage, prevPage,
                selectedGamePath, installOptions, openSelectedGamePath, refreshGamePaths,
                resetFilters, highlightSearch, clearCacheAndReload, dataSourceText
            };
        }
    });

    try {
        if (window.CustomVueSelect) app.component('custom-vue-select', window.CustomVueSelect);
        if (window._itemsApp) window._itemsApp.unmount();
        window._itemsApp = app;
        app.mount('#items-vue-app');
    } catch (err) {
        console.error("Failed to initialize Item Codex app:", err);
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Failed to initialize Item Codex: ${String((err && err.message) || err)}</div>`;
    } finally {
        delete root.dataset.itemsInitializing;
    }
}

document.addEventListener('items_loaded', initItemsView);
if (document.readyState !== 'loading') initItemsView();
