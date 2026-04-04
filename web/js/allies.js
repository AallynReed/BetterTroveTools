document.addEventListener('allies_loaded', async () => {
    console.log("Ally Codex initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

    let alliesData = [];
    const grid = document.getElementById('allies-grid');
    const searchInput = document.getElementById('ally-search-input');
    const categorySelect = document.getElementById('ally-category-select');
    const statSelect = document.getElementById('ally-stat-select');
    const abilitySelect = document.getElementById('ally-ability-select');
    const statsDisplay = document.getElementById('search-stats-display');

    statsDisplay.innerText = t("Checking for Codex updates...");

    if (window.eel && eel.sync_allies_data) {
        try {
            await eel.sync_allies_data()();
        } catch (e) {
            console.warn("Could not reach Python backend for Ally sync.");
        }
    }

    statsDisplay.innerText = t("Loading allies...");

    const cacheBuster = new Date().getTime();
    fetch(`/assets/data/allies.json?t=${cacheBuster}`)
        .then(response => response.json())
        .then(data => {
            const uniqueCategories = new Set();
            const uniqueStats = new Set();
            const uniqueAbilities = new Set();

            alliesData = Object.keys(data).map(key => {
                const ally = data[key];
                
                if (ally.category) uniqueCategories.add(ally.category);

                const parser = new DOMParser();
                const doc = parser.parseFromString(ally.tooltip, 'text/html');
                
                const listItems = doc.querySelectorAll('li');
                const rawStats = [];
                const parsedStats = {};

                Array.from(listItems).forEach(li => {
                    const text = li.textContent.trim();
                    rawStats.push(text);
                    
                    const match = text.match(/^([+-]?[\d.]+)(%?)\s+(.+)$/);
                    if (match) {
                        const val = parseFloat(match[1]);
                        const isPercent = match[2] === '%';
                        const statName = match[3].trim();
                        
                        uniqueStats.add(statName);
                        parsedStats[statName] = { value: val, isPercent: isPercent, raw: text };
                    }
                });

                const paragraphs = doc.querySelectorAll('p');
                const abilities = Array.from(paragraphs)
                    .map(p => p.textContent.trim())
                    .filter(text => text !== 'Ally' && text !== '');

                abilities.forEach(ab => uniqueAbilities.add(ab));

                return {
                    id: key,
                    ...ally,
                    rawStats: rawStats,
                    parsedStats: parsedStats,
                    extractedAbilities: abilities
                };
            });

            Array.from(uniqueCategories).sort().forEach(cat => {
                const opt = document.createElement('option');
                opt.value = cat;
                opt.innerText = t(cat);
                categorySelect.appendChild(opt);
            });

            Array.from(uniqueStats).sort().forEach(stat => {
                const opt = document.createElement('option');
                opt.value = stat;
                opt.innerText = t(stat);
                statSelect.appendChild(opt);
            });

            Array.from(uniqueAbilities).sort().forEach(ability => {
                const opt = document.createElement('option');
                opt.value = ability;
                opt.innerText = t(ability);
                abilitySelect.appendChild(opt);
            });

            if (window.jQuery && $.fn.select2) {
                $('#ally-stat-select').select2({
                    placeholder: t("Select one or more stats..."),
                    allowClear: true,
                    theme: "btt-dark"
                });
                
                $('#ally-ability-select').select2({
                    placeholder: t("Select one or more abilities..."),
                    allowClear: true,
                    theme: "btt-dark"
                });

                $('#ally-stat-select, #ally-ability-select').on('change', applyFilters);
            }

            applyFilters();
            
            searchInput.addEventListener('input', applyFilters);
            categorySelect.addEventListener('change', applyFilters);
        })
        .catch(err => {
            console.error("Failed to load allies data:", err);
            statsDisplay.innerText = t("Error loading data.");
        });

    const resetBtn = document.getElementById('btn-reset-ally-filters');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            searchInput.value = '';
            categorySelect.value = 'All';
            if (window.jQuery && $.fn.select2) {
                $('#ally-stat-select').val(null).trigger('change');
                $('#ally-ability-select').val(null).trigger('change');
            }
            applyFilters();
        });
    }

    function applyFilters() {
        const textQuery = searchInput.value.toLowerCase().trim();
        const catQuery = categorySelect.value;
        
        const statQueries = window.jQuery && $.fn.select2 ? $('#ally-stat-select').val() : [];
        const abilityQueries = window.jQuery && $.fn.select2 ? $('#ally-ability-select').val() : [];

        let filtered = alliesData;

        if (textQuery) {
            filtered = filtered.filter(ally => {
                if (ally.name.toLowerCase().includes(textQuery)) return true;
                if (ally.extractedAbilities.some(ability => ability.toLowerCase().includes(textQuery))) return true;
                return false;
            });
        }

        if (catQuery && catQuery !== "All") {
            filtered = filtered.filter(ally => ally.category === catQuery);
        }

        if (statQueries && statQueries.length > 0) {
            filtered = filtered.filter(ally => {
                return statQueries.every(sq => ally.parsedStats[sq] !== undefined);
            });
            
            const primaryStat = statQueries[0];
            filtered.sort((a, b) => {
                const statA = a.parsedStats[primaryStat];
                const statB = b.parsedStats[primaryStat];

                if (statA.isPercent && !statB.isPercent) return -1;
                if (!statA.isPercent && statB.isPercent) return 1;

                return statB.value - statA.value;
            });
        } else {
            filtered.sort((a, b) => a.name.localeCompare(b.name));
        }

        if (abilityQueries && abilityQueries.length > 0) {
            filtered = filtered.filter(ally => {
                return abilityQueries.every(aq => ally.extractedAbilities.includes(aq));
            });
        }

        renderAllies(filtered, statQueries, abilityQueries);
    }

    function renderAllies(alliesToRender, activeStatHighlights = [], activeAbilityHighlights = []) {
        grid.innerHTML = '';
        statsDisplay.innerText = t("Showing {count} of {total} allies")
            .replace("{count}", alliesToRender.length)
            .replace("{total}", alliesData.length);

        if (!activeStatHighlights) activeStatHighlights = [];
        if (!activeAbilityHighlights) activeAbilityHighlights = [];

        alliesToRender.forEach((ally, idx) => {
            const card = document.createElement('div');
            card.className = 'ally-card';
            card.style.animationDelay = `${Math.min(idx * 0.03, 0.3)}s`; // Stagger animation, cap at 0.3s so it doesn't take forever

            let statsHtml = '';
            if (ally.rawStats.length > 0) {
                const lis = ally.rawStats.map(s => {
                    const isHighlighted = activeStatHighlights.some(highlight => s.includes(highlight));
                    return `<li>${isHighlighted ? `<strong>${s}</strong>` : s}</li>`;
                }).join('');
                statsHtml = `<ul class="ally-stats-list">${lis}</ul>`;
            }

            let abilitiesHtml = '';
            if (ally.extractedAbilities.length > 0) {
                abilitiesHtml = ally.extractedAbilities.map(a => {
                    const isHighlighted = activeAbilityHighlights.includes(a);
                    return `<div class="ally-ability">${isHighlighted ? `<strong>${a}</strong>` : a}</div>`;
                }).join('');
            }

            let imgSource = ally.image || ally.blueprint;
            let imagePath = imgSource.startsWith('http') ? imgSource : `https://trovesaurus.com/data/catalog/${imgSource}.png`;

            let footerHtml = '';
            const pr = parseInt(ally.powerrank) || 0;
            const mast = parseInt(ally.mastery) || 0;
            const geodeMast = parseInt(ally.mastery_geode) || 0;

            if (pr > 0) {
                footerHtml += `<span class="footer-stat"><i class="fa-solid fa-star" style="color: #fbc02d;"></i> ${t("Power Rank")} ${pr}</span>`;
            }
            if (mast > 0) {
                footerHtml += `<span class="footer-stat"><i class="fa-solid fa-crown" style="color: #ff9800;"></i> ${t("Mastery {val}").replace("{val}", mast)}</span>`;
            }
            if (geodeMast > 0) {
                footerHtml += `<span class="footer-stat"><i class="fa-solid fa-gem" style="color: #00bcd4;"></i> ${t("Geode Mastery {val}").replace("{val}", geodeMast)}</span>`;
            }
            
            const footerContainer = footerHtml ? `<div class="ally-footer">${footerHtml}</div>` : '';

            card.innerHTML = `
                <div class="ally-header">
                    <div class="ally-icon">
                        <img src="${imagePath}" onerror="this.src='/assets/images/default_ally.png'; this.onerror=null;" alt="">
                    </div>
                    <div class="ally-title-area">
                        <div class="ally-name">${t(ally.name)}</div>
                        <div class="ally-category">${t(ally.category || 'Unknown')}</div>
                    </div>
                </div>
                <div class="ally-body">
                    <div class="ally-desc">"${t(ally.desc)}"</div>
                    ${statsHtml}
                    ${abilitiesHtml}
                </div>
                ${footerContainer}
            `;

            grid.appendChild(card);
        });
    }
});