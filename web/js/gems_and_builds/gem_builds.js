document.addEventListener("gem_builds_loaded", () => {
    console.log("Gem Builds Engine initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
            const PREF_STATE_KEY = 'state_gem_builds';
            const unwrapResp = (resp, key = null, fallback = null) => {
                if (key) {
                    if (resp && Object.prototype.hasOwnProperty.call(resp, key)) return resp[key];
                    if (resp && resp.data && Object.prototype.hasOwnProperty.call(resp.data, key)) return resp.data[key];
                }
                if (resp && resp.data !== undefined && resp.success !== undefined) return resp.data;
                return resp ?? fallback;
            };

            const config = reactive({
                character: "Boomeranger",
                subclass: "Knight",
                build_type: "Light",
                ally: "boot_clown",
                food: "",
                light: 0,
                critical_damage_count: 3,
                berserker_battler: false,
                litany: false,
                subclass_active: false,
                no_face: false,
                star_chart: "",
                scTemplate: ""
            });
            const modifiersOpen = ref(false);
            const tipsDismissed = ref(false);

            let hydratingState = false;

            const saveState = () => {
                if (!window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    config: JSON.parse(JSON.stringify(config)),
                    ui: {
                        modifiersOpen: !!modifiersOpen.value,
                        tipsDismissed: !!tipsDismissed.value
                    }
                });
            };

            const restoreState = async () => {
                if (!window.AppSettings) return;
                await window.AppSettings.load();
                const saved = window.AppSettings.getPref(PREF_STATE_KEY, null);
                if (!saved || typeof saved !== 'object') return;

                const savedConfig = saved.config && typeof saved.config === 'object' ? saved.config : saved;
                const savedUi = saved.ui && typeof saved.ui === 'object' ? saved.ui : null;

                hydratingState = true;
                Object.keys(config).forEach((key) => {
                    if (savedConfig[key] !== undefined) {
                        config[key] = savedConfig[key];
                    }
                });
                if (savedUi && typeof savedUi.modifiersOpen === 'boolean') {
                    modifiersOpen.value = savedUi.modifiersOpen;
                }
                if (savedUi && typeof savedUi.tipsDismissed === 'boolean') {
                    tipsDismissed.value = savedUi.tipsDismissed;
                }
                hydratingState = false;
            };

            const classesData = ref([]);
            const foodsData = ref({});
            const alliesData = ref({});
            const starChartTemplates = ref({});
            const starChartSummary = ref(null);

            const cachedBuilds = ref([]);
            const currentPage = ref(0);
            const itemsPerPage = 15;
            const isCalculating = ref(false);
            // True when the build optimizer (desktop calc engine) is unavailable,
            // e.g. hosted web mode or the Android build.
            const buildsUnavailable = ref(false);

            const classIcon = computed(() => {
                const cls = classesData.value.find(c => c.value === config.character);
                return cls ? `assets/images/classes/${cls.name.toLowerCase().replace(/ /g, '_')}.png` : '';
            });
            const subclassIcon = computed(() => {
                const cls = classesData.value.find(c => c.value === config.subclass);
                return cls ? `assets/images/classes/${cls.name.toLowerCase().replace(/ /g, '_')}.png` : '';
            });
            const onImageError = (e) => {
                if (!e.target.dataset.retried) {
                    e.target.dataset.retried = "true";
                    e.target.src = e.target.src.replace('/classes/', '/icons/');
                }
            };

            const bestCoeff = computed(() => cachedBuilds.value.length > 0 ? cachedBuilds.value[0].coefficient : 1);
            const maxPages = computed(() => Math.ceil(cachedBuilds.value.length / itemsPerPage) || 1);
            const paginatedBuilds = computed(() => {
                const start = currentPage.value * itemsPerPage;
                return cachedBuilds.value.slice(start, start + itemsPerPage);
            });

            const nextPage = () => { if (currentPage.value < maxPages.value - 1) currentPage.value++; };
            const prevPage = () => { if (currentPage.value > 0) currentPage.value--; };

            const getTradeoffSummary = (build) => {
                const best = cachedBuilds.value[0];
                if (!best || build.rank === 1) {
                    return t('gems.gem_builds.best_overall_coefficient_for_this_setup');
                }

                const coeffGap = (((best.coefficient - build.coefficient) / best.coefficient) * 100).toFixed(3);
                const lightDelta = build.light - best.light;
                const critDelta = build.crit_dmg - best.crit_dmg;
                const damageDelta = Math.round(build.total_dmg - best.total_dmg);
                const tradeoffs = [];

                if (lightDelta > 0) tradeoffs.push(t('gems.gem_builds.gains_value_light').replace('{value}', lightDelta.toLocaleString()));
                if (critDelta > 0) tradeoffs.push(t('gems.gem_builds.gains_value_crit_damage').replace('{value}', critDelta.toFixed(1)));
                if (damageDelta > 0) tradeoffs.push(t('gems.gem_builds.gains_value_total_damage').replace('{value}', damageDelta.toLocaleString()));
                if (lightDelta < 0) tradeoffs.push(t('gems.gem_builds.gives_up_value_light').replace('{value}', Math.abs(lightDelta).toLocaleString()));
                if (critDelta < 0) tradeoffs.push(t('gems.gem_builds.gives_up_value_crit_damage').replace('{value}', Math.abs(critDelta).toFixed(1)));

                const tradeoffText = tradeoffs.length > 0
                    ? tradeoffs.slice(0, 2).join(', ')
                    : t('gems.gem_builds.changes_the_stat_spread_without_a_major_309ba4');

                return t('gems.gem_builds.this_build_is_value_behind_the_best_but_00d201')
                    .replace('{value}', coeffGap)
                    .replace('{tradeoff}', tradeoffText);
            };

            const getBuildHeadline = (build) => {
                if (!build) return '';
                if (build.rank === 1) {
                    if (cachedBuilds.value.length > 1) {
                        const runnerUp = cachedBuilds.value[1];
                        const edge = (((build.coefficient - runnerUp.coefficient) / runnerUp.coefficient) * 100).toFixed(3);
                        return t('gems.gem_builds.highest_coefficient_for_your_current_set_ea1fda').replace('{value}', edge);
                    }
                    return t('gems.gem_builds.highest_coefficient_for_your_current_set_d2b906');
                }
                return getTradeoffSummary(build);
            };

            const getTooltipHtml = (build) => {
                const classBonusText = build.class_bonus ? `<span style="color: var(--accent-blue);"> + ${build.class_bonus}%</span>` : "";
                const tradeoffText = getTradeoffSummary(build);
                return `
                    <div style="min-width: 220px;">
                        <h3>${t("gems.gem_builds.build_rank_details").replace("{rank}", build.rank)}</h3>
                        <p style="margin: 0 0 10px 0; color: var(--text-muted); line-height: 1.45;">${tradeoffText}</p>
                        <ul style="list-style: none; padding: 0; margin: 0;">
                            <li style="margin-bottom: 4px;"><strong>${t("common.light")}:</strong> <span style="float: right; color: #fff;">${build.light.toLocaleString()}</span></li>
                            <li style="margin-bottom: 4px;"><strong>${t("gems.gem_builds.base_dmg")}:</strong> <span style="float: right; color: #fff;">${Math.round(build.base_dmg).toLocaleString()}</span></li>
                            <li style="margin-bottom: 4px;"><strong>${t("gems.gem_builds.bonus_dmg")}:</strong> <span style="float: right; color: #fff;">${build.bonus_dmg.toFixed(2)}%${classBonusText}</span></li>
                            <li style="margin-bottom: 4px;"><strong>${t("gems.gem_builds.crit_dmg")}:</strong> <span style="float: right; color: #fff;">${build.crit_dmg.toFixed(1)}%</span></li>
                            <hr style="border: 0; border-top: 1px dashed var(--border-color); margin: 8px 0;">
                            <li style="margin-bottom: 4px;"><strong>${t("gems.gem_builds.total_dmg")}:</strong> <span style="float: right; color: #fff;">${Math.round(build.total_dmg).toLocaleString()}</span></li>
                            <li style="margin-bottom: 4px;"><strong>${t("gems.gem_builds.coefficient")}:</strong> <span style="float: right; color: var(--accent-orange); font-weight: bold;">${build.coefficient.toLocaleString()}</span></li>
                        </ul>
                    </div>
                `.replace(/"/g, '&quot;');
            };

            const copyLayout = async (layout, e) => {
                try {
                    await navigator.clipboard.writeText(layout);
                    const originalColor = e.target.style.color;
                    e.target.style.color = "#4CAF50";
                    setTimeout(() => e.target.style.color = originalColor, 500);
                    if(window.showToast) window.showToast(t("gems.gem_builds.copied_build_layout_to_clipboard"));
                } catch (err) {
                    console.error("Failed to copy:", err);
                }
            };

            const dismissTips = () => {
                tipsDismissed.value = true;
                if (!hydratingState && window.AppSettings) {
                    saveState();
                }
            };

            const exportCsv = () => {
                if (!cachedBuilds.value || cachedBuilds.value.length === 0) {
                    if(window.showToast) window.showToast(t("gems.gem_builds.no_builds_available_to_export"), true);
                    return;
                }
                let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
                csvContent += "Rank,Build Layout,Light,Base Dmg,Bonus Dmg (%),Total Dmg,Crit Dmg (%),Coefficient\n";
                cachedBuilds.value.forEach(b => {
                    csvContent += `${b.rank},${b.layout},${b.light},${Math.round(b.base_dmg)},${b.bonus_dmg.toFixed(2)},${Math.round(b.total_dmg)},${b.crit_dmg.toFixed(1)},${b.coefficient}\n`;
                });
                const link = document.createElement("a");
                link.setAttribute("href", encodeURI(csvContent));
                link.setAttribute("download", "gem_builds_export.csv");
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            };

            const showContextMenu = (e, build) => {
                if (!window.ContextMenu) return;
                window.ContextMenu.show(e, [
                    {
                        label: 'Copy Build Layout',
                        icon: 'fa-copy',
                        action: () => navigator.clipboard.writeText(build.layout).then(() => { if(window.showToast) window.showToast(t("gems.gem_builds.copied_build_layout_to_clipboard")); })
                    },
                    {
                        label: 'Copy Coefficient',
                        icon: 'fa-hashtag',
                        action: () => navigator.clipboard.writeText(build.coefficient.toString()).then(() => { if(window.showToast) window.showToast(t("gems.gem_builds.copied_coefficient_to_clipboard")); })
                    },
                    {
                        label: 'Copy All Stats',
                        icon: 'fa-clipboard-list',
                        action: () => {
                            const classBonusText = build.class_bonus ? ` + ${build.class_bonus}%` : "";
                            const statsText = [
                                `${t("gems.gem_builds.build_rank")}: #${build.rank}`,
                                `${t("gems.gem_builds.build")}: ${build.layout}`,
                                `${t("common.light")}: ${build.light.toLocaleString()}`,
                                `${t("gems.gem_builds.base_dmg")}: ${Math.round(build.base_dmg).toLocaleString()}`,
                                `${t("gems.gem_builds.bonus_dmg")}: ${build.bonus_dmg.toFixed(2)}%${classBonusText}`,
                                `${t("gems.gem_builds.crit_dmg")}: ${build.crit_dmg.toFixed(1)}%`,
                                `${t("gems.gem_builds.total_dmg")}: ${Math.round(build.total_dmg).toLocaleString()}`,
                                `${t("gems.gem_builds.coefficient")}: ${build.coefficient.toLocaleString()}`
                            ].join('\n');
                            navigator.clipboard.writeText(statsText).then(() => { if(window.showToast) window.showToast(t("gems.gem_builds.copied_all_stats_to_clipboard")); });
                        }
                    },
                    { separator: true },
                    { label: 'Export All to CSV', icon: 'fa-file-csv', action: exportCsv }
                ]);
            };

            let calcTimeout;
            const triggerCalculation = () => {
                clearTimeout(calcTimeout);
                calcTimeout = setTimeout(async () => {
                    if (isCalculating.value) return;
                    isCalculating.value = true;
                    try {
                        const pyConfig = {
                            character: config.character,
                            subclass: config.subclass,
                            build_type: config.build_type,
                            ally: config.ally,
                            food: config.food,
                            light: config.light,
                            critical_damage_count: config.critical_damage_count,
                            berserker_battler: config.berserker_battler,
                            litany: config.litany,
                            subclass_active: config.subclass_active,
                            no_face: config.no_face,
                            star_chart: config.star_chart
                        };
                        const results = await eel.calculate_gem_builds(pyConfig)();
                        if (results && results.success === false) {
                            // Build optimization needs the desktop calc engine; it is
                            // unavailable in hosted web mode / the Android build. Show a
                            // notice instead of letting a non-array crash the render.
                            cachedBuilds.value = [];
                            buildsUnavailable.value = true;
                        } else {
                            const parsedResults = unwrapResp(results, 'builds', results);
                            cachedBuilds.value = Array.isArray(parsedResults) ? parsedResults : [];
                            buildsUnavailable.value = false;
                        }
                        currentPage.value = 0;
                    } catch (e) {
                        console.error(e);
                    } finally {
                        isCalculating.value = false;
                    }
                }, 300);
            };

            watch(() => config.character, (newVal) => {
                if (newVal === config.subclass) {
                    const other = classesData.value.find(c => c.value !== newVal);
                    if (other) config.subclass = other.value;
                }
            });

            watch(() => config.subclass, (newVal) => {
                if (newVal === config.character) {
                    const other = classesData.value.find(c => c.value !== newVal);
                    if (other) config.character = other.value;
                }
            });

            watch(() => config.star_chart, async (newVal) => {
                let matched = false;
                for (const [name, code] of Object.entries(starChartTemplates.value)) {
                    if (code === newVal && newVal !== "") {
                        config.scTemplate = code;
                        matched = true;
                        break;
                    }
                }
                if (!matched) config.scTemplate = "";

                if (!newVal) {
                    starChartSummary.value = null;
                    return;
                }

                try {
                    const parsedData = await eel.parse_star_chart_code(newVal)();
                    const parsed = unwrapResp(parsedData, null, {});
                    const pathsCount = Number(parsed?.paths_count) || 0;
                    if (pathsCount <= 0) {
                        throw new Error('Invalid build code');
                    }
                    starChartSummary.value = { pathsCount, stats: parsed?.stats || {}, error: false };
                } catch(e) {
                    starChartSummary.value = { error: true };
                }
            });

            watch(config, () => {
                if (!hydratingState && window.AppSettings) {
                    saveState();
                }
                triggerCalculation();
            }, { deep: true });

            watch(modifiersOpen, () => {
                if (!hydratingState && window.AppSettings) {
                    saveState();
                }
            });

            watch(tipsDismissed, () => {
                if (!hydratingState && window.AppSettings) {
                    saveState();
                }
            });

            onMounted(async () => {
                try {
                    await restoreState();

                    const [cData, fData, aData, scData] = await Promise.all([
                        eel.get_trove_classes()(),
                        eel.get_food_data()(),
                        eel.get_ally_data()(),
                        eel.get_star_chart_templates()()
                    ]);
                    const classes = unwrapResp(cData, 'classes', []);
                    const foods = unwrapResp(fData, null, {});
                    const allies = unwrapResp(aData, null, {});
                    const templates = unwrapResp(scData, 'templates', {});

                    if (classes) classesData.value = classes;
                    if (foods) foodsData.value = foods;
                    if (allies) alliesData.value = allies;
                    if (templates) starChartTemplates.value = templates;
                    
                    triggerCalculation();
                    nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                } catch(e) {
                    console.error("Config load error:", e);
                }
            });

            // Only show these stats in the star chart summary
            const allowedStats = ['Physical Damage', 'Magic Damage', 'Critical Damage', 'Critical Hit', 'Light'];
            const filteredStarChartStats = computed(() => {
                if (!starChartSummary.value || !starChartSummary.value.stats) return {};
                const stats = starChartSummary.value.stats;
                const filtered = {};
                for (const key of allowedStats) {
                    if (stats[key]) filtered[key] = stats[key];
                }
                return filtered;
            });

            return {
                t, config, classesData, foodsData, alliesData, starChartTemplates, starChartSummary,
                filteredStarChartStats,
                classIcon, subclassIcon, onImageError,
                modifiersOpen, tipsDismissed,
                cachedBuilds, currentPage, maxPages, paginatedBuilds, isCalculating, bestCoeff, buildsUnavailable,
                nextPage, prevPage, getTooltipHtml, copyLayout, exportCsv, showContextMenu,
                getBuildHeadline, dismissTips
            };
        }
    });

    if (window._gemBuildsApp) window._gemBuildsApp.unmount();
    window._gemBuildsApp = app;
    
    app.mount('#gem-builds-vue-app-inner');
});
