function initFishView() {
    const root = document.getElementById('fish-vue-app');
    if (!root || root.dataset.fishInitializing === '1') return;
    root.dataset.fishInitializing = '1';

    if (typeof Vue === 'undefined') {
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Vue failed to load for Fish Codex.</div>`;
        return;
    }

    const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick, watch } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
            const PREF_STATE_KEY = 'state_fish';
            let hydratingState = false;

            const isLoading = ref(true);
            const loadError = ref('');
            const fishData = ref([]);
            const dataSourceText = ref('');
            const sourceOptions = ref([['All Sources', 'All']]);
            const rarityOptions = ref([['All Rarities', 'All']]);
            const searchQuery = ref('');
            const selectedSource = ref('All');
            const selectedRarity = ref('All');
            const currentPage = ref(1);
            const pageSize = ref(8);   // groups per page in grouped view (5 sources fit on page 1)

            const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Relic'];
            const RARITY_COLORS = {
                Common: '#b0bec5', Uncommon: '#7ed957', Rare: '#5ec6ff',
                Epic: '#b066ff', Legendary: '#ffd54f', Relic: '#ff8a65'
            };

            const applyStateSnapshot = (saved) => {
                if (!saved || typeof saved !== 'object') return;
                if (typeof saved.searchQuery === 'string') searchQuery.value = saved.searchQuery;
                if (typeof saved.selectedSource === 'string') selectedSource.value = saved.selectedSource;
                if (typeof saved.selectedRarity === 'string') selectedRarity.value = saved.selectedRarity;
                if (saved.currentPage !== undefined) {
                    const p = parseInt(saved.currentPage, 10);
                    currentPage.value = Number.isFinite(p) && p > 0 ? p : 1;
                }
            };
            const persistState = () => {
                if (hydratingState || !window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    searchQuery: searchQuery.value,
                    selectedSource: selectedSource.value,
                    selectedRarity: selectedRarity.value,
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
                applyGamePathState((await window.CodexGamePathApi.getState()) || {});
            };
            const refreshGamePaths = async () => {
                if (!window.CodexGamePathApi || !window.CodexGamePathApi.refresh) return;
                applyGamePathState((await window.CodexGamePathApi.refresh()) || {});
            };
            const openSelectedGamePath = async () => {
                if (!window.CodexGamePathApi || !window.CodexGamePathApi.openSelectedPath) return;
                await window.CodexGamePathApi.openSelectedPath(selectedGamePath.value);
            };
            const handleCodexGamePathChanged = async () => {
                try {
                    isLoading.value = true;
                    await syncGamePathPicker();
                    await loadFish(false);
                } catch (err) {
                    loadError.value = String((err && err.message) || err || 'Failed to load data from game files.');
                } finally {
                    isLoading.value = false;
                    nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                }
            };

            const escapeHtml = (txt) => String(txt || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            const normalizeCatalogImageId = (value) => String(value || '')
                .replace(/\.blueprint$/i, '').replace(/\\/g, '/').replace(/^\$+/, '')
                .replace(/^\/+/, '').replace(/^[^a-z0-9_/]+/i, '').trim().toLowerCase();
            const highlightSearch = (text) => {
                const q = searchQuery.value.trim();
                const safe = escapeHtml(text || '');
                if (!q) return safe;
                const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return safe.replace(new RegExp(`(${escaped})`, 'ig'), '<mark>$1</mark>');
            };
            const rarityColor = (r) => RARITY_COLORS[r] || '#9aa7b4';
            const trophyCount = (fish) => fish.trophies ? Object.keys(fish.trophies).length : 0;
            const weightText = (fish) => (fish.weight_min != null && fish.weight_max != null)
                ? `${fish.weight_min} - ${fish.weight_max}` : '';

            const filteredFish = computed(() => {
                let result = fishData.value.slice();
                const sq = searchQuery.value.toLowerCase().trim();
                if (sq.length >= 3) {
                    let general = sq;
                    const filters = { name: null, source: null, rarity: null, path: null };
                    const regex = /(name|source|rarity|path):("([^"]+)"|([^\s]+))/g;
                    let m;
                    while ((m = regex.exec(sq)) !== null) {
                        filters[m[1]] = (m[3] || m[4] || '').toLowerCase();
                        general = general.replace(m[0], '');
                    }
                    general = general.trim();
                    result = result.filter(f => {
                        const name = String(f.name || '').toLowerCase();
                        const source = String(f.source || '').toLowerCase();
                        const rarity = String(f.rarity || '').toLowerCase();
                        const path = String(f.filename || '').toLowerCase();
                        const desc = String(f.desc || '').toLowerCase();
                        if (filters.name && !name.includes(filters.name)) return false;
                        if (filters.source && !source.includes(filters.source)) return false;
                        if (filters.rarity && !rarity.includes(filters.rarity)) return false;
                        if (filters.path && !path.includes(filters.path)) return false;
                        if (general.length > 0 && !`${name} ${source} ${rarity} ${path} ${desc}`.includes(general)) return false;
                        return true;
                    });
                }
                if (selectedSource.value !== 'All') result = result.filter(f => f.source === selectedSource.value);
                if (selectedRarity.value !== 'All') result = result.filter(f => f.rarity === selectedRarity.value);
                return [...result].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            });

            // Group the filtered fish by liquid (source). Inside each group, sort by
            // rarity Common -> Rare so the section reads naturally.
            const groupedFish = computed(() => {
                const groups = new Map();
                for (const f of filteredFish.value) {
                    const label = f.source || 'Other';
                    if (!groups.has(label)) groups.set(label, []);
                    groups.get(label).push(f);
                }
                const arr = Array.from(groups.entries()).map(([label, list]) => {
                    list.sort((a, b) => {
                        const ra = (RARITY_ORDER.indexOf(String(a.rarity || '').toLowerCase()) + 1) || 99;
                        const rb = (RARITY_ORDER.indexOf(String(b.rarity || '').toLowerCase()) + 1) || 99;
                        if (ra !== rb) return ra - rb;
                        return String(a.name || '').localeCompare(String(b.name || ''));
                    });
                    return { label, fish: list, count: list.length };
                });
                arr.sort((a, b) => a.label.localeCompare(b.label));
                return arr;
            });

            const totalPages = computed(() => Math.max(1, Math.ceil(groupedFish.value.length / pageSize.value)));
            const paginatedGroups = computed(() => groupedFish.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
            const visibleStart = computed(() => groupedFish.value.length === 0 ? 0 : (currentPage.value - 1) * pageSize.value + 1);
            const visibleEnd = computed(() => groupedFish.value.length === 0 ? 0 : Math.min(currentPage.value * pageSize.value, groupedFish.value.length));
            const pageNumbers = computed(() => {
                const total = totalPages.value, current = currentPage.value;
                const pages = new Set([1, total, current - 1, current, current + 1]);
                return Array.from(pages).filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
            });
            const setPage = (p) => { currentPage.value = Math.min(totalPages.value, Math.max(1, p)); };
            const nextPage = () => setPage(currentPage.value + 1);
            const prevPage = () => setPage(currentPage.value - 1);

            watch([searchQuery, selectedSource, selectedRarity], () => { currentPage.value = 1; });
            watch(totalPages, (n) => { if (currentPage.value > n) currentPage.value = n; });
            watch([searchQuery, selectedSource, selectedRarity, currentPage], persistState, { deep: true });
            watch(selectedGamePath, async (newVal, oldVal) => {
                if (syncingGamePath || !window.CodexGamePathApi || !window.CodexGamePathApi.setSelectedPath || newVal === oldVal) return;
                applyGamePathState((await window.CodexGamePathApi.setSelectedPath(newVal)) || {});
            });

            const loadFish = async (forceRefresh = false) => {
                loadError.value = '';
                if (!(window.eel && eel.get_fish_data)) throw new Error('Backend fish endpoint is unavailable');
                const response = await eel.get_fish_data(forceRefresh, getSelectedGamePath())();
                if (!response || response.success === false) {
                    throw new Error((response && response.error) || 'Failed to retrieve fish data from backend');
                }
                const cacheUrl = String((response && response.cache_file) || (response && response.meta && response.meta.cache && response.meta.cache.cache_url) || '').trim();
                let data;
                if (cacheUrl) {
                    const cacheResp = await fetch(cacheUrl, { cache: 'no-store' });
                    if (!cacheResp.ok) throw new Error(`Failed to load fish cache file (${cacheResp.status})`);
                    data = await cacheResp.json();
                } else {
                    data = (response && response.data && typeof response.data === 'object') ? response.data : response;
                }

                const sources = new Set(), rarities = new Set();
                fishData.value = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.source) sources.add(row.source);
                    if (row.rarity) rarities.add(row.rarity);
                    return {
                        id: key, ...row,
                        imagePath: `https://trovesaurus.com/data/catalog/${normalizeCatalogImageId(row.blueprint || row.filename || key)}.png`,
                    };
                });
                sourceOptions.value = [['All Sources', 'All'], ...Array.from(sources).sort().map(s => [s, s])];
                rarityOptions.value = [['All Rarities', 'All'], ...Array.from(rarities)
                    .sort((a, b) => (RARITY_ORDER.indexOf(a) + 1 || 99) - (RARITY_ORDER.indexOf(b) + 1 || 99))
                    .map(r => [r, r])];

                const source = (response && response.source) || '';
                if (source === 'game-cache') dataSourceText.value = t('fish.loaded_fish_data_from_cached_game_file_s_1562da');
                else if (source === 'game-cache-stale') dataSourceText.value = t('fish.loaded_fish_data_from_cache_refreshing_i_e9df1d');
                else if (source === 'game-live') dataSourceText.value = t('fish.loaded_fish_data_from_live_game_files');
                else dataSourceText.value = '';
            };

            const clearCacheAndReload = async () => {
                try {
                    isLoading.value = true;
                    if (window.eel && eel.clear_fish_cache) await eel.clear_fish_cache()();
                    await loadFish(true);
                } finally {
                    isLoading.value = false;
                    nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                }
            };

            onMounted(async () => {
                hydratingState = true;
                if (window.AppSettings) {
                    await window.AppSettings.load();
                    applyStateSnapshot(window.AppSettings.getPref(PREF_STATE_KEY, null));
                }
                await syncGamePathPicker();
                try { await loadFish(false); }
                catch (err) { loadError.value = String((err && err.message) || err || 'Failed to load fish from game files.'); }
                isLoading.value = false;
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                hydratingState = false;
                document.addEventListener('codex_game_path_changed', handleCodexGamePathChanged);
            });
            onBeforeUnmount(() => {
                document.removeEventListener('codex_game_path_changed', handleCodexGamePathChanged);
            });

            return {
                t, isLoading, loadError, fishData, filteredFish,
                groupedFish, paginatedGroups,
                searchQuery, selectedSource, selectedRarity, sourceOptions, rarityOptions,
                currentPage, totalPages, pageNumbers, visibleStart, visibleEnd,
                setPage, nextPage, prevPage, rarityColor, trophyCount, weightText,
                selectedGamePath, installOptions, openSelectedGamePath, refreshGamePaths,
                highlightSearch, clearCacheAndReload, dataSourceText
            };
        }
    });

    try {
        if (window.CustomVueSelect) app.component('custom-vue-select', window.CustomVueSelect);
        if (window._fishApp) window._fishApp.unmount();
        window._fishApp = app;
        app.mount('#fish-vue-app');
    } catch (err) {
        console.error("Failed to initialize Fish Codex app:", err);
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Failed to initialize Fish Codex: ${String((err && err.message) || err)}</div>`;
    } finally {
        delete root.dataset.fishInitializing;
    }
}

// Init is driven solely by the `fish_loaded` event, which codexes.js dispatches
// right after lazy-loading this script (the listener above is already attached
// by then). The old `if (document.readyState !== 'loading') initFishView()`
// self-call fired an extra time on load, causing a full mount + immediate
// unmount/remount and a duplicate data fetch on first open. Removed.
document.addEventListener('fish_loaded', initFishView);
