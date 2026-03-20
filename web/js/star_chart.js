document.addEventListener('star_chart_loaded', async () => {
    console.log("Star Chart initialized!");
    
    const wrapper = document.getElementById('chart-wrapper');
    const tooltip = document.getElementById('star-tooltip');
    const summaryPanel = document.getElementById('summary-content');
    
    // Share Controls
    const codeInput = document.getElementById('build-code-input');
    const btnCopyCode = document.getElementById('btn-copy-code');
    const btnLoadCode = document.getElementById('btn-load-code');

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
        wrapper.innerHTML = `<div style="color: #ff4444; text-align: center;">Error loading chart data:<br>${response.error}</div>`;
        return;
    }

    const data = response.data;
    const origin = response.origin;

    wrapper.classList.remove('placeholder-box');
    wrapper.innerHTML = "";
    svg.setAttribute("id", "chart-svg");
    svg.setAttribute("viewBox", "0 0 1000 1000");
    wrapper.appendChild(svg);

    // Populate nodeMap and build SVG hierarchy
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
                    window.showToast("Cannot exceed maximum of 40 active nodes.", true);
                    return; 
                }
                nodesToAdd.forEach(p => selectedPaths.add(p));
            }
            
            updateChartVisuals();
            calculateStats();
        });

        shape.addEventListener("mouseenter", () => {
            let html = `<h3>${star.Name || star.Constellation}</h3>`;
            html += `<span class="type">${star.Type} Node</span>`;
            if (star.Description) html += `<p>${star.Description}</p><hr/>`;
            if (star.Stats && star.Stats.length > 0) {
                html += `<ul>`;
                star.Stats.forEach(s => html += `<li><strong>${s.name}:</strong> +${s.value}${s.percentage ? "%" : ""}</li>`);
                html += `</ul>`;
            }
            if (star.Abilities && star.Abilities.length > 0) {
                if(star.Stats && star.Stats.length > 0) html += `<hr/>`;
                html += `<ul>`;
                star.Abilities.forEach(a => html += `<li>${a}</li>`);
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

    // --- Graph Logic ---

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
            window.showToast("Cannot exceed maximum of 40 active nodes.", true);
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
            summaryPanel.innerHTML = '<p class="file-meta">Select nodes to calculate stats.</p>';
            return;
        }

        let html = `<div style="margin-bottom: 15px; color: var(--text-muted); font-size: 12px;">Nodes Active: ${aggData.paths.length} / 40</div>`;
        
        if (aggData.stats.length > 0) {
            html += `<div class="summary-section"><h4>Aggregated Stats</h4><ul>`;
            aggData.stats.forEach(s => {
                html += `<li><strong>${s.name}:</strong> +${s.value}${s.percentage ? "%" : ""}</li>`;
            });
            html += `</ul></div>`;
        }

        if (aggData.abilities.length > 0) {
            html += `<div class="summary-section"><h4>Active Abilities</h4><ul>`;
            aggData.abilities.forEach(a => html += `<li>${a}</li>`);
            html += `</ul></div>`;
        }

        if (aggData.obtainables.length > 0) {
            html += `<div class="summary-section"><h4>Obtainables</h4><ul>`;
            aggData.obtainables.forEach(o => html += `<li>${o}</li>`);
            html += `</ul></div>`;
        }

        summaryPanel.innerHTML = html;
    }

    // --- Share Controls Logic ---

    btnCopyCode.addEventListener('click', () => {
        const code = codeInput.value;
        if (!code) {
            window.showToast("No nodes selected to copy.", true);
            return;
        }
        navigator.clipboard.writeText(code).then(() => {
            window.showToast("Build code copied to clipboard!");
        }).catch(err => {
            window.showToast("Failed to copy: " + err, true);
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
                window.showToast(`Loaded ${loaded} nodes. Skipped ${skipped} (Max 40 limit).`, true);
            } else if (loaded > 0) {
                window.showToast(`Successfully loaded ${loaded} nodes!`);
            } else {
                window.showToast("No valid nodes found in build code.", true);
            }
        } catch (e) {
            window.showToast("Invalid build code format.", true);
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

    // --- Boot Sequence ---

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