function initBadgesView() {
    const root = document.getElementById('badges-vue-app');
    if (!root || root.dataset.badgesInitializing === '1') return;
    root.dataset.badgesInitializing = '1';

    if (typeof Vue === 'undefined') {
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Vue failed to load for Badge Codex.</div>`;
        return;
    }

    const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick, watch } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
            const PREF_STATE_KEY = 'state_badges';
            let hydratingState = false;

            const isLoading = ref(true);
            const loadError = ref('');
            const badgesData = ref([]);
            const dataSourceText = ref('');
            const tierOptions = ref([['All Tiers', 'All']]);
            const categoryOptions = ref([['All Categories', 'All']]);
            const searchQuery = ref('');
            const selectedTier = ref('All');
            const selectedCategory = ref('All');
            const currentPage = ref(1);
            const pageSize = ref(8);   // groups per page in grouped view

            const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Obsidian', 'Trovium'];
            const TIER_COLORS = {
                Bronze: '#cd7f32', Silver: '#c0c0c0', Gold: '#ffd54f',
                Platinum: '#e5e4e2', Diamond: '#b9f2ff', Obsidian: '#7a4dff', Trovium: '#ff8a65'
            };

            const applyStateSnapshot = (saved) => {
                if (!saved || typeof saved !== 'object') return;
                if (typeof saved.searchQuery === 'string') searchQuery.value = saved.searchQuery;
                if (typeof saved.selectedTier === 'string') selectedTier.value = saved.selectedTier;
                if (typeof saved.selectedCategory === 'string') selectedCategory.value = saved.selectedCategory;
                if (saved.currentPage !== undefined) {
                    const p = parseInt(saved.currentPage, 10);
                    currentPage.value = Number.isFinite(p) && p > 0 ? p : 1;
                }
            };
            const persistState = () => {
                if (hydratingState || !window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    searchQuery: searchQuery.value,
                    selectedTier: selectedTier.value,
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
                    await loadBadges(false);
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
            const tierColor = (t) => TIER_COLORS[t] || '#9aa7b4';
            const masteryText = (b) => (b.base && b.multiplier > 1)
                ? `${b.mastery} (${b.base} × ${b.multiplier})` : `${b.mastery}`;

            const filteredBadges = computed(() => {
                let result = badgesData.value.slice();
                const sq = searchQuery.value.toLowerCase().trim();
                if (sq.length >= 3) {
                    let general = sq;
                    const filters = { name: null, group: null, tier: null, category: null };
                    const regex = /(name|group|tier|category):("([^"]+)"|([^\s]+))/g;
                    let m;
                    while ((m = regex.exec(sq)) !== null) {
                        filters[m[1]] = (m[3] || m[4] || '').toLowerCase();
                        general = general.replace(m[0], '');
                    }
                    general = general.trim();
                    result = result.filter(b => {
                        const name = String(b.name || '').toLowerCase();
                        const group = String(b.group || '').toLowerCase();
                        const tier = String(b.tier || '').toLowerCase();
                        const category = String(b.in_game_category || '').toLowerCase();
                        const path = String(b.filename || '').toLowerCase();
                        if (filters.name && !name.includes(filters.name)) return false;
                        if (filters.group && !group.includes(filters.group)) return false;
                        if (filters.tier && !tier.includes(filters.tier)) return false;
                        if (filters.category && !category.includes(filters.category)) return false;
                        if (general.length > 0 && !`${name} ${group} ${tier} ${category} ${path}`.includes(general)) return false;
                        return true;
                    });
                }
                if (selectedTier.value !== 'All') {
                    result = (selectedTier.value === '(none)')
                        ? result.filter(b => !b.tier)
                        : result.filter(b => b.tier === selectedTier.value);
                }
                if (selectedCategory.value !== 'All') {
                    result = (selectedCategory.value === '(uncategorized)')
                        ? result.filter(b => !b.in_game_category)
                        : result.filter(b => b.in_game_category === selectedCategory.value);
                }
                return [...result].sort((a, b) => {
                    // sort by category, then group, then tier order
                    const ca = String(a.in_game_category || '~').localeCompare(String(b.in_game_category || '~'));
                    if (ca !== 0) return ca;
                    const ga = String(a.group || '').localeCompare(String(b.group || ''));
                    if (ga !== 0) return ga;
                    const ta = TIER_ORDER.indexOf(a.tier) + 1 || 99;
                    const tb = TIER_ORDER.indexOf(b.tier) + 1 || 99;
                    return ta - tb;
                });
            });

            // Pretty-print a snake_case group id ("dragon_beard" -> "Dragon Beard")
            const prettifyGroup = (s) => String(s || '').split('_')
                .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '').join(' ').trim();

            // Group the filtered badges by family (prefer the in-game category from
            // collection_badge.binfab, fall back to the group id). Inside each group,
            // sort by tier order so Bronze..Trovium reads naturally.
            const groupedBadges = computed(() => {
                const groups = new Map();
                for (const b of filteredBadges.value) {
                    const label = b.in_game_category || prettifyGroup(b.group) || 'Other';
                    if (!groups.has(label)) groups.set(label, []);
                    groups.get(label).push(b);
                }
                const arr = Array.from(groups.entries()).map(([label, list]) => {
                    list.sort((a, b) => {
                        const ta = (TIER_ORDER.indexOf(a.tier) + 1) || 99;
                        const tb = (TIER_ORDER.indexOf(b.tier) + 1) || 99;
                        if (ta !== tb) return ta - tb;
                        return String(a.name || '').localeCompare(String(b.name || ''));
                    });
                    return {
                        label,
                        badges: list,
                        count: list.length,
                        totalMastery: list.reduce((s, x) => s + (x.mastery || 0), 0),
                    };
                });
                arr.sort((a, b) => a.label.localeCompare(b.label));
                return arr;
            });

            const totalPages = computed(() => Math.max(1, Math.ceil(groupedBadges.value.length / pageSize.value)));
            const paginatedGroups = computed(() => groupedBadges.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
            const visibleStart = computed(() => groupedBadges.value.length === 0 ? 0 : (currentPage.value - 1) * pageSize.value + 1);
            const visibleEnd = computed(() => groupedBadges.value.length === 0 ? 0 : Math.min(currentPage.value * pageSize.value, groupedBadges.value.length));
            const pageNumbers = computed(() => {
                const total = totalPages.value, current = currentPage.value;
                const pages = new Set([1, total, current - 1, current, current + 1]);
                return Array.from(pages).filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
            });
            const setPage = (p) => { currentPage.value = Math.min(totalPages.value, Math.max(1, p)); };
            const nextPage = () => setPage(currentPage.value + 1);
            const prevPage = () => setPage(currentPage.value - 1);

            watch([searchQuery, selectedTier, selectedCategory], () => { currentPage.value = 1; });
            watch(totalPages, (n) => { if (currentPage.value > n) currentPage.value = n; });
            watch([searchQuery, selectedTier, selectedCategory, currentPage], persistState, { deep: true });
            watch(selectedGamePath, async (newVal, oldVal) => {
                if (syncingGamePath || !window.CodexGamePathApi || !window.CodexGamePathApi.setSelectedPath || newVal === oldVal) return;
                applyGamePathState((await window.CodexGamePathApi.setSelectedPath(newVal)) || {});
            });

            const totalMastery = computed(() => filteredBadges.value.reduce((s, b) => s + (b.mastery || 0), 0));

            const loadBadges = async (forceRefresh = false) => {
                loadError.value = '';
                if (!(window.eel && eel.get_badges_data)) throw new Error('Backend badges endpoint is unavailable');
                const response = await eel.get_badges_data(forceRefresh, getSelectedGamePath())();
                if (!response || response.success === false) {
                    throw new Error((response && response.error) || 'Failed to retrieve badge data from backend');
                }
                const cacheUrl = String((response && response.cache_file) || (response && response.meta && response.meta.cache && response.meta.cache.cache_url) || '').trim();
                let data;
                if (cacheUrl) {
                    const cacheResp = await fetch(cacheUrl, { cache: 'no-store' });
                    if (!cacheResp.ok) throw new Error(`Failed to load badge cache file (${cacheResp.status})`);
                    data = await cacheResp.json();
                } else {
                    data = (response && response.data && typeof response.data === 'object') ? response.data : response;
                }

                const tiers = new Set(), cats = new Set();
                badgesData.value = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.tier) tiers.add(row.tier);
                    if (row.in_game_category) cats.add(row.in_game_category);
                    return {
                        id: key, ...row,
                        imagePath: `https://trovesaurus.com/data/catalog/${normalizeCatalogImageId(row.blueprint || row.filename || key)}.png`,
                    };
                });
                tierOptions.value = [['All Tiers', 'All'], ...Array.from(tiers)
                    .sort((a, b) => (TIER_ORDER.indexOf(a) + 1 || 99) - (TIER_ORDER.indexOf(b) + 1 || 99))
                    .map(t => [t, t]), ['(no tier)', '(none)']];
                categoryOptions.value = [['All Categories', 'All'], ...Array.from(cats).sort().map(c => [c, c]), ['(uncategorized)', '(uncategorized)']];

                const source = (response && response.source) || '';
                if (source === 'game-cache') dataSourceText.value = t('Loaded badge data from cached game-file scan.');
                else if (source === 'game-live') dataSourceText.value = t('Loaded badge data from live game files.');
                else dataSourceText.value = '';
            };

            const clearCacheAndReload = async () => {
                try {
                    isLoading.value = true;
                    if (window.eel && eel.clear_badges_cache) await eel.clear_badges_cache()();
                    await loadBadges(true);
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
                try { await loadBadges(false); }
                catch (err) { loadError.value = String((err && err.message) || err || 'Failed to load badges from game files.'); }
                isLoading.value = false;
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                hydratingState = false;
                document.addEventListener('codex_game_path_changed', handleCodexGamePathChanged);
            });
            onBeforeUnmount(() => {
                document.removeEventListener('codex_game_path_changed', handleCodexGamePathChanged);
            });

            return {
                t, isLoading, loadError, badgesData, filteredBadges,
                groupedBadges, paginatedGroups,
                searchQuery, selectedTier, selectedCategory, tierOptions, categoryOptions,
                currentPage, totalPages, pageNumbers, visibleStart, visibleEnd,
                setPage, nextPage, prevPage, tierColor, masteryText, totalMastery,
                selectedGamePath, installOptions, openSelectedGamePath, refreshGamePaths,
                highlightSearch, clearCacheAndReload, dataSourceText
            };
        }
    });

    try {
        if (window.CustomVueSelect) app.component('custom-vue-select', window.CustomVueSelect);
        if (window._badgesApp) window._badgesApp.unmount();
        window._badgesApp = app;
        app.mount('#badges-vue-app');
    } catch (err) {
        console.error("Failed to initialize Badge Codex app:", err);
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Failed to initialize Badge Codex: ${String((err && err.message) || err)}</div>`;
    } finally {
        delete root.dataset.badgesInitializing;
    }
}

document.addEventListener('badges_loaded', initBadgesView);
if (document.readyState !== 'loading') initBadgesView();
