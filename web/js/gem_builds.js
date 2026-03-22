document.addEventListener("gem_builds_loaded", () => {
    let currentPage = 0;
    let cachedBuilds = [];
    const itemsPerPage = 25;
    let isCalculating = false;

    const tbody = document.getElementById("gb-results-body");
    const pageInfo = document.getElementById("gb-page-info");
    const starChartInput = document.getElementById("gb-star-chart");
    const starChartSummary = document.getElementById("gb-star-chart-summary");

    // --- UTILITY: DEBOUNCE ---
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    // --- UI LOGIC: BASE LIGHT TOGGLE ---
    function updateLightInputState() {
        const buildType = document.getElementById("gb-build-type")?.value;
        const lightInput = document.getElementById("gb-light");
        
        if (lightInput) {
            const wrapper = lightInput.parentElement;
            if (buildType === "Farm") {
                lightInput.disabled = false;
                if (wrapper) wrapper.style.opacity = "1";
            } else {
                lightInput.disabled = true;
                if (wrapper) wrapper.style.opacity = "0.5";
            }
        }
    }

    // --- 1. CORE CALCULATION LOGIC ---
    async function triggerCalculation() {
        if (isCalculating) return;
        isCalculating = true;

        const config = {
            character: document.getElementById("gb-class")?.value || "boomeranger",
            subclass: document.getElementById("gb-subclass")?.value || "knight",
            build_type: document.getElementById("gb-build-type")?.value || "Light",
            ally: document.getElementById("gb-ally")?.value || "boot_clown",
            food: document.getElementById("gb-food")?.value || "",
            light: parseInt(document.getElementById("gb-light")?.value) || 0,
            critical_damage_count: parseInt(document.getElementById("gb-cd-count")?.value) || 3,
            berserker_battler: document.getElementById("gb-berserker")?.checked || false,
            litany: document.getElementById("gb-litany")?.checked || false,
            subclass_active: document.getElementById("gb-subclass-active")?.checked || false,
            no_face: document.getElementById("gb-no-face")?.checked || false,
            star_chart: document.getElementById("gb-star-chart")?.value.trim() || null
        };

        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> Crunching Math...</td></tr>`;
        }

        try {
            const results = await eel.calculate_gem_builds(config)(); 
            cachedBuilds = results;
            currentPage = 0;
            renderTable();
        } catch (err) {
            console.error("Gem Builds Engine Error:", err);
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="9" class="text-center" style="color: #ff4444;">Calculation failed. Check console.</td></tr>`;
            }
        } finally {
            isCalculating = false;
        }
    }

    const debouncedCalc = debounce(triggerCalculation, 300);

    // --- 2. INIT DATA VIA EEL ---
    async function loadConfigData() {
        try {
            const [classesData, foodsData, alliesData] = await Promise.all([
                eel.get_trove_classes()(),
                eel.get_food_data()(),
                eel.get_ally_data()()
            ]);
            
            const classSelect = document.getElementById("gb-class");
            const subclassSelect = document.getElementById("gb-subclass");
            const foodSelect = document.getElementById("gb-food");
            const allySelect = document.getElementById("gb-ally");

            // 1. Populate Classes
            if (classSelect && subclassSelect && classesData) {
                classSelect.options.length = 0;
                subclassSelect.options.length = 0;
                
                for (let i = 0; i < classesData.length; i++) {
                    const cls = classesData[i];
                    classSelect.add(new Option(cls.name, cls.value));
                    subclassSelect.add(new Option(cls.name, cls.value));
                }
                
                // Ensure Class and Subclass are never the same on load
                if (classSelect.value === subclassSelect.value) {
                    for (let i = 0; i < subclassSelect.options.length; i++) {
                        if (subclassSelect.options[i].value !== classSelect.value) {
                            subclassSelect.selectedIndex = i;
                            break;
                        }
                    }
                }
            }

            // 2. Populate Food
            if (foodSelect && foodsData) {
                foodSelect.options.length = 0;
                foodSelect.add(new Option("None", ""));
                for (const [key, data] of Object.entries(foodsData)) {
                    foodSelect.add(new Option(data.qualified_name || key, key));
                }
            }

            // 3. Populate Allies
            if (allySelect && alliesData) {
                allySelect.options.length = 0;
                allySelect.add(new Option("None (Auto-Optimal)", "boot_clown"));
                for (const [key, data] of Object.entries(alliesData)) {
                    allySelect.add(new Option(data.qualified_name || key, key));
                }
            }
            
            console.log("✅ Gem Builds: All dropdowns populated successfully!");

            // Run initial calculation once populated
            triggerCalculation();

        } catch (err) {
            console.error("❌ Gem Builds: Failed to load config data from Python:", err);
            const classSelect = document.getElementById("gb-class");
            if (classSelect) {
                classSelect.options.length = 0;
                classSelect.add(new Option("Error Loading Data", "error"));
            }
        }
    }

    // Set up Base Light tooltip and initial state
    const lightInput = document.getElementById("gb-light");
    if (lightInput) {
        const label = lightInput.previousElementSibling;
        if (label && label.tagName === "LABEL" && !label.querySelector('.fa-circle-info')) {
            label.innerHTML += ` <i class="fa-solid fa-circle-info" style="cursor: help; color: var(--text-muted);" title="Base Light optimization is only active for 'Farm' builds."></i>`;
        }
    }
    updateLightInputState();

    // Fire the initial load
    loadConfigData();

    // --- 3. EVENT LISTENERS ---

    // Prevent Class and Subclass from being the same
    const classSelect = document.getElementById("gb-class");
    const subclassSelect = document.getElementById("gb-subclass");

    if (classSelect && subclassSelect) {
        classSelect.addEventListener("change", () => {
            if (classSelect.value === subclassSelect.value) {
                for (let i = 0; i < subclassSelect.options.length; i++) {
                    if (subclassSelect.options[i].value !== classSelect.value) {
                        subclassSelect.selectedIndex = i;
                        break;
                    }
                }
            }
        });

        subclassSelect.addEventListener("change", () => {
            if (subclassSelect.value === classSelect.value) {
                for (let i = 0; i < classSelect.options.length; i++) {
                    if (classSelect.options[i].value !== subclassSelect.value) {
                        classSelect.selectedIndex = i;
                        break;
                    }
                }
            }
        });
    }

    // Watch Build Type to update Base Light input state
    const buildTypeSelect = document.getElementById("gb-build-type");
    if (buildTypeSelect) {
        buildTypeSelect.addEventListener("change", updateLightInputState);
    }

    // Auto-calculate triggers for standard inputs
    const instantChangeElements = [
        "gb-class", "gb-subclass", "gb-build-type", "gb-ally", "gb-food",
        "gb-berserker", "gb-litany", "gb-subclass-active", "gb-no-face"
    ];
    
    instantChangeElements.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.addEventListener("change", triggerCalculation);
    });

    if(lightInput) lightInput.addEventListener("input", debouncedCalc);

    // Gear Crit Dmg Rolls Slider Listener
    const cdCountInput = document.getElementById("gb-cd-count");
    const cdCountDisplay = document.getElementById("gb-cd-count-display");
    if (cdCountInput) {
        cdCountInput.addEventListener("input", (e) => {
            if (cdCountDisplay) cdCountDisplay.innerText = e.target.value;
            debouncedCalc();
        });
    }

    // --- STAR CHART UI FEEDBACK ---
    if (starChartInput && starChartSummary) {
        const scTemplateSelect = document.createElement("select");
        scTemplateSelect.className = 'btt-select';
        scTemplateSelect.style.padding = '8px';
        scTemplateSelect.style.background = 'var(--bg-dark, #111)';
        scTemplateSelect.style.color = '#fff';
        scTemplateSelect.style.border = '1px solid var(--border-color, #333)';
        scTemplateSelect.style.borderRadius = '4px';
        scTemplateSelect.style.width = '100%';
        scTemplateSelect.style.marginBottom = '8px';
        scTemplateSelect.innerHTML = '<option value="">-- Load Saved Star Chart --</option>';

        starChartInput.parentElement.insertBefore(scTemplateSelect, starChartInput);

        eel.get_star_chart_templates()().then(templates => {
            for (let name in templates) {
                let opt = document.createElement('option');
                opt.value = templates[name];
                opt.innerText = name;
                scTemplateSelect.appendChild(opt);
            }
        });

        scTemplateSelect.addEventListener("change", () => {
            starChartInput.value = scTemplateSelect.value;
            starChartInput.dispatchEvent(new Event("input"));
        });

        starChartInput.addEventListener("input", async () => {
            const code = starChartInput.value.trim();
            
            let matched = false;
            for (let i = 0; i < scTemplateSelect.options.length; i++) {
                if (scTemplateSelect.options[i].value === code && code !== "") {
                    scTemplateSelect.selectedIndex = i;
                    matched = true;
                    break;
                }
            }
            if (!matched) scTemplateSelect.value = "";

            if (!code) {
                starChartSummary.style.display = "none";
                debouncedCalc();
                return;
            }

            try {
                // Basic client-side validation
                const decoded = atob(code);
                const paths = decoded.split('$');
                
                // Fetch the actual stats from the backend parser
                const parsedData = await eel.parse_star_chart_code(code)();
                
                let statsHtml = "";
                if (parsedData && parsedData.stats) {
                    for (const [statName, values] of Object.entries(parsedData.stats)) {
                        let valStr = [];
                        if (values.flat > 0) valStr.push(`+${values.flat}`);
                        if (values.pct > 0) valStr.push(`+${values.pct}%`);
                        
                        if (valStr.length > 0) {
                            statsHtml += `<li><strong>${statName}:</strong> <span style="color: var(--accent-orange);">${valStr.join(" / ")}</span></li>`;
                        }
                    }
                }

                starChartSummary.innerHTML = `
                    <h4><i class="fa-solid fa-chart-network"></i> Star Chart Loaded</h4>
                    <ul style="margin-bottom: 8px;">
                        <li><strong>${paths.length}</strong> Nodes Detected</li>
                    </ul>
                    ${statsHtml ? `<hr class="divider" style="margin: 8px 0;"><ul style="list-style-type: none; padding-left: 0;">${statsHtml}</ul>` : ""}
                `;
                starChartSummary.style.display = "block";
                
                debouncedCalc();
            } catch (e) {
                starChartSummary.style.display = "block";
                starChartSummary.innerHTML = `<span style="color: #ff4444;"><i class="fa-solid fa-triangle-exclamation"></i> Invalid Base64 Build Code</span>`;
            }
        });
    }

    // --- 4. PAGINATION CONTROLS ---
    const btnPrev = document.getElementById("gb-prev");
    const btnNext = document.getElementById("gb-next");

    if (btnPrev) {
        btnPrev.addEventListener("click", () => {
            if (currentPage > 0) { 
                currentPage--; 
                renderTable(); 
            }
        });
    }

    if (btnNext) {
        btnNext.addEventListener("click", () => {
            const maxPages = Math.ceil(cachedBuilds.length / itemsPerPage);
            if (currentPage < maxPages - 1) { 
                currentPage++; 
                renderTable(); 
            }
        });
    }

    // --- 5. TABLE RENDERER ---
    function renderTable() {
        if (!tbody) return;
        
        if (cachedBuilds.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted">No builds generated. Check your config.</td></tr>`;
            return;
        }

        const maxPages = Math.ceil(cachedBuilds.length / itemsPerPage);
        if (pageInfo) {
            pageInfo.innerText = `Page ${currentPage + 1} / ${maxPages}`;
        }

        const startIdx = currentPage * itemsPerPage;
        const pageItems = cachedBuilds.slice(startIdx, startIdx + itemsPerPage);
        const bestCoeff = cachedBuilds[0].coefficient; 

        let tableHTML = "";
        pageItems.forEach(build => {
            const isBest = build.rank === 1;
            const deviation = isBest ? 
                `<span style="color: var(--accent-blue);">Best</span>` : 
                `-${(((bestCoeff - build.coefficient) / bestCoeff) * 100).toFixed(3)}%`;

            const classBonusText = build.class_bonus ? `<span style="color: var(--accent-blue);"> + ${build.class_bonus}%</span>` : "";

            tableHTML += `
                <tr style="${isBest ? 'background: rgba(94, 198, 255, 0.1);' : ''}">
                    <td>${build.rank}</td>
                    <td class="build-layout-cell" data-layout="${build.layout}" style="font-family: monospace; color: var(--accent-orange); cursor: pointer;" title="Click to copy">
                        ${build.layout}
                    </td>
                    <td>${build.light.toLocaleString()}</td>
                    <td>${Math.round(build.base_dmg).toLocaleString()}</td>
                    <td>${build.bonus_dmg.toFixed(2)}%${classBonusText}</td>
                    <td>${Math.round(build.total_dmg).toLocaleString()}</td>
                    <td>${build.crit_dmg.toFixed(1)}%</td>
                    <td style="font-weight: bold; color: #fff;">${build.coefficient.toLocaleString()}</td>
                    <td>${deviation}</td>
                </tr>
            `;
        });
        
        tbody.innerHTML = tableHTML;

        document.querySelectorAll('.build-layout-cell').forEach(cell => {
            cell.addEventListener('click', async (e) => {
                const layoutText = e.target.getAttribute('data-layout');
                try {
                    await navigator.clipboard.writeText(layoutText);
                    const originalColor = e.target.style.color;
                    e.target.style.color = "#4CAF50"; 
                    setTimeout(() => e.target.style.color = originalColor, 500);
                    if(window.showToast) window.showToast("Copied Build Layout to clipboard!");
                } catch (err) {
                    console.error("Failed to copy:", err);
                }
            });
        });
    }
});