document.addEventListener('allies_loaded', async () => {
    console.log("Ally Codex Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, computed, onMounted, nextTick } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

            const isLoading = ref(true);
            const alliesData = ref([]);
            
            const categoryOptions = ref([]);
            const statsList = ref([]);
            const abilitiesList = ref([]);

            const searchQuery = ref('');
            const selectedCategory = ref('All');
            const selectedStats = ref([]);
            const selectedAbilities = ref([]);

            const resetFilters = () => {
                searchQuery.value = '';
                selectedCategory.value = 'All';
                selectedStats.value = [];
                selectedAbilities.value = [];
            };

            const formatStat = (statText) => {
                const isHighlighted = selectedStats.value.some(h => statText.includes(h));
                return isHighlighted ? `<strong>${statText}</strong>` : statText;
            };

            const formatAbility = (abilityText) => {
                const isHighlighted = selectedAbilities.value.includes(abilityText);
                return isHighlighted ? `<strong>${abilityText}</strong>` : abilityText;
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
                                                 a.extractedAbilities.some(ab => ab.toLowerCase().includes(generalSearch));
                            if (!matchGeneral) return false;
                        }
                        return true;
                    });
                }

                if (selectedCategory.value && selectedCategory.value !== 'All') {
                    result = result.filter(a => a.category === selectedCategory.value);
                }

                if (selectedStats.value.length > 0) {
                    result = result.filter(a => selectedStats.value.every(s => a.parsedStats[s] !== undefined));
                    
                    const primary = selectedStats.value[0];
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

                if (selectedAbilities.value.length > 0) {
                    result = result.filter(a => selectedAbilities.value.every(ab => a.extractedAbilities.includes(ab)));
                }

                return result;
            });

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

                    statsList.value = Array.from(uniqueStats).sort().map(s => ({ id: s, text: t(s) }));
                    abilitiesList.value = Array.from(uniqueAbilities).sort().map(a => ({ id: a, text: t(a) }));

                } catch (err) {
                    console.error("Failed to load allies data:", err);
                }
                
                isLoading.value = false;
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
            });

            return {
                t, isLoading, alliesData, filteredAllies,
                searchQuery, selectedCategory, selectedStats, selectedAbilities,
                categoryOptions, statsList, abilitiesList,
                resetFilters, formatStat, formatAbility
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);
    app.component('select2', window.Select2Component);
    
    if (window._alliesApp) window._alliesApp.unmount();
    window._alliesApp = app;
    
    app.mount('#allies-vue-app');
});