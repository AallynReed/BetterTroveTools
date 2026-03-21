document.addEventListener('allies_loaded', async () => {
    console.log("Ally Codex initialized!");

    let alliesData = [];
    const grid = document.getElementById('allies-grid');
    const searchInput = document.getElementById('ally-search-input');
    const categorySelect = document.getElementById('ally-category-select');
    const statSelect = document.getElementById('ally-stat-select');
    const abilitySelect = document.getElementById('ally-ability-select');
    const statsDisplay = document.getElementById('search-stats-display');

    statsDisplay.innerText = "Checking for Codex updates...";

    // 1. Ask Python to attempt the 3-second background update
    if (window.eel && eel.sync_allies_data) {
        try {
            await eel.sync_allies_data()();
        } catch (e) {
            console.warn("Could not reach Python backend for Ally sync.");
        }
    }

    statsDisplay.innerText = "Loading allies...";

    // 2. Fetch the local JSON 
    const cacheBuster = new Date().getTime();
    fetch(`/assets/data/allies.json?t=${cacheBuster}`)
        .then(response => response.json())
        .then(data => {
            const uniqueCategories = new Set();
            const uniqueStats = new Set();
            const uniqueAbilities = new Set();

            // Convert and Parse
            alliesData = Object.keys(data).map(key => {
                const ally = data[key];
                
                if (ally.category) uniqueCategories.add(ally.category);

                const parser = new DOMParser();
                const doc = parser.parseFromString(ally.tooltip, 'text/html');
                
                // Extract Stats and parse numbers/percentages
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

                // Extract Abilities
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

            // Populate Category Dropdown (Standard Select)
            Array.from(uniqueCategories).sort().forEach(cat => {
                const opt = document.createElement('option');
                opt.value = cat;
                opt.innerText = cat;
                categorySelect.appendChild(opt);
            });

            // Populate Stat Dropdown (Multiple)
            Array.from(uniqueStats).sort().forEach(stat => {
                const opt = document.createElement('option');
                opt.value = stat;
                opt.innerText = stat;
                statSelect.appendChild(opt);
            });

            // Populate Ability Dropdown (Multiple)
            Array.from(uniqueAbilities).sort().forEach(ability => {
                const opt = document.createElement('option');
                opt.value = ability;
                opt.innerText = ability;
                abilitySelect.appendChild(opt);
            });

            // Initialize Select2 Multiple Dropdowns with Custom Theme
            if (window.jQuery && $.fn.select2) {
                $('#ally-stat-select').select2({
                    placeholder: "Select one or more stats...",
                    allowClear: true,
                    theme: "btt-dark"
                });
                
                $('#ally-ability-select').select2({
                    placeholder: "Select one or more abilities...",
                    allowClear: true,
                    theme: "btt-dark"
                });

                // Bind Select2 change events
                $('#ally-stat-select, #ally-ability-select').on('change', applyFilters);
            }

            // Initial render
            applyFilters();
            
            // Set up native listeners
            searchInput.addEventListener('input', applyFilters);
            categorySelect.addEventListener('change', applyFilters);
        })
        .catch(err => {
            console.error("Failed to load allies data:", err);
            statsDisplay.innerText = "Error loading data.";
        });

    function applyFilters() {
        const textQuery = searchInput.value.toLowerCase().trim();
        const catQuery = categorySelect.value;
        
        // Select2 multiple returns an array, or null if empty
        const statQueries = window.jQuery && $.fn.select2 ? $('#ally-stat-select').val() : [];
        const abilityQueries = window.jQuery && $.fn.select2 ? $('#ally-ability-select').val() : [];

        let filtered = alliesData;

        // 1. Filter by Text Search
        if (textQuery) {
            filtered = filtered.filter(ally => {
                if (ally.name.toLowerCase().includes(textQuery)) return true;
                if (ally.extractedAbilities.some(ability => ability.toLowerCase().includes(textQuery))) return true;
                return false;
            });
        }

        // 2. Filter by Category
        if (catQuery && catQuery !== "All") {
            filtered = filtered.filter(ally => ally.category === catQuery);
        }

        // 3. Filter by Selected Stats (Must have ALL selected stats)
        if (statQueries && statQueries.length > 0) {
            filtered = filtered.filter(ally => {
                return statQueries.every(sq => ally.parsedStats[sq] !== undefined);
            });
            
            // SORTING LOGIC: Sort by the FIRST stat selected. Percentages beat Flats.
            const primaryStat = statQueries[0];
            filtered.sort((a, b) => {
                const statA = a.parsedStats[primaryStat];
                const statB = b.parsedStats[primaryStat];

                if (statA.isPercent && !statB.isPercent) return -1;
                if (!statA.isPercent && statB.isPercent) return 1;

                return statB.value - statA.value;
            });
        } else {
            // Default sort by Name if no stats are selected to sort by
            filtered.sort((a, b) => a.name.localeCompare(b.name));
        }

        // 4. Filter by Selected Abilities (Must have ALL selected abilities)
        if (abilityQueries && abilityQueries.length > 0) {
            filtered = filtered.filter(ally => {
                return abilityQueries.every(aq => ally.extractedAbilities.includes(aq));
            });
        }

        renderAllies(filtered, statQueries, abilityQueries);
    }

    function renderAllies(alliesToRender, activeStatHighlights = [], activeAbilityHighlights = []) {
        grid.innerHTML = '';
        statsDisplay.innerText = `Showing ${alliesToRender.length} of ${alliesData.length} allies`;

        // Ensure arrays
        if (!activeStatHighlights) activeStatHighlights = [];
        if (!activeAbilityHighlights) activeAbilityHighlights = [];

        alliesToRender.forEach(ally => {
            const card = document.createElement('div');
            card.className = 'ally-card';

            // Build Stats HTML (Highlighting the searched stats)
            let statsHtml = '';
            if (ally.rawStats.length > 0) {
                const lis = ally.rawStats.map(s => {
                    const isHighlighted = activeStatHighlights.some(highlight => s.includes(highlight));
                    return `<li>${isHighlighted ? `<strong>${s}</strong>` : s}</li>`;
                }).join('');
                statsHtml = `<ul class="ally-stats-list">${lis}</ul>`;
            }

            // Build Abilities HTML (Highlighting the searched abilities)
            let abilitiesHtml = '';
            if (ally.extractedAbilities.length > 0) {
                abilitiesHtml = ally.extractedAbilities.map(a => {
                    const isHighlighted = activeAbilityHighlights.includes(a);
                    return `<div class="ally-ability">${isHighlighted ? `<strong>${a}</strong>` : a}</div>`;
                }).join('');
            }

            let imgSource = ally.image || ally.blueprint;
            let imagePath = imgSource.startsWith('http') ? imgSource : `https://trovesaurus.com/data/catalog/${imgSource}.png`;

            card.innerHTML = `
                <div class="ally-header">
                    <div class="ally-icon">
                        <img src="${imagePath}" onerror="this.src='/assets/images/default_ally.png'; this.onerror=null;" alt="">
                    </div>
                    <div class="ally-title-area">
                        <div class="ally-name">${ally.name}</div>
                        <div class="ally-category">${ally.category || 'Unknown'}</div>
                    </div>
                </div>
                <div class="ally-body">
                    <div class="ally-desc">"${ally.desc}"</div>
                    ${statsHtml}
                    ${abilitiesHtml}
                </div>
                <div class="ally-footer">
                    <span class="footer-stat"><i class="fa-solid fa-star" style="color: #fbc02d;"></i> PR ${ally.powerrank}</span>
                    <span class="footer-stat"><i class="fa-solid fa-crown" style="color: #ff9800;"></i> Mastery ${ally.mastery}</span>
                </div>
            `;

            grid.appendChild(card);
        });
    }
});