document.addEventListener('calculators_loaded', () => {
    console.log("Calculators view initialized!");
    
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, computed, watch, onMounted } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
            const PREF_STATE_KEY = 'state_calculators';

            const activeTab = ref('pr-tab');
            let hydratingState = false;

            const troveMastery = ref(900);
            const geodeMastery = ref(100);

            const masteryPR = computed(() => {
                const tCapped = Math.min(troveMastery.value || 0, 1000);
                const gCapped = Math.min(geodeMastery.value || 0, 100);
                const t1 = Math.min(tCapped, 500);
                const t2 = Math.max(0, tCapped - 500);
                return (t1 * 4) + (t2 * 1) + (gCapped * 5);
            });
            
            const masteryDmg = computed(() => '+' + (Math.min(troveMastery.value || 0, 500) * 0.2).toFixed(1) + '%');
            const masteryHp = computed(() => '+' + (Math.min(troveMastery.value || 0, 500) * 0.6).toFixed(1) + '%');
            const masteryLight = computed(() => '+' + (Math.min(geodeMastery.value || 0, 100) * 10).toLocaleString());
            const masteryMf = computed(() => '+' + Math.max(0, Math.min(troveMastery.value || 0, 1000) - 500));

            const resetMastery = () => { troveMastery.value = 900; geodeMastery.value = 100; };
            const clampMastery = () => {
                troveMastery.value = Math.max(0, Math.min(parseInt(troveMastery.value) || 0, 2000));
                geodeMastery.value = Math.max(0, Math.min(parseInt(geodeMastery.value) || 0, 200));
            };

            const mfData = ref([]);
            
            const fetchMf = async () => {
                try {
                    const res = await fetch('/assets/data/stats/magic_find.json');
                    const data = await res.json();
                    mfData.value = [
                        { name: "Mastery", type: "mastery", percentage: false, max: 1000, default: 900 },
                        ...data,
                        { name: "Patron", type: "patron_switch", percentage: true, value: 100, default_checked: false }
                    ].map(item => ({
                        ...item,
                        currentValue: item.type.includes('switch') ? (item.default_checked !== undefined ? item.default_checked : true) : (item.default !== undefined ? item.default : (item.value || 0))
                    }));
                } catch(e) { console.warn("Skipping Magic Find setup (data missing):", e); }
            };

            const mfStats = computed(() => {
                let flat = 0;
                let bonus = 0;
                let patron = 1;
                
                mfData.value.forEach(item => {
                    let val = 0;
                    if (item.type.includes('switch')) {
                        val = item.currentValue ? item.value : 0;
                    } else if (item.type === 'mastery') {
                        val = Math.max(0, (item.currentValue || 0) - 500);
                    } else {
                        val = item.currentValue || 0;
                    }

                    if (item.type === 'patron_switch') patron = item.currentValue ? (item.value / 100) + 1 : 1;
                    else if (item.percentage) bonus += val;
                    else flat += val;
                });
                return { flat, bonus, patron, total: Math.floor(flat * (1 + (bonus / 100)) * patron) };
            });

            const resetMf = () => mfData.value.forEach(i => i.currentValue = i.type.includes('switch') ? (i.default_checked !== undefined ? i.default_checked : true) : (i.default !== undefined ? i.default : (i.value || 0)));
            const clampMfValue = (item) => item.currentValue = Math.max(0, Math.min(parseInt(item.currentValue) || 0, item.max || item.value));
            
            const getMfBadgeText = (item) => {
                if (item.type === 'patron_switch') return t("+{val}% Multiplier").replace("{val}", item.value);
                if (item.type === 'switch') return item.percentage ? t("+{val}% Bonus").replace("{val}", item.value) : t("+{val} Flat").replace("{val}", item.value);
                let v = item.type === 'mastery' ? Math.max(0, (item.currentValue || 0) - 500) : (item.currentValue || 0);
                return item.percentage ? t("+{val}% Bonus").replace("{val}", v) : t("+{val} Flat").replace("{val}", v);
            };

            const prData = ref([]);
            
            const fetchPr = async () => {
                try {
                    const res = await fetch('/assets/data/stats/power_rank.json');
                    const data = await res.json();
                    prData.value = [
                        { name: "Trove Mastery", type: "pr_mastery", percentage: false, max: 1100, default: 900 },
                        { name: "Geode Mastery", type: "pr_geode_mastery", percentage: false, max: 150, default: 100 },
                        ...data
                    ].map(item => ({
                        ...item,
                        currentValue: item.type === 'switch' ? true : (item.default !== undefined ? item.default : (item.value || 0))
                    }));
                } catch(e) { console.warn("Skipping Power Rank setup (data missing):", e); }
            };

            const totalPR = computed(() => {
                let total = 0;
                prData.value.forEach(item => {
                    if (item.type === 'switch') {
                        total += item.currentValue ? item.value : 0;
                    } else if (item.type === 'pr_mastery') {
                        const capped = Math.min(item.currentValue || 0, 1000);
                        total += (Math.min(capped, 500) * 4) + (Math.max(0, capped - 500) * 1);
                    } else if (item.type === 'pr_geode_mastery') {
                        total += Math.min(item.currentValue || 0, 100) * 5;
                    } else {
                        total += item.currentValue || 0;
                    }
                });
                return total;
            });

            const resetPr = () => prData.value.forEach(i => i.currentValue = i.type === 'switch' ? true : (i.default !== undefined ? i.default : (i.value || 0)));
            const clampPrValue = (item) => {
                let max = item.type === 'pr_mastery' ? 2000 : (item.type === 'pr_geode_mastery' ? 200 : item.value);
                item.currentValue = Math.max(0, Math.min(parseInt(item.currentValue) || 0, max));
            };

            const getStateKey = (item) => item.name || item.type;

            const normalizeItemValue = (item, rawValue) => {
                if (item.type && item.type.includes('switch')) return !!rawValue;
                const numeric = parseInt(rawValue, 10);
                return Number.isFinite(numeric) ? numeric : 0;
            };

            const buildStateSnapshot = () => {
                const mfValues = {};
                mfData.value.forEach((item) => {
                    mfValues[getStateKey(item)] = item.currentValue;
                });

                const prValues = {};
                prData.value.forEach((item) => {
                    prValues[getStateKey(item)] = item.currentValue;
                });

                return {
                    activeTab: activeTab.value,
                    troveMastery: troveMastery.value,
                    geodeMastery: geodeMastery.value,
                    mfValues,
                    prValues
                };
            };

            const applyStateSnapshot = (saved) => {
                if (!saved || typeof saved !== 'object') return;

                if (typeof saved.activeTab === 'string') {
                    activeTab.value = saved.activeTab;
                }
                if (saved.troveMastery !== undefined) {
                    troveMastery.value = parseInt(saved.troveMastery, 10) || 0;
                }
                if (saved.geodeMastery !== undefined) {
                    geodeMastery.value = parseInt(saved.geodeMastery, 10) || 0;
                }
                clampMastery();

                if (saved.mfValues && typeof saved.mfValues === 'object') {
                    mfData.value.forEach((item) => {
                        const key = getStateKey(item);
                        if (Object.prototype.hasOwnProperty.call(saved.mfValues, key)) {
                            item.currentValue = normalizeItemValue(item, saved.mfValues[key]);
                            if (!(item.type && item.type.includes('switch'))) {
                                clampMfValue(item);
                            }
                        }
                    });
                }

                if (saved.prValues && typeof saved.prValues === 'object') {
                    prData.value.forEach((item) => {
                        const key = getStateKey(item);
                        if (Object.prototype.hasOwnProperty.call(saved.prValues, key)) {
                            item.currentValue = normalizeItemValue(item, saved.prValues[key]);
                            if (!(item.type && item.type.includes('switch'))) {
                                clampPrValue(item);
                            }
                        }
                    });
                }
            };

            const persistState = () => {
                if (hydratingState || !window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, buildStateSnapshot());
            };
            
            const getPrBadgeText = (item) => {
                let v = 0;
                if (item.type === 'pr_mastery') {
                    const c = Math.min(item.currentValue || 0, 1000);
                    v = (Math.min(c, 500) * 4) + (Math.max(0, c - 500) * 1);
                } else if (item.type === 'pr_geode_mastery') {
                    v = Math.min(item.currentValue || 0, 100) * 5;
                } else if (item.type === 'switch') {
                    v = item.currentValue ? item.value : 0;
                } else {
                    v = item.currentValue || 0;
                }
                return t("+{val} PR").replace("{val}", v);
            };

            watch([activeTab, troveMastery, geodeMastery, mfData, prData], persistState, { deep: true });

            onMounted(async () => {
                hydratingState = true;
                try {
                    if (window.AppSettings) await window.AppSettings.load();
                    await Promise.all([fetchMf(), fetchPr()]);
                    const saved = window.AppSettings ? window.AppSettings.getPref(PREF_STATE_KEY, null) : null;
                    applyStateSnapshot(saved);
                } finally {
                    hydratingState = false;
                }
            });

            return {
                t, activeTab,
                troveMastery, geodeMastery, masteryPR, masteryDmg, masteryHp, masteryLight, masteryMf, resetMastery, clampMastery,
                mfData, mfStats, resetMf, getMfBadgeText, clampMfValue,
                prData, totalPR, resetPr, getPrBadgeText, clampPrValue
            };
        }
    });

    if (window._calculatorsApp) window._calculatorsApp.unmount();
    window._calculatorsApp = app;
    
    app.mount('#calculators-vue-app');
});