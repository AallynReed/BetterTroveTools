document.addEventListener('star_chart_loaded', async () => {
    console.log("Star Chart Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;

    const COLORS = {
        Combat: { minor: "#FF8F00", major: "#D84315" },
        Gathering: { minor: "#00695C", major: "#558B2F" },
        Pve: { minor: "#6A1B9A", major: "#283593" }
    };

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

            const isLoading = ref(true);
            const origin = ref([500, 500]);
            
            const nodeMap = reactive({});
            const selectedPaths = reactive(new Set());
            const linesList = ref([]);
            const nodesList = ref([]);

            const buildCode = ref("");
            const codeInputFocused = ref(false);

            const templates = ref({});
            const selectedTemplate = ref("");

            const modal = reactive({ show: false, title: '', msg: '', showInput: false, inputValue: '', action: null });
            const modalInputRef = ref(null);

            const tooltip = reactive({ show: false, node: null, x: 0, y: 0 });

            // --- Template Selection ---
            const templateOptions = computed(() => {
                const opts = [];
                for (let name in templates.value) {
                    opts.push([name, name]);
                }
                return opts;
            });

            // --- Stats ---
            const overwrites = computed(() => {
                let ow = new Set();
                selectedPaths.forEach(p => {
                    let node = nodeMap[p];
                    if (node && node.Overwrites) node.Overwrites.forEach(o => ow.add(o));
                });
                return ow;
            });

            const activePaths = computed(() => {
                return Array.from(selectedPaths).filter(p => !overwrites.value.has(p));
            });

            const summaryStats = computed(() => {
                let statsObj = {};
                activePaths.value.forEach(path => {
                    let node = nodeMap[path];
                    if (node && node.Stats) {
                        node.Stats.forEach(stat => {
                            let key = stat.name + (stat.percentage ? "_pct" : "_flat");
                            if (!statsObj[key]) statsObj[key] = { name: stat.name, percentage: stat.percentage, value: 0 };
                            statsObj[key].value += stat.value;
                        });
                    }
                });
                return Object.values(statsObj);
            });

            const summaryAbilities = computed(() => {
                let abs = [];
                activePaths.value.forEach(path => {
                    let node = nodeMap[path];
                    if (node && node.Abilities) abs.push(...node.Abilities);
                });
                return abs;
            });

            const summaryObtainables = computed(() => {
                let obsMap = {};
                activePaths.value.forEach(path => {
                    let node = nodeMap[path];
                    if (node && node.Obtainables) {
                        node.Obtainables.forEach(o => obsMap[o] = (obsMap[o] || 0) + 1);
                    }
                });
                return Object.entries(obsMap).map(([name, count]) => ({ name, count }));
            });

            const hasAnySelection = computed(() => {
                let has = false;
                selectedPaths.forEach(path => {
                    if (nodeMap[path]) has = true;
                });
                return has;
            });

            const selectedNodeCount = computed(() => selectedPaths.size);

            // --- Build SVG Elements ---
            const renderNodes = computed(() => {
                return nodesList.value.map(node => {
                    const isSelected = selectedPaths.has(node.Path);
                    const isOverwritten = overwrites.value.has(node.Path);
                    
                    let rootActive = false;
                    if (node.Type === 'Root') {
                        // Check if any selected node is in this constellation
                        for (let p of selectedPaths) {
                            if (nodeMap[p] && nodeMap[p].constellName === node.constellName) {
                                rootActive = true;
                                break;
                            }
                        }
                    }

                    return {
                        ...node,
                        selected: isSelected,
                        overwritten: isOverwritten,
                        rootActive: rootActive
                    };
                });
            });

            const lines = computed(() => {
                return linesList.value.map(line => {
                    const isSelected = selectedPaths.has(line.pathId);
                    return {
                        ...line,
                        selected: isSelected
                    };
                });
            });

            // --- Graph Traversal ---
            function registerNode(star, constellName, parentPath) {
                star.parentPath = parentPath;
                star.constellName = constellName;
                nodeMap[star.Path] = star;
                
                const isRoot = star.Type === 'Root';
                const isMajor = star.Type === 'Major';

                if (star.Coords) {
                    let nodeData = {
                        id: 'node-' + star.Path.replace(/\./g, "-"),
                        Path: star.Path,
                        Type: star.Type,
                        Name: star.Name,
                        Constellation: star.Constellation,
                        Description: star.Description,
                        Stats: star.Stats,
                        Abilities: star.Abilities,
                        Obtainables: star.Obtainables,
                        Overwrites: star.Overwrites,
                        constellName: constellName
                    };

                    if (isRoot) {
                        const size = 16;
                        const [cx, cy] = star.Coords;
                        nodeData.points = `${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`;
                        nodeData.stroke = COLORS[constellName].major;
                    } else {
                        nodeData.cx = star.Coords[0];
                        nodeData.cy = star.Coords[1];
                        nodeData.r = isMajor ? 14 : 9;
                        nodeData.fill = COLORS[constellName] ? COLORS[constellName][isMajor ? "major" : "minor"] : "#fff";
                    }
                    nodesList.value.push(nodeData);
                }

                if (star.Stars && star.Stars.length > 0) {
                    star.Stars.forEach(child => {
                        if (star.Coords && child.Coords) {
                            linesList.value.push({
                                id: 'line-' + child.Path.replace(/\./g, "-"),
                                pathId: child.Path,
                                x1: star.Coords[0], y1: star.Coords[1],
                                x2: child.Coords[0], y2: child.Coords[1]
                            });
                        }
                        registerNode(child, constellName, star.Path);
                    });
                }
            }

            // --- Interactions ---
            const getAncestorsToSelect = (path, newNodes = []) => {
                if (!path || selectedPaths.has(path)) return newNodes;
                newNodes.push(path);
                const node = nodeMap[path];
                if (node && node.parentPath && nodeMap[node.parentPath].Type !== "Root") {
                    return getAncestorsToSelect(node.parentPath, newNodes);
                }
                return newNodes;
            };

            const deselectNodeAndChildren = (path) => {
                if (!path) return;
                selectedPaths.delete(path);
                Object.values(nodeMap).forEach(child => {
                    if (child.parentPath === path) deselectNodeAndChildren(child.Path);
                });
            };

            const selectAllDescendants = (rootPath) => {
                const rootNode = nodeMap[rootPath];
                if (!rootNode) return;
                let limitHit = false;
                Object.values(nodeMap).forEach(node => {
                    if (node.constellName === rootNode.constellName && node.Type !== "Root") {
                        if (!selectedPaths.has(node.Path)) {
                            if (selectedPaths.size >= 40) { limitHit = true; return; }
                            selectedPaths.add(node.Path);
                        }
                    }
                });
                if (limitHit) window.showToast(t("Cannot exceed maximum of 40 active nodes."), true);
            };

            let clickTimer = null;
            const onRootClick = (node, e) => {
                if (e.detail === 1) {
                    clickTimer = setTimeout(() => {
                        deselectNodeAndChildren(node.Path);
                    }, 250);
                } else if (e.detail === 2) {
                    clearTimeout(clickTimer);
                    selectAllDescendants(node.Path);
                }
            };

            const onNodeClick = (node) => {
                if (selectedPaths.has(node.Path)) {
                    deselectNodeAndChildren(node.Path);
                } else {
                    const nodesToAdd = getAncestorsToSelect(node.Path, []);
                    if (selectedPaths.size + nodesToAdd.length > 40) {
                        window.showToast(t("Cannot exceed maximum of 40 active nodes."), true);
                        return;
                    }
                    nodesToAdd.forEach(p => selectedPaths.add(p));
                }
            };

            // --- Code & Templates ---
            const normalizeCode = (code) => {
                if (!code) return "";
                try { return atob(code).split('$').sort().join('$'); } catch(e) { return code; }
            };

            watch(selectedPaths, () => {
                if (!codeInputFocused.value) {
                    const pathsArray = Array.from(selectedPaths);
                    buildCode.value = pathsArray.length > 0 ? btoa(pathsArray.join('$')) : "";
                }
                updateTemplateDropdown();
            }, { deep: true });

            const updateTemplateDropdown = () => {
                let matchedTemplate = "";
                const currentCode = buildCode.value.trim();
                const normalizedCurrent = normalizeCode(currentCode);
                
                for (let name in templates.value) {
                    if (normalizeCode(templates.value[name]) === normalizedCurrent && currentCode !== "") {
                        matchedTemplate = name;
                        break;
                    }
                }
                selectedTemplate.value = matchedTemplate;
            };

            const loadCode = (silentArg) => {
                const isSilent = silentArg === true;
                const code = buildCode.value.trim();
                if (!code) return;
                try {
                    const paths = atob(code).split('$');
                    
                    let hasValid = false;
                    paths.forEach(p => {
                        if (nodeMap[p] && nodeMap[p].Type !== "Root") hasValid = true;
                    });
                    
                    if (!hasValid) {
                        if (!isSilent) window.showToast(t("No valid nodes found in build code."), true);
                        return;
                    }

                    selectedPaths.clear();
                    let loaded = 0, skipped = 0;

                    paths.forEach(p => {
                        if (nodeMap[p] && nodeMap[p].Type !== "Root") {
                            if (selectedPaths.size < 40) {
                                selectedPaths.add(p);
                                loaded++;
                            } else {
                                skipped++;
                            }
                        }
                    });
                    
                    if (!isSilent) {
                        if (skipped > 0) window.showToast(t("Loaded {loaded} nodes. Skipped {skipped} (Max 40 limit).").replace("{loaded}", loaded).replace("{skipped}", skipped), true);
                        else if (loaded > 0) window.showToast(t("Successfully loaded {loaded} nodes!").replace("{loaded}", loaded));
                    }
                } catch (e) {
                    if (!isSilent) window.showToast(t("Invalid build code format."), true);
                }
            };

            watch(buildCode, (newVal) => {
                if (codeInputFocused.value && newVal) {
                    loadCode(true);
                }
            });

            const copyCode = () => {
                const code = buildCode.value;
                if (!code) { window.showToast(t("No nodes selected to copy."), true); return; }
                navigator.clipboard.writeText(code).then(() => window.showToast(t("Build code copied to clipboard!"))).catch(err => window.showToast(t("Failed to copy: {error}").replace("{error}", err), true));
            };

            watch(selectedTemplate, (newVal) => {
                if (newVal && templates.value[newVal]) {
                    buildCode.value = templates.value[newVal];
                    loadCode();
                }
            });

            const fetchTemplates = async () => {
                templates.value = await eel.get_star_chart_templates()();
                updateTemplateDropdown();
            };

            const saveTemplate = () => {
                const code = buildCode.value.trim();
                if (!code) { window.showToast(t("No active build to save."), true); return; }
                modal.action = 'save';
                modal.title = t('Save Template');
                modal.msg = t('Enter a name for your build:');
                modal.showInput = true;
                modal.inputValue = '';
                modal.show = true;
                nextTick(() => { if (modalInputRef.value) modalInputRef.value.focus(); });
            };

            const deleteTemplate = () => {
                const name = selectedTemplate.value;
                if (!name) return;
                modal.action = 'delete';
                modal.title = t('Delete Template');
                modal.msg = t("Are you sure you want to delete '{name}'?").replace("{name}", name);
                modal.showInput = false;
                modal.show = true;
            };

            const confirmModal = async () => {
                if (modal.action === 'save') {
                    const name = modal.inputValue.trim();
                    if (!name) return window.showToast(t("Please enter a name."), true);
                    const code = buildCode.value.trim();
                    const res = await eel.save_star_chart_template(name, code)();
                    if (res.success) {
                        window.showToast(t("Template '{name}' saved!").replace("{name}", name));
                        await fetchTemplates();
                        selectedTemplate.value = name;
                    } else window.showToast(t("Error saving template."), true);
                } else if (modal.action === 'delete') {
                    const name = selectedTemplate.value;
                    const res = await eel.delete_star_chart_template(name)();
                    if (res.success) {
                        window.showToast(t("Template '{name}' deleted!").replace("{name}", name));
                        await fetchTemplates();
                        selectedTemplate.value = '';
                    } else window.showToast(t("Error deleting template."), true);
                }
                modal.show = false;
            };

            // --- Tooltips ---
            const showTooltip = (e, node) => {
                tooltip.node = node;
                tooltip.show = true;
                moveTooltip(e);
            };
            const moveTooltip = (e) => {
                if (!tooltip.show) return;
                let x = e.clientX + 15, y = e.clientY + 15;
                const ttEl = document.getElementById('star-tooltip');
                if (ttEl) {
                    if (x + ttEl.offsetWidth > window.innerWidth) x = e.clientX - ttEl.offsetWidth - 15;
                    if (y + ttEl.offsetHeight > window.innerHeight) y = e.clientY - ttEl.offsetHeight - 15;
                }
                tooltip.x = x; tooltip.y = y;
            };
            const hideTooltip = () => { tooltip.show = false; tooltip.node = null; };

            const showContextMenu = (e, node) => {
                if (!window.ContextMenu) return;
                const items = [];

                if (node.Type === 'Root') {
                    items.push({
                        label: 'Select Constellation',
                        icon: 'fa-check-double',
                        action: () => selectAllDescendants(node.Path)
                    });
                    items.push({
                        label: 'Deselect Constellation',
                        icon: 'fa-ban',
                        action: () => deselectNodeAndChildren(node.Path)
                    });
                } else {
                    const isSelected = selectedPaths.has(node.Path);
                    items.push({
                        label: isSelected ? 'Deselect Node' : 'Select Node',
                        icon: isSelected ? 'fa-minus' : 'fa-plus',
                        action: () => onNodeClick(node)
                    });
                }

                items.push({ separator: true });
                items.push({
                    label: 'Copy Name',
                    icon: 'fa-copy',
                    action: () => navigator.clipboard.writeText(t(node.Name || node.Constellation)).then(() => { if (window.showToast) window.showToast(t("Copied to clipboard!")); })
                });

                window.ContextMenu.show(e, items);
            };

            onMounted(async () => {
                await fetchTemplates();

                const response = await eel.get_calculated_star_chart()();
                if (response.success) {
                    const data = response.data;
                    origin.value = response.origin;
                    
                    Object.keys(COLORS).forEach(constellName => {
                        if (data[constellName]) {
                            registerNode(data[constellName], constellName, null);
                            if (data[constellName].Coords) {
                                linesList.value.push({
                                    id: 'line-' + data[constellName].Path + '_rootline',
                                    pathId: data[constellName].Path + '_rootline',
                                    x1: origin.value[0], y1: origin.value[1],
                                    x2: data[constellName].Coords[0], y2: data[constellName].Coords[1]
                                });
                            }
                        }
                    });
                    isLoading.value = false;
                    nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                } else {
                    window.showToast(t("Error loading chart data: {error}").replace("{error}", response.error), true);
                }
            });

            return {
                t, isLoading, origin, lines, renderNodes,
                selectedNodeCount, summaryStats, summaryAbilities, summaryObtainables, hasAnySelection,
                onRootClick, onNodeClick,
                buildCode, codeInputFocused, loadCode, copyCode,
                selectedTemplate, templateOptions, saveTemplate, deleteTemplate,
                modal, modalInputRef, confirmModal,
                tooltip, showTooltip, moveTooltip, hideTooltip, showContextMenu
            };
        }
    });

    if (window._starChartApp) window._starChartApp.unmount();
    window._starChartApp = app;

    // Use our custom-vue-select from Gem Simulator if available, else fallback (it's declared globally or we can redefine it)
    if (window.CustomVueSelect) {
        app.component('custom-vue-select', window.CustomVueSelect);
    } else {
        // Redefine the CustomVueSelect component since it's only in gem_simulator right now.
        // Wait, it's better to just use standard select since we call window.applyCustomDropdowns(),
        // OR define CustomVueSelect here too.
        app.component('custom-vue-select', {
            props: ['modelValue', 'options', 'disabled'],
            setup(props, { emit }) {
                const isOpen = ref(false);
                const isDropUp = ref(false);
                const maxH = ref(250);
                const wrapperRef = ref(null);
                const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
                const currentLabel = computed(() => {
                    if (props.modelValue === "") return `-- ${t('Templates')} --`;
                    const found = props.options.find(opt => opt[1] === props.modelValue);
                    return found ? t(found[0]) : `-- ${t('Templates')} --`;
                });
                const toggle = () => {
                    if (props.disabled) return;
                    isOpen.value = !isOpen.value;
                    if (isOpen.value && wrapperRef.value) {
                        const rect = wrapperRef.value.getBoundingClientRect();
                        const spaceBelow = window.innerHeight - rect.bottom;
                        const spaceAbove = rect.top;
                        if (spaceBelow < 250 && spaceAbove > spaceBelow) {
                            isDropUp.value = true;
                            maxH.value = Math.max(100, Math.min(spaceAbove - 20, 250));
                        } else {
                            isDropUp.value = false;
                            maxH.value = Math.max(100, Math.min(spaceBelow - 20, 250));
                        }
                    }
                };
                const selectOpt = (val) => { emit('update:modelValue', val); isOpen.value = false; };
                const handleKey = (e) => {
                    if (props.disabled) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
                    else if (e.key === 'Escape') isOpen.value = false;
                    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        if (!props.options || props.options.length === 0) return;
                        let currentIdx = props.options.findIndex(opt => opt[1] === props.modelValue);
                        if (props.modelValue === '') currentIdx = -1;
                        if (e.key === 'ArrowDown' && currentIdx < props.options.length - 1) currentIdx++;
                        if (e.key === 'ArrowUp' && currentIdx > -1) currentIdx--;
                        if (currentIdx === -1) selectOpt('');
                        else selectOpt(props.options[currentIdx][1]);
                    }
                };
                onMounted(() => { document.addEventListener('click', (e) => { if (wrapperRef.value && !wrapperRef.value.contains(e.target)) isOpen.value = false; }); });
                return { isOpen, isDropUp, maxH, wrapperRef, t, currentLabel, toggle, selectOpt, handleKey };
            },
            template: `
                <div ref="wrapperRef" class="custom-select-wrapper" :class="{ disabled: disabled, open: isOpen, 'drop-up': isDropUp }" @click.stop="toggle" tabindex="0" @keydown="handleKey">
                    <div class="custom-select-trigger">
                        <span class="custom-select-trigger-text">{{ currentLabel }}</span>
                        <i class="fa-solid fa-chevron-down"></i>
                    </div>
                    <div class="custom-select-options" :style="{ maxHeight: maxH + 'px' }">
                        <div class="custom-select-option" :class="{ selected: modelValue === '' }" @click.stop="selectOpt('')">-- {{ t('Templates') }} --</div>
                        <div v-for="opt in options" :key="opt[0]" class="custom-select-option" :class="{ selected: modelValue === opt[1] }" @click.stop="selectOpt(opt[1])">
                            {{ t(opt[0]) }}
                        </div>
                    </div>
                </div>
            `
        });
    }

    app.mount('#star-chart-vue-app');
});