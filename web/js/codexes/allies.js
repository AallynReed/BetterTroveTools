function initAlliesView() {
    const root = document.getElementById('allies-vue-app');
    if (!root || root.dataset.alliesInitializing === '1') return;
    root.dataset.alliesInitializing = '1';

    console.log("Ally Codex Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: var(--danger-ink); padding: var(--t-5);">Vue failed to load for Ally Codex.</div>`;
        return;
    }

    const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick, watch } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
            const PREF_STATE_KEY = 'state_allies';
            let hydratingState = false;

            const isLoading = ref(true);
            const loadError = ref('');
            const alliesData = ref([]);
            const dataSourceText = ref('');
            
            const categoryOptions = ref([]);
            const statsOptions = ref([]);
            const abilitiesOptions = ref([[t('allies.all_abilities'), '']]);

            const searchQuery = ref('');
            const activeResultIndex = ref(-1);
            const selectedCategory = ref('All');
            const selectedStat = ref([]);
            const selectedAbility = ref('');
            const currentPage = ref(1);
            const pageSize = ref(36);
            const toursEnabled = window.BTT_ENABLE_ONBOARDING_TOURS !== false;
            const showOnboardingTips = ref(toursEnabled && (window.AppSettings ? window.AppSettings.getPref('onboarding_allies_v1', '') !== 'dismissed' : true));
            const showSearchShortcutHint = ref(window.AppSettings ? window.AppSettings.getPref('hint_allies_search_shortcuts_v1', '') !== 'dismissed' : true);

            const resetFilters = () => {
                searchQuery.value = '';
                selectedCategory.value = 'All';
                selectedStat.value = [];
                selectedAbility.value = '';
                currentPage.value = 1;
            };

            const applyStateSnapshot = (saved) => {
                if (!saved || typeof saved !== 'object') return;
                if (typeof saved.searchQuery === 'string') searchQuery.value = saved.searchQuery;
                if (typeof saved.selectedCategory === 'string') selectedCategory.value = saved.selectedCategory;
                if (saved.selectedStat !== undefined) {
                    if (Array.isArray(saved.selectedStat)) selectedStat.value = saved.selectedStat;
                    else if (typeof saved.selectedStat === 'string' && saved.selectedStat) selectedStat.value = [saved.selectedStat];
                    else selectedStat.value = [];
                }
                if (typeof saved.selectedAbility === 'string') selectedAbility.value = saved.selectedAbility;
                if (saved.currentPage !== undefined) {
                    const parsedPage = parseInt(saved.currentPage, 10);
                    currentPage.value = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
                }
                if (saved.pageSize !== undefined) {
                    const parsedSize = parseInt(saved.pageSize, 10);
                    pageSize.value = Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 36;
                }
            };

            const persistState = () => {
                if (hydratingState || !window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    searchQuery: searchQuery.value,
                    selectedCategory: selectedCategory.value,
                    selectedStat: selectedStat.value,
                    selectedAbility: selectedAbility.value,
                    currentPage: currentPage.value,
                    pageSize: pageSize.value
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
                    activeResultIndex.value = -1;
                    await syncGamePathPicker();
                    await loadAllies(false);
                } catch (err) {
                    console.error('Failed to reload allies data for new game path:', err);
                    loadError.value = String((err && err.message) || err || 'Failed to load allies from game files.');
                } finally {
                    isLoading.value = false;
                    nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                }
            };

            const dismissOnboardingTips = () => {
                showOnboardingTips.value = false;
                if (window.AppSettings) window.AppSettings.setPrefSync('onboarding_allies_v1', 'dismissed');
            };

            const dismissSearchShortcutHint = () => {
                showSearchShortcutHint.value = false;
                if (window.AppSettings) window.AppSettings.setPrefSync('hint_allies_search_shortcuts_v1', 'dismissed');
            };

            const formatNumberWithSeparators = (value) => {
                if (typeof value !== 'number' || !Number.isFinite(value)) return '';
                const normalized = Object.is(value, -0) ? 0 : value;
                return normalized.toLocaleString(undefined, { maximumFractionDigits: 20 });
            };

            const translateText = (text) => t(String(text || '').trim());
            const formatStatValue = (stat) => {
                if (!stat || typeof stat !== 'object') return '';
                if (typeof stat.value_display === 'string' && stat.value_display.trim()) return stat.value_display.trim();
                if (typeof stat.display === 'string' && stat.display.trim()) return stat.display.trim();
                if (typeof stat.value !== 'number' || !Number.isFinite(stat.value)) return '';
                return stat.is_percent
                    ? t('common.value').replace('{value}', formatNumberWithSeparators(stat.value))
                    : formatNumberWithSeparators(stat.value);
            };

            const buildTranslatedStatLine = (stat) => {
                if (!stat || typeof stat !== 'object') return String(stat || '');
                const statName = translateText(stat.name || '');
                const formattedValue = formatStatValue(stat);
                if (formattedValue && statName) {
                    return t('common.value_stat')
                        .replace('{value}', formattedValue)
                        .replace('{stat}', statName);
                }
                return formattedValue || statName || '';
            };

            const formatStat = (statText) => {
                let statLine = typeof statText === 'string' ? statText : ((statText && statText.text) || '');
                if (statText && typeof statText === 'object' && typeof statText.value === 'number') {
                    statLine = buildTranslatedStatLine(statText);
                } else if (typeof statText === 'string') {
                    statLine = translateText(statText);
                }
                const highlightKeys = selectedStat.value || [];
                const statKey = statText && typeof statText === 'object' ? String(statText.name || '').trim() : '';
                const translatedStatKey = translateText(statKey);
                const isHighlighted = highlightKeys.length > 0 && (
                    (statKey && highlightKeys.includes(statKey)) ||
                    (translatedStatKey && highlightKeys.includes(translatedStatKey))
                );
                const safeLine = escapeHtml(statLine);
                return isHighlighted ? `<strong>${safeLine}</strong>` : safeLine;
            };

            const formatAbility = (abilityText) => {
                const translatedAbility = translateText(abilityText);
                const isHighlighted = !!selectedAbility.value && selectedAbility.value === abilityText;
                const safeAbility = escapeHtml(translatedAbility);
                return isHighlighted ? `<strong>${safeAbility}</strong>` : safeAbility;
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
                .replace(/^[^a-z0-9_/]+/i, '')
                .trim()
                .toLowerCase();

            const highlightSearch = (text) => {
                const q = searchQuery.value.trim();
                const safe = escapeHtml(text || '');
                if (!q) return safe;
                const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(`(${escaped})`, 'ig');
                return safe.replace(re, '<mark>$1</mark>');
            };

            const filteredAllies = computed(() => {
                let result = alliesData.value.filter(a => {
                    const category = a.category || 'Unknown';
                    return category !== 'Unknown' && category !== 'InProgress';
                });
                
                const sq = searchQuery.value.toLowerCase().trim();
                if (sq.length >= 3) {
                    let generalSearch = sq;
                    let filters = { author: null, name: null, ability: null, desc: null, category: null };

                    const regex = /(author|designer|name|ability|desc|category):("([^"]+)"|([^\s]+))/g;
                    let match;
                    while ((match = regex.exec(sq)) !== null) {
                        const key = match[1] === 'designer' ? 'author' : match[1];
                        filters[key] = match[3] || match[4];
                        generalSearch = generalSearch.replace(match[0], '');
                    }
                    generalSearch = generalSearch.trim();

                    result = result.filter(a => {
                        const translatedName = translateText(a.name).toLowerCase();
                        const translatedDesc = translateText(a.desc).toLowerCase();
                        const translatedCategory = translateText(a.category).toLowerCase();
                        const translatedAbilities = a.extractedAbilities.map(ab => translateText(ab).toLowerCase());

                        if (filters.author && !(a.designer && a.designer.toLowerCase().includes(filters.author))) return false;
                        if (filters.name && !translatedName.includes(filters.name)) return false;
                        if (filters.ability && !translatedAbilities.some(ab => ab.includes(filters.ability))) return false;
                        if (filters.desc && !translatedDesc.includes(filters.desc)) return false;
                        if (filters.category && !translatedCategory.includes(filters.category)) return false;

                        if (generalSearch.length > 0) {
                            const translatedStats = a.rawStats.map(stat => typeof stat === 'object' ? buildTranslatedStatLine(stat).toLowerCase() : translateText(stat).toLowerCase());
                            const matchGeneral = translatedName.includes(generalSearch) || 
                                                 (a.designer && a.designer.toLowerCase().includes(generalSearch)) ||
                                                 translatedDesc.includes(generalSearch) ||
                                                 translatedCategory.includes(generalSearch) ||
                                                 translatedAbilities.some(ab => ab.includes(generalSearch)) ||
                                                 translatedStats.some(stat => stat.includes(generalSearch));
                            if (!matchGeneral) return false;
                        }
                        return true;
                    });
                }

                if (selectedCategory.value && selectedCategory.value !== 'All') {
                    result = result.filter(a => a.category === selectedCategory.value);
                }

                if (selectedStat.value && selectedStat.value.length > 0) {
                    result = result.filter(a => selectedStat.value.every(stat => a.parsedStats[stat] !== undefined));

                    const primary = selectedStat.value[0];
                    result.sort((a, b) => {
                        const sA = a.parsedStats[primary];
                        const sB = b.parsedStats[primary];
                        if (sA.isPercent && !sB.isPercent) return -1;
                        if (!sA.isPercent && sB.isPercent) return 1;
                        return sB.value - sA.value;
                    });
                } else {
                    result = [...result].sort((a, b) => a.name.localeCompare(b.name));
                }

                if (selectedAbility.value) {
                    result = result.filter(a => a.extractedAbilities.includes(selectedAbility.value));
                }

                return result;
            });

            const totalPages = computed(() => Math.max(1, Math.ceil(filteredAllies.value.length / pageSize.value)));

            const paginatedAllies = computed(() => {
                const start = (currentPage.value - 1) * pageSize.value;
                const end = start + pageSize.value;
                return filteredAllies.value.slice(start, end);
            });

            const visibleStart = computed(() => {
                if (filteredAllies.value.length === 0) return 0;
                return (currentPage.value - 1) * pageSize.value + 1;
            });

            const visibleEnd = computed(() => {
                if (filteredAllies.value.length === 0) return 0;
                return Math.min(currentPage.value * pageSize.value, filteredAllies.value.length);
            });

            const pageNumbers = computed(() => {
                const total = totalPages.value;
                const current = currentPage.value;
                const pages = new Set([1, total, current - 1, current, current + 1]);
                return Array.from(pages).filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
            });

            const setPage = (page) => {
                currentPage.value = Math.min(totalPages.value, Math.max(1, page));
                activeResultIndex.value = -1;
            };

            const nextPage = () => setPage(currentPage.value + 1);
            const prevPage = () => setPage(currentPage.value - 1);

            watch([searchQuery, selectedCategory, selectedStat, selectedAbility], () => {
                currentPage.value = 1;
                activeResultIndex.value = -1;
            });

            watch(selectedStat, (newValue) => {
                if (!Array.isArray(newValue)) return;
                if (newValue.length > 3) {
                    selectedStat.value = newValue.slice(0, 3);
                }
            }, { deep: true });

            watch(totalPages, (newTotal) => {
                if (currentPage.value > newTotal) currentPage.value = newTotal;
            });

            watch([searchQuery, selectedCategory, selectedStat, selectedAbility, currentPage, pageSize], persistState, { deep: true });

            const setActiveResult = (index) => {
                const cards = Array.from(document.querySelectorAll('#allies-vue-app .ally-card'));
                cards.forEach(c => c.classList.remove('kbd-active-result'));
                if (!cards.length) {
                    activeResultIndex.value = -1;
                    return;
                }
                const normalized = ((index % cards.length) + cards.length) % cards.length;
                activeResultIndex.value = normalized;
                cards[normalized].classList.add('kbd-active-result');
                cards[normalized].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            };

            const nextSearchResult = () => setActiveResult(activeResultIndex.value + 1);
            const prevSearchResult = () => setActiveResult(activeResultIndex.value - 1);

            const focusSearchInput = () => {
                const input = document.getElementById('ally-search-input');
                if (!input) return;
                input.focus();
                input.select();
            };


            watch(selectedGamePath, async (newVal, oldVal) => {
                if (syncingGamePath || !window.CodexGamePathApi || !window.CodexGamePathApi.setSelectedPath || newVal === oldVal) return;
                const state = await window.CodexGamePathApi.setSelectedPath(newVal);
                applyGamePathState(state || {});
            });

            const loadAllies = async (forceRefresh = false) => {
                loadError.value = '';
                let data = null;
                let response = null;

                if (window.eel && eel.get_allies_data) {
                    response = await eel.get_allies_data(forceRefresh, getSelectedGamePath())();
                    if (!response || response.success === false) {
                        throw new Error((response && response.error) || 'Failed to retrieve allies data from backend');
                    }
                    const cacheUrl = String(
                        (response && response.cache_file)
                        || (response && response.meta && response.meta.cache && response.meta.cache.cache_url)
                        || ''
                    ).trim();
                    if (cacheUrl) {
                        const cacheResp = await fetch(cacheUrl, { cache: 'no-store' });
                        if (!cacheResp.ok) throw new Error(`Failed to load ally cache file (${cacheResp.status})`);
                        data = await cacheResp.json();
                    } else {
                        data = (response && response.data && typeof response.data === 'object') ? response.data : response;
                    }
                } else {
                    throw new Error('Backend allies endpoint is unavailable');
                }

                const uniqueCategories = new Set();
                const uniqueStats = new Set();
                const uniqueAbilities = new Set();

                const parsedAllies = Object.keys(data).map(key => {
                    const ally = data[key];
                    if (ally.category) uniqueCategories.add(ally.category);
                    const parsedStats = {};
                    const stats = Array.isArray(ally.stats) ? ally.stats : [];
                    const rawStats = stats.filter(stat => stat && ((typeof stat.text === 'string' && stat.text) || (typeof stat.value === 'number' && stat.name)));
                    stats.forEach(stat => {
                        const statName = (stat && stat.name) || '';
                        if (!statName) return;
                        uniqueStats.add(statName);
                        parsedStats[statName] = {
                            value: stat && typeof stat.value === 'number' ? stat.value : parseFloat((stat && stat.value) || 0),
                            isPercent: !!(stat && stat.is_percent)
                        };
                    });

                    const abilities = Array.isArray(ally.abilities) ? ally.abilities.filter(Boolean) : [];
                    abilities.forEach(ab => uniqueAbilities.add(ab));

                    const explicitImage = String(ally.image || '');
                    const catalogId = normalizeCatalogImageId(ally.blueprint || explicitImage);
                    const imagePath = explicitImage.startsWith('http')
                        ? explicitImage
                        : `https://trovesaurus.com/data/catalog/${catalogId}.png`;

                    return {
                        id: key,
                        ...ally,
                        rawStats,
                        parsedStats,
                        extractedAbilities: abilities,
                        imagePath
                    };
                });

                alliesData.value = parsedAllies;

                const catOpts = [['All Categories', 'All']];
                Array.from(uniqueCategories).sort().forEach(c => catOpts.push([c, c]));
                categoryOptions.value = catOpts;

                // A-Z by the name the dropdown shows, not by the raw key: the two
                // disagree once translated (SpellDamage reads "Magic Damage").
                statsOptions.value = Array.from(uniqueStats).map(s => ({ id: s, text: t(s) }))
                    .sort((a, b) => a.text.localeCompare(b.text));
                abilitiesOptions.value = [[t('allies.all_abilities'), '']].concat(
                    Array.from(uniqueAbilities).map(a => [t(a), a]).sort((x, y) => x[0].localeCompare(y[0])));

                const source = (response && response.source) || '';
                const cacheMeta = (response && response.meta && response.meta.cache) || {};
                if (source === 'game-cache') {
                    dataSourceText.value = t('allies.loaded_ally_data_from_cached_game_file_s_3ece41');
                } else if (source === 'game-cache-stale') {
                    dataSourceText.value = t('allies.loaded_ally_data_from_cache_refreshing_i_13cb40');
                } else if (source === 'game-live') {
                    dataSourceText.value = t('allies.loaded_ally_data_from_live_game_files');
                } else {
                    dataSourceText.value = '';
                }
                if (source && cacheMeta && cacheMeta.age_seconds !== undefined && source === 'game-cache') {
                    const hours = Math.floor((cacheMeta.age_seconds || 0) / 3600);
                    if (hours > 0) dataSourceText.value += ` ${t('common.cache_age')}: ${hours}h.`;
                }
            };

            const exportCsv = () => {
                if (!window.CodexExport) return;
                const { joinList, statsText } = window.CodexExport;
                window.CodexExport.run({
                    rows: filteredAllies.value,
                    basename: 'allies',
                    t,
                    columns: [
                        { label: 'Name', value: (row) => t(row.name) },
                        { label: 'Category', value: (row) => t(row.category || 'Unknown') },
                        { label: 'Description', value: (row) => t(row.desc || '') },
                        { label: 'Mastery', value: (row) => row.mastery || '0' },
                        { label: 'Geode Mastery', value: (row) => row.mastery_geode || '0' },
                        { label: 'Power Rank', value: (row) => row.powerrank || '' },
                        { label: 'Stats', value: (row) => statsText(row.rawStats) },
                        { label: 'Abilities', value: (row) => joinList((row.extractedAbilities || []).map(a => t(a))) },
                        { label: 'Designer', value: (row) => row.designer || '' },
                        { label: 'Path', value: (row) => row.filename || '' },
                        { label: 'Blueprint', value: (row) => row.blueprint || '' },
                        { label: 'ID', value: (row) => row.id || '' },
                    ],
                });
            };

            const clearCacheAndReload = async () => {
                try {
                    isLoading.value = true;
                    if (window.eel && eel.clear_allies_cache) {
                        await eel.clear_allies_cache()();
                    }
                    await loadAllies(true);
                } catch (err) {
                    console.error("Failed to clear ally cache:", err);
                } finally {
                    isLoading.value = false;
                    nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                }
            };

            const onKeyDown = (e) => {
                const root = document.getElementById('allies-vue-app');
                if (!root || root.offsetParent === null) return;
                if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'f') {
                    const input = document.getElementById('ally-search-input');
                    if (input) {
                        e.preventDefault();
                        input.focus();
                        input.select();
                    }
                    return;
                }
                const activeEl = document.activeElement;
                if (activeEl && activeEl.id === 'ally-search-input') {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        nextSearchResult();
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        prevSearchResult();
                    }
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
                    await loadAllies(false);
                } catch (err) {
                    console.error("Failed to load allies data:", err);
                    loadError.value = String((err && err.message) || err || 'Failed to load allies from game files.');
                }
                
                isLoading.value = false;
                document.addEventListener('keydown', onKeyDown);
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                hydratingState = false;
                document.addEventListener('codex_game_path_changed', handleCodexGamePathChanged);
            });

            onBeforeUnmount(() => {
                document.removeEventListener('keydown', onKeyDown);
                document.removeEventListener('codex_game_path_changed', handleCodexGamePathChanged);
            });

            return {
                t, isLoading, loadError, alliesData, filteredAllies, paginatedAllies,
                searchQuery, selectedCategory, selectedStat, selectedAbility,
                categoryOptions, statsOptions, abilitiesOptions,
                currentPage, totalPages, pageNumbers, visibleStart, visibleEnd,
                setPage, nextPage, prevPage,
                selectedGamePath, installOptions, openSelectedGamePath, refreshGamePaths,
                resetFilters, formatStat, formatAbility,
                highlightSearch, nextSearchResult, prevSearchResult,
                focusSearchInput, clearCacheAndReload, exportCsv, dataSourceText,
                showSearchShortcutHint, dismissSearchShortcutHint,
                showOnboardingTips, dismissOnboardingTips
            };
        }
    });

    try {
        if (window.CustomVueSelect) app.component('custom-vue-select', window.CustomVueSelect);
        if (window.MultiSelect) app.component('multi-select', window.MultiSelect);

        if (window._alliesApp) window._alliesApp.unmount();
        window._alliesApp = app;

        app.mount('#allies-vue-app');
    } catch (err) {
        console.error("Failed to initialize Ally Codex app:", err);
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: var(--danger-ink); padding: var(--t-5);">Failed to initialize Ally Codex: ${String((err && err.message) || err)}</div>`;
    } finally {
        delete root.dataset.alliesInitializing;
    }
}

document.addEventListener('allies_loaded', initAlliesView);
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initAlliesView, 0);
});
