document.addEventListener('allies_loaded', async () => {
    console.log("Ally Codex Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, computed, onMounted, onBeforeUnmount, nextTick } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

            const isLoading = ref(true);
            const alliesData = ref([]);
            
            const categoryOptions = ref([]);
            const statsOptions = ref([[t('All Stats'), '']]);
            const abilitiesOptions = ref([[t('All Abilities'), '']]);

            const searchQuery = ref('');
            const activeResultIndex = ref(-1);
            const selectedCategory = ref('All');
            const selectedStat = ref('');
            const selectedAbility = ref('');
            const toursEnabled = window.BTT_ENABLE_ONBOARDING_TOURS !== false;
            const showOnboardingTips = ref(toursEnabled && (window.AppSettings ? window.AppSettings.getPref('onboarding_allies_v1', '') !== 'dismissed' : true));
            const showSearchShortcutHint = ref(window.AppSettings ? window.AppSettings.getPref('hint_allies_search_shortcuts_v1', '') !== 'dismissed' : true);

            const resetFilters = () => {
                searchQuery.value = '';
                selectedCategory.value = 'All';
                selectedStat.value = '';
                selectedAbility.value = '';
            };

            const dismissOnboardingTips = () => {
                showOnboardingTips.value = false;
                if (window.AppSettings) window.AppSettings.setPrefSync('onboarding_allies_v1', 'dismissed');
            };

            const dismissSearchShortcutHint = () => {
                showSearchShortcutHint.value = false;
                if (window.AppSettings) window.AppSettings.setPrefSync('hint_allies_search_shortcuts_v1', 'dismissed');
            };

            const formatStat = (statText) => {
                const isHighlighted = !!selectedStat.value && statText.includes(selectedStat.value);
                return isHighlighted ? `<strong>${statText}</strong>` : statText;
            };

            const formatAbility = (abilityText) => {
                const isHighlighted = !!selectedAbility.value && selectedAbility.value === abilityText;
                return isHighlighted ? `<strong>${abilityText}</strong>` : abilityText;
            };

            const escapeHtml = (text) => String(text || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');

            const highlightSearch = (text) => {
                const q = searchQuery.value.trim();
                const safe = escapeHtml(text || '');
                if (!q) return safe;
                const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(`(${escaped})`, 'ig');
                return safe.replace(re, '<mark>$1</mark>');
            };

            const filteredAllies = computed(() => {
                let result = alliesData.value;
                
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
                        if (filters.author && !(a.designer && a.designer.toLowerCase().includes(filters.author))) return false;
                        if (filters.name && !a.name.toLowerCase().includes(filters.name)) return false;
                        if (filters.ability && !a.extractedAbilities.some(ab => ab.toLowerCase().includes(filters.ability))) return false;
                        if (filters.desc && !(a.desc && a.desc.toLowerCase().includes(filters.desc))) return false;
                        if (filters.category && !(a.category && a.category.toLowerCase().includes(filters.category))) return false;

                        if (generalSearch.length > 0) {
                            const matchGeneral = a.name.toLowerCase().includes(generalSearch) || 
                                                 (a.designer && a.designer.toLowerCase().includes(generalSearch)) ||
                                                 a.extractedAbilities.some(ab => ab.toLowerCase().includes(generalSearch)) ||
                                                 (window.fuzzyIncludes ? window.fuzzyIncludes(`${a.name || ''} ${a.designer || ''} ${(a.extractedAbilities || []).join(' ')}`, generalSearch, 4) : false);
                            if (!matchGeneral) return false;
                        }
                        return true;
                    });
                }

                if (selectedCategory.value && selectedCategory.value !== 'All') {
                    result = result.filter(a => a.category === selectedCategory.value);
                }

                if (selectedStat.value) {
                    result = result.filter(a => a.parsedStats[selectedStat.value] !== undefined);

                    const primary = selectedStat.value;
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
                if (window.eel && eel.sync_allies_data) {
                    try { await eel.sync_allies_data()(); } catch (e) {}
                }

                try {
                    const cacheBuster = new Date().getTime();
                    const response = await fetch(`/assets/data/allies.json?t=${cacheBuster}`);
                    const data = await response.json();

                    const uniqueCategories = new Set();
                    const uniqueStats = new Set();
                    const uniqueAbilities = new Set();

                    const parsedAllies = Object.keys(data).map(key => {
                        const ally = data[key];
                        if (ally.category) uniqueCategories.add(ally.category);

                        const parser = new DOMParser();
                        const doc = parser.parseFromString(ally.tooltip, 'text/html');
                        
                        const rawStats = [];
                        const parsedStats = {};

                        Array.from(doc.querySelectorAll('li')).forEach(li => {
                            const text = li.textContent.trim();
                            rawStats.push(text);
                            const match = text.match(/^([+-]?[\d.]+)(%?)\s+(.+)$/);
                            if (match) {
                                const statName = match[3].trim();
                                uniqueStats.add(statName);
                                parsedStats[statName] = { value: parseFloat(match[1]), isPercent: match[2] === '%' };
                            }
                        });

                        const abilities = Array.from(doc.querySelectorAll('p'))
                            .map(p => p.textContent.trim())
                            .filter(text => text !== 'Ally' && text !== '');

                        abilities.forEach(ab => uniqueAbilities.add(ab));

                        let imgSource = ally.image || ally.blueprint;
                        let imagePath = imgSource.startsWith('http') ? imgSource : `https://trovesaurus.com/data/catalog/${imgSource}.png`;

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

                    statsOptions.value = [[t('All Stats'), '']].concat(Array.from(uniqueStats).sort().map(s => [t(s), s]));
                    abilitiesOptions.value = [[t('All Abilities'), '']].concat(Array.from(uniqueAbilities).sort().map(a => [t(a), a]));

                } catch (err) {
                    console.error("Failed to load allies data:", err);
                }
                
                isLoading.value = false;
                document.addEventListener('keydown', onKeyDown);
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
            });

            onBeforeUnmount(() => {
                document.removeEventListener('keydown', onKeyDown);
            });

            return {
                t, isLoading, alliesData, filteredAllies,
                searchQuery, selectedCategory, selectedStat, selectedAbility,
                categoryOptions, statsOptions, abilitiesOptions,
                resetFilters, formatStat, formatAbility,
                highlightSearch, nextSearchResult, prevSearchResult,
                focusSearchInput,
                showSearchShortcutHint, dismissSearchShortcutHint,
                showOnboardingTips, dismissOnboardingTips
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);
    
    if (window._alliesApp) window._alliesApp.unmount();
    window._alliesApp = app;
    
    app.mount('#allies-vue-app');
});