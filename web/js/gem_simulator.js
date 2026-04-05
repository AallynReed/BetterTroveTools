document.addEventListener('gem_simulator_loaded', async () => {
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted } = Vue;

    const ELEMENT_COLORS = { Fire: '#e57373', Water: '#64b5f6', Air: '#fff59d', Cosmic: '#4db6ac' };
    const ELEMENT_DEFAULT_COLOR = '#888888';

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

            const lookups = ref({});
            const inventory = ref(new Array(150).fill(null));
            const equipped = ref(new Array(12).fill(null));
            
            const selected = ref(null);
            const selectedSource = ref(null); // { pane: 'inventory'|'equipped', idx: number }
            
            const primordialToggles = reactive({});
            
            const creatorParams = reactive({
                type: "", tier: "", element: "", restriction: "",
                level: 1, augmentNull: true, augment: 0
            });

            const selectedStatIdx = ref(0);
            const selectedActionKey = ref(null);
            
            const confirmModal = reactive({ show: false, title: '', message: '', onConfirm: null });
            const tooltip = reactive({ show: false, item: null, x: 0, y: 0 });
            
            const isGenerating = ref(false);
            const isLevelingUp = ref(false);
            const isActioning = ref(false);
            const isSyncing = ref(false);

            const formatGemName = (name) => {
                if (!name) return "";
                return String(name).split('_').join(' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            };

            const getTypeDisplayName = (idOrName) => {
                const entry = Object.entries(lookups.value.types || {}).find(([k, v]) => v == idOrName || k == idOrName);
                return entry ? t(formatGemName(entry[0])) : idOrName;
            };
            const getElementNameById = (id) => {
                const found = Object.entries(lookups.value.elements || {}).find(([, v]) => v == id);
                return found ? formatGemName(found[0]) : "Unknown";
            };
            const getTierDisplayName = (id) => {
                const name = Object.keys(lookups.value.tiers || {}).find(k => String(lookups.value.tiers[k]) === String(id));
                return name ? t(formatGemName(name)) : id;
            };

            const gemTierBgUrl = (gem) => `assets/gems/gem_tiers/${gem.tier}.png`;
            const gemImageUrl = (gem) => `assets/gems/gem_types/${gem.type}/elements/${gem.element}.png`;

            const formattedObj = (obj) => {
                if (!obj) return [[`(${t('None')})`, '']];
                const opts = Object.entries(obj).sort((a,b) => a[1]-b[1]).map(([k, v]) => [formatGemName(k), v]);
                opts.unshift([`(${t('None')})`, '']);
                return opts;
            };

            const getStatName = (gem, idx) => Object.keys(gem.stat_values[idx])[0] || `Stat ${idx + 1}`;
            const getStatValue = (gem, idx) => {
                const name = getStatName(gem, idx);
                return gem.stat_values[idx][name];
            };
            const getBarColor = (val) => val < 0.33 ? '#d32f2f' : (val < 0.66 ? '#fbc02d' : '#34d058');
            
            const formatStat = (val) => (Math.round(val * 100) / 100).toLocaleString();

            const equippedRows = computed(() => {
                if (!lookups.value.elements) return [];
                return Object.entries(lookups.value.elements)
                    .sort((a, b) => a[1] - b[1])
                    .map(([name, id], rowIdx) => ({
                        elementId: id,
                        elementName: t(formatGemName(name)),
                        color: ELEMENT_COLORS[formatGemName(name)] || ELEMENT_DEFAULT_COLOR,
                        slots: [
                            { typeRestriction: 1, idx: rowIdx * 3 + 0 },
                            { typeRestriction: 1, idx: rowIdx * 3 + 1 },
                            { typeRestriction: 2, idx: rowIdx * 3 + 2 }
                        ]
                    }));
            });

            const elementsList = computed(() => {
                if(!lookups.value.elements) return [];
                return Object.entries(lookups.value.elements).sort((a, b) => a[1] - b[1]).map(([name, id]) => ({
                    id, name: t(formatGemName(name)), color: ELEMENT_COLORS[formatGemName(name)] || ELEMENT_DEFAULT_COLOR
                }));
            });

            const statTotalsBuffed = computed(() => {
                let totals = {};
                equipped.value.filter(Boolean).forEach(gem => {
                    const buffActive = primordialToggles[gem.element];
                    gem.stats.forEach((_, i) => {
                        const statName = getStatName(gem, i);
                        const val = getStatValue(gem, i);
                        totals[statName] = (totals[statName] || 0) + (buffActive ? val * 1.10 : val);
                    });
                });
                return totals;
            });

            const sortedStatTotals = computed(() => {
                const sorted = [];
                const raw = statTotalsBuffed.value;
                Object.keys(raw).sort().forEach(k => {
                    if (raw[k] > 0) sorted.push({ name: k, value: raw[k] });
                });
                return sorted;
            });

            const totalPRBuffed = computed(() => {
                let total = 0;
                equipped.value.filter(Boolean).forEach(gem => {
                    const buffActive = primordialToggles[gem.element];
                    total += buffActive ? gem.power_rank * 1.10 : gem.power_rank;
                });
                return Math.round(total);
            });

            const augmentOptions = computed(() => {
                if (!lookups.value.augment_types) return [];
                return Object.entries(lookups.value.augment_types).sort((a, b) => a[1] - b[1]).map(([_, id]) => ({
                    key: `augment-${id}`, img: `assets/gems/augments/${id}.png`
                }));
            });

            const modifierOptions = [
                { key: 'spark', img: 'assets/gems/modifiers/spark.png' },
                { key: 'flare', img: 'assets/gems/modifiers/flare.png' }
            ];

            const actionButtonText = computed(() => {
                if (!selectedActionKey.value) return 'Action';
                if (selectedActionKey.value === 'spark') return 'Change Stat';
                if (selectedActionKey.value === 'flare') return 'Move Boost';
                return 'Augment Stat';
            });

            const isSelectedInStorage = computed(() => {
                if (!selected.value || !selected.value.id) return true;
                const inInv = inventory.value.some(i => i && i.id === selected.value.id);
                const inEq = equipped.value.some(i => i && i.id === selected.value.id);
                return inInv || inEq;
            });

            const saveInventoryDebounced = () => {
                eel.save_gem_storage({
                    inventory: inventory.value,
                    equipped: equipped.value,
                    toggles: primordialToggles
                })();
            };

            watch([inventory, equipped, primordialToggles], saveInventoryDebounced, { deep: true });

            const loadStorage = async () => {
                const data = await eel.load_gem_storage()();
                if (data) {
                    if (data.inventory && data.inventory.length > 0) inventory.value = data.inventory;
                    if (data.equipped && data.equipped.length > 0) equipped.value = data.equipped;
                    if (data.toggles) {
                        Object.keys(data.toggles).forEach(k => primordialToggles[k] = data.toggles[k]);
                    }
                }
                if (lookups.value.elements) {
                    Object.values(lookups.value.elements).forEach(id => {
                        if (primordialToggles[id] === undefined) primordialToggles[id] = true;
                    });
                }
            };

            const selectGem = (gem, pane, idx) => {
                if (selected.value && selected.value.id !== gem.id) {
                    selectedActionKey.value = null;
                    selectedStatIdx.value = 0;
                }
                selected.value = gem;
                selectedSource.value = { pane, idx };
                hideTooltip();
            };

            const showConfirm = (title, message, onConfirmCallback) => {
                confirmModal.title = title;
                confirmModal.message = message;
                confirmModal.onConfirm = onConfirmCallback;
                confirmModal.show = true;
            };

            const executeConfirm = () => {
                if (confirmModal.onConfirm) confirmModal.onConfirm();
                confirmModal.show = false;
            };

            const onDragStart = (e, pane, idx) => {
                hideTooltip();
                e.dataTransfer.setData('text/plain', JSON.stringify({ pane, idx }));
            };

            const resolveDraggedGem = (pane, idx) => {
                if (pane === 'selected') return { source: selectedSource.value, gem: selected.value };
                const sourceGem = pane === 'inventory' ? inventory.value[idx] : equipped.value[idx];
                return { source: { pane, idx }, gem: sourceGem };
            };

            const updateSelectionAfterSwap = (paneA, idxA, gemA, paneB, idxB, gemB) => {
                if (selected.value) {
                    if (gemB && selected.value.id === gemB.id) selectedSource.value = { pane: paneB, idx: idxB };
                    if (gemA && selected.value.id === gemA.id) selectedSource.value = { pane: paneA, idx: idxA };
                }
            };

            const validateEquip = (gem, slotIdx) => {
                let targetElement = null, targetType = null;
                for (const row of equippedRows.value) {
                    const s = row.slots.find(s => s.idx === slotIdx);
                    if (s) { targetElement = row.elementId; targetType = s.typeRestriction; break; }
                }
                if (String(gem.element) !== String(targetElement) || String(gem.type) !== String(targetType)) {
                    return { valid: false, error: String(gem.element) !== String(targetElement) ? t("Requires {element}.").replace("{element}", getElementNameById(targetElement)) : t("Requires {type} gem.").replace("{type}", getTypeDisplayName(targetType)) };
                }
                if (gem.ability) {
                    const isDup = equipped.value.some((g, i) => g && i !== slotIdx && String(g.ability) === String(gem.ability));
                    if (isDup) return { valid: false, error: t("Cannot equip multiple Empowered Gems with the same ability.") };
                }
                return { valid: true };
            };

            const onDropInventory = (e, toIdx) => {
                const data = e.dataTransfer.getData('text/plain');
                if (!data) return;
                const { source, gem: draggedGem } = resolveDraggedGem(...Object.values(JSON.parse(data)));
                if (!draggedGem || (source.pane === 'inventory' && source.idx === toIdx)) return;

                const targetGem = inventory.value[toIdx];
                
                if (source.pane === 'inventory') {
                    inventory.value[source.idx] = targetGem;
                    inventory.value[toIdx] = draggedGem;
                    updateSelectionAfterSwap('inventory', source.idx, targetGem, 'inventory', toIdx, draggedGem);
                } else if (source.pane === 'equipped') {
                    if (targetGem) {
                        const val = validateEquip(targetGem, source.idx);
                        if (!val.valid) return window.showToast(val.error, true);
                    }
                    equipped.value[source.idx] = targetGem;
                    inventory.value[toIdx] = draggedGem;
                    updateSelectionAfterSwap('equipped', source.idx, targetGem, 'inventory', toIdx, draggedGem);
                }
            };

            const onDropEquipped = (e, reqElementId, reqType, toIdx) => {
                const data = e.dataTransfer.getData('text/plain');
                if (!data) return;
                const { source, gem: draggedGem } = resolveDraggedGem(...Object.values(JSON.parse(data)));
                if (!draggedGem || (source.pane === 'equipped' && source.idx === toIdx)) return;

                const val = validateEquip(draggedGem, toIdx);
                if (!val.valid) return window.showToast(val.error, true);

                const targetGem = equipped.value[toIdx];

                if (source.pane === 'inventory') {
                    inventory.value[source.idx] = targetGem;
                    equipped.value[toIdx] = draggedGem;
                    updateSelectionAfterSwap('inventory', source.idx, targetGem, 'equipped', toIdx, draggedGem);
                } else if (source.pane === 'equipped') {
                    equipped.value[source.idx] = targetGem;
                    equipped.value[toIdx] = draggedGem;
                    updateSelectionAfterSwap('equipped', source.idx, targetGem, 'equipped', toIdx, draggedGem);
                }
            };

            const onDropTrash = (e) => {
                const data = e.dataTransfer.getData('text/plain');
                if (!data) return;
                const { source, gem: draggedGem } = resolveDraggedGem(...Object.values(JSON.parse(data)));
                if (!draggedGem) return;

                showConfirm(t('Trash Gem'), t('Are you sure you want to permanently delete this gem?'), () => {
                    if (source.pane === 'inventory') inventory.value[source.idx] = null;
                    if (source.pane === 'equipped') equipped.value[source.idx] = null;
                    if (selected.value && selected.value.id === draggedGem.id) {
                        selected.value = null;
                        selectedSource.value = null;
                    }
                    window.showToast(t('Gem deleted.'));
                });
            };

            const trashSelected = () => {
                if (!selected.value) return window.showToast(t("No gem selected to trash."), true);
                showConfirm(t("Trash Gem"), t("Are you sure you want to permanently delete the selected gem?"), () => {
                    if (selectedSource.value) {
                        if (selectedSource.value.pane === 'equipped') equipped.value[selectedSource.value.idx] = null;
                        if (selectedSource.value.pane === 'inventory') inventory.value[selectedSource.value.idx] = null;
                    }
                    selected.value = null;
                    selectedSource.value = null;
                    window.showToast(t("Gem deleted."));
                });
            };

            const saveSelectedToInventory = () => {
                const emptyIdx = inventory.value.findIndex(i => !i);
                if (emptyIdx === -1) return window.showToast(t('Inventory is full.'), true);
                inventory.value[emptyIdx] = JSON.parse(JSON.stringify(selected.value));
            };

            const showContextMenu = (e, item, pane, idx) => {
                if (!window.ContextMenu) return;
                window.ContextMenu.show(e, [
                    { label: 'Select Gem', icon: 'fa-hand-pointer', action: () => selectGem(item, pane, idx) },
                    { separator: true },
                    { label: 'Trash Gem', icon: 'fa-trash', danger: true, action: () => {
                        showConfirm(t("Trash Gem"), t("Are you sure you want to permanently delete this gem?"), () => {
                            if (pane === 'inventory') inventory.value[idx] = null;
                            if (pane === 'equipped') equipped.value[idx] = null;
                            if (selected.value && selected.value.id === item.id) { selected.value = null; selectedSource.value = null; }
                        });
                    }}
                ]);
            };

            const showTooltip = (e, item) => {
                tooltip.item = item;
                tooltip.show = true;
                moveTooltip(e);
            };
            const moveTooltip = (e) => {
                if (!tooltip.show) return;
                let x = e.clientX + 15, y = e.clientY + 15;
                const ttEl = document.getElementById('gem-tooltip');
                if (ttEl) {
                    if (x + ttEl.offsetWidth > window.innerWidth) x = e.clientX - ttEl.offsetWidth - 15;
                    if (y + ttEl.offsetHeight > window.innerHeight) y = e.clientY - ttEl.offsetHeight - 15;
                }
                tooltip.x = x; tooltip.y = y;
            };
            const hideTooltip = () => { tooltip.show = false; tooltip.item = null; };

            const generateGem = async () => {
                isGenerating.value = true;
                try {
                    const body = {};
                    if (creatorParams.type) body.type = parseInt(creatorParams.type);
                    if (creatorParams.tier) body.tier = parseInt(creatorParams.tier);
                    if (creatorParams.element) body.element = parseInt(creatorParams.element);
                    if (creatorParams.type === 1 && creatorParams.restriction) body.restriction = parseInt(creatorParams.restriction);
                    if (creatorParams.level) body.level = parseInt(creatorParams.level);
                    if (creatorParams.augmentNull) body.augmentation = null;
                    else body.augmentation = creatorParams.augment / 100;

                    const resp = await eel.create_gem(body)();
                    if (resp && resp.success) {
                        selected.value = resp.gem;
                        selectedSource.value = null;
                    } else {
                        window.showToast(t("Could not generate gem: {error}").replace("{error}", resp?.error || t("Unknown Error")), true);
                    }
                } catch(err) {
                    window.showToast(t("Connection error: {error}").replace("{error}", err), true);
                }
                isGenerating.value = false;
            };

            const levelUpSelected = async () => {
                isLevelingUp.value = true;
                try {
                    const resp = await eel.level_up_gem(selected.value)();
                    if (resp && resp.success) {
                        selected.value = resp.gem;
                        if (selectedSource.value) {
                            if (selectedSource.value.pane === 'inventory') inventory.value[selectedSource.value.idx] = resp.gem;
                            if (selectedSource.value.pane === 'equipped') equipped.value[selectedSource.value.idx] = resp.gem;
                        }
                    } else {
                        window.showToast(t("Could not level up gem: {error}").replace("{error}", resp?.error || t("Unknown Error")), true);
                    }
                } catch(e) {
                    window.showToast(t("Connection error: {error}").replace("{error}", e), true);
                }
                isLevelingUp.value = false;
            };

            const doSelectedAction = async () => {
                if (!selectedActionKey.value || !selected.value) return;
                isActioning.value = true;
                try {
                    const statTypeId = selected.value.stats[selectedStatIdx.value].type;
                    let resp;
                    if (selectedActionKey.value.startsWith('augment-')) {
                        const augmentId = parseInt(selectedActionKey.value.split('-')[1]);
                        resp = await eel.augment_gem(selected.value, statTypeId, augmentId)();
                    } else if (selectedActionKey.value === 'spark') {
                        resp = await eel.spark_gem(selected.value, statTypeId)();
                    } else if (selectedActionKey.value === 'flare') {
                        resp = await eel.flare_gem(selected.value, statTypeId)();
                    }

                    if (resp && resp.success) {
                        selected.value = resp.gem;
                        if (selectedSource.value) {
                            if (selectedSource.value.pane === 'inventory') inventory.value[selectedSource.value.idx] = resp.gem;
                            if (selectedSource.value.pane === 'equipped') equipped.value[selectedSource.value.idx] = resp.gem;
                        }
                    } else {
                        window.showToast(t("Action failed: {error}").replace("{error}", resp?.error || t("Unknown Error")), true);
                    }
                } catch(e) {
                    window.showToast(t("Connection error: {error}").replace("{error}", e), true);
                }
                isActioning.value = false;
            };

            const syncGems = async () => {
                isSyncing.value = true;
                try {
                    if (inventory.value.length > 0) inventory.value = await eel.mass_update_gems(inventory.value)().then(r => r.success ? r.gems : inventory.value);
                    if (equipped.value.length > 0) equipped.value = await eel.mass_update_gems(equipped.value)().then(r => r.success ? r.gems : equipped.value);
                    
                    if (selectedSource.value) {
                        if (selectedSource.value.pane === "inventory" && inventory.value[selectedSource.value.idx]?.id === selected.value.id) selected.value = inventory.value[selectedSource.value.idx];
                        else if (selectedSource.value.pane === "equipped" && equipped.value[selectedSource.value.idx]?.id === selected.value.id) selected.value = equipped.value[selectedSource.value.idx];
                        else { selected.value = null; selectedSource.value = null; }
                    }
                    window.showToast(t("Gems synced with backend!"));
                } catch(e) {}
                isSyncing.value = false;
            };

            onMounted(async () => {
                try {
                    const res = await eel.get_gem_lookups()();
                    if (res && res.success) lookups.value = res.data;
                } catch(e) {}
                await loadStorage();
            });

            return {
                t, lookups, formattedObj, formatGemName,
                inventory, equipped, equippedRows, elementsList, primordialToggles, statTotalsBuffed, sortedStatTotals, formatStat,
                selected, selectedSource, isSelectedInStorage, selectGem, getStatName, getStatValue, getBarColor, getTierDisplayName, getTypeDisplayName,
                gemTierBgUrl, gemImageUrl,
                creatorParams, isGenerating, generateGem,
                selectedStatIdx, selectedActionKey, augmentOptions, modifierOptions,
                actionButtonText, isLevelingUp, isActioning, levelUpSelected, doSelectedAction,
                onDragStart, onDropEquipped, onDropInventory, onDropTrash, trashSelected, saveSelectedToInventory,
                showContextMenu, tooltip, showTooltip, moveTooltip, hideTooltip,
                isSyncing, syncGems,
                confirmModal, executeConfirm
            };
        }
    });

    if (window._gemSimApp) window._gemSimApp.unmount();
    window._gemSimApp = app;
    
    app.component('custom-vue-select', window.CustomVueSelect);
    app.mount('#gem-simulator-vue-app');
});