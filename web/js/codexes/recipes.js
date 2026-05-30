function initRecipesView() {
    const root = document.getElementById('recipes-vue-app');
    if (!root || root.dataset.recipesInitializing === '1') return;
    root.dataset.recipesInitializing = '1';

    if (typeof Vue === 'undefined') {
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Vue failed to load for Recipe Codex.</div>`;
        return;
    }

    const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick, watch } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
            const PREF_STATE_KEY = 'state_recipes';
            let hydratingState = false;

            const isLoading = ref(true);
            const loadError = ref('');
            const recipesData = ref([]);
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
                    await loadRecipes(false);
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

            const prettyPath = (value) => String(value || '')
                .replace(/\\/g, '/')
                .replace(/^\/+/, '')
                .trim();

            const highlightSearch = (text) => {
                const q = searchQuery.value.trim();
                const safe = escapeHtml(text || '');
                if (!q) return safe;
                const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(`(${escaped})`, 'ig');
                return safe.replace(re, '<mark>$1</mark>');
            };

            const filteredRecipes = computed(() => {
                let result = recipesData.value.slice();

                const sq = searchQuery.value.toLowerCase().trim();
                if (sq.length >= 3) {
                    let generalSearch = sq;
                    const filters = { name: null, category: null, ingredient: null, output: null };
                    const regex = /(name|category|ingredient|output):("([^"]+)"|([^\s]+))/g;
                    let match;
                    while ((match = regex.exec(sq)) !== null) {
                        filters[match[1]] = (match[3] || match[4] || '').toLowerCase();
                        generalSearch = generalSearch.replace(match[0], '');
                    }
                    generalSearch = generalSearch.trim();

                    result = result.filter(recipe => {
                        const name = String(recipe.name || '').toLowerCase();
                        const category = String(recipe.category || '').toLowerCase();
                        const output = String(recipe.outputLabel || '').toLowerCase();
                        const ingredients = (recipe.ingredients || []).map(row => `${row.name} ${row.path}`.toLowerCase()).join(' ');
                        const requirements = (recipe.requirements || []).join(' ').toLowerCase();

                        if (filters.name && !name.includes(filters.name)) return false;
                        if (filters.category && !category.includes(filters.category)) return false;
                        if (filters.ingredient && !ingredients.includes(filters.ingredient)) return false;
                        if (filters.output && !output.includes(filters.output)) return false;

                        if (generalSearch.length > 0) {
                            const haystack = `${name} ${category} ${output} ${ingredients} ${requirements}`;
                            if (!haystack.includes(generalSearch)) return false;
                        }
                        return true;
                    });
                }

                if (selectedCategory.value && selectedCategory.value !== 'All') {
                    result = result.filter(recipe => recipe.category === selectedCategory.value);
                }

                return [...result].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            });

            const totalPages = computed(() => Math.max(1, Math.ceil(filteredRecipes.value.length / pageSize.value)));
            const paginatedRecipes = computed(() => filteredRecipes.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
            const visibleStart = computed(() => filteredRecipes.value.length === 0 ? 0 : (currentPage.value - 1) * pageSize.value + 1);
            const visibleEnd = computed(() => filteredRecipes.value.length === 0 ? 0 : Math.min(currentPage.value * pageSize.value, filteredRecipes.value.length));
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

            const loadRecipes = async (forceRefresh = false) => {
                loadError.value = '';
                let data = null;
                let response = null;
                if (window.eel && eel.get_recipes_data) {
                    response = await eel.get_recipes_data(forceRefresh, getSelectedGamePath())();
                    if (!response || response.success === false) {
                        throw new Error((response && response.error) || 'Failed to retrieve recipe data from backend');
                    }
                    const cacheUrl = String(
                        (response && response.cache_file)
                        || (response && response.meta && response.meta.cache && response.meta.cache.cache_url)
                        || ''
                    ).trim();
                    if (cacheUrl) {
                        const cacheResp = await fetch(cacheUrl, { cache: 'no-store' });
                        if (!cacheResp.ok) throw new Error(`Failed to load recipe cache file (${cacheResp.status})`);
                        data = await cacheResp.json();
                    } else {
                        data = (response && response.data && typeof response.data === 'object') ? response.data : response;
                    }
                } else {
                    throw new Error('Backend recipes endpoint is unavailable');
                }

                const uniqueCategories = new Set();
                const parsed = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.category) uniqueCategories.add(row.category);
                    const outputPath = prettyPath(row.output_path || '');
                    return {
                        id: key,
                        ...row,
                        outputPath,
                        outputAmount: Number(row.output_amount || 1),
                        unlockCount: Number(row.unlock_count || 0),
                        outputLabel: outputPath || prettyPath(row.filename || key),
                        imagePath: `https://trovesaurus.com/data/catalog/${normalizeCatalogImageId(row.blueprint || outputPath)}.png`,
                        ingredients: Array.isArray(row.ingredients) ? row.ingredients : [],
                        requirements: Array.isArray(row.requirements) ? row.requirements : []
                    };
                });
                recipesData.value = parsed;

                const catOpts = [['All Categories', 'All']];
                Array.from(uniqueCategories).sort().forEach(c => catOpts.push([c, c]));
                categoryOptions.value = catOpts;

                const source = (response && response.source) || '';
                const cacheMeta = (response && response.meta && response.meta.cache) || {};
                if (source === 'game-cache') dataSourceText.value = t('recipes.loaded_recipe_data_from_cached_game_file_b84260');
                else if (source === 'game-cache-stale') dataSourceText.value = t('recipes.loaded_recipe_data_from_cache_refreshing_b7261a');
                else if (source === 'game-live') dataSourceText.value = t('recipes.loaded_recipe_data_from_live_game_files');
                else dataSourceText.value = '';
                if (source && cacheMeta && cacheMeta.age_seconds !== undefined && source === 'game-cache') {
                    const hours = Math.floor((cacheMeta.age_seconds || 0) / 3600);
                    if (hours > 0) dataSourceText.value += ` ${t('common.cache_age')}: ${hours}h.`;
                }
            };

            const clearCacheAndReload = async () => {
                try {
                    isLoading.value = true;
                    if (window.eel && eel.clear_recipes_cache) await eel.clear_recipes_cache()();
                    await loadRecipes(true);
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
                    await loadRecipes(false);
                } catch (err) {
                    loadError.value = String((err && err.message) || err || 'Failed to load recipes from game files.');
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
                t, isLoading, loadError, recipesData, filteredRecipes, paginatedRecipes,
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
        if (window._recipesApp) window._recipesApp.unmount();
        window._recipesApp = app;
        app.mount('#recipes-vue-app');
    } catch (err) {
        console.error("Failed to initialize Recipe Codex app:", err);
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Failed to initialize Recipe Codex: ${String((err && err.message) || err)}</div>`;
    } finally {
        delete root.dataset.recipesInitializing;
    }
}

// Driven solely by the `recipes_loaded` event dispatched after lazy-load; the
// old readyState self-call double-initialized (mount + remount + duplicate
// fetch) once these scripts became lazy-loaded. Removed.
document.addEventListener('recipes_loaded', initRecipesView);
