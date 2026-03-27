document.addEventListener("gem_builds_loaded", () => {
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    let currentPage = 0;
    let cachedBuilds = [];
    const itemsPerPage = 24;
    let isCalculating = false;

    const tbody = document.getElementById("gb-results-body");
    const starChartInput = document.getElementById("gb-star-chart");
    const starChartSummary = document.getElementById("gb-star-chart-summary");

    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

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
            tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> ${t("Crunching Math...")}</td></tr>`;
        }

        try {
            const results = await eel.calculate_gem_builds(config)(); 
            cachedBuilds = results;
            currentPage = 0;
            renderTable();
        } catch (err) {
            console.error("Gem Builds Engine Error:", err);
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="9" class="text-center" style="color: #ff4444;">${t("Calculation failed. Check console.")}</td></tr>`;
            }
        } finally {
            isCalculating = false;
        }
    }

    const debouncedCalc = debounce(triggerCalculation, 300);

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

            if (classSelect && subclassSelect && classesData) {
                classSelect.options.length = 0;
                subclassSelect.options.length = 0;
                
                for (let i = 0; i < classesData.length; i++) {
                    const cls = classesData[i];
                    classSelect.add(new Option(t(cls.name), cls.value));
                    subclassSelect.add(new Option(t(cls.name), cls.value));
                }
                
                if (classSelect.value === subclassSelect.value) {
                    for (let i = 0; i < subclassSelect.options.length; i++) {
                        if (subclassSelect.options[i].value !== classSelect.value) {
                            subclassSelect.selectedIndex = i;
                            break;
                        }
                    }
                }
            }

            if (foodSelect && foodsData) {
                foodSelect.options.length = 0;
                foodSelect.add(new Option(t("None"), ""));
                for (const [key, data] of Object.entries(foodsData)) {
                    foodSelect.add(new Option(t(data.qualified_name || key), key));
                }
            }

            if (allySelect && alliesData) {
                allySelect.options.length = 0;
                allySelect.add(new Option(t("None (Auto-Optimal)"), "boot_clown"));
                for (const [key, data] of Object.entries(alliesData)) {
                    allySelect.add(new Option(t(data.qualified_name || key), key));
                }
            }
            
            console.log("✅ Gem Builds: All dropdowns populated successfully!");

            triggerCalculation();

        } catch (err) {
            console.error("❌ Gem Builds: Failed to load config data from Python:", err);
            const classSelect = document.getElementById("gb-class");
            if (classSelect) {
                classSelect.options.length = 0;
                classSelect.add(new Option(t("Error Loading Data"), "error"));
            }
        }
    }

    const lightInput = document.getElementById("gb-light");
    if (lightInput) {
        const label = lightInput.previousElementSibling;
        if (label && label.tagName === "LABEL" && !label.querySelector('.fa-circle-info')) {
            label.innerHTML += ` <i class="fa-solid fa-circle-info" style="cursor: help; color: var(--text-muted);" title="${t("Base Light optimization is only active for 'Farm' builds.")}"></i>`;
        }
    }
    updateLightInputState();

    loadConfigData();

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

    const buildTypeSelect = document.getElementById("gb-build-type");
    if (buildTypeSelect) {
        buildTypeSelect.addEventListener("change", updateLightInputState);
    }

    const instantChangeElements = [
        "gb-class", "gb-subclass", "gb-build-type", "gb-ally", "gb-food",
        "gb-berserker", "gb-litany", "gb-subclass-active", "gb-no-face"
    ];
    
    instantChangeElements.forEach(id => {
        const el = document.getElementById(id);
        if(el) el.addEventListener("change", triggerCalculation);
    });

    if(lightInput) lightInput.addEventListener("input", debouncedCalc);

    const cdCountInput = document.getElementById("gb-cd-count");
    const cdCountDisplay = document.getElementById("gb-cd-count-display");
    if (cdCountInput) {
        cdCountInput.addEventListener("input", (e) => {
            if (cdCountDisplay) cdCountDisplay.innerText = e.target.value;
            debouncedCalc();
        });
    }

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
        scTemplateSelect.innerHTML = `<option value="">-- ${t("Load Saved Star Chart")} --</option>`;

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
                const decoded = atob(code);
                const paths = decoded.split('$');
                
                const parsedData = await eel.parse_star_chart_code(code)();
                
                let statsHtml = "";
                if (parsedData && parsedData.stats) {
                    for (const [statName, values] of Object.entries(parsedData.stats)) {
                        let valStr = [];
                        if (values.flat > 0) valStr.push(`+${values.flat}`);
                        if (values.pct > 0) valStr.push(`+${values.pct}%`);
                        
                        if (valStr.length > 0) {
                            statsHtml += `<li><strong>${t(statName)}:</strong> <span style="color: var(--accent-orange);">${valStr.join(" / ")}</span></li>`;
                        }
                    }
                }

                starChartSummary.innerHTML = `
                    <h4><i class="fa-solid fa-chart-network"></i> ${t("Star Chart Loaded")}</h4>
                    <ul style="margin-bottom: 8px;">
                        <li><strong>${paths.length}</strong> ${t("Nodes Detected")}</li>
                    </ul>
                    ${statsHtml ? `<hr class="divider" style="margin: 8px 0;"><ul style="list-style-type: none; padding-left: 0;">${statsHtml}</ul>` : ""}
                `;
                starChartSummary.style.display = "block";
                
                debouncedCalc();
            } catch (e) {
                starChartSummary.style.display = "block";
                starChartSummary.innerHTML = `<span style="color: #ff4444;"><i class="fa-solid fa-triangle-exclamation"></i> ${t("Invalid Base64 Build Code")}</span>`;
            }
        });
    }

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

    function renderTable() {
        if (!tbody) return;
        
        if (cachedBuilds.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted">${t("No builds generated. Check your config.")}</td></tr>`;
            return;
        }

        const maxPages = Math.ceil(cachedBuilds.length / itemsPerPage);
        
        const pageCurrent = document.getElementById('gb-page-current');
        const pageMax = document.getElementById('gb-page-max');
        if (pageCurrent) pageCurrent.innerText = currentPage + 1;
        if (pageMax) pageMax.innerText = maxPages;

        const startIdx = currentPage * itemsPerPage;
        const pageItems = cachedBuilds.slice(startIdx, startIdx + itemsPerPage);
        const bestCoeff = cachedBuilds[0].coefficient; 

        let tableHTML = "";
        pageItems.forEach(build => {
            const isBest = build.rank === 1;
            const deviation = isBest ? 
                `<span style="color: var(--accent-blue);">${t("Best")}</span>` : 
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
                    if(window.showToast) window.showToast(t("Copied Build Layout to clipboard!"));
                } catch (err) {
                    console.error("Failed to copy:", err);
                }
            });
        });
    }
});