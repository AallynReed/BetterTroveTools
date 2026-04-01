document.addEventListener('star_chart_loaded', async () => {
    console.log("Star Chart initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    
    const wrapper = document.getElementById('chart-wrapper');
    const tooltip = document.getElementById('star-tooltip');
    const summaryPanel = document.getElementById('summary-content');
    
    const codeInput = document.getElementById('build-code-input');
    const btnCopyCode = document.getElementById('btn-copy-code');
    const btnLoadCode = document.getElementById('btn-load-code');

    const templateControlsWrapper = document.createElement('div');
    templateControlsWrapper.style.display = 'flex';
    templateControlsWrapper.style.gap = '5px';
    templateControlsWrapper.style.marginTop = '10px';
    templateControlsWrapper.style.marginBottom = '15px';
    templateControlsWrapper.style.paddingBottom = '15px';
    templateControlsWrapper.style.borderBottom = '1px dashed var(--border-color)';

    const templateSelect = document.createElement('select');
    templateSelect.className = 'btt-select';
    templateSelect.style.padding = '8px';
    templateSelect.style.background = 'var(--bg-dark, #111)';
    templateSelect.style.color = '#fff';
    templateSelect.style.border = '1px solid var(--border-color, #333)';
    templateSelect.style.borderRadius = '4px';
    templateSelect.style.width = '150px';

    const btnSaveTemplate = document.createElement('button');
    btnSaveTemplate.className = 'primary-btn';
    btnSaveTemplate.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> ${t("Save")}`;

    const btnDeleteTemplate = document.createElement('button');
    btnDeleteTemplate.className = 'danger-btn';
    btnDeleteTemplate.innerHTML = '<i class="fa-solid fa-trash"></i>';
    btnDeleteTemplate.style.display = 'none';
    
    templateControlsWrapper.appendChild(templateSelect);
    templateControlsWrapper.appendChild(btnSaveTemplate);
    templateControlsWrapper.appendChild(btnDeleteTemplate);
    
    const shareControls = document.querySelector('.build-share-controls');
    if (shareControls) {
        shareControls.insertAdjacentElement('afterend', templateControlsWrapper);
    }

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    
    const COLORS = {
        Combat: { minor: "#FF8F00", major: "#D84315" },
        Gathering: { minor: "#00695C", major: "#558B2F" },
        Pve: { minor: "#6A1B9A", major: "#283593" }
    };

    let nodeMap = {};
    let selectedPaths = new Set();
    let currentAggregatedData = null;

    const response = await eel.get_calculated_star_chart()();
    
    if (!response.success) {
        wrapper.innerHTML = `<div style="color: #ff4444; text-align: center;">${t("Error loading chart data: {error}").replace("{error}", response.error)}</div>`;
        return;
    }

    const data = response.data;
    const origin = response.origin;

    wrapper.classList.remove('placeholder-box');
    wrapper.innerHTML = "";
    svg.setAttribute("id", "chart-svg");
    svg.setAttribute("viewBox", "0 0 1000 1000");
    wrapper.appendChild(svg);

    function registerNode(star, constellName, parentPath) {
        star.parentPath = parentPath;
        star.constellName = constellName;
        nodeMap[star.Path] = star;
        if (star.Stars) {
            star.Stars.forEach(child => registerNode(child, constellName, star.Path));
        }
    }

    function drawLine(p1, p2, pathId) {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", p1[0]);
        line.setAttribute("y1", p1[1]);
        line.setAttribute("x2", p2[0]);
        line.setAttribute("y2", p2[1]);
        line.setAttribute("stroke", "#333");
        line.setAttribute("stroke-width", "3");
        line.setAttribute("id", "line-" + pathId.replace(/\./g, "-"));
        svg.appendChild(line);
    }

    function drawStarNode(star, constellName) {
        if (star.Stars && star.Stars.length > 0) {
            star.Stars.forEach(child => {
                if (star.Coords && child.Coords) drawLine(star.Coords, child.Coords, child.Path);
                drawStarNode(child, constellName);
            });
        }

        if (!star.Coords) return;

        let shape;
        const isRoot = star.Type === "Root";

        if (isRoot) {
            shape = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
            const size = 16;
            const [cx, cy] = star.Coords;
            shape.setAttribute("points", `${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`);
            shape.setAttribute("fill", "var(--bg-dark, #111)");
            shape.setAttribute("stroke", COLORS[constellName].major);
            shape.setAttribute("stroke-width", "4");
            shape.classList.add("star-node", "root-node");
        } else {
            const isMajor = star.Type === "Major";
            shape = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            shape.setAttribute("cx", star.Coords[0]);
            shape.setAttribute("cy", star.Coords[1]);
            shape.setAttribute("r", isMajor ? 14 : 9);
            shape.setAttribute("fill", COLORS[constellName] ? COLORS[constellName][isMajor ? "major" : "minor"] : "#fff");
            shape.setAttribute("stroke", "#111");
            shape.setAttribute("stroke-width", "2");
            shape.classList.add("star-node");
        }

        shape.setAttribute("id", "node-" + star.Path.replace(/\./g, "-"));

        let clickTimer = null;

        shape.addEventListener("click", (e) => {
            if (isRoot) {
                if (e.detail === 1) {
                    clickTimer = setTimeout(() => {
                        deselectNodeAndChildren(star.Path);
                        updateChartVisuals();
                        calculateStats();
                    }, 250);
                } else if (e.detail === 2) {
                    clearTimeout(clickTimer);
                    selectAllDescendants(star.Path);
                    updateChartVisuals();
                    calculateStats();
                }
                return;
            }
            
            if (selectedPaths.has(star.Path)) {
                deselectNodeAndChildren(star.Path);
            } else {
                const nodesToAdd = getAncestorsToSelect(star.Path, []);
                if (selectedPaths.size + nodesToAdd.length > 40) {
                    window.showToast(t("Cannot exceed maximum of 40 active nodes."), true);
                    return;
                }
                nodesToAdd.forEach(p => selectedPaths.add(p));
            }
            
            updateChartVisuals();
            calculateStats();
        });

        shape.addEventListener("mouseenter", () => {
            let html = `<h3>${t(star.Name || star.Constellation)}</h3>`;
            html += `<span class="type">${t("{type} Node").replace("{type}", t(star.Type))}</span>`;
            if (star.Description) html += `<p>${t(star.Description)}</p><hr/>`;
            if (star.Stats && star.Stats.length > 0) {
                html += `<ul>`;
                star.Stats.forEach(s => html += `<li><strong>${t(s.name)}:</strong> +${s.value}${s.percentage ? "%" : ""}</li>`);
                html += `</ul>`;
            }
            if (star.Abilities && star.Abilities.length > 0) {
                if(star.Stats && star.Stats.length > 0) html += `<hr/>`;
                html += `<ul>`;
                star.Abilities.forEach(a => html += `<li>${t(a)}</li>`);
                html += `</ul>`;
            }
            tooltip.innerHTML = html;
            tooltip.style.display = "block";
        });
        
        shape.addEventListener("mousemove", (e) => {
            tooltip.style.left = (e.clientX + 15) + "px";
            tooltip.style.top = (e.clientY + 15) + "px";
        });
        
        shape.addEventListener("mouseleave", () => tooltip.style.display = "none");

        svg.appendChild(shape);
    }

    function getAncestorsToSelect(path, newNodes = []) {
        if (!path || selectedPaths.has(path)) return newNodes;
        newNodes.push(path);
        const node = nodeMap[path];
        if (node && node.parentPath && nodeMap[node.parentPath].Type !== "Root") {
            return getAncestorsToSelect(node.parentPath, newNodes);
        }
        return newNodes;
    }

    function deselectNodeAndChildren(path) {
        if (!path) return;
        selectedPaths.delete(path);
        Object.values(nodeMap).forEach(child => {
            if (child.parentPath === path) deselectNodeAndChildren(child.Path);
        });
    }

    function selectAllDescendants(rootPath) {
        const rootNode = nodeMap[rootPath];
        if (!rootNode) return;

        let limitHit = false;

        Object.values(nodeMap).forEach(node => {
            if (node.constellName === rootNode.constellName && node.Type !== "Root") {
                if (!selectedPaths.has(node.Path)) {
                    if (selectedPaths.size >= 40) {
                        limitHit = true;
                        return;
                    }
                    selectedPaths.add(node.Path);
                }
            }
        });

        if (limitHit) {
            window.showToast(t("Cannot exceed maximum of 40 active nodes."), true);
        }
    }

    function updateChartVisuals() {
        let overwrites = new Set();
        selectedPaths.forEach(p => {
            let node = nodeMap[p];
            if (node.Overwrites) node.Overwrites.forEach(ow => overwrites.add(ow));
        });

        document.querySelectorAll('.star-node, line').forEach(el => {
            el.classList.remove('node-selected', 'node-overwritten', 'root-active', 'line-selected');
        });

        let activeConstellations = new Set();

        selectedPaths.forEach(path => {
            const nodeId = "node-" + path.replace(/\./g, "-");
            const nodeEl = document.getElementById(nodeId);
            const lineId = "line-" + path.replace(/\./g, "-");
            const lineEl = document.getElementById(lineId);

            if (nodeEl) {
                nodeEl.classList.add('node-selected');
                if (overwrites.has(path)) nodeEl.classList.add('node-overwritten');
            }
            if (lineEl) lineEl.classList.add('line-selected');

            if (nodeMap[path]) activeConstellations.add(nodeMap[path].constellName);
        });

        const hasAnySelection = activeConstellations.size > 0;
        if (hasAnySelection) {
            document.getElementById('center-anchor').classList.add('root-active');
        }
        activeConstellations.forEach(constell => {
            const rootPath = data[constell].Path;
            const rootNodeEl = document.getElementById("node-" + rootPath.replace(/\./g, "-"));
            if (rootNodeEl) rootNodeEl.classList.add('root-active');
        });
    }

    function calculateStats() {
        let overwrites = new Set();
        selectedPaths.forEach(path => {
            if (nodeMap[path] && nodeMap[path].Overwrites) {
                nodeMap[path].Overwrites.forEach(ow => overwrites.add(ow));
            }
        });

        let activePaths = Array.from(selectedPaths).filter(p => !overwrites.has(p));

        let finalStats = {};
        let finalAbilities = [];
        let finalObtainables = [];

        activePaths.forEach(path => {
            let node = nodeMap[path];
            if (node.Stats) {
                node.Stats.forEach(stat => {
                    let key = stat.name + (stat.percentage ? "_pct" : "_flat");
                    if (!finalStats[key]) {
                        finalStats[key] = { name: stat.name, percentage: stat.percentage, value: 0 };
                    }
                    finalStats[key].value += stat.value;
                });
            }
            if (node.Abilities) finalAbilities.push(...node.Abilities);
            if (node.Obtainables) finalObtainables.push(...node.Obtainables);
        });

        currentAggregatedData = {
            paths: Array.from(selectedPaths),
            stats: Object.values(finalStats),
            abilities: finalAbilities,
            obtainables: finalObtainables
        };

        if (document.activeElement !== codeInput) {
            if (currentAggregatedData.paths.length > 0) {
                codeInput.value = btoa(currentAggregatedData.paths.join('$'));
            } else {
                codeInput.value = "";
            }
        }

        renderSummary(currentAggregatedData);
    }

    function renderSummary(aggData) {
        if (aggData.paths.length === 0) {
            summaryPanel.innerHTML = `<p class="file-meta">${t("Select nodes to calculate stats.")}</p>`;
            return;
        }

        let html = `<div style="margin-bottom: 15px; color: var(--text-muted); font-size: 12px;">${t("Nodes Active: {count} / 40").replace("{count}", aggData.paths.length)}</div>`;
        
        if (aggData.stats.length > 0) {
            html += `<div class="summary-section"><h4>${t("Aggregated Stats")}</h4><ul>`;
            aggData.stats.forEach(s => {
                html += `<li><strong>${t(s.name)}:</strong> +${s.value}${s.percentage ? "%" : ""}</li>`;
            });
            html += `</ul></div>`;
        }

        if (aggData.abilities.length > 0) {
            html += `<div class="summary-section"><h4>${t("Active Abilities")}</h4><ul>`;
            aggData.abilities.forEach(a => html += `<li>${t(a)}</li>`);
            html += `</ul></div>`;
        }

        if (aggData.obtainables.length > 0) {
            html += `<div class="summary-section"><h4>${t("Obtainables")}</h4><ul>`;
            aggData.obtainables.forEach(o => html += `<li>${t(o)}</li>`);
            html += `</ul></div>`;
        }

        summaryPanel.innerHTML = html;
    }

    btnCopyCode.addEventListener('click', () => {
        const code = codeInput.value;
        if (!code) {
            window.showToast(t("No nodes selected to copy."), true);
            return;
        }
        navigator.clipboard.writeText(code).then(() => {
            window.showToast(t("Build code copied to clipboard!"));
        }).catch(err => {
            window.showToast(t("Failed to copy: {error}").replace("{error}", err), true);
        });
    });

    btnLoadCode.addEventListener('click', () => {
        const code = codeInput.value.trim();
        if (!code) return;
        
        try {
            const paths = atob(code).split('$');
            selectedPaths.clear();
            let loaded = 0;
            let skipped = 0;

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

            updateChartVisuals();
            calculateStats();
            
            if (skipped > 0) {
                window.showToast(t("Loaded {loaded} nodes. Skipped {skipped} (Max 40 limit).").replace("{loaded}", loaded).replace("{skipped}", skipped), true);
            } else if (loaded > 0) {
                window.showToast(t("Successfully loaded {loaded} nodes!").replace("{loaded}", loaded));
            } else {
                window.showToast(t("No valid nodes found in build code."), true);
            }
        } catch (e) {
            window.showToast(t("Invalid build code format."), true);
        }
    });

    codeInput.addEventListener('focus', () => codeInput.dataset.focused = "true");
    codeInput.addEventListener('blur', () => {
        codeInput.dataset.focused = "false";
        if (currentAggregatedData && currentAggregatedData.paths.length > 0) {
            codeInput.value = btoa(currentAggregatedData.paths.join('$'));
        } else {
            codeInput.value = "";
        }
    });

    let templates = {};

    async function loadTemplates() {
        templates = await eel.get_star_chart_templates()();
        
        templateSelect.innerHTML = `<option value="">-- ${t("Templates")} --</option>`;
        for (let name in templates) {
            let opt = document.createElement('option');
            opt.value = name;
            opt.innerText = name;
            templateSelect.appendChild(opt);
        }
        
        btnDeleteTemplate.style.display = templateSelect.value ? 'inline-block' : 'none';
    }

    templateSelect.addEventListener('change', () => {
        btnDeleteTemplate.style.display = templateSelect.value ? 'inline-block' : 'none';
        if (templateSelect.value && templates[templateSelect.value]) {
            codeInput.value = templates[templateSelect.value];
            btnLoadCode.click();
        }
    });

    const oldModal = document.getElementById('st-modal-overlay');
    if (oldModal) oldModal.remove();

    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'st-modal-overlay';
    modalOverlay.style.cssText = "display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:9999; justify-content:center; align-items:center;";
    modalOverlay.innerHTML = `
        <div style="background:var(--bg-panel, #1e1e2e); padding:20px; border-radius:8px; width:350px; text-align:center; border: 1px solid var(--border-color, #333); box-shadow: 0 4px 15px rgba(0,0,0,0.5);">
            <h3 id="st-modal-title" style="margin-top:0; color:var(--text-main, #fff);"></h3>
            <p id="st-modal-msg" style="color:var(--text-muted, #aaa); margin-bottom:15px; font-size:14px;"></p>
            <input type="text" id="st-modal-input" style="width:calc(100% - 22px); margin-bottom:15px; display:none; padding:10px; background:var(--bg-dark, #111); border:1px solid var(--border-color, #333); color:#fff; border-radius:4px;" placeholder="${t("Template Name")}" />
            <div style="display:flex; gap:10px; justify-content:center;">
                <button id="st-modal-confirm" class="primary-btn" style="flex:1;">${t("Confirm")}</button>
                <button id="st-modal-cancel" class="secondary-btn" style="flex:1;">${t("Cancel")}</button>
            </div>
        </div>
    `;
    document.body.appendChild(modalOverlay);

    const stModalTitle = document.getElementById('st-modal-title');
    const stModalMsg = document.getElementById('st-modal-msg');
    const stModalInput = document.getElementById('st-modal-input');
    const stModalConfirm = document.getElementById('st-modal-confirm');
    const stModalCancel = document.getElementById('st-modal-cancel');

    let currentModalAction = null;

    function openModal(action, title, msg, showInput = false) {
        currentModalAction = action;
        stModalTitle.innerText = title;
        stModalMsg.innerText = msg;
        stModalInput.style.display = showInput ? 'block' : 'none';
        stModalInput.value = '';
        modalOverlay.style.display = 'flex';
        if (showInput) stModalInput.focus();
    }

    stModalCancel.addEventListener('click', () => {
        modalOverlay.style.display = 'none';
    });

    stModalConfirm.addEventListener('click', async () => {
        if (currentModalAction === 'save') {
            const name = stModalInput.value.trim();
            if (!name) {
                if (window.showToast) window.showToast(t("Please enter a name."), true);
                return;
            }
            const code = codeInput.value.trim();
            if (!code) {
                if (window.showToast) window.showToast(t("No active build to save."), true);
                modalOverlay.style.display = 'none';
                return;
            }
            const res = await eel.save_star_chart_template(name, code)();
            if (res.success) {
                if (window.showToast) window.showToast(t("Template '{name}' saved!").replace("{name}", name));
                await loadTemplates();
                templateSelect.value = name;
                btnDeleteTemplate.style.display = 'inline-block';
            } else {
                if (window.showToast) window.showToast(t("Error saving template."), true);
            }
        } else if (currentModalAction === 'delete') {
            const name = templateSelect.value;
            if (!name) return;
            const res = await eel.delete_star_chart_template(name)();
            if (res.success) {
                if (window.showToast) window.showToast(t("Template '{name}' deleted!").replace("{name}", name));
                await loadTemplates();
            } else {
                if (window.showToast) window.showToast(t("Error deleting template."), true);
            }
        }
        modalOverlay.style.display = 'none';
    });

    btnSaveTemplate.addEventListener('click', () => {
        const code = codeInput.value.trim();
        if (!code) {
            if (window.showToast) window.showToast(t("No active build to save."), true);
            return;
        }
        openModal('save', t('Save Template'), t('Enter a name for your build:'), true);
    });

    btnDeleteTemplate.addEventListener('click', () => {
        const name = templateSelect.value;
        if (!name) return;
        openModal('delete', t('Delete Template'), t("Are you sure you want to delete '{name}'?").replace("{name}", name), false);
    });

    loadTemplates();


    const centerNode = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    centerNode.setAttribute("cx", origin[0]);
    centerNode.setAttribute("cy", origin[1]);
    centerNode.setAttribute("r", 20);
    centerNode.setAttribute("fill", "var(--bg-panel)");
    centerNode.setAttribute("stroke", "var(--border-color)");
    centerNode.setAttribute("stroke-width", "4");
    centerNode.setAttribute("id", "center-anchor");
    centerNode.classList.add("root-node");
    svg.appendChild(centerNode);

    Object.keys(COLORS).forEach(constellName => {
        if (data[constellName]) {
            registerNode(data[constellName], constellName, null);
            if (data[constellName].Coords) {
                drawLine(origin, data[constellName].Coords, data[constellName].Path + "_rootline");
                drawStarNode(data[constellName], constellName);
            }
        }
    });
});