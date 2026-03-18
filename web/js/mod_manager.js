// --- APP METADATA (Run Immediately on App Load) ---
document.addEventListener('DOMContentLoaded', async () => {
    const metaResponse = await eel.get_app_metadata()();
    let currentVersion = metaResponse?.APP_VERSION || "Unknown";
    
    if (metaResponse && metaResponse.APP_VERSION) {
        const appName = metaResponse.APP_NAME || "Better Trove Tools";
        document.title = `${appName} v${currentVersion}`;
        const titleEl = document.getElementById('app-title');
        if (titleEl) {
            titleEl.innerHTML = `
                <div class="app-name-text">${appName}</div>
                <div class="app-version-text">v${currentVersion}</div>
            `;
        }
    }

    // --- APP UPDATE CHECK ---
    try {
        const ghResponse = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/releases/latest');
        if (ghResponse.ok) {
            const ghData = await ghResponse.json();
            let latestVersion = ghData.tag_name;
            
            // Strip the 'v' prefix if GitHub tag includes it, so it matches your metadata.json
            if (latestVersion && latestVersion.startsWith('v')) {
                latestVersion = latestVersion.substring(1);
            }
            
            if (latestVersion && currentVersion !== latestVersion) {
                const sidebar = document.getElementById('sidebar');
                if (sidebar) {
                    const updateContainer = document.createElement('div');
                    updateContainer.className = 'app-update-container';
                    updateContainer.innerHTML = `
                        <button class="nav-btn update-app-btn" title="A new version is available! Click to download." onclick="eel.open_url_in_browser('${ghData.html_url}')()">
                            <i class="fa-solid fa-cloud-arrow-down nav-icon"></i>
                            <span class="nav-text">Update v${latestVersion}</span>
                        </button>
                    `;
                    sidebar.appendChild(updateContainer);
                }
            }
        }
    } catch (err) {
        console.error("Failed to check for app updates:", err);
    }
});

