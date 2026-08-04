document.addEventListener('gem_evaluator_loaded', async () => {
    if (typeof Vue === 'undefined') {
        console.error('Vue.js failed to load!');
        return;
    }

    const { createApp, ref, reactive, computed, onMounted, onUnmounted, watch } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
            const PREF_STATE_KEY = 'state_gem_evaluator';
            const HISTORY_PREF_KEY = 'gem_evaluator_history_v1';
            const HISTORY_LIMIT = 20;
            const lookups = ref({});
            const results = ref([]);
            const bestMatch = ref(null);
            const isEvaluating = ref(false);
            const isGuessingStats = ref(false);
            const activeMode = ref('simple');

            const history = ref([]);
            const compareA = ref(null);
            const compareB = ref(null);
            const showCompare = ref(false);
            const nextFocusSim = ref(null);
            const isSimulatingFocus = ref(false);
            const showMathExpander = ref(false);
            const statRanges = reactive({ 0: null, 1: null, 2: null });
            const inferredElement = ref(0);

            const simpleForm = reactive({
                type: 1,
                tier: 4,
                powerRank: '',
                level: 1
            });
            const form = reactive({
                type: 1,
                tier: 4,
                level: 1,
                stats: [
                    { type: '', value: '', extraContainers: 0 },
                    { type: '', value: '', extraContainers: 0 },
                    { type: '', value: '', extraContainers: 0 }
                ]
            });

            const tierOptions = computed(() => {
                return Object.entries(lookups.value.tiers || {})
                    .sort((a, b) => a[1] - b[1])
                    .map(([name, value]) => [name, value]);
            });

            const typeOptions = computed(() => {
                return Object.entries(lookups.value.types || {})
                    .sort((a, b) => a[1] - b[1])
                    .map(([name, value]) => [name, value]);
            });

            const statBaseOptions = computed(() => {
                const options = Object.entries(lookups.value.stat_types || {})
                    .sort((a, b) => a[1] - b[1])
                    .filter(([, value]) => value <= 7)
                    .map(([name, value]) => [name, value]);
                return [[`(${t('gems.gem_evaluator.select_stat')})`, ''], ...options];
            });

            const levelNumber = computed(() => {
                const parsed = parseInt(form.level, 10);
                if (Number.isNaN(parsed)) return 1;
                return Math.max(1, Math.min(35, parsed));
            });

            const availableExtraContainers = computed(() => Math.min(levelNumber.value, 15) / 5 >> 0);
            const allocatedExtraContainers = computed(() => form.stats.reduce((sum, stat) => sum + Number(stat.extraContainers || 0), 0));
            const remainingExtraContainers = computed(() => availableExtraContainers.value - allocatedExtraContainers.value);
            const canGuessStats = computed(() => form.stats.every((stat) => stat.value !== '' && Number(stat.value) >= 0));
            const needsStatGuess = computed(() => form.stats.some((stat) => !stat.type));
            const procSpreadSummary = computed(() => form.stats.map((stat) => Number(stat.extraContainers || 0)).join(' / '));

            const statOptionsFor = (index) => {
                const selectedByOthers = new Set(
                    form.stats
                        .filter((_, statIndex) => statIndex !== index)
                        .map((stat) => String(stat.type || ''))
                        .filter(Boolean)
                );
                return statBaseOptions.value.filter(([, value]) => value === '' || !selectedByOthers.has(String(value)));
            };

            const normalizeProcSpread = () => {
                const maxAllowed = availableExtraContainers.value;
                let used = 0;
                form.stats.forEach((stat) => {
                    const sanitized = Math.max(0, Math.min(3, Number(stat.extraContainers || 0)));
                    stat.extraContainers = sanitized;
                });
                form.stats.forEach((stat) => {
                    if (used + stat.extraContainers > maxAllowed) {
                        stat.extraContainers = Math.max(0, maxAllowed - used);
                    }
                    used += stat.extraContainers;
                });
            };

            const formatNumber = (value) => {
                const numeric = Number(value || 0);
                return numeric.toLocaleString(undefined, { maximumFractionDigits: 3 });
            };

            const gemPreviewIcon = (result) => {
                const hasLight = Array.isArray(result?.stats) && result.stats.some((stat) => Number(stat.type) === 7);
                if (hasLight) {
                    return `assets/gems/gem_types/${result.type}/elements/4.png`;
                }
                return Number(result?.type) === 2
                    ? 'assets/gems/misc/empowered.png'
                    : 'assets/gems/misc/lesser.png';
            };

            const focusIcon = (focusKey) => ({
                rough: 'assets/gems/augments/1.png',
                precise: 'assets/gems/augments/2.png',
                superior: 'assets/gems/augments/3.png'
            }[focusKey] || '');

            const itemIcon = (materialKey) => `assets/gems/misc/items/${materialKey}.png`;

            const focusPlanEntries = (result) => {
                const order = ['optimized_all', 'optimized_precise_rough', 'rough_only'];
                return order
                    .map((key) => result?.focus_totals?.[key])
                    .filter(Boolean);
            };

            const hasAnyFocusCost = (result) => focusPlanEntries(result).some((plan) => Number(plan?.total || 0) > 0);

            const focusCountEntries = (plan) => ([
                { key: 'superior', label: 'Superior', count: Number(plan?.superior || 0) },
                { key: 'precise', label: 'Precise', count: Number(plan?.precise || 0) },
                { key: 'rough', label: 'Rough', count: Number(plan?.rough || 0) }
            ]).filter((entry) => entry.count > 0);

            const recipeEntries = (plan) => {
                const order = [
                    'bound_brilliance',
                    'heart_of_darkness',
                    'water_gem_dust',
                    'air_gem_dust',
                    'fire_gem_dust',
                    'diamond_dragonite',
                    'titan_soul',
                    'flux'
                ];
                return order
                    .filter((key) => Number(plan?.recipe_totals?.[key] || 0) > 0)
                    .map((key) => ({
                        key,
                        amount: Number(plan.recipe_totals[key]),
                        label: key
                            .split('_')
                            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                            .join(' ')
                    }));
            };

            const buildPayload = () => ({
                type: Number(form.type),
                tier: Number(form.tier),
                level: levelNumber.value,
                stats: form.stats.map((stat) => ({
                    type: Number(stat.type),
                    value: Number(stat.value),
                    extra_containers: Number(stat.extraContainers)
                }))
            });

            const inferElementFromStats = () => {
                // Cosmic if any stat is Light (value 7), else Water. Mirrors backend _infer_element.
                const hasLight = form.stats.some((stat) => Number(stat.type) === 7);
                return hasLight ? 4 : 1; // GemElement.COSMIC = 4, WATER = 1
            };

            const fetchStatRange = async (statIndex) => {
                const stat = form.stats[statIndex];
                if (!stat || !stat.type) {
                    statRanges[statIndex] = null;
                    return;
                }
                const element = inferElementFromStats();
                try {
                    const response = await eel.get_gem_stat_range({
                        tier: Number(form.tier),
                        type: Number(form.type),
                        stat_type: Number(stat.type),
                        element,
                        level: levelNumber.value,
                        extra_containers: Number(stat.extraContainers || 0)
                    })();
                    if (response && response.success) {
                        statRanges[statIndex] = response.data || null;
                    } else {
                        statRanges[statIndex] = null;
                    }
                } catch {
                    statRanges[statIndex] = null;
                }
            };

            const refreshAllStatRanges = async () => {
                inferredElement.value = inferElementFromStats();
                await Promise.all([0, 1, 2].map((i) => fetchStatRange(i)));
            };

            const statRangePercent = (statIndex, currentValue) => {
                const range = statRanges[statIndex];
                if (!range || !Number.isFinite(currentValue)) return null;
                const span = range.max_value - range.min_value;
                if (span <= 0) return null;
                const pct = ((currentValue - range.min_value) / span) * 100;
                return Math.max(0, Math.min(100, pct));
            };

            const runNextFocusSim = async () => {
                if (!results.value.length || activeMode.value !== 'full') {
                    nextFocusSim.value = null;
                    return;
                }
                isSimulatingFocus.value = true;
                try {
                    const response = await eel.simulate_next_focus(buildPayload())();
                    if (response && response.success) {
                        nextFocusSim.value = response.data || response || null;
                    } else {
                        nextFocusSim.value = null;
                    }
                } catch {
                    nextFocusSim.value = null;
                }
                isSimulatingFocus.value = false;
            };

            // ---- History (auto-saved on each successful Full evaluation) ----
            const hashGemInputs = (payload) => {
                const stats = (payload.stats || []).map((s) => `${s.type}:${s.value}:${s.extra_containers}`).join('|');
                return `${payload.type}:${payload.tier}:${payload.level}:${stats}`;
            };

            const persistHistory = () => {
                if (!window.AppSettings) return;
                window.AppSettings.setPrefSync(HISTORY_PREF_KEY, history.value.slice(0, HISTORY_LIMIT));
            };

            const addHistoryEntry = (payload, result) => {
                if (!payload || !result) return;
                const hash = hashGemInputs(payload);
                const filtered = history.value.filter((entry) => entry.hash !== hash);
                const entry = {
                    hash,
                    savedAt: Date.now(),
                    payload,
                    summary: {
                        type: result.type,
                        type_name: result.type_name,
                        tier: result.tier,
                        level: result.level,
                        quality_percent: result.quality_percent,
                        calculated_power_rank: result.calculated_power_rank,
                        element: result.element,
                        restriction_name: result.restriction_name,
                        stat_names: (result.stats || []).map((s) => s.display_name)
                    }
                };
                history.value = [entry, ...filtered].slice(0, HISTORY_LIMIT);
                persistHistory();
            };

            const restoreFromHistory = (entry) => {
                if (!entry || !entry.payload) return;
                const p = entry.payload;
                form.type = p.type;
                form.tier = p.tier;
                form.level = p.level;
                (p.stats || []).forEach((stat, index) => {
                    if (!form.stats[index]) return;
                    form.stats[index].type = stat.type;
                    form.stats[index].value = stat.value;
                    form.stats[index].extraContainers = stat.extra_containers || 0;
                });
                activeMode.value = 'full';
                results.value = [];
                bestMatch.value = null;
                nextFocusSim.value = null;
                evaluateGem();
            };

            const deleteHistoryEntry = (hash) => {
                history.value = history.value.filter((entry) => entry.hash !== hash);
                if (compareA.value && compareA.value.hash === hash) compareA.value = null;
                if (compareB.value && compareB.value.hash === hash) compareB.value = null;
                persistHistory();
            };

            const clearHistory = () => {
                history.value = [];
                compareA.value = null;
                compareB.value = null;
                persistHistory();
            };

            // ---- Compare ----
            const pinCurrentToSlot = (slot) => {
                if (!results.value.length) return;
                const result = results.value[0];
                const payload = buildPayload();
                const entry = {
                    hash: hashGemInputs(payload),
                    savedAt: Date.now(),
                    payload,
                    summary: {
                        type: result.type,
                        type_name: result.type_name,
                        tier: result.tier,
                        level: result.level,
                        quality_percent: result.quality_percent,
                        calculated_power_rank: result.calculated_power_rank,
                        element: result.element,
                        restriction_name: result.restriction_name,
                        stat_names: (result.stats || []).map((s) => s.display_name)
                    },
                    result
                };
                if (slot === 'A') compareA.value = entry;
                else compareB.value = entry;
                showCompare.value = true;
            };

            const pinHistoryToSlot = (entry, slot) => {
                if (!entry) return;
                if (slot === 'A') compareA.value = entry;
                else compareB.value = entry;
                showCompare.value = true;
            };

            const swapCompare = () => {
                const tmp = compareA.value;
                compareA.value = compareB.value;
                compareB.value = tmp;
            };

            const clearCompare = () => {
                compareA.value = null;
                compareB.value = null;
                showCompare.value = false;
            };

            const compareDiff = computed(() => {
                if (!compareA.value || !compareB.value) return null;
                const a = compareA.value.summary;
                const b = compareB.value.summary;
                return {
                    quality_delta: +(b.quality_percent - a.quality_percent).toFixed(2),
                    pr_delta: b.calculated_power_rank - a.calculated_power_rank
                };
            });

            const tierName = (tierValue) => {
                const entry = (tierOptions.value || []).find((opt) => opt[1] === tierValue);
                return entry ? entry[0] : '';
            };
            const typeName = (typeValue) => {
                const entry = (typeOptions.value || []).find((opt) => opt[1] === typeValue);
                return entry ? entry[0] : '';
            };

            // ---- Math explainer (collapsed by default) ----
            const mathLines = computed(() => {
                if (!results.value.length) return [];
                const result = results.value[0];
                const lines = [];
                lines.push(t('gems.gem_evaluator.quality_is_the_average_of_each_stat_s_no_a6a7f0'));
                (result.stats || []).forEach((stat) => {
                    lines.push(
                        `${t(stat.display_name)}: ${t('gems.gem_evaluator.value_f32b67')} ${formatNumber(stat.entered_value)} → ` +
                        `${t('gems.gem_evaluator.progress')} ${(stat.progress * 100).toFixed(2)}% ` +
                        `(${t('gems.gem_evaluator.containers_642b5c')}: ${stat.containers})`
                    );
                });
                const avg = (result.stats || []).reduce((sum, s) => sum + s.progress * s.containers, 0);
                const tot = (result.stats || []).reduce((sum, s) => sum + s.containers, 0);
                lines.push(
                    `${t('gems.gem_evaluator.overall')}: (${(result.stats || []).map((s) => `${(s.progress * 100).toFixed(2)}%×${s.containers}`).join(' + ')}) / ${tot} = ${result.quality_percent.toFixed(2)}%`
                );
                lines.push(
                    `${t('common.power_rank')}: ${t('gems.gem_evaluator.base')} + ${t('gems.gem_evaluator.level_increments')} + ${t('gems.gem_evaluator.per_stat_contributions')} = ${result.calculated_power_rank}`
                );
                return lines;
            });

            const applyGuessedDistribution = (distribution) => {
                if (!Array.isArray(distribution) || distribution.length !== form.stats.length) return;
                distribution.forEach((extraContainers, index) => {
                    form.stats[index].extraContainers = Number(extraContainers || 0);
                });
            };

            const setActiveMode = (mode) => {
                activeMode.value = mode;
                results.value = [];
                bestMatch.value = null;
            };

            const persistState = () => {
                if (!window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    activeMode: activeMode.value
                });
            };

            const restoreState = async () => {
                if (!window.AppSettings) return;
                await window.AppSettings.load();
                const saved = window.AppSettings.getPref(PREF_STATE_KEY, null);
                if (saved && typeof saved === 'object' && (saved.activeMode === 'simple' || saved.activeMode === 'full')) {
                    activeMode.value = saved.activeMode;
                }
            };

            const submitActiveEvaluator = async () => {
                if (activeMode.value === 'simple') return evaluateSimpleGem();
                return evaluateGem();
            };

            const guessStats = async (silent = false) => {
                if (!canGuessStats.value) return;
                isGuessingStats.value = true;
                try {
                    const response = await eel.guess_gem_stats(buildPayload())();
                    if (response && response.success) {
                        const guessedTypes = response.guessed_types || response.data?.guessed_types || [];
                        guessedTypes.forEach((type, index) => {
                            if (form.stats[index]) form.stats[index].type = type;
                        });
                        applyGuessedDistribution(response.guessed_distribution || response.data?.guessed_distribution || []);
                    } else if (!silent) {
                        window.showToast(
                            t('gems.gem_evaluator.could_not_guess_stats_error').replace('{error}', response?.error || t('common.unknown_error')),
                            true
                        );
                    }
                } catch (error) {
                    if (!silent) {
                        window.showToast(
                            t('common.connection_error_error').replace('{error}', error),
                            true
                        );
                    }
                }
                isGuessingStats.value = false;
            };

            const evaluateGem = async () => {
                const invalidStat = form.stats.find((stat) => !stat.type || stat.value === '' || Number(stat.value) < 0);
                if (invalidStat && canGuessStats.value) {
                    await guessStats(true);
                }

                const stillInvalidStat = form.stats.find((stat) => !stat.type || stat.value === '' || Number(stat.value) < 0);
                if (stillInvalidStat) {
                    window.showToast(t('gems.gem_evaluator.fill_in_all_three_stat_rows_before_evalu_03eb62'), true);
                    return;
                }

                isEvaluating.value = true;
                try {
                    const payload = buildPayload();
                    const response = await eel.evaluate_gem(payload)();
                    if (response && response.success) {
                        results.value = response.results || response.data?.results || [];
                        bestMatch.value = response.best_match || response.data?.best_match || null;
                        applyGuessedDistribution(response.guessed_distribution || response.data?.guessed_distribution || []);
                        if (results.value.length) {
                            addHistoryEntry(payload, results.value[0]);
                            runNextFocusSim();
                            refreshAllStatRanges();
                        }
                    } else {
                        window.showToast(
                            t('gems.gem_evaluator.could_not_evaluate_gem_error').replace('{error}', response?.error || t('common.unknown_error')),
                            true
                        );
                    }
                } catch (error) {
                    window.showToast(
                        t('common.connection_error_error').replace('{error}', error),
                        true
                    );
                }
                isEvaluating.value = false;
            };

            const evaluateSimpleGem = async () => {
                const powerRank = Number(simpleForm.powerRank || 0);
                const level = Number(simpleForm.level || 1);
                if (powerRank <= 0 || level <= 0) {
                    window.showToast(t('gems.gem_evaluator.fill_in_power_rank_and_level_before_eval_8bc743'), true);
                    return;
                }
                isEvaluating.value = true;
                try {
                    const response = await eel.evaluate_gem_simple({
                        type: Number(simpleForm.type),
                        tier: Number(simpleForm.tier),
                        power_rank: powerRank,
                        level
                    })();
                    if (response && response.success) {
                        results.value = response.results || response.data?.results || [];
                        bestMatch.value = response.best_match || response.data?.best_match || null;
                    } else {
                        window.showToast(
                            t('gems.gem_evaluator.could_not_evaluate_gem_error').replace('{error}', response?.error || t('common.unknown_error')),
                            true
                        );
                    }
                } catch (error) {
                    window.showToast(
                        t('common.connection_error_error').replace('{error}', error),
                        true
                    );
                }
                isEvaluating.value = false;
            };

            watch(() => form.level, () => {
                normalizeProcSpread();
            });

            watch(activeMode, persistState);

            watch(
                () => [
                    form.type,
                    form.tier,
                    form.level,
                    ...form.stats.map((stat) => `${stat.value}`)
                ],
                async () => {
                    normalizeProcSpread();
                    if (activeMode.value === 'full' && canGuessStats.value && needsStatGuess.value) {
                        await guessStats(true);
                    }
                }
            );

            // Refresh stat range hints whenever a stat-relevant field changes.
            watch(
                () => [
                    form.type,
                    form.tier,
                    form.level,
                    ...form.stats.map((stat) => `${stat.type}|${stat.extraContainers}`)
                ],
                () => { refreshAllStatRanges(); },
                { immediate: false }
            );

            // Ctrl+G triggers "Guess Stats" while the evaluator is focused.
            const onHotkey = (e) => {
                if (!(e.ctrlKey || e.metaKey)) return;
                if (e.key.toLowerCase() !== 'g') return;
                if (activeMode.value !== 'full' || !canGuessStats.value || isGuessingStats.value) return;
                e.preventDefault();
                guessStats();
            };

            const loadHistoryFromPrefs = () => {
                if (!window.AppSettings) return;
                const saved = window.AppSettings.getPref(HISTORY_PREF_KEY, []);
                if (Array.isArray(saved)) {
                    history.value = saved.slice(0, HISTORY_LIMIT);
                }
            };

            onMounted(async () => {
                await restoreState();
                loadHistoryFromPrefs();
                document.addEventListener('keydown', onHotkey);
                try {
                    const response = await eel.get_gem_lookups()();
                    if (response && response.success) {
                        lookups.value = response.data || {};
                    }
                } catch (error) {
                    console.error('Failed to load gem evaluator lookups:', error);
                }
            });

            onUnmounted(() => {
                document.removeEventListener('keydown', onHotkey);
            });

            // Hints on this page (see window.createHelpTips).
            const { helpOpen, toggleHelp } = window.createHelpTips(Vue);

            return {
                t,
                helpOpen,
                toggleHelp,
                activeMode,
                setActiveMode,
                submitActiveEvaluator,
                simpleForm,
                form,
                typeOptions,
                tierOptions,
                results,
                bestMatch,
                isEvaluating,
                isGuessingStats,
                availableExtraContainers,
                allocatedExtraContainers,
                remainingExtraContainers,
                procSpreadSummary,
                canGuessStats,
                needsStatGuess,
                statOptionsFor,
                guessStats,
                evaluateGem,
                evaluateSimpleGem,
                formatNumber,
                gemPreviewIcon,
                focusIcon,
                itemIcon,
                focusPlanEntries,
                hasAnyFocusCost,
                focusCountEntries,
                recipeEntries,
                // New bindings
                history,
                restoreFromHistory,
                deleteHistoryEntry,
                clearHistory,
                compareA,
                compareB,
                showCompare,
                pinCurrentToSlot,
                pinHistoryToSlot,
                swapCompare,
                clearCompare,
                compareDiff,
                nextFocusSim,
                isSimulatingFocus,
                showMathExpander,
                statRanges,
                statRangePercent,
                tierName,
                typeName,
                mathLines
            };
        }
    });

    if (window._gemEvaluatorApp) window._gemEvaluatorApp.unmount();
    window._gemEvaluatorApp = app;

    app.component('custom-vue-select', window.CustomVueSelect);
    app.mount('#gem-evaluator-vue-app-inner');
});
