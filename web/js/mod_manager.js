document.addEventListener('mod_manager_loaded', async () => {
    console.log("Mod Manager view initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

    const modSelect = document.getElementById('mod-game-select');
    const refreshBtn = document.getElementById('btn-refresh-mods');
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

    function applyFilters() {
        const searchTerm = searchInput.value.toLowerCase();
        const statusLimit = filterStatus.value;
        const cards = document.querySelectorAll('.mod-card');
        let visibleCount = 0;

        cards.forEach(card => {
            const name = card.dataset.name.toLowerCase();
            const author = card.dataset.author.toLowerCase();
            const status = card.dataset.status;
            const activeConflict = card.dataset.activeConflict === 'true';

            const matchesSearch = name.includes(searchTerm) || author.includes(searchTerm);
            
            let matchesStatus = false;
            if (statusLimit === 'all') {
                matchesStatus = true;
            } else if (statusLimit === 'conflicts') {
                matchesStatus = activeConflict;
            } else {
                matchesStatus = status === statusLimit;
            }

            if (matchesSearch && matchesStatus) {
                card.style.display = "flex";
                visibleCount++;
            } else {
                card.style.display = "none";
            }
        });

        if (visibleCountDisp) visibleCountDisp.innerText = visibleCount;
        if (totalCountDisp) totalCountDisp.innerText = cards.length;

        if (visibleCount === 0 && cards.length > 0) {
            let noResultsMsg = modGrid.querySelector('.no-results-message');
            if (!noResultsMsg) {
                noResultsMsg = document.createElement('div');
                noResultsMsg.className = 'placeholder-box no-results-message';
                modGrid.appendChild(noResultsMsg);
            }
            noResultsMsg.style.display = 'block';
            noResultsMsg.innerText = t("No mods match your current filters.");
        } else {
            const noResultsMsg = modGrid.querySelector('.no-results-message');
            if (noResultsMsg) noResultsMsg.style.display = 'none';
        }
    }

    if (searchInput) searchInput.addEventListener('input', applyFilters);
    if (filterStatus) filterStatus.addEventListener('change', applyFilters);

    async function scanForGames() {
        if (!modSelect) return;
        modSelect.innerHTML = `<option value="">${t("Searching for Game Installs...")}</option>`;
        const response = await eel.get_detected_game_paths()();
        const settings = await eel.get_settings()();
        modSelect.innerHTML = ""; 
        
        if (response.success && response.paths.length > 0) {
            response.paths.forEach(game => {
                let option = document.createElement('option');
                option.value = game.path; 
                option.textContent = `${game.name} - ${game.path}`;
                modSelect.appendChild(option);
            });
            if (settings.last_game_path && response.paths.some(p => p.path === settings.last_game_path)) {
                modSelect.value = settings.last_game_path;
            }
            if (modSelect.value) loadMods(modSelect.value);
        } else {
            modSelect.innerHTML = `<option value="">${t("No installations found.")}</option>`;
        }
    }
    
    scanForGames();
    
    if (refreshBtn) refreshBtn.addEventListener('click', scanForGames);

    if (modSelect) {
        modSelect.addEventListener('change', async () => {
            const settings = await eel.get_settings()();
            settings.last_game_path = modSelect.value;
            await eel.save_settings(settings)();
            if (modSelect.value) loadMods(modSelect.value);
        });
    }

    async function loadMods(gamePath) {
        if (!modGrid) return;
        modGrid.innerHTML = `<div class="placeholder-box"><span data-i18n>Scanning Mod Directory...</span></div>`;
        modGrid.className = "placeholder-box"; 
        
        const settings = await eel.get_settings()();
        let statusText = t("Scanning Mod Directory...");
        if (settings.auto_fix_names || settings.auto_fix_configs) {
            let fixing = [];
            if (settings.auto_fix_names) fixing.push(t("Names"));
            if (settings.auto_fix_configs) fixing.push(t("Configs"));
            statusText = t("Auto-fixing Mod {fixing}...").replace("{fixing}", fixing.join(" & "));
        }
        modGrid.innerHTML = `<div class="placeholder-box"><i class="fa-solid fa-spinner fa-spin"></i> ${statusText}</div>`;
        
        const response = await eel.get_installed_mods(gamePath, settings.auto_fix_names === true, settings.auto_fix_configs === true)();
        
        if (response.success) {
            let modsData = [];
            try {
                const fetchRes = await fetch(response.cached_file + '?t=' + new Date().getTime());
                const data = await fetchRes.json();
                modsData = data.mods;
            } catch (err) {
                console.error("Failed to load mod cache:", err);
                modGrid.innerHTML = `<div class="placeholder-box" style="color: #ff5555;">${t("Error reading mod data from cache.")}</div>`;
                return;
            }

            if (modsData.length === 0) {
                modGrid.innerHTML = `<div class="placeholder-box">${t("No mods found in the selected directory.")}</div>`;
                return;
            }

            modGrid.className = "mod-grid";
            if (totalCountDisp) totalCountDisp.innerText = modsData.length;
            let html = "";
            
            modsData.forEach(mod => {
                const isEnabled = mod.status === 'enabled';
                const statusColor = isEnabled ? '#28a745' : '#666';
                const btnText = isEnabled ? t('Disable') : t('Enable');
                const btnClass = isEnabled ? 'active' : '';
                const cardOpacity = isEnabled ? '1' : '0.6';
                
                const hasActiveConflict = isEnabled && mod.conflicts_with.some(c => c.enabled);

                const imageHTML = mod.image 
                    ? `<img src="data:image/png;base64,${mod.image}" alt="Preview" class="mod-preview-img" loading="lazy" style="max-height: 200px; object-fit: cover; width: 100%;">`
                    : `<div class="mod-preview-img placeholder-img" style="height: 200px; display: flex; align-items: center; justify-content: center;">${t("No Preview")}</div>`;
                
                let conflictBadge = '';
                if (mod.has_conflicts) {
                    const badgeClass = hasActiveConflict ? 'conflict-active' : 'conflict-inactive';
                    const conflictNames = mod.conflicts_with.map(c => `${c.name} (${c.enabled ? t('ENABLED') : t('Disabled')})`).join('&#10;• ');
                    
                    const conflictTitle = hasActiveConflict ? t('CRITICAL CONFLICT') : t('POTENTIAL CONFLICT');
                    const titleText = `${conflictTitle}&#10;• ${conflictNames}`;
                    
                    conflictBadge = `<span class="mod-conflict-inline ${badgeClass}" title="${titleText}"><i class="fa-solid fa-triangle-exclamation"></i></span>`;
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
                            <span class="mod-badge" style="background: ${statusColor}">${t(mod.status.toUpperCase())}</span>
                        </div>
                        <div class="mod-card-content">
                            <h3 class="mod-title" title="${mod.name}">${mod.name}</h3>
                            <span class="mod-meta">${mod.author}</span>
                            <div class="mod-card-footer">
                                ${conflictBadge}
                                <button class="update-mod-btn hidden" data-path="${mod.path}" title="${t("Update Available")}"><i class="fa-solid fa-download"></i></button>
                                <button class="toggle-mod-btn ${btnClass}" data-path="${mod.path}">${btnText}</button>
                            </div>
                        </div>
                    </div>
                `;
            });
            
            modGrid.innerHTML = html;
            applyFilters();
            await getModUrls(gamePath);
            await checkForUpdates(gamePath);
        } else {
            modGrid.innerHTML = `<div class="placeholder-box" style="color: #ff5555;">${t("Error loading mods: {error}").replace("{error}", response.error)}</div>`;
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
                        titleEl.title = t("{title} (Click to view on Trovesaurus)").replace("{title}", titleEl.innerText);
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
            
            document.querySelectorAll('.update-mod-btn').forEach(btn => {
                const path = btn.getAttribute('data-path');
                if (updates[path]) {
                    btn.classList.remove('hidden');
                }
            });
        }
    }

    if (modGrid) {
        modGrid.addEventListener('click', async (e) => {
            const toggleBtn = e.target.closest('.toggle-mod-btn');
            if (toggleBtn) {
                const currentPath = toggleBtn.getAttribute('data-path');
                const gamePath = modSelect.value;
                toggleBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Working...")}`;
                toggleBtn.disabled = true;

                const response = await eel.toggle_mod(gamePath, currentPath)();
                if (response.success) loadMods(gamePath);
                else {
                    window.showToast(t("Failed to toggle mod: {error}").replace("{error}", response.error), true);
                    loadMods(gamePath);
                }
                return;
            }

            const updateBtn = e.target.closest('.update-mod-btn');
            if (updateBtn) {
                const currentPath = updateBtn.getAttribute('data-path');
                const gamePath = modSelect.value;
                
                updateBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                updateBtn.disabled = true;
                updateBtn.style.animation = "pulse 1s infinite";

                const response = await eel.perform_mod_update(gamePath, currentPath)();
                
                if (response.success) {
                    loadMods(gamePath);
                } else {
                    window.showToast(t("Failed to update mod: {error}").replace("{error}", response.error), true);
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

    if (imageModal) {
        imageModal.addEventListener('click', (e) => {
            if (e.target === imageModal || e.target.classList.contains('close-modal')) {
                imageModal.classList.remove('active');
                setTimeout(() => { modalImg.src = ""; }, 200);
            }
        });
    }

    const runUtility = async (btn, eelFunc, successMsg) => {
        const gamePath = modSelect.value;
        if (!gamePath) return window.showToast(t("Select a game first."), true);
        
        const originalText = btn.innerHTML;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Processing...")}`;
        btn.disabled = true;

        const response = await eelFunc(gamePath)();
        if (response.success) {
            window.showToast(successMsg(response));
            loadMods(gamePath);
        } else window.showToast(t("Error: {error}").replace("{error}", response.error), true);

        btn.innerHTML = originalText;
        btn.disabled = false;
    };

    if (fixNamesBtn) fixNamesBtn.addEventListener('click', () => runUtility(fixNamesBtn, eel.fix_mod_names, r => t("Fixed {count} mod names!").replace("{count}", r.fixed_count)));
    if (fixConfigsBtn) fixConfigsBtn.addEventListener('click', () => runUtility(fixConfigsBtn, eel.fix_mod_configs, r => t("Verified configs for {count} mods!").replace("{count}", r.configs_ensured)));
});