document.addEventListener('mod_manager_loaded', async () => {
    console.log("Mod Manager view initialized!");

    // --- UI ELEMENTS ---
    const modSelect = document.getElementById('mod-game-select');
    const refreshBtn = document.getElementById('btn-refresh-mods');
    const browseBtn = document.getElementById('btn-browse-mods');
    const modGrid = document.getElementById('mod-grid-container');
    
    const fixNamesBtn = document.getElementById('btn-fix-names');
    const fixConfigsBtn = document.getElementById('btn-fix-configs');

    const imageModal = document.getElementById('image-modal');
    const modalImg = document.getElementById('expanded-img');
    const modalCaption = document.getElementById('modal-caption');

    const searchInput = document.getElementById('mod-search-input');
    const filterStatus = document.getElementById('mod-filter-status');
    const visibleCountDisp = document.getElementById('visible-count');
    const totalCountDisp = document.getElementById('total-count');

    // --- 1. FILTERING LOGIC ---
    function applyFilters() {
        const searchTerm = searchInput.value.toLowerCase();
        const statusLimit = filterStatus.value;
        const cards = document.querySelectorAll('.mod-card');
        let visibleCount = 0;

        cards.forEach(card => {
            const name = card.getAttribute('data-name').toLowerCase();
            const author = card.getAttribute('data-author').toLowerCase();
            const isEnabled = card.getAttribute('data-status') === 'enabled';
            const hasActiveConflict = card.getAttribute('data-active-conflict') === 'true';

            const matchesSearch = name.includes(searchTerm) || author.includes(searchTerm);
            let matchesStatus = true;

            if (statusLimit === 'enabled') matchesStatus = isEnabled;
            else if (statusLimit === 'disabled') matchesStatus = !isEnabled;
            else if (statusLimit === 'conflicts') matchesStatus = hasActiveConflict;

            if (matchesSearch && matchesStatus) {
                card.style.display = "flex";
                visibleCount++;
            } else {
                card.style.display = "none";
            }
        });

        if (visibleCountDisp) visibleCountDisp.innerText = visibleCount;
        if (totalCountDisp) totalCountDisp.innerText = cards.length;
    }

    if (searchInput) searchInput.addEventListener('input', applyFilters);
    if (filterStatus) filterStatus.addEventListener('change', applyFilters);

    // --- 2. GAME SCANNING ---
    async function scanForGames() {
        if (!modSelect) return;
        modSelect.innerHTML = `<option value="">Searching for Game Installs...</option>`;
        const response = await eel.get_detected_game_paths()();
        modSelect.innerHTML = ""; 
        
        if (response.success && response.paths.length > 0) {
            response.paths.forEach(game => {
                let option = document.createElement('option');
                option.value = game.path; 
                option.textContent = `${game.name} - ${game.path}`;
                modSelect.appendChild(option);
            });
            if (modSelect.value) loadMods(modSelect.value);
        } else {
            modSelect.innerHTML = `<option value="">No installations found.</option>`;
        }
    }
    
    scanForGames();
    
    if (refreshBtn) refreshBtn.addEventListener('click', scanForGames);

    if (browseBtn) {
        browseBtn.addEventListener('click', async () => {
            const response = await eel.browse_for_game_dir()();
            if (response.success) {
                let option = document.createElement('option');
                option.value = response.path;
                option.textContent = `(Custom) - ${response.path}`;
                modSelect.appendChild(option);
                modSelect.value = response.path;
                loadMods(response.path);
            }
        });
    }

    if (modSelect) {
        modSelect.addEventListener('change', () => {
            if (modSelect.value) loadMods(modSelect.value);
        });
    }

    // --- 3. MOD LOADING ---
    async function loadMods(gamePath) {
        if (!modGrid) return;
        modGrid.innerHTML = `<div class="placeholder-box">Scanning Mod Directory...</div>`;
        modGrid.className = ""; 
        
        const response = await eel.get_installed_mods(gamePath)();
        
        if (response.success) {
            if (response.mods.length === 0) {
                modGrid.innerHTML = `<div class="placeholder-box">No mods found in the selected directory.</div>`;
                return;
            }

            modGrid.className = "mod-grid";
            let html = "";
            
            response.mods.forEach(mod => {
                const isEnabled = mod.status === 'enabled';
                const statusColor = isEnabled ? '#28a745' : '#666'; 
                const btnText = isEnabled ? 'Disable' : 'Enable';
                const btnClass = isEnabled ? 'active' : '';
                const cardOpacity = isEnabled ? '1' : '0.6'; 
                
                const hasActiveConflict = isEnabled && mod.conflicts_with.some(c => c.enabled);

                const imageHTML = mod.image 
                    ? `<img src="data:image/png;base64,${mod.image}" alt="Preview" class="mod-preview-img" loading="lazy" style="max-height: 200px; object-fit: cover; width: 100%;">`
                    : `<div class="mod-preview-img placeholder-img" style="height: 200px; display: flex; align-items: center; justify-content: center;">No Preview</div>`;
                
                let conflictBadge = '';
                if (mod.has_conflicts) {
                    const badgeClass = hasActiveConflict ? 'conflict-active' : 'conflict-inactive';
                    const conflictNames = mod.conflicts_with.map(c => `${c.name} (${c.enabled ? 'ENABLED' : 'Disabled'})`).join('&#10;• ');
                    conflictBadge = `<span class="mod-conflict-inline ${badgeClass}" title="${hasActiveConflict ? 'CRITICAL CONFLICT' : 'POTENTIAL CONFLICT'}&#10;• ${conflictNames}"><i class="fa-solid fa-triangle-exclamation"></i></span>`;
                }
                
                html += `
                    <div class="mod-card" 
                         data-name="${mod.name}" 
                         data-author="${mod.author}" 
                         data-status="${mod.status}"
                         data-active-conflict="${hasActiveConflict}"
                         style="opacity: ${cardOpacity}">
                        <div class="mod-image-container">
                            ${imageHTML}
                            <span class="mod-badge" style="background: ${statusColor}">${mod.status.toUpperCase()}</span>
                        </div>
                        <div class="mod-card-content">
                            <h3 class="mod-title" title="${mod.name}">${mod.name}</h3>
                            <span class="mod-meta">${mod.author}</span>
                            <div class="mod-card-footer">
                                ${conflictBadge}
                                <button class="update-mod-btn hidden" data-path="${mod.path}" title="Update Available"><i class="fa-solid fa-download"></i></button>
                                <button class="toggle-mod-btn ${btnClass}" data-path="${mod.path}">${btnText}</button>
                            </div>
                        </div>
                    </div>
                `;
            });
            
            modGrid.innerHTML = html;
            applyFilters();
            getModUrls(gamePath);
            checkForUpdates(gamePath);
        } else {
            modGrid.innerHTML = `<div class="placeholder-box" style="color: #ff5555;">Error loading mods: ${response.error}</div>`;
        }
    }

    async function getModUrls(gamePath) {
        const response = await eel.get_mod_urls(gamePath)();
        if (response.success && response.urls) {
            document.querySelectorAll('.toggle-mod-btn').forEach(btn => {
                const path = btn.getAttribute('data-path');
                if (response.urls[path]) {
                    const card = btn.closest('.mod-card');
                    const titleEl = card ? card.querySelector('.mod-title') : null;
                    if (titleEl && !titleEl.classList.contains('ts-mod-title')) {
                        titleEl.classList.add('ts-mod-title');
                        titleEl.title = titleEl.innerText + " (Click to view on Trovesaurus)";
                        titleEl.onclick = () => eel.open_url_in_browser(response.urls[path])();
                    }
                }
            });
        }
    }

    async function checkForUpdates(gamePath) {
        const response = await eel.check_mod_updates(gamePath)();
        if (response.success) {
            const updates = response.updates || {};
            
            // Find all update buttons and unhide the ones that need updates
            document.querySelectorAll('.update-mod-btn').forEach(btn => {
                const path = btn.getAttribute('data-path');
                if (updates[path]) {
                    btn.classList.remove('hidden');
                }
            });
        }
    }

    // --- 4. GRID CLICKS (Toggle & Modal) ---
    if (modGrid) {
        modGrid.addEventListener('click', async (e) => {
            const toggleBtn = e.target.closest('.toggle-mod-btn');
            if (toggleBtn) {
                const currentPath = toggleBtn.getAttribute('data-path');
                const gamePath = modSelect.value;
                // Changed from innerText to innerHTML for the FA icon
                toggleBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Working...';
                toggleBtn.disabled = true;

                const response = await eel.toggle_mod(gamePath, currentPath)();
                if (response.success) loadMods(gamePath); 
                else {
                    alert("Failed to toggle mod: " + response.error);
                    loadMods(gamePath);
                }
                return;
            }

            const updateBtn = e.target.closest('.update-mod-btn');
            if (updateBtn) {
                const currentPath = updateBtn.getAttribute('data-path');
                const gamePath = modSelect.value;
                
                // Visual feedback: A cool spinning circle!
                updateBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                updateBtn.disabled = true;
                updateBtn.style.animation = "pulse 1s infinite";

                const response = await eel.perform_mod_update(gamePath, currentPath)();
                
                if (response.success) {
                    // Reload the grid to show the new hash/version
                    loadMods(gamePath); 
                } else {
                    alert("Failed to update mod: " + response.error);
                    // Reset back to the download icon
                    updateBtn.innerHTML = '<i class="fa-solid fa-download"></i>'; 
                    updateBtn.disabled = false;
                    updateBtn.style.animation = "none";
                }
                return;
            }

            const previewImg = e.target.closest('img.mod-preview-img');
            if (previewImg && imageModal) {
                const card = previewImg.closest('.mod-card');
                modalImg.src = previewImg.src;
                modalCaption.innerText = card.querySelector('.mod-title').innerText;
                imageModal.classList.add('active');
            }
        });
    }

    // --- 5. MODAL CLOSING ---
    if (imageModal) {
        imageModal.addEventListener('click', (e) => {
            if (e.target === imageModal || e.target.classList.contains('close-modal')) {
                imageModal.classList.remove('active');
                setTimeout(() => { modalImg.src = ""; }, 200); 
            }
        });
    }

    // --- 6. UTILITY BUTTONS ---
    const runUtility = async (btn, eelFunc, successMsg) => {
        const gamePath = modSelect.value;
        if (!gamePath) return alert("Select a game first.");
        
        const originalText = btn.innerHTML;
        // Changed to FA spinning icon
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
        btn.disabled = true;

        const response = await eelFunc(gamePath)();
        if (response.success) {
            alert(successMsg(response));
            loadMods(gamePath);
        } else alert("Error: " + response.error);

        btn.innerHTML = originalText;
        btn.disabled = false;
    };

    if (fixNamesBtn) fixNamesBtn.addEventListener('click', () => runUtility(fixNamesBtn, eel.fix_mod_names, r => `Fixed ${r.fixed_count} mod names!`));
    if (fixConfigsBtn) fixConfigsBtn.addEventListener('click', () => runUtility(fixConfigsBtn, eel.fix_mod_configs, r => `Verified configs for ${r.configs_ensured} mods!`));
});