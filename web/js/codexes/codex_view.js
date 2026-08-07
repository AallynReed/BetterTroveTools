/* Shared plumbing for the codex views (badges, fish, styles, ...).
 *
 * Every codex view is the same shell around a different dataset: guarded mount,
 * game-path picker, search + filter state persisted to prefs, pagination, and a
 * loader that resolves the backend's cache URL. Only the filtering, grouping and
 * CSV columns are actually per-codex, so everything else lives here once.
 *
 * A view does:
 *
 *     const kit = window.CodexView.create({ key: 'fish', singular: 'fish', ... });
 *     const { selectedSource, selectedRarity } = kit.filters;
 *     const groupedFish = computed(() => ...);
 *     kit.paginate(groupedFish);
 *     return { ...kit.expose(), groupedFish, ... };
 *
 * Loaded before the view scripts by BTT_CODEX_SUBVIEW_SCRIPTS in main.js.
 */
(function () {
    'use strict';

    const FAIL_STYLE = 'color: var(--danger-ink); padding: var(--t-5);';
    const failHtml = (message) =>
        `<div class="search-stats" style="${FAIL_STYLE}">${message}</div>`;

    // Guarded init + mount. Derives the root id, re-entry flag and app global from
    // `key`, which every codex view already names consistently.
    function boot(key, label, setup) {
        const rootId = `${key}-vue-app`;
        const flag = `${key}Initializing`;
        const root = document.getElementById(rootId);
        if (!root || root.dataset[flag] === '1') return;
        root.dataset[flag] = '1';

        if (typeof Vue === 'undefined') {
            root.removeAttribute('v-cloak');
            root.innerHTML = failHtml(`Vue failed to load for ${label} Codex.`);
            return;
        }

        const app = Vue.createApp({ setup });
        try {
            if (window.CustomVueSelect) app.component('custom-vue-select', window.CustomVueSelect);
            const globalName = `_${key}App`;
            if (window[globalName]) window[globalName].unmount();
            window[globalName] = app;
            app.mount(`#${rootId}`);
        } catch (err) {
            console.error(`Failed to initialize ${label} Codex app:`, err);
            root.removeAttribute('v-cloak');
            root.innerHTML = failHtml(`Failed to initialize ${label} Codex: ${String((err && err.message) || err)}`);
        } finally {
            delete root.dataset[flag];
        }
    }

    function create(config) {
        const { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;

        const key = config.key;
        const singular = config.singular || key;
        const plural = config.plural || key;
        const t = (str, p) => (window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str);

        const PREF_STATE_KEY = `state_${key}`;
        let hydratingState = false;

        const isLoading = ref(true);
        const loadError = ref('');
        const dataSourceText = ref('');
        const searchQuery = ref('');
        const currentPage = ref(1);
        const pageSize = ref(config.pageSize || 8);

        // Filter refs are declared by the view as { name: initialValue }; they take
        // part in state persistence and reset the page when changed.
        const filters = {};
        for (const [name, initial] of Object.entries(config.filters || {})) {
            filters[name] = ref(initial);
        }
        const filterNames = Object.keys(filters);
        const filterRefs = filterNames.map((name) => filters[name]);

        // --- persisted view state -----------------------------------------
        const applyStateSnapshot = (saved) => {
            if (!saved || typeof saved !== 'object') return;
            if (typeof saved.searchQuery === 'string') searchQuery.value = saved.searchQuery;
            for (const name of filterNames) {
                if (typeof saved[name] === 'string') filters[name].value = saved[name];
            }
            if (saved.currentPage !== undefined) {
                const p = parseInt(saved.currentPage, 10);
                currentPage.value = Number.isFinite(p) && p > 0 ? p : 1;
            }
        };
        const persistState = () => {
            if (hydratingState || !window.AppSettings) return;
            // Key order matches what the views wrote before this was shared, so an
            // existing settings.json entry round-trips byte-identically.
            const snapshot = { searchQuery: searchQuery.value };
            for (const name of filterNames) snapshot[name] = filters[name].value;
            snapshot.currentPage = currentPage.value;
            window.AppSettings.setPrefSync(PREF_STATE_KEY, snapshot);
        };

        // --- game install picker ------------------------------------------
        const getSelectedGamePath = () => (window.getSelectedCodexGamePath ? window.getSelectedCodexGamePath() : '');
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

        // --- text helpers --------------------------------------------------
        const escapeHtml = (txt) => String(txt || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const normalizeCatalogImageId = (value) => String(value || '')
            .replace(/\.blueprint$/i, '').replace(/\\/g, '/').replace(/^\$+/, '')
            .replace(/^\/+/, '').replace(/^[^a-z0-9_/]+/i, '').trim().toLowerCase();
        const catalogImage = (value) =>
            `https://trovesaurus.com/data/catalog/${normalizeCatalogImageId(value)}.png`;
        const highlightSearch = (text) => {
            const q = searchQuery.value.trim();
            const safe = escapeHtml(text || '');
            if (!q) return safe;
            const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return safe.replace(new RegExp(`(${escaped})`, 'ig'), '<mark>$1</mark>');
        };

        // --- pagination ----------------------------------------------------
        // The view hands its paginated list in via paginate(); reading it lazily
        // lets the kit exist before the computed that depends on it.
        const source = shallowRef(null);
        const sourceLength = () => (source.value ? source.value.value.length : 0);
        const paginate = (list) => { source.value = list; };

        const totalPages = computed(() => Math.max(1, Math.ceil(sourceLength() / pageSize.value)));
        const paginatedItems = computed(() => (source.value
            ? source.value.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value)
            : []));
        const visibleStart = computed(() => (sourceLength() === 0 ? 0 : (currentPage.value - 1) * pageSize.value + 1));
        const visibleEnd = computed(() => (sourceLength() === 0 ? 0 : Math.min(currentPage.value * pageSize.value, sourceLength())));
        const pageNumbers = computed(() => {
            const total = totalPages.value, current = currentPage.value;
            const pages = new Set([1, total, current - 1, current, current + 1]);
            return Array.from(pages).filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
        });
        const setPage = (p) => { currentPage.value = Math.min(totalPages.value, Math.max(1, p)); };
        const nextPage = () => setPage(currentPage.value + 1);
        const prevPage = () => setPage(currentPage.value - 1);

        const resetFilters = () => {
            searchQuery.value = '';
            for (const [name, initial] of Object.entries(config.filters || {})) filters[name].value = initial;
            currentPage.value = 1;
        };

        watch([searchQuery, ...filterRefs], () => { currentPage.value = 1; });
        // The grouped views clamp the page when the list shrinks; the flat ones
        // never did, and a restored out-of-range page is visible there, so this
        // stays opt-out rather than silently changing their behaviour.
        if (config.clampPage !== false) {
            watch(totalPages, (n) => { if (currentPage.value > n) currentPage.value = n; });
        }
        watch([searchQuery, ...filterRefs, currentPage], persistState, { deep: true });
        watch(selectedGamePath, async (newVal, oldVal) => {
            if (syncingGamePath || !window.CodexGamePathApi || !window.CodexGamePathApi.setSelectedPath || newVal === oldVal) return;
            applyGamePathState((await window.CodexGamePathApi.setSelectedPath(newVal)) || {});
        });

        // --- loading -------------------------------------------------------
        // The dataset itself is served from /api/cache/<file> rather than pushed
        // over the eel bridge; the endpoint only hands back the URL and metadata.
        const load = async (forceRefresh = false) => {
            loadError.value = '';
            const endpoint = `get_${key}_data`;
            if (!(window.eel && eel[endpoint])) throw new Error(`Backend ${plural} endpoint is unavailable`);
            const response = await eel[endpoint](forceRefresh, getSelectedGamePath())();
            if (!response || response.success === false) {
                throw new Error((response && response.error) || `Failed to retrieve ${singular} data from backend`);
            }
            const cacheUrl = String((response && response.cache_file)
                || (response && response.meta && response.meta.cache && response.meta.cache.cache_url) || '').trim();
            let data;
            if (cacheUrl) {
                const cacheResp = await fetch(cacheUrl, { cache: 'no-store' });
                if (!cacheResp.ok) throw new Error(`Failed to load ${singular} cache file (${cacheResp.status})`);
                data = await cacheResp.json();
            } else {
                data = (response && response.data && typeof response.data === 'object') ? response.data : response;
            }

            config.ingest(data, response);

            const sourceKey = (response && response.source) || '';
            const textId = (config.sourceText || {})[sourceKey];
            dataSourceText.value = textId ? t(textId) : '';
            // The flat views also say how stale a served cache is.
            if (config.cacheAgeSuffix && sourceKey === 'game-cache') {
                const cacheMeta = (response && response.meta && response.meta.cache) || {};
                if (cacheMeta.age_seconds !== undefined) {
                    const hours = Math.floor((cacheMeta.age_seconds || 0) / 3600);
                    if (hours > 0) dataSourceText.value += ` ${t('common.cache_age')}: ${hours}h.`;
                }
            }
        };

        const refreshDropdowns = () => nextTick(() => {
            if (window.applyCustomDropdowns) window.applyCustomDropdowns();
        });

        const clearCacheAndReload = async () => {
            try {
                isLoading.value = true;
                if (window.eel && eel[`clear_${key}_cache`]) await eel[`clear_${key}_cache`]()();
                await load(true);
            } finally {
                isLoading.value = false;
                refreshDropdowns();
            }
        };

        const handleCodexGamePathChanged = async () => {
            try {
                isLoading.value = true;
                await syncGamePathPicker();
                await load(false);
            } catch (err) {
                loadError.value = String((err && err.message) || err || 'Failed to load data from game files.');
            } finally {
                isLoading.value = false;
                refreshDropdowns();
            }
        };

        onMounted(async () => {
            hydratingState = true;
            if (window.AppSettings) {
                await window.AppSettings.load();
                applyStateSnapshot(window.AppSettings.getPref(PREF_STATE_KEY, null));
            }
            await syncGamePathPicker();
            try { await load(false); }
            catch (err) { loadError.value = String((err && err.message) || err || `Failed to load ${plural} from game files.`); }
            isLoading.value = false;
            refreshDropdowns();
            hydratingState = false;
            document.addEventListener('codex_game_path_changed', handleCodexGamePathChanged);
        });
        onBeforeUnmount(() => {
            document.removeEventListener('codex_game_path_changed', handleCodexGamePathChanged);
        });

        // Everything the shared template markup binds to. A view spreads this into
        // its setup() return and adds its own data, computeds and helpers.
        const expose = () => ({
            t, isLoading, loadError, dataSourceText,
            searchQuery, currentPage, totalPages, pageNumbers, visibleStart, visibleEnd,
            setPage, nextPage, prevPage,
            selectedGamePath, installOptions, openSelectedGamePath, refreshGamePaths,
            highlightSearch, clearCacheAndReload,
            ...filters,
        });

        return {
            t, isLoading, loadError, dataSourceText, searchQuery, currentPage, pageSize,
            filters, escapeHtml, normalizeCatalogImageId, catalogImage, highlightSearch,
            paginate, paginatedItems, totalPages, pageNumbers, visibleStart, visibleEnd,
            setPage, nextPage, prevPage, resetFilters,
            installOptions, selectedGamePath, openSelectedGamePath, refreshGamePaths,
            load, clearCacheAndReload, expose,
        };
    }

    window.CodexView = { boot, create };
})();
