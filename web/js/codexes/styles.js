function initStylesView() {
    const root = document.getElementById('styles-vue-app');
    if (!root || root.dataset.stylesInitializing === '1') return;
    root.dataset.stylesInitializing = '1';

    if (typeof Vue === 'undefined') {
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: var(--danger-ink); padding: var(--t-5);">Vue failed to load for Style Codex.</div>`;
        return;
    }

    const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick, watch } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
            const PREF_STATE_KEY = 'state_styles';
            let hydratingState = false;

            const isLoading = ref(true);
            const loadError = ref('');
            const stylesData = ref([]);
            const dataSourceText = ref('');
            const familyOptions = ref([['All Families', 'All']]);
            const masteryOptions = ref([
                ['All Mastery', 'All'],
                ['Has mastery', 'has'],
                ['Review-only', 'review'],
            ]);
            const searchQuery = ref('');
            const selectedFamily = ref('All');
            const selectedMastery = ref('All');
            const currentPage = ref(1);
            const pageSize = ref(8);   // families per page in grouped view

            const applyStateSnapshot = (saved) => {
                if (!saved || typeof saved !== 'object') return;
                if (typeof saved.searchQuery === 'string') searchQuery.value = saved.searchQuery;
                if (typeof saved.selectedFamily === 'string') selectedFamily.value = saved.selectedFamily;
                if (typeof saved.selectedMastery === 'string') selectedMastery.value = saved.selectedMastery;
                if (saved.currentPage !== undefined) {
                    const p = parseInt(saved.currentPage, 10);
                    currentPage.value = Number.isFinite(p) && p > 0 ? p : 1;
                }
            };
            const persistState = () => {
                if (hydratingState || !window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    searchQuery: searchQuery.value,
                    selectedFamily: selectedFamily.value,
                    selectedMastery: selectedMastery.value,
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
                    await loadStyles(false);
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

            const filteredStyles = computed(() => {
                let result = stylesData.value.slice();
                const sq = searchQuery.value.toLowerCase().trim();
                if (sq.length >= 3) {
                    let general = sq;
                    const filters = { name: null, family: null, equipment: null };
                    const regex = /(name|family|equipment):("([^"]+)"|([^\s]+))/g;
                    let m;
                    while ((m = regex.exec(sq)) !== null) {
                        filters[m[1]] = (m[3] || m[4] || '').toLowerCase();
                        general = general.replace(m[0], '');
                    }
                    general = general.trim();
                    result = result.filter(s => {
                        const name = String(s.name || '').toLowerCase();
                        const family = String(s.family || '').toLowerCase();
                        const equipment = String(s.equipment_ref || '').toLowerCase();
                        const path = String(s.filename || '').toLowerCase();
                        if (filters.name && !name.includes(filters.name)) return false;
                        if (filters.family && !family.includes(filters.family)) return false;
                        if (filters.equipment && !equipment.includes(filters.equipment)) return false;
                        if (general.length > 0 && !`${name} ${family} ${equipment} ${path}`.includes(general)) return false;
                        return true;
                    });
                }
                if (selectedFamily.value !== 'All') {
                    result = (selectedFamily.value === '(none)')
                        ? result.filter(s => !s.family)
                        : result.filter(s => s.family === selectedFamily.value);
                }
                if (selectedMastery.value === 'has') {
                    result = result.filter(s => s.mastery != null);
                } else if (selectedMastery.value === 'review') {
                    result = result.filter(s => s.mastery == null);
                }
                return [...result].sort((a, b) => {
                    const fa = String(a.family || '~').localeCompare(String(b.family || '~'));
                    if (fa !== 0) return fa;
                    return String(a.name || '').localeCompare(String(b.name || ''));
                });
            });

            // Group the filtered styles by family (Hat / Face / Weapon / Banner).
            const groupedStyles = computed(() => {
                const groups = new Map();
                for (const s of filteredStyles.value) {
                    const label = s.family || 'Other';
                    if (!groups.has(label)) groups.set(label, []);
                    groups.get(label).push(s);
                }
                const arr = Array.from(groups.entries()).map(([label, list]) => {
                    list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
                    return {
                        label,
                        styles: list,
                        count: list.length,
                        totalMastery: list.reduce((s, x) => s + (x.mastery || 0), 0),
                    };
                });
                arr.sort((a, b) => a.label.localeCompare(b.label));
                return arr;
            });

            const totalPages = computed(() => Math.max(1, Math.ceil(groupedStyles.value.length / pageSize.value)));
            const paginatedGroups = computed(() => groupedStyles.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
            const visibleStart = computed(() => groupedStyles.value.length === 0 ? 0 : (currentPage.value - 1) * pageSize.value + 1);
            const visibleEnd = computed(() => groupedStyles.value.length === 0 ? 0 : Math.min(currentPage.value * pageSize.value, groupedStyles.value.length));
            const pageNumbers = computed(() => {
                const total = totalPages.value, current = currentPage.value;
                const pages = new Set([1, total, current - 1, current, current + 1]);
                return Array.from(pages).filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
            });
            const setPage = (p) => { currentPage.value = Math.min(totalPages.value, Math.max(1, p)); };
            const nextPage = () => setPage(currentPage.value + 1);
            const prevPage = () => setPage(currentPage.value - 1);

            watch([searchQuery, selectedFamily, selectedMastery], () => { currentPage.value = 1; });
            watch(totalPages, (n) => { if (currentPage.value > n) currentPage.value = n; });
            watch([searchQuery, selectedFamily, selectedMastery, currentPage], persistState, { deep: true });
            watch(selectedGamePath, async (newVal, oldVal) => {
                if (syncingGamePath || !window.CodexGamePathApi || !window.CodexGamePathApi.setSelectedPath || newVal === oldVal) return;
                applyGamePathState((await window.CodexGamePathApi.setSelectedPath(newVal)) || {});
            });

            const totalMastery = computed(() => filteredStyles.value.reduce((s, x) => s + (x.mastery || 0), 0));

            const loadStyles = async (forceRefresh = false) => {
                loadError.value = '';
                if (!(window.eel && eel.get_styles_data)) throw new Error('Backend styles endpoint is unavailable');
                const response = await eel.get_styles_data(forceRefresh, getSelectedGamePath())();
                if (!response || response.success === false) {
                    throw new Error((response && response.error) || 'Failed to retrieve style data from backend');
                }
                const cacheUrl = String((response && response.cache_file) || (response && response.meta && response.meta.cache && response.meta.cache.cache_url) || '').trim();
                let data;
                if (cacheUrl) {
                    const cacheResp = await fetch(cacheUrl, { cache: 'no-store' });
                    if (!cacheResp.ok) throw new Error(`Failed to load style cache file (${cacheResp.status})`);
                    data = await cacheResp.json();
                } else {
                    data = (response && response.data && typeof response.data === 'object') ? response.data : response;
                }

                const families = new Set();
                stylesData.value = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.family) families.add(row.family);
                    return {
                        id: key, ...row,
                        imagePath: `https://trovesaurus.com/data/catalog/${normalizeCatalogImageId(row.blueprint || row.equipment_ref || row.filename || key)}.png`,
                    };
                });
                familyOptions.value = [['All Families', 'All'], ...Array.from(families).sort().map(f => [f, f]), ['(no family)', '(none)']];

                const source = (response && response.source) || '';
                if (source === 'game-cache') dataSourceText.value = t('styles.loaded_style_data_from_cached_game_files');
                else if (source === 'game-live') dataSourceText.value = t('styles.loaded_style_data_from_live_game_files');
                else dataSourceText.value = '';
            };

            const exportCsv = () => {
                if (!window.CodexExport) return;
                window.CodexExport.run({
                    rows: filteredStyles.value,
                    basename: 'styles',
                    t,
                    columns: [
                        { label: 'Name', value: (row) => t(row.name) },
                        { label: 'Family', value: (row) => t(row.family || '') },
                        { label: 'Category', value: (row) => t(row.category || '') },
                        { label: 'Description', value: (row) => t(row.desc || '') },
                        { label: 'Mastery', value: (row) => row.mastery || 0 },
                        { label: 'Geode Mastery', value: (row) => row.mastery_geode || 0 },
                        { label: 'Equipment Ref', value: (row) => row.equipment_ref || '' },
                        { label: 'Path', value: (row) => row.filename || '' },
                        { label: 'Blueprint', value: (row) => row.blueprint || '' },
                        { label: 'ID', value: (row) => row.id || '' },
                    ],
                });
            };

            const clearCacheAndReload = async () => {
                try {
                    isLoading.value = true;
                    if (window.eel && eel.clear_styles_cache) await eel.clear_styles_cache()();
                    await loadStyles(true);
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
                try { await loadStyles(false); }
                catch (err) { loadError.value = String((err && err.message) || err || 'Failed to load styles from game files.'); }
                isLoading.value = false;
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                hydratingState = false;
                document.addEventListener('codex_game_path_changed', handleCodexGamePathChanged);
            });
            onBeforeUnmount(() => {
                document.removeEventListener('codex_game_path_changed', handleCodexGamePathChanged);
            });

            return {
                t, isLoading, loadError, stylesData, filteredStyles,
                groupedStyles, paginatedGroups,
                searchQuery, selectedFamily, selectedMastery, familyOptions, masteryOptions,
                currentPage, totalPages, pageNumbers, visibleStart, visibleEnd,
                setPage, nextPage, prevPage, totalMastery,
                selectedGamePath, installOptions, openSelectedGamePath, refreshGamePaths,
                highlightSearch, clearCacheAndReload, exportCsv, dataSourceText
            };
        }
    });

    try {
        if (window.CustomVueSelect) app.component('custom-vue-select', window.CustomVueSelect);
        if (window._stylesApp) window._stylesApp.unmount();
        window._stylesApp = app;
        app.mount('#styles-vue-app');
    } catch (err) {
        console.error("Failed to initialize Style Codex app:", err);
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: var(--danger-ink); padding: var(--t-5);">Failed to initialize Style Codex: ${String((err && err.message) || err)}</div>`;
    } finally {
        delete root.dataset.stylesInitializing;
    }
}

document.addEventListener('styles_loaded', initStylesView);
