document.addEventListener('gem_simulator_loaded', async () => {
    console.log("Gem Simulator 3-Column UI initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

    const ELEMENT_COLORS = { Fire: '#e57373', Water: '#64b5f6', Air: '#fff59d', Cosmic: '#4db6ac' };
    const ELEMENT_DEFAULT_COLOR = '#888888';

    let GEM_LOOKUPS = {};
    let equipped = [];
    let inventory = [];
    let selected = null;
    let selectedSource = null;

    function formatGemName(name) {
        if (!name) return "";
        return name.split('_').join(' ').split(' ').map(
            word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        ).join(' ');
    }

    function getTypeDisplayName(typeIdOrName) {
        const entry = Object.entries(GEM_LOOKUPS.types || {}).find(([key, val]) => val == typeIdOrName || key == typeIdOrName);
        return entry ? t(formatGemName(entry[0])) : typeIdOrName;
    }

    function getElementNameById(id) {
        const found = Object.entries(GEM_LOOKUPS.elements || {}).find(([, val]) => val == id);
        return found ? t(formatGemName(found[0])) : t("Unknown");
    }

    function getTierDisplayName(tierId) {
        const backendName = Object.keys(GEM_LOOKUPS.tiers || {}).find(key => String(GEM_LOOKUPS.tiers[key]) === String(tierId));
        return backendName ? t(formatGemName(backendName)) : tierId;
    }

    function gemTierBgUrl(item) { return `assets/gems/gem_tiers/${item.tier}.png`; }
    function gemImageUrl(item) { return `assets/gems/gem_types/${item.type}/elements/${item.element}.png`; }

    function getEquippedRows() {
        const sortedElements = Object.entries(GEM_LOOKUPS.elements || {}).sort((a, b) => a[1] - b[1]);
        return sortedElements.map(([_, elementId], rowIdx) => ({
            elementId,
            slots: [
                { typeRestriction: 1, slotIdx: rowIdx * 3 + 0 },
                { typeRestriction: 1, slotIdx: rowIdx * 3 + 1 },
                { typeRestriction: 2, slotIdx: rowIdx * 3 + 2 }
            ]
        }));
    }

    function saveInventory() {
        const data = {
            inventory: inventory,
            equipped: equipped,
            toggles: window.primordialDragonToggles || {}
        };
        eel.save_gem_storage(data)();
    }

    async function loadInventory() {
        const data = await eel.load_gem_storage()();
        if (data) {
            if (data.inventory) inventory = data.inventory;
            if (data.equipped) equipped = data.equipped;
            if (data.toggles) window.primordialDragonToggles = data.toggles;
        }
        render();
    }

    function showConfirmModal(title, message, onConfirm) {
        const modal = document.getElementById('custom-confirm-modal');
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-message').textContent = message;
        
        const btnConfirm = document.getElementById('modal-confirm-btn');
        const btnCancel = document.getElementById('modal-cancel-btn');
        
        const newConfirm = btnConfirm.cloneNode(true);
        const newCancel = btnCancel.cloneNode(true);
        btnConfirm.parentNode.replaceChild(newConfirm, btnConfirm);
        btnCancel.parentNode.replaceChild(newCancel, btnCancel);
        
        newCancel.addEventListener('click', () => {
            modal.style.display = 'none';
        });
        
        newConfirm.addEventListener('click', () => {
            modal.style.display = 'none';
            if (onConfirm) onConfirm();
        });
        
        modal.style.display = 'flex';
    }

    async function fetchGemLookups() {
        try {
            const response = await eel.get_gem_lookups()();
            if (response && response.success) {
                GEM_LOOKUPS = response.data;
                populateGemFormMenus();
                setInitialRestrictionState();
            } else {
                window.showToast(t("Failed to fetch gem lookups: {error}").replace("{error}", response ? response.error : t("Unknown Error")), true);
            }
        } catch (e) {
            window.showToast(t("Backend connection error: {error}").replace("{error}", e), true);
        }
    }

    function populateGemFormMenus() {
        function fillSelect(id, dataObj) {
            const select = document.getElementById(id);
            if (!select) return;
            select.innerHTML = `<option value="">(${t("None")})</option>`;
            Object.entries(dataObj || {})
                .sort((a, b) => a[1] - b[1])
                .forEach(([name, val]) => {
                    const opt = document.createElement('option');
                    opt.value = val;
                    opt.textContent = t(formatGemName(name));
                    select.appendChild(opt);
                });
        }
        fillSelect('gem-type', GEM_LOOKUPS.types);
        fillSelect('gem-tier', GEM_LOOKUPS.tiers);
        fillSelect('gem-element', GEM_LOOKUPS.elements);
        fillSelect('gem-restriction', GEM_LOOKUPS.restrictions);
    }

    function setInitialRestrictionState() {
        const typeSelect = document.getElementById('gem-type');
        const restrictionSelect = document.getElementById('gem-restriction');
        if (typeSelect && restrictionSelect) {
            if (typeSelect.value === "1") {
                restrictionSelect.disabled = false;
            } else {
                restrictionSelect.disabled = true;
                restrictionSelect.value = "";
            }
        }
    }

    function render() {
        renderEquipped();
        renderInventory();
        renderSelected();
        renderTrashSlot();
        saveInventory();
    }

    function renderEquipped() {
        if (!window.primordialDragonToggles) window.primordialDragonToggles = {};
        Object.entries(GEM_LOOKUPS.elements || {}).forEach(([elementName, elementId]) => {
            if (typeof window.primordialDragonToggles[elementId] === "undefined") {
                window.primordialDragonToggles[elementId] = true;
            }
        });

        const equippedEl = document.getElementById('equipped');
        if(!equippedEl) return;
        equippedEl.innerHTML = '';
        if (!GEM_LOOKUPS.elements || !GEM_LOOKUPS.types) return;

        const equippedRows = getEquippedRows();
        equippedRows.forEach((row, rowIdx) => {
            const elementName = getElementNameById(row.elementId);
            const color = ELEMENT_COLORS[formatGemName(elementName)] || ELEMENT_DEFAULT_COLOR;
            const rowLabel = document.createElement('div');
            rowLabel.className = 'equipped-row-label';
            rowLabel.textContent = elementName;
            rowLabel.style.color = color;
            equippedEl.appendChild(rowLabel);

            const rowDiv = document.createElement('div');
            rowDiv.className = 'equipped-row';
            rowDiv.style.border = `1px dashed ${color}`;
            
            row.slots.forEach((slot, slotIdx) => {
                const idx = slot.slotIdx;
                if (!equipped[idx]) equipped[idx] = null;
                const item = equipped[idx];
                const slotDiv = document.createElement('div');
                slotDiv.className = 'slot';
                slotDiv.dataset.row = rowIdx;
                slotDiv.dataset.slot = slotIdx;
                slotDiv.dataset.index = idx;
                slotDiv.dataset.pane = 'equipped';
                slotDiv.setAttribute('data-has-item', !!item);
                slotDiv.ondragover = handleDragOver;
                slotDiv.ondrop = (e) => handleEquippedDrop(e, row.elementId, slot.typeRestriction, idx);
                
                if (item) {
                    const itemEl = createItem(item, 'equipped', idx);
                    slotDiv.appendChild(itemEl);
                }

                if (slotIdx === 1) {
                    const separator = document.createElement('div');
                    separator.className = 'slot-vertical-separator';
                    separator.style.borderColor = color;
                    rowDiv.appendChild(slotDiv);
                    rowDiv.appendChild(separator);
                } else {
                    rowDiv.appendChild(slotDiv);
                }
            });
            equippedEl.appendChild(rowDiv);
        });

        const equippedStatsSummary = document.createElement('div');
        equippedStatsSummary.style.marginTop = '20px';

        const togglesRow = document.createElement('div');
        togglesRow.className = 'primordial-toggles-row';
        Object.entries(GEM_LOOKUPS.elements || {}).sort((a, b) => a[1] - b[1]).forEach(([elementName, elementId]) => {
            const color = ELEMENT_COLORS[formatGemName(elementName)] || ELEMENT_DEFAULT_COLOR;
            const toggleDiv = document.createElement('label');
            toggleDiv.className = 'primordial-toggle-label';

            const toggleInput = document.createElement('input');
            toggleInput.type = 'checkbox';
            toggleInput.className = 'primordial-toggle-checkbox';
            toggleInput.checked = !!window.primordialDragonToggles[elementId];
            toggleInput.onchange = () => {
                window.primordialDragonToggles[elementId] = toggleInput.checked;
                renderEquipped();
            };

            const customSlider = document.createElement('span');
            customSlider.className = 'primordial-toggle-slider';
            customSlider.style.background = toggleInput.checked ? color : '#333';

            const labelText = document.createElement('span');
            labelText.textContent = `${t(formatGemName(elementName))}`;
            labelText.style.color = color;

            toggleDiv.appendChild(toggleInput);
            toggleDiv.appendChild(customSlider);
            toggleDiv.appendChild(labelText);
            togglesRow.appendChild(toggleDiv);
        });
        equippedStatsSummary.appendChild(togglesRow);

        const equippedGems = equipped.filter(Boolean);
        const perElementStats = {};
        const perElementPR = {};
        const allStatNames = new Set();

        equippedGems.forEach(gem => {
            const elementId = gem.element;
            if (!perElementStats[elementId]) perElementStats[elementId] = {};
            if (!perElementPR[elementId]) perElementPR[elementId] = 0;
            perElementPR[elementId] += gem.power_rank || 0;
            (gem.stats || []).forEach((stat, i) => {
                const statName = Object.keys(gem.stat_values[i])[0];
                const value = gem.stat_values[i][statName];
                perElementStats[elementId][statName] = (perElementStats[elementId][statName] || 0) + value;
                allStatNames.add(statName);
            });
        });

        const statTotalsBuffed = {};
        let totalPRBuffed = 0;

        Object.entries(GEM_LOOKUPS.elements || {}).forEach(([elementName, elementId]) => {
            const stats = perElementStats[elementId] || {};
            const buffActive = !!window.primordialDragonToggles[elementId];
            const origPR = perElementPR[elementId] || 0;
            totalPRBuffed += buffActive ? origPR * 1.10 : origPR;

            Object.entries(stats).forEach(([statName, val]) => {
                statTotalsBuffed[statName] = (statTotalsBuffed[statName] || 0) + (buffActive ? val * 1.10 : val);
            });
        });

        const totalsCard = document.createElement('div');
        totalsCard.className = 'selected-stats-square';
        totalsCard.style.width = '100%';
        totalsCard.style.maxWidth = '100%';
        totalsCard.style.boxSizing = 'border-box';
        
        let statsHtml = `<div style="text-align:center;font-weight:bold;font-size:1.1em;margin-bottom:10px;color:var(--accent-blue);">${t("Total Power Rank: {pr}").replace("{pr}", Math.round(totalPRBuffed))}</div><hr style="width:100%; border-color:#444c5e; margin-bottom: 10px;">`;
        
        statsHtml += `<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.9em;">`;
        Array.from(allStatNames).sort().forEach(statName => {
            const statVal = statTotalsBuffed[statName] ?? 0;
            if (statVal > 0) {
                statsHtml += `<div><span style="color:var(--text-muted);">${t(statName)}</span><br><b>${Math.round(statVal * 100) / 100}</b></div>`;
            }
        });
        statsHtml += `</div>`;
        
        totalsCard.innerHTML = statsHtml;
        equippedStatsSummary.appendChild(totalsCard);
        equippedEl.appendChild(equippedStatsSummary);
    }

    function renderInventory() {
        const inventoryEl = document.getElementById('inventory');
        if(!inventoryEl) return;
        inventoryEl.innerHTML = '';
        for (let idx = 0; idx < 150; idx++) {
            if (!inventory[idx]) inventory[idx] = null;
            const item = inventory[idx];
            const slot = document.createElement('div');
            slot.className = 'slot';
            slot.dataset.index = idx;
            slot.dataset.pane = 'inventory';
            slot.setAttribute('data-has-item', !!item);
            slot.ondragover = handleDragOver;
            slot.ondrop = handleDrop;
            if (item) {
                const itemEl = createItem(item, 'inventory', idx);
                slot.appendChild(itemEl);
            }
            inventoryEl.appendChild(slot);
        }

        let updateBtn = document.getElementById('update-gems-btn');
        if (updateBtn) updateBtn.remove();

        updateBtn = document.createElement('button');
        updateBtn.id = 'update-gems-btn';
        updateBtn.innerText = t('Sync Inventory Bases');
        updateBtn.className = 'primary-btn';
        updateBtn.style.width = '100%';
        updateBtn.style.marginTop = '20px';
        
        updateBtn.onclick = async function() {
            let prevSelection = null;
            if (selected && selectedSource && selectedSource !== null &&
                ((selectedSource.pane === "inventory" && inventory[selectedSource.idx]?.id === selected.id) ||
                (selectedSource.pane === "equipped" && equipped[selectedSource.idx]?.id === selected.id))) {
                prevSelection = { pane: selectedSource.pane, idx: selectedSource.idx, id: selected.id };
            }

            if (Array.isArray(inventory) && inventory.length > 0) inventory = await eel.mass_update_gems(inventory)().then(r => r.success ? r.gems : inventory);
            if (Array.isArray(equipped) && equipped.length > 0) equipped = await eel.mass_update_gems(equipped)().then(r => r.success ? r.gems : equipped);

            if (prevSelection) {
                if (prevSelection.pane === "inventory" && inventory[prevSelection.idx]?.id === prevSelection.id) {
                    selected = inventory[prevSelection.idx];
                    selectedSource = { pane: "inventory", idx: prevSelection.idx };
                } else if (prevSelection.pane === "equipped" && equipped[prevSelection.idx]?.id === prevSelection.id) {
                    selected = equipped[prevSelection.idx];
                    selectedSource = { pane: "equipped", idx: prevSelection.idx };
                } else {
                    selected = null; selectedSource = null;
                }
            } else {
                selected = null; selectedSource = null;
            }
            render();
            window.showToast(t("Gems synced with backend!"));
        };
        inventoryEl.parentNode.insertBefore(updateBtn, inventoryEl.nextSibling);
    }

    if (!window._selectedGemId) window._selectedGemId = null;
    if (!window._selectedActionKey) window._selectedActionKey = null;

    function renderSelected() {
        const selectedEl = document.getElementById('selected');
        if(!selectedEl) return;
        selectedEl.innerHTML = '';
        
        if (!selected) {
            selectedEl.innerHTML = `<div class="placeholder-text">${t("Select a gem to view details")}</div>`;
            return;
        }

        if (window._selectedGemId !== selected.id) {
            window._selectedActionKey = null;
            window._selectedStatIdx = 0; 
            window._selectedGemId = selected.id;
        }

        const nameDiv = document.createElement('div');
        nameDiv.style.textAlign = 'center';
        nameDiv.style.fontWeight = 'bold';
        nameDiv.style.fontSize = '1.2em';
        nameDiv.style.marginBottom = '15px';
        nameDiv.textContent = selected.gem_name ? t(selected.gem_name) : `(${t("Unnamed Gem")})`;
        selectedEl.appendChild(nameDiv);

        const container = document.createElement('div');
        container.className = 'selected-container';

        const circle = document.createElement('div');
        circle.className = 'big-slot';
        circle.draggable = true;
        circle.ondragstart = function (e) {
            e.dataTransfer.setData('text/plain', JSON.stringify({ fromPane: 'selected', fromIdx: 0 }));
        };
        const holder = document.createElement('div');
        holder.className = 'big-slot-inner-holder';
        const tierBg = document.createElement('img');
        tierBg.className = 'big-slot-tier-bg';
        tierBg.src = gemTierBgUrl(selected);
        holder.appendChild(tierBg);
        const gemImg = document.createElement('img');
        gemImg.className = 'big-slot-gem-img';
        gemImg.src = gemImageUrl(selected);
        holder.appendChild(gemImg);
        const lvDiv = document.createElement('div');
        lvDiv.className = 'big-slot-lv';
        lvDiv.textContent = `Lv.${selected.level}`;
        holder.appendChild(lvDiv);
        const powerDiv = document.createElement('div');
        powerDiv.className = 'big-slot-power';
        powerDiv.textContent = selected.power_rank;
        holder.appendChild(powerDiv);
        circle.appendChild(holder);
        container.appendChild(circle);

        const detailsPanel = document.createElement('div');
        detailsPanel.className = 'selected-stats-square';
        detailsPanel.style.flex = "1";
        detailsPanel.innerHTML = `
            <div style="font-size: 0.9em; line-height: 1.6;">
                <div><span style="color:var(--text-muted)">${t("Power:")}</span> <b>${selected.power_rank}</b></div>
                <div><span style="color:var(--text-muted)">${t("Level:")}</span> <b>${selected.level}</b></div>
                <div><span style="color:var(--text-muted)">${t("Type:")}</span> <b>${getTypeDisplayName(selected.type)}</b></div>
                <div><span style="color:var(--text-muted)">${t("Tier:")}</span> <b>${getTierDisplayName(selected.tier)}</b></div>
                <div><span style="color:var(--text-muted)">${t("Quality:")}</span> <b>${(selected.quality * 100).toFixed(1)}%</b></div>
            </div>
        `;
        container.appendChild(detailsPanel);
        selectedEl.appendChild(container);

        let selectedStatIdx = window._selectedStatIdx || 0;
        
        if (selectedStatIdx >= (selected.stats || []).length) {
            selectedStatIdx = 0;
            window._selectedStatIdx = 0;
        }

        const statCol = document.createElement('div');
        statCol.className = 'stat-list-column';

        (selected.stats || []).forEach((stat, statIdx) => {
            const statBox = document.createElement('div');
            statBox.className = 'stat-vert-square';
            statBox.setAttribute("stat_type", stat.type);
            if (statIdx === selectedStatIdx) statBox.classList.add('stat-vert-square-selected');
            statBox.onclick = () => { window._selectedStatIdx = statIdx; renderSelected(); };

            const statLabelRow = document.createElement('div');
            statLabelRow.style.display = "flex";
            statLabelRow.style.justifyContent = "space-between";
            statLabelRow.style.marginBottom = "8px";

            const statValueData = selected.stat_values[statIdx] || {};
            const statTypeName = Object.keys(statValueData)[0] || `Stat ${statIdx + 1}`;
            const statValue = statValueData[statTypeName];
            
            const statLabel = document.createElement('div');
            statLabel.className = 'stat-label';
            statLabel.style.margin = "0";
            statLabel.innerHTML = `<b>${statValue !== undefined ? statValue.toFixed(2) : '0.00'}</b> <span style="color:var(--text-muted); font-size:0.9em; font-weight:normal;">${t(statTypeName)}</span>`;
            statLabelRow.appendChild(statLabel);

            const augPct = document.createElement('div');
            augPct.className = 'stat-augment-pct';
            augPct.style.position = "relative";
            augPct.style.right = "0";
            augPct.style.top = "0";
            augPct.style.margin = "0";
            augPct.textContent = `${((stat.augmentation_progress || 0) * 100).toFixed(1)}%`;
            statLabelRow.appendChild(augPct);
            statBox.appendChild(statLabelRow);

            const containerRow = document.createElement('div');
            containerRow.className = 'container-chip-row';

            (stat.containers || []).forEach((container) => {
                const chip = document.createElement('div');
                chip.className = 'container-chip-vert';
                const pct = document.createElement('div');
                pct.className = 'container-chip-val';
                pct.textContent = `${(container.real_value * 100).toFixed(0)}%`;
                chip.appendChild(pct);

                const barWrap = document.createElement('div');
                barWrap.className = 'container-chip-bar-wrap';
                const bar = document.createElement('div');
                bar.className = 'container-chip-bar';
                let v = container.value;
                if (v < 0.33) bar.style.background = '#d32f2f';
                else if (v < 0.66) bar.style.background = '#fbc02d';
                else bar.style.background = '#34d058';
                bar.style.width = `${(v * 100).toFixed(1)}%`;
                barWrap.appendChild(bar);
                chip.appendChild(barWrap);
                containerRow.appendChild(chip);
            });
            statBox.appendChild(containerRow);
            statCol.appendChild(statBox);
        });
        selectedEl.appendChild(statCol);

        const buttonRow = document.createElement('div');
        buttonRow.className = "button-row";
        
        const actionGroup = document.createElement('div');
        actionGroup.className = 'action-group';
        actionGroup.style.display = 'flex';
        let selectedActionKey = window._selectedActionKey;

        Object.entries(GEM_LOOKUPS.augment_types || {}).sort((a, b) => a[1] - b[1]).forEach(([name, id]) => {
            const square = document.createElement('div');
            square.className = 'action-square';
            square.dataset.actionKey = `augment-${id}`;
            const img = document.createElement('img');
            img.src = `assets/gems/augments/${id}.png`;
            square.appendChild(img);
            if (selectedActionKey === `augment-${id}`) square.classList.add('selected');
            square.onclick = () => { window._selectedActionKey = square.dataset.actionKey; renderSelected(); };
            actionGroup.appendChild(square);
        });

        const sep = document.createElement('div');
        sep.className = 'action-separator';
        actionGroup.appendChild(sep);

        [ { key: 'spark', url: 'assets/gems/modifiers/spark.png' },
          { key: 'flare', url: 'assets/gems/modifiers/flare.png' }
        ].forEach(mod => {
            const square = document.createElement('div');
            square.className = 'action-square';
            square.dataset.actionKey = mod.key;
            const img = document.createElement('img');
            img.src = mod.url;
            square.appendChild(img);
            if (selectedActionKey === mod.key) square.classList.add('selected');
            square.onclick = () => { window._selectedActionKey = square.dataset.actionKey; renderSelected(); };
            actionGroup.appendChild(square);
        });

        buttonRow.appendChild(actionGroup);
        selectedEl.appendChild(buttonRow);

        const actionsRow = document.createElement('div');
        actionsRow.className = 'gem-actions-row';

        const levelUpBtn = document.createElement('button');
        levelUpBtn.className = 'gem-action-btn';
        if (selected.is_max_level) {
            levelUpBtn.textContent = t('Max Level');
            levelUpBtn.disabled = true;
        } else {
            levelUpBtn.textContent = t('Level Up');
            levelUpBtn.onclick = async () => {
                levelUpBtn.disabled = true;
                levelUpBtn.textContent = '...';
                
                try {
                    const resp = await eel.level_up_gem(selected)();
                    if (resp && resp.success) {
                        selected = resp.gem;
                        if (selectedSource && selectedSource.pane === 'inventory' && selectedSource.idx != null) inventory[selectedSource.idx] = resp.gem;
                        if (selectedSource && selectedSource.pane === 'equipped' && selectedSource.idx != null) equipped[selectedSource.idx] = resp.gem;
                        render();
                    } else {
                        window.showToast(t("Could not level up gem: {error}").replace("{error}", resp ? resp.error : t("Unknown Error")), true);
                        levelUpBtn.disabled = false;
                        levelUpBtn.textContent = t('Level Up');
                    }
                } catch(e) {
                    window.showToast(t("Connection error: {error}").replace("{error}", e), true);
                    levelUpBtn.disabled = false;
                    levelUpBtn.textContent = t('Level Up');
                }
            };
        }
        actionsRow.appendChild(levelUpBtn);

        const actionBtn = document.createElement('button');
        actionBtn.className = 'gem-action-btn';
        actionBtn.disabled = !window._selectedActionKey;
        if (!window._selectedActionKey) actionBtn.textContent = t('Action');
        else if (window._selectedActionKey === 'spark') actionBtn.textContent = t('Change Stat');
        else if (window._selectedActionKey === 'flare') actionBtn.textContent = t('Move Boost');
        else actionBtn.textContent = t('Augment Stat');

        actionBtn.onclick = async () => {
            if (!window._selectedActionKey) return;
            const statCol = document.querySelector('.stat-list-column');
            const statBoxes = statCol.querySelectorAll('.stat-vert-square');
            const statTypeId = parseInt(statBoxes[window._selectedStatIdx].getAttribute('stat_type'));

            actionBtn.disabled = true;
            actionBtn.textContent = '...';

            try {
                let resp;
                if (window._selectedActionKey.startsWith('augment-')) {
                    const augmentId = parseInt(window._selectedActionKey.split('-')[1]);
                    resp = await eel.augment_gem(selected, statTypeId, augmentId)();
                } else if (window._selectedActionKey === 'spark') {
                    resp = await eel.spark_gem(selected, statTypeId)();
                } else if (window._selectedActionKey === 'flare') {
                    resp = await eel.flare_gem(selected, statTypeId)();
                }

                if(resp && resp.success) {
                    selected = resp.gem;
                    if (selectedSource && selectedSource.pane === 'inventory' && selectedSource.idx != null) inventory[selectedSource.idx] = resp.gem;
                    if (selectedSource && selectedSource.pane === 'equipped' && selectedSource.idx != null) equipped[selectedSource.idx] = resp.gem;
                    render();
                } else {
                    window.showToast(t("Action failed: {error}").replace("{error}", resp ? resp.error : t("Unknown Error")), true);
                    actionBtn.disabled = false;
                    if (!window._selectedActionKey) actionBtn.textContent = t('Action');
                    else if (window._selectedActionKey === 'spark') actionBtn.textContent = t('Change Stat');
                    else if (window._selectedActionKey === 'flare') actionBtn.textContent = t('Move Boost');
                    else actionBtn.textContent = t('Augment Stat');
                }
            } catch(e) {
                window.showToast(t("Connection error: {error}").replace("{error}", e), true);
                actionBtn.disabled = false;
            }
        };

        actionsRow.appendChild(actionBtn);
        selectedEl.appendChild(actionsRow);

        const inInventory = selected.id !== undefined && inventory.some(item => item && item.id === selected.id);
        const inEquipped = selected.id !== undefined && equipped.some(item => item && item.id === selected.id);
        if (selected.id !== undefined && !inInventory && !inEquipped) {
            const saveBtn = document.createElement('button');
            saveBtn.className = 'save-gem-btn';
            saveBtn.textContent = t('Add to Inventory');
            saveBtn.onclick = () => {
                const emptyIdx = inventory.findIndex(i => !i);
                if (emptyIdx === -1) return window.showToast(t('Inventory is full.'), true);
                inventory[emptyIdx] = JSON.parse(JSON.stringify(selected));
                render();
            };
            selectedEl.appendChild(saveBtn);
        }
    }

    function renderTrashSlot() {
        const trashContainer = document.getElementById('trash-slot-container');
        if(!trashContainer) return;
        trashContainer.innerHTML = '';
        
        const trashSlot = document.createElement('div');
        trashSlot.className = 'trash-slot';
        trashSlot.title = t("Click to delete selected gem, or drag a gem here");
        
        trashSlot.onclick = function() {
            if (!selected) {
                window.showToast(t("No gem selected to trash."), true);
                return;
            }
            showConfirmModal(t("Trash Gem"), t("Are you sure you want to permanently delete the selected gem?"), () => {
                if (selectedSource) {
                    if (selectedSource.pane === 'equipped') equipped[selectedSource.idx] = null;
                    else if (selectedSource.pane === 'inventory') inventory[selectedSource.idx] = null;
                }
                selected = null;
                selectedSource = null;
                render();
                window.showToast(t("Gem deleted."));
            });
        };

        trashSlot.ondragover = (e) => { e.preventDefault(); };
        trashSlot.ondrop = function (e) {
            e.preventDefault();
            const data = e.dataTransfer.getData('text/plain');
            if(!data) return;
            let { fromPane, fromIdx } = JSON.parse(data);
            
            if (fromPane === 'selected' && selectedSource !== null) {
                fromPane = selectedSource.pane;
                fromIdx = selectedSource.idx;
            }

            let item = null;
            if (fromPane === 'equipped') item = equipped[fromIdx];
            else if (fromPane === 'inventory') item = inventory[fromIdx];
            else if (fromPane === 'selected') item = selected;

            if (!item) return;
            
            showConfirmModal(t("Trash Gem"), t("Are you sure you want to permanently delete this gem?"), () => {
                if (fromPane === 'equipped') equipped[fromIdx] = null;
                else if (fromPane === 'inventory') inventory[fromIdx] = null;
                
                if (selected && selected.id === item.id) {
                    selected = null;
                    selectedSource = null;
                }
                render();
                window.showToast(t("Gem deleted."));
            });
        };
        
        const trashIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        trashIcon.setAttribute("viewBox", "0 0 24 24");
        trashIcon.setAttribute("class", "trash-icon");
        trashIcon.innerHTML = `<path fill="currentColor" d="M9,3V4H4V6H5V19A2,2 0 0,0 7,21H17A2,2 0 0,0 19,19V6H20V4H15V3H9M7,6H17V19H7V6Z"/>`;
        trashSlot.appendChild(trashIcon);
        
        const label = document.createElement('div');
        label.className = 'trash-label';
        label.textContent = t("Trash");
        
        trashContainer.appendChild(trashSlot);
        trashContainer.appendChild(label);
    }

    function createItem(item, fromPane, fromIdx) {
        const itemEl = document.createElement('div');
        itemEl.className = 'item';
        itemEl.draggable = true;
        itemEl.addEventListener('mousedown', function (e) {
            if (e.button === 1) {
                e.preventDefault();
                showConfirmModal(t("Trash Gem"), t("Are you sure you want to permanently delete this gem?"), () => {
                    if (fromPane === 'inventory') inventory[fromIdx] = null;
                    else if (fromPane === 'equipped') equipped[fromIdx] = null;
                    if (selected && selected.id === item.id) {
                        selected = null;
                        selectedSource = null;
                    }
                    render();
                });
                return false;
            }
        });

        const imgHolder = document.createElement('div');
        imgHolder.className = 'item-img-holder';
        const tierBg = document.createElement('img');
        tierBg.className = 'item-tier-bg';
        tierBg.src = gemTierBgUrl(item);
        imgHolder.appendChild(tierBg);
        const gemImg = document.createElement('img');
        gemImg.className = 'item-gem-img';
        gemImg.src = gemImageUrl(item);
        imgHolder.appendChild(gemImg);
        const lvDiv = document.createElement('div');
        lvDiv.className = 'item-lv';
        lvDiv.textContent = `Lv.${item.level}`;
        imgHolder.appendChild(lvDiv);
        const powerDiv = document.createElement('div');
        powerDiv.className = 'item-power';
        powerDiv.textContent = item.power_rank;
        imgHolder.appendChild(powerDiv);
        itemEl.appendChild(imgHolder);
        itemEl.dataset.fromPane = fromPane;
        itemEl.dataset.fromIdx = fromIdx;
        itemEl.ondragstart = handleDragStart;
        itemEl.onclick = () => {
            selected = item;
            selectedSource = { pane: fromPane, idx: fromIdx };
            render();
        };
        return itemEl;
    }

    function handleDragStart(e) {
        let target = e.target;
        while (target && !target.classList.contains('item')) target = target.parentElement;
        if (!target) return;
        e.dataTransfer.setData('text/plain', JSON.stringify({
            fromPane: target.dataset.fromPane,
            fromIdx: target.dataset.fromIdx
        }));
    }

    function handleDragOver(e) { e.preventDefault(); }
    
    function handleDrop(e) {
        e.preventDefault();
        const data = e.dataTransfer.getData('text/plain');
        if(!data) return;
        let { fromPane, fromIdx } = JSON.parse(data);
        const toPane = this.dataset.pane;
        const toIdx = parseInt(this.dataset.index);

        if (fromPane === 'selected' && selectedSource !== null) {
            fromPane = selectedSource.pane;
            fromIdx = selectedSource.idx;
        }

        if (fromPane === toPane && fromIdx === toIdx) return;
        
        let draggedGem = null;
        if (fromPane === 'selected') draggedGem = selected;
        else if (fromPane === 'inventory') draggedGem = inventory[fromIdx];
        else if (fromPane === 'equipped') draggedGem = equipped[fromIdx];

        if (!draggedGem) return;

        if (toPane === 'inventory') {
            const oldTargetGem = inventory[toIdx];
            if (fromPane === 'selected') {
                inventory[toIdx] = draggedGem;
                selectedSource = { pane: 'inventory', idx: toIdx };
                if (oldTargetGem) {
                    const free = inventory.findIndex((i, index) => !i && index !== toIdx);
                    if (free !== -1) inventory[free] = oldTargetGem;
                }
            } else if (fromPane === 'inventory') {
                inventory[fromIdx] = oldTargetGem;
                inventory[toIdx] = draggedGem;
                if (selected && selected.id === draggedGem.id) selectedSource = { pane: 'inventory', idx: toIdx };
                if (selected && oldTargetGem && selected.id === oldTargetGem.id) selectedSource = { pane: 'inventory', idx: fromIdx };
            } else if (fromPane === 'equipped') {
                if (oldTargetGem) {
                    const equippedRows = getEquippedRows();
                    let restrictType, restrictElement;
                    for (const row of equippedRows) {
                        for (const slot of row.slots) {
                            if (slot.slotIdx == fromIdx) { restrictType = slot.typeRestriction; restrictElement = row.elementId; break; }
                        }
                    }
                    if (String(oldTargetGem.element) !== String(restrictElement) || String(oldTargetGem.type) !== String(restrictType)) {
                        window.showToast(t("Cannot swap: inventory gem is incompatible with the equipped slot."), true);
                        return;
                    }
                    if (oldTargetGem.ability) {
                        const isDup = equipped.some((g, i) => g && i !== fromIdx && String(g.ability) === String(oldTargetGem.ability));
                        if (isDup) {
                            window.showToast(t("Cannot swap: an Empowered Gem with this ability is already equipped."), true);
                            return;
                        }
                    }
                }
                equipped[fromIdx] = oldTargetGem;
                inventory[toIdx] = draggedGem;
                if (selected && selected.id === draggedGem.id) selectedSource = { pane: 'inventory', idx: toIdx };
                if (selected && oldTargetGem && selected.id === oldTargetGem.id) selectedSource = { pane: 'equipped', idx: fromIdx };
            }
            render();
            return;
        }
    }

    function handleEquippedDrop(e, elementId, typeRestriction, equippedIdx) {
        e.preventDefault();
        const data = e.dataTransfer.getData('text/plain');
        if(!data) return;
        let { fromPane, fromIdx } = JSON.parse(data);
        
        if (fromPane === 'selected' && selectedSource !== null) {
            fromPane = selectedSource.pane;
            fromIdx = selectedSource.idx;
        }
        
        let draggedGem = null;
        if (fromPane === 'selected') draggedGem = selected;
        else if (fromPane === 'inventory') draggedGem = inventory[fromIdx];
        else if (fromPane === 'equipped') draggedGem = equipped[fromIdx];
        
        if (!draggedGem) return;
        
        if (String(draggedGem.element) !== String(elementId) || String(draggedGem.type) !== String(typeRestriction)) {
            const errorMsg = String(draggedGem.element) !== String(elementId)
                ? t("Requires {element}.").replace("{element}", getElementNameById(elementId))
                : t("Requires {type} gem.").replace("{type}", getTypeDisplayName(typeRestriction));
            window.showToast(errorMsg, true);
            return;
        }

        const sourceIdx = fromPane === 'equipped' ? fromIdx : -1;
        if (draggedGem.ability) {
            const isDup = equipped.some((g, i) => g && i !== equippedIdx && i !== sourceIdx && String(g.ability) === String(draggedGem.ability));
            if (isDup) {
                window.showToast(t("Cannot equip multiple Empowered Gems with the same ability."), true);
                return;
            }
        }
        
        const oldTargetGem = equipped[equippedIdx];
        
        if (fromPane === 'selected') {
            if (oldTargetGem) {
                const free = inventory.findIndex(i => !i);
                if (free !== -1) inventory[free] = oldTargetGem;
                else { window.showToast(t("Inventory full, cannot displace equipped gem."), true); return; }
            }
            equipped[equippedIdx] = draggedGem;
            selectedSource = { pane: 'equipped', idx: equippedIdx };
        } else if (fromPane === 'inventory') {
            inventory[fromIdx] = oldTargetGem;
            equipped[equippedIdx] = draggedGem;
            if (selected && selected.id === draggedGem.id) selectedSource = { pane: 'equipped', idx: equippedIdx };
            if (selected && oldTargetGem && selected.id === oldTargetGem.id) selectedSource = { pane: 'inventory', idx: fromIdx };
        } else if (fromPane === 'equipped') {
            equipped[fromIdx] = oldTargetGem;
            equipped[equippedIdx] = draggedGem;
            if (selected && selected.id === draggedGem.id) selectedSource = { pane: 'equipped', idx: equippedIdx };
            if (selected && oldTargetGem && selected.id === oldTargetGem.id) selectedSource = { pane: 'equipped', idx: fromIdx };
        }
        render();
    }

    document.addEventListener('change', function (e) {
        if (e.target && e.target.id === 'gem-type') {
            const restrictionSelect = document.getElementById('gem-restriction');
            if (e.target.value === "1") {
                restrictionSelect.disabled = false;
            } else {
                restrictionSelect.disabled = true;
                restrictionSelect.value = "";
            }
        }
    });

    const levelSlider = document.getElementById('gem-level-slider');
    const augmentSlider = document.getElementById('gem-augment-slider');
    const levelValue = document.getElementById('gem-level-value');
    const augmentValue = document.getElementById('gem-augment-value');
    const augmentNull = document.getElementById('gem-augment-null');

    if (levelSlider && levelValue) levelSlider.addEventListener('input', () => { levelValue.textContent = levelSlider.value; });
    if (augmentSlider && augmentValue && augmentNull) {
        if (augmentNull.checked) {
            augmentSlider.disabled = true;
            augmentValue.textContent = '—';
            augmentValue.style.color = "var(--text-muted)";
        }
        augmentNull.addEventListener('change', function () {
            if (this.checked) {
                augmentSlider.disabled = true;
                augmentValue.textContent = '—';
                augmentValue.style.color = "var(--text-muted)";
            } else {
                augmentSlider.disabled = false;
                augmentValue.textContent = augmentSlider.value;
                augmentValue.style.color = "var(--text-main)";
            }
        });
        augmentSlider.addEventListener('input', function () {
            if (!augmentNull.checked) augmentValue.textContent = augmentSlider.value;
        });
    }

    const btnGenerate = document.getElementById('btn-generate-gem');
    if(btnGenerate) {
        btnGenerate.addEventListener('click', async function (e) {
            e.preventDefault();
            btnGenerate.disabled = true;
            btnGenerate.textContent = '...';

            try {
                const typeVal = document.getElementById('gem-type').value;
                const tierVal = document.getElementById('gem-tier').value;
                const elementVal = document.getElementById('gem-element').value;
                const restrictionVal = document.getElementById('gem-restriction').value;
                const levelVal = document.getElementById('gem-level-slider').value;

                let body = {};
                if (typeVal) body.type = parseInt(typeVal, 10);
                if (tierVal) body.tier = parseInt(tierVal, 10);
                if (elementVal) body.element = parseInt(elementVal, 10);
                const restrictionSelect = document.getElementById('gem-restriction');
                if (!restrictionSelect.disabled && restrictionVal) body.restriction = parseInt(restrictionVal, 10);
                
                const augmentVal = document.getElementById('gem-augment-slider').value;
                if (levelVal) body.level = parseInt(levelVal, 10);
                if (augmentNull && augmentNull.checked) body.augmentation = null;
                else if (augmentVal) body.augmentation = parseInt(augmentVal, 10) / 100;

                const resp = await eel.create_gem(body)();
                if (resp && resp.success) {
                    selected = resp.gem;
                    selectedSource = null;
                    render();
                } else {
                    window.showToast(t("Could not generate gem: {error}").replace("{error}", resp ? resp.error : t("Unknown Error")), true);
                }
            } catch(err) {
                window.showToast(t("Connection error: {error}").replace("{error}", err), true);
            }
            
            btnGenerate.disabled = false;
            btnGenerate.textContent = t('Generate Random Gem');
        });
    }

    await fetchGemLookups();
    await loadInventory();

});