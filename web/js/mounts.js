function initMountsView() {
    const root = document.getElementById('mounts-vue-app');
    if (!root || root.dataset.mountsInitializing === '1') return;
    root.dataset.mountsInitializing = '1';

    if (typeof Vue === 'undefined') {
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Vue failed to load for Mount Codex.</div>`;
        return;
    }

    const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick, watch } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
            const PREF_STATE_KEY = 'state_mounts';
            let hydratingState = false;

            const isLoading = ref(true);
            const loadError = ref('');
            const mountsData = ref([]);
            const dataSourceText = ref('');

            const categoryOptions = ref([]);
            const statsOptions = ref([]);

            const searchQuery = ref('');
            const activeResultIndex = ref(-1);
            const selectedCategory = ref('All');
            const selectedStat = ref([]);
            const currentPage = ref(1);
            const pageSize = ref(36);

            const resetFilters = () => {
                searchQuery.value = '';
                selectedCategory.value = 'All';
                selectedStat.value = [];
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
                    currentPage: currentPage.value,
                    pageSize: pageSize.value
                });
            };

            const formatNumberWithSeparators = (value) => {
                if (typeof value !== 'number' || !Number.isFinite(value)) return '';
                const normalized = Object.is(value, -0) ? 0 : value;
                return normalized.toLocaleString(undefined, { maximumFractionDigits: 20 });
            };

            const componentHeadingLabel = (componentType) => {
                switch (componentType) {
                    case 'Mag Rider':
                        return t('Mag Rider');
                    case 'Mount':
                        return t('Ground');
                    case 'Wings':
                        return t('Flight');
                    case 'Stat Stats':
                        return t('Permanent Stat increases');
                    case 'Boat/Ship':
                        return t('Water');
                    default:
                        return '';
                }
            };

            const resolveStatHeading = (stat) => {
                if (!stat || typeof stat !== 'object' || typeof stat.value !== 'number') return '';
                const statName = stat.stat || stat.name || stat.label || '';
                const value = stat.display_value ?? stat.value;
                const componentType = stat.component_type || '';

                if (componentType === 'Wings' || statName === 'Glide') {
                    return t('Flight');
                }
                if (componentType === 'Boat/Ship' || statName === 'Acceleration' || statName === 'Turning Rate' || statName === 'TurningRate') {
                    return t('Water');
                }
                if (statName === 'MovementSpeed' || statName === 'Movement Speed') {
                    return Math.abs(Number(value) - 25) < 0.0001 ? t('Mag Rider') : t('Ground');
                }
                if (componentType === 'Stat Stats') {
                    return t('Permanent Stat increases');
                }
                return componentHeadingLabel(componentType);
            };

            const buildGroupedStats = (stats) => {
                const grouped = [];
                let lastHeading = '';
                for (const stat of stats) {
                    if (!stat || typeof stat !== 'object' || typeof stat.value !== 'number') {
                        if (stat) grouped.push(stat);
                        continue;
                    }
                    const heading = resolveStatHeading(stat);
                    if (heading && heading !== lastHeading) {
                        grouped.push({ heading, text: `${heading}:`, isHeading: true });
                        lastHeading = heading;
                    }
                    grouped.push(stat);
                }
                return grouped;
            };

            const formatStat = (statText) => {
                if (statText && typeof statText === 'object' && statText.isHeading) {
                    return `<strong>${escapeHtml(statText.text || '')}</strong>`;
                }
                let statLine = typeof statText === 'string' ? statText : ((statText && statText.text) || '');
                if (statText && typeof statText === 'object' && typeof statText.value === 'number') {
                    const name = (statText.label || statText.name || '').trim();
                    const formattedValue = statText.value_display || statText.display || (
                        statText.is_percent
                            ? `${formatNumberWithSeparators(statText.value * 100)}%`
                            : formatNumberWithSeparators(statText.value)
                    );
                    if (formattedValue) {
                        statLine = `${formattedValue} ${name}`.trim();
                    }
                }
                const isHighlighted = selectedStat.value && selectedStat.value.length > 0 && selectedStat.value.some(s => statLine.includes(s));
                return isHighlighted ? `<strong>${statLine}</strong>` : statLine;
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

            const filteredMounts = computed(() => {
                let result = mountsData.value.filter(m => {
                    const category = m.category || 'Unknown';
                    return category !== 'Unknown' && category !== 'InProgress' && category !== 'READY_FOR_GAME';
                });

                const sq = searchQuery.value.toLowerCase().trim();
                if (sq.length >= 3) {
                    let generalSearch = sq;
                    const filters = { author: null, name: null, desc: null, category: null };
                    const regex = /(author|designer|name|desc|category):("([^"]+)"|([^\s]+))/g;
                    let match;
                    while ((match = regex.exec(sq)) !== null) {
                        const key = match[1] === 'designer' ? 'author' : match[1];
                        filters[key] = match[3] || match[4];
                        generalSearch = generalSearch.replace(match[0], '');
                    }
                    generalSearch = generalSearch.trim();

                    result = result.filter(m => {
                        if (filters.author && !(m.designer && m.designer.toLowerCase().includes(filters.author))) return false;
                        if (filters.name && !m.name.toLowerCase().includes(filters.name)) return false;
                        if (filters.desc && !(m.desc && m.desc.toLowerCase().includes(filters.desc))) return false;
                        if (filters.category && !(m.category && m.category.toLowerCase().includes(filters.category))) return false;

                        if (generalSearch.length > 0) {
                            const matchGeneral = m.name.toLowerCase().includes(generalSearch) ||
                                (m.designer && m.designer.toLowerCase().includes(generalSearch)) ||
                                (m.desc && m.desc.toLowerCase().includes(generalSearch)) ||
                                m.rawStats.some(stat => {
                                    const statValue = stat.value_display || stat.display || (stat.is_percent && typeof stat.value === 'number'
                                        ? `${formatNumberWithSeparators(stat.value * 100)}%`
                                        : (stat.value ?? ''));
                                    const text = typeof stat === 'string' ? stat : `${statValue || ''} ${stat.label || stat.name || ''}`;
                                    return text.toLowerCase().includes(generalSearch);
                                });
                            if (!matchGeneral) return false;
                        }
                        return true;
                    });
                }

                if (selectedCategory.value && selectedCategory.value !== 'All') {
                    result = result.filter(m => m.category === selectedCategory.value);
                }

                if (selectedStat.value && selectedStat.value.length > 0) {
                    result = result.filter(m => selectedStat.value.every(stat => m.parsedStats[stat] !== undefined));
                }

                return [...result].sort((a, b) => a.name.localeCompare(b.name));
            });

            const totalPages = computed(() => Math.max(1, Math.ceil(filteredMounts.value.length / pageSize.value)));

            const paginatedMounts = computed(() => {
                const start = (currentPage.value - 1) * pageSize.value;
                const end = start + pageSize.value;
                return filteredMounts.value.slice(start, end);
            });

            const visibleStart = computed(() => {
                if (filteredMounts.value.length === 0) return 0;
                return (currentPage.value - 1) * pageSize.value + 1;
            });

            const visibleEnd = computed(() => {
                if (filteredMounts.value.length === 0) return 0;
                return Math.min(currentPage.value * pageSize.value, filteredMounts.value.length);
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
                nextTick(() => {
                    const grid = document.querySelector('#mounts-vue-app .allies-grid');
                    if (grid) grid.scrollIntoView({ block: 'start', behavior: 'smooth' });
                });
            };

            const nextPage = () => setPage(currentPage.value + 1);
            const prevPage = () => setPage(currentPage.value - 1);

            watch([searchQuery, selectedCategory, selectedStat], () => {
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

            watch([searchQuery, selectedCategory, selectedStat, currentPage, pageSize], persistState, { deep: true });

            const setActiveResult = (index) => {
                const cards = Array.from(document.querySelectorAll('#mounts-vue-app .ally-card'));
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

            const loadMounts = async (forceRefresh = false) => {
                loadError.value = '';
                let data = null;
                let response = null;

                if (window.eel && eel.get_mounts_data) {
                    response = await eel.get_mounts_data(forceRefresh)();
                    if (!response || response.success === false) {
                        throw new Error((response && response.error) || 'Failed to retrieve mount data from backend');
                    }
                    data = (response && response.data && typeof response.data === 'object') ? response.data : response;
                } else {
                    throw new Error('Backend mounts endpoint is unavailable');
                }

                const uniqueCategories = new Set();
                const uniqueStats = new Set();

                const parsedMounts = Object.keys(data).map(key => {
                    const mount = data[key];
                    if (mount.category) uniqueCategories.add(mount.category);

                    const parsedStats = {};
                    const stats = Array.isArray(mount.stats) ? mount.stats : [];
                    const rawStats = buildGroupedStats(
                        stats.filter(stat => stat && (((typeof stat.label === 'string' || typeof stat.name === 'string') && typeof stat.value === 'number') || typeof stat.text === 'string'))
                    );

                    stats.forEach(stat => {
                        const statName = (stat && (stat.label || stat.name)) || '';
                        if (!statName) return;
                        uniqueStats.add(statName);
                        parsedStats[statName] = {
                            value: stat && typeof stat.value === 'number' ? stat.value : parseFloat((stat && stat.value) || 0),
                            isPercent: !!(stat && stat.is_percent)
                        };
                    });

                    const catalogId = normalizeCatalogImageId(mount.blueprint || mount.image || '');
                    const imagePath = String(mount.image || '').startsWith('http')
                        ? String(mount.image)
                        : `https://trovesaurus.com/data/catalog/${catalogId}.png`;

                    return {
                        id: key,
                        ...mount,
                        rawStats,
                        parsedStats,
                        imagePath
                    };
                });

                mountsData.value = parsedMounts;

                const catOpts = [['All Categories', 'All']];
                Array.from(uniqueCategories).sort().forEach(c => catOpts.push([c, c]));
                categoryOptions.value = catOpts;
                statsOptions.value = Array.from(uniqueStats).sort().map(s => ({ id: s, text: t(s) }));

                const source = (response && response.source) || '';
                const cacheMeta = (response && response.meta && response.meta.cache) || {};
                if (source === 'game-cache') {
                    dataSourceText.value = t('Loaded mount data from cached game-file scan.');
                } else if (source === 'game-live') {
                    dataSourceText.value = t('Loaded mount data from live game files.');
                } else {
                    dataSourceText.value = '';
                }
                if (source && cacheMeta && cacheMeta.age_seconds !== undefined && source === 'game-cache') {
                    const hours = Math.floor((cacheMeta.age_seconds || 0) / 3600);
                    if (hours > 0) dataSourceText.value += ` ${t('Cache age')}: ${hours}h.`;
                }
            };

            const clearCacheAndReload = async () => {
                try {
                    isLoading.value = true;
                    if (window.eel && eel.clear_mounts_cache) {
                        await eel.clear_mounts_cache()();
                    }
                    await loadMounts(true);
                } catch (err) {
                    console.error("Failed to clear mount cache:", err);
                } finally {
                    isLoading.value = false;
                    nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                }
            };

            const onKeyDown = (e) => {
                const rootEl = document.getElementById('mounts-vue-app');
                if (!rootEl || rootEl.offsetParent === null) return;
                if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'f') {
                    const input = document.getElementById('mount-search-input');
                    if (input) {
                        e.preventDefault();
                        input.focus();
                        input.select();
                    }
                    return;
                }
                const activeEl = document.activeElement;
                if (activeEl && activeEl.id === 'mount-search-input') {
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
                try {
                    await loadMounts(false);
                } catch (err) {
                    console.error("Failed to load mounts data:", err);
                    loadError.value = String((err && err.message) || err || 'Failed to load mounts from game files.');
                }

                isLoading.value = false;
                document.addEventListener('keydown', onKeyDown);
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                hydratingState = false;
            });

            onBeforeUnmount(() => {
                document.removeEventListener('keydown', onKeyDown);
            });

            return {
                t, isLoading, loadError, mountsData, filteredMounts, paginatedMounts,
                searchQuery, selectedCategory, selectedStat,
                categoryOptions, statsOptions,
                currentPage, totalPages, pageNumbers, visibleStart, visibleEnd,
                setPage, nextPage, prevPage,
                resetFilters, formatStat, highlightSearch,
                nextSearchResult, prevSearchResult,
                clearCacheAndReload, dataSourceText
            };
        }
    });

    try {
        if (window.CustomVueSelect) app.component('custom-vue-select', window.CustomVueSelect);
        if (window.Select2Component) app.component('select2-component', window.Select2Component);

        if (window._mountsApp) window._mountsApp.unmount();
        window._mountsApp = app;

        app.mount('#mounts-vue-app');
    } catch (err) {
        console.error("Failed to initialize Mount Codex app:", err);
        root.removeAttribute('v-cloak');
        root.innerHTML = `<div class="search-stats" style="color: #ff5555; padding: 20px;">Failed to initialize Mount Codex: ${String((err && err.message) || err)}</div>`;
    } finally {
        delete root.dataset.mountsInitializing;
    }
}

document.addEventListener('mounts_loaded', initMountsView);
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initMountsView, 0);
});
