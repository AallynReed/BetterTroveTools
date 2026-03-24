document.addEventListener('file_manager_loaded', () => {
    console.log("High-Performance File Manager initialized!");

    const tabButtons = document.querySelectorAll('.file-manager-container .tab-btn');
    const tabContents = document.querySelectorAll('.file-manager-container .tab-content');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            document.getElementById(btn.getAttribute('data-tab')).classList.add('active');
        });
    });

    const installSelect = document.getElementById('game-install-select');
    const loadBtn = document.getElementById('btn-load-tree');
    const refreshBtn = document.getElementById('btn-refresh-installs');
    const treeContainer = document.getElementById('file-tree-container');
    const searchInput = document.getElementById('tree-search');
    const clearSearchBtn = document.getElementById('clear-search');
    const searchCount = document.getElementById('search-count');
    const extractionBar = document.getElementById('extraction-bar');
    const extractionSummary = document.getElementById('extraction-summary');
    const massExtractBtn = document.getElementById('btn-mass-extract');
    const collapseBtn = document.getElementById('btn-collapse-all');
    const selectVisibleBtn = document.getElementById('btn-select-visible');
    
    const trackerGameSelect = document.getElementById('tracker-game-select');
    const trackerStatusText = document.getElementById('tracker-status-text');
    const trackerSubText = document.getElementById('tracker-sub-text');
    const trackerActions = document.getElementById('tracker-actions');
    const btnBuildBaseline = document.getElementById('btn-build-baseline');
    const btnScanUpdates = document.getElementById('btn-scan-updates');

    const trackerDirSelect = document.getElementById('tracker-dir-select');
    const btnAddTrackerDir = document.getElementById('btn-add-tracker-dir');
    const trackerModal = document.getElementById('tracker-modal');
    const closeTrackerModal = document.getElementById('close-tracker-modal');
    const btnBrowseNewTracker = document.getElementById('btn-browse-new-tracker');
    const newTrackerName = document.getElementById('new-tracker-name');
    const newTrackerPath = document.getElementById('new-tracker-path');
    const btnSaveTrackerDir = document.getElementById('btn-save-tracker-dir');

    let fileCache = [];
    let fileIdCounter = 0;
    let searchTimeout = null;
    let currentTrackingDir = null;

    async function scanForGames() {
        installSelect.innerHTML = `<option value="">Searching...</option>`;
        trackerGameSelect.innerHTML = `<option value="">Searching...</option>`;
        
        const response = await eel.get_detected_game_paths()();
        const settings = await eel.get_settings()();
        
        installSelect.innerHTML = ""; 
        trackerGameSelect.innerHTML = "";
        
        if (response.success && response.paths.length > 0) {
            response.paths.forEach(game => {
                let option = document.createElement('option');
                option.value = game.path; 
                option.textContent = `${game.name} - ${game.path}`;
                
                installSelect.appendChild(option.cloneNode(true));
                trackerGameSelect.appendChild(option.cloneNode(true));
            });
            if (settings.last_game_path && response.paths.some(p => p.path === settings.last_game_path)) {
                installSelect.value = settings.last_game_path;
                trackerGameSelect.value = settings.last_game_path;
            }
        } else {
            installSelect.innerHTML = `<option value="">No installations found.</option>`;
            trackerGameSelect.innerHTML = `<option value="">No installations found.</option>`;
        }
    }
    
    scanForGames();
    if (refreshBtn) refreshBtn.addEventListener('click', scanForGames);

    if (installSelect) {
        installSelect.addEventListener('change', async () => {
            const settings = await eel.get_settings()();
            settings.last_game_path = installSelect.value;
            trackerGameSelect.value = installSelect.value;
            await eel.save_settings(settings)();
        });
    }

    if (trackerGameSelect) {
        trackerGameSelect.addEventListener('change', async () => {
            const settings = await eel.get_settings()();
            settings.last_game_path = trackerGameSelect.value;
            installSelect.value = trackerGameSelect.value;
            await eel.save_settings(settings)();
        });
    }

    function timeSince(dateString) {
        if (!dateString) return "";
        const date = new Date(dateString);
        const seconds = Math.floor((new Date() - date) / 1000);
        let interval = seconds / 31536000;
        if (interval > 1) return Math.floor(interval) + " years ago";
        interval = seconds / 2592000;
        if (interval > 1) return Math.floor(interval) + " months ago";
        interval = seconds / 86400;
        if (interval > 1) return Math.floor(interval) + " days ago";
        interval = seconds / 3600;
        if (interval > 1) return Math.floor(interval) + " hours ago";
        interval = seconds / 60;
        if (interval > 1) return Math.floor(interval) + " minutes ago";
        return "Just now";
    }

    async function loadTrackingDirectories() {
        const res = await eel.get_tracking_directories()();
        if (res.success) {
            trackerDirSelect.innerHTML = "";
            if (res.directories.length === 0) {
                trackerDirSelect.innerHTML = `<option value="">No paths saved. Add one...</option>`;
                currentTrackingDir = null;
            } else {
                res.directories.sort((a, b) => {
                    const timeA = a.last_used ? new Date(a.last_used).getTime() : 0;
                    const timeB = b.last_used ? new Date(b.last_used).getTime() : 0;
                    return timeB - timeA; 
                });

                res.directories.forEach(d => {
                    const opt = document.createElement('option');
                    opt.value = d.path;
                    
                    let text = `${d.name} (${d.path})`;
                    if (d.last_used) {
                        text += ` - Last used: ${timeSince(d.last_used)}`;
                    }
                    
                    opt.textContent = text;
                    trackerDirSelect.appendChild(opt);
                });
                
                if (res.last_used && res.directories.some(d => d.path === res.last_used)) {
                    trackerDirSelect.value = res.last_used;
                    currentTrackingDir = res.last_used;
                } else {
                    trackerDirSelect.value = res.directories[0].path;
                    currentTrackingDir = res.directories[0].path;
                    eel.set_last_tracking_directory(currentTrackingDir)();
                }
            }
            checkTrackerStatus();
        }
    }

    loadTrackingDirectories();

    trackerDirSelect.addEventListener('change', () => {
        if (trackerDirSelect.value) {
            currentTrackingDir = trackerDirSelect.value;
            eel.set_last_tracking_directory(currentTrackingDir)();
            checkTrackerStatus();
        } else {
            currentTrackingDir = null;
            checkTrackerStatus();
        }
    });

    btnAddTrackerDir.addEventListener('click', () => {
        trackerModal.classList.add('active');
        newTrackerName.value = '';
        newTrackerPath.value = '';
    });

    closeTrackerModal.addEventListener('click', () => {
        trackerModal.classList.remove('active');
    });

    btnBrowseNewTracker.addEventListener('click', async () => {
        const response = await eel.select_tracking_directory()();
        if (response.success && response.path) {
            newTrackerPath.value = response.path;
            if (!newTrackerName.value) {
                newTrackerName.value = response.path.split('\\').pop().split('/').pop(); 
            }
        }
    });

    btnSaveTrackerDir.addEventListener('click', async () => {
        const name = newTrackerName.value.trim();
        const path = newTrackerPath.value.trim();
        
        if (!name || !path) {
            return window.showToast("Please provide both a name and a valid path.", true);
        }
        
        btnSaveTrackerDir.disabled = true;
        await eel.save_tracking_directory(name, path)();
        trackerModal.classList.remove('active');
        btnSaveTrackerDir.disabled = false;
        
        await loadTrackingDirectories();
        window.showToast("Tracking directory saved!");
    });

    function performSearch() {
        clearTimeout(searchTimeout);
        const term = searchInput.value.toLowerCase().trim();

        if (term.length < 4) {
            treeContainer.classList.remove('searching');
            treeContainer.querySelectorAll('.is-match, .has-match').forEach(n => {
                n.classList.remove('is-match', 'has-match');
            });
            searchCount.innerText = term.length > 0 ? "Minimum 4 characters required..." : "";
            return;
        }

        searchTimeout = setTimeout(() => {
            treeContainer.classList.add('searching');
            
            treeContainer.querySelectorAll('.is-match, .has-match').forEach(n => {
                n.classList.remove('is-match', 'has-match');
            });

            const matches = fileCache.filter(f => f.name.includes(term) || f.path.includes(term));
            
            matches.forEach(match => {
                const el = document.getElementById(match.id);
                if (el) {
                    el.classList.add('is-match');
                    let parent = el.closest('details.folder');
                    while (parent) {
                        if (parent.classList.contains('has-match')) break; 
                        parent.classList.add('has-match');
                        parent.open = true; 
                        parent = parent.parentElement.closest('details.folder');
                    }
                }
            });

            searchCount.innerText = `Found ${matches.length} matches`;
        }, 300);
    }

    searchInput.addEventListener('input', performSearch);
    clearSearchBtn.addEventListener('click', () => {
        searchInput.value = "";
        performSearch();
    });

    if (loadBtn) {
        loadBtn.addEventListener('click', async () => {
            const selectedPath = installSelect.value;
            if (!selectedPath) return window.showToast("Select a game first.", true);

            treeContainer.innerHTML = `<div style="text-align: center; padding: 40px;"><h3><i class="fa-solid fa-spinner fa-spin"></i> Parsing ${selectedPath}...</h3></div>`;
            
            fileCache = [];
            fileIdCounter = 0;

            const response = await eel.load_entire_game_tree(selectedPath)();
            if (response.success) {
                let treeHTML = `<div class="file-tree">`;
                const rootChildren = response.tree.children;
                const sortedKeys = Object.keys(rootChildren).sort((a, b) => {
                    const nodeA = rootChildren[a], nodeB = rootChildren[b];
                    if (nodeA.type === 'folder' && nodeB.type === 'file') return -1;
                    return a.localeCompare(b);
                });

                sortedKeys.forEach(key => { treeHTML += buildTreeHTML(key, rootChildren[key]); });
                treeHTML += `</div>`;
                treeContainer.innerHTML = treeHTML;
                treeContainer.classList.remove('placeholder-box');
            }
        });
    }

    function buildTreeHTML(name, node, currentPath = "") {
        let fullPath = currentPath ? currentPath + "/" + name : name;
        
        if (node.type === 'folder') {
            let html = `<details class="folder"><summary><div class="checkbox-container"><input type="checkbox" class="folder-check"><span><i class="fa-solid fa-folder" style="color: #e8b031; margin-right: 4px;"></i> ${name}</span></div></summary><div class="folder-content">`;
            const sortedKeys = Object.keys(node.children).sort((a, b) => {
                const childA = node.children[a], childB = node.children[b];
                if (childA.type === 'folder' && childB.type === 'file') return -1;
                return a.localeCompare(b);
            });
            sortedKeys.forEach(childName => { html += buildTreeHTML(childName, node.children[childName], fullPath); });
            return html + `</div></details>`;
        } else {
            const id = `f-${fileIdCounter++}`;
            const fileNameLower = name.toLowerCase();
            const filePathLower = fullPath.toLowerCase();

            fileCache.push({ id: id, name: fileNameLower, path: filePathLower });

            const sizeStr = node.size > 1048576 ? (node.size / 1048576).toFixed(2) + ' MB' : (node.size / 1024).toFixed(2) + ' KB';
            
            return `<div class="file-item" id="${id}">
            <div class="checkbox-container">
                <input type="checkbox" class="file-check" data-archive="${node.archive_index}" data-offset="${node.offset}" data-tfi="${node.tfi_parent}" data-size="${node.size}" data-filepath="${fullPath}">
                <div class="file-label">
                    <span class="file-name"><i class="fa-regular fa-file"></i> ${name}</span>
                </div>
            </div>
            <div class="file-actions">
                <span class="file-meta">archive${node.archive_index}.tfa | ${sizeStr}</span>
            </div>
        </div>`;
        }
    }

    treeContainer.addEventListener('change', (e) => {
        if (e.target.classList.contains('folder-check')) {
            const isChecked = e.target.checked;
            const content = e.target.closest('details').querySelector('.folder-content');
            content.querySelectorAll('input[type="checkbox"]').forEach(box => box.checked = isChecked);
        }

        let totalFiles = 0, totalBytes = 0;
        document.querySelectorAll('.file-check:checked').forEach(box => {
            totalFiles++;
            totalBytes += parseInt(box.getAttribute('data-size'));
        });

        if (totalFiles > 0) {
            extractionSummary.innerText = `${totalFiles} files selected (${(totalBytes / 1048576).toFixed(2)} MB)`;
            extractionBar.classList.add('active');
        } else {
            extractionBar.classList.remove('active');
        }
    });

    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            const openFolders = treeContainer.querySelectorAll('details.folder[open]');
            openFolders.forEach(folder => { folder.open = false; });
            treeContainer.classList.remove('searching');
            searchInput.value = "";
            searchCount.innerText = "";
        });
    }

    if (selectVisibleBtn) {
        selectVisibleBtn.addEventListener('click', () => {
            const isSearching = treeContainer.classList.contains('searching');
            const fileCheckboxes = isSearching 
                ? treeContainer.querySelectorAll('.file-item.is-match .file-check')
                : treeContainer.querySelectorAll('.file-check');

            if (fileCheckboxes.length === 0) return;

            const shouldCheck = Array.from(fileCheckboxes).some(cb => !cb.checked);
            fileCheckboxes.forEach(cb => cb.checked = shouldCheck);

            treeContainer.dispatchEvent(new Event('change', { bubbles: true }));
        });
    }

    eel.expose(update_progress_ui);
    function update_progress_ui(current, total, filename, etaStr, elapsedStr = "") {
        const percent = Math.round((current / total) * 100);
        document.getElementById('progress-fill').style.width = percent + '%';
        
        let timeText = [];
        
        if (elapsedStr && elapsedStr !== "N/A") {
            timeText.push(`Elapsed: ${elapsedStr}`);
        }
        
        if (etaStr) {
            if (!etaStr.includes('Baseline') && !etaStr.includes('Scanning') && !etaStr.includes('Cataloging')) {
                timeText.push(`ETA: ${etaStr}`);
            } else {
                timeText.push(etaStr);
            }
        }
        
        const timeString = timeText.length > 0 ? timeText.join(' | ') : '';
        
        document.getElementById('progress-text').innerText = `${percent}% | ${timeString}`;
        
        const filenameEl = document.getElementById('progress-filename');
        if (filenameEl) {
            filenameEl.innerText = filename || "";
        }
    }

    function showProgressUI() {
        extractionSummary.style.display = 'none';
        document.getElementById('extraction-progress').style.display = 'flex';
        extractionBar.classList.add('active');
        massExtractBtn.style.display = 'none';
    }

    function hideProgressUI() {
        extractionBar.classList.remove('active');
        setTimeout(() => {
            extractionSummary.style.display = 'block';
            document.getElementById('extraction-progress').style.display = 'none';
            massExtractBtn.style.display = 'block';
        }, 300);
    }

    if (massExtractBtn) {
        massExtractBtn.addEventListener('click', async () => {
            const destDir = await eel.ask_extraction_directory()();
            if (!destDir) return;

            const filesToExtract = Array.from(document.querySelectorAll('.file-check:checked')).map(box => ({
                tfi: box.getAttribute('data-tfi'),
                archive: parseInt(box.getAttribute('data-archive')),
                offset: parseInt(box.getAttribute('data-offset')),
                size: parseInt(box.getAttribute('data-size')),
                filepath: box.getAttribute('data-filepath')
            }));

            filesToExtract.sort((a, b) => a.tfi.localeCompare(b.tfi) || a.archive - b.archive);

            extractionSummary.style.display = 'none';
            document.getElementById('extraction-progress').style.display = 'flex';
            massExtractBtn.disabled = true;

            const response = await eel.mass_extract_files(destDir, filesToExtract)();

            if (response.success) {
                massExtractBtn.innerHTML = '<i class="fa-solid fa-check"></i> Complete!';
                setTimeout(() => {
                    document.querySelectorAll('input[type="checkbox"]').forEach(b => b.checked = false);
                    extractionBar.classList.remove('active');
                    massExtractBtn.disabled = false;
                    massExtractBtn.innerHTML = '<i class="fa-solid fa-file-export"></i> Extract Selected';
                    extractionSummary.style.display = 'block';
                    document.getElementById('extraction-progress').style.display = 'none';
                }, 2000);
            }
        });
    }

    async function checkTrackerStatus() {
        if (!currentTrackingDir) {
            trackerStatusText.innerText = "Select or add a tracking directory to continue.";
            trackerStatusText.style.color = "var(--text-main)";
            trackerSubText.innerText = "";
            trackerActions.style.display = "none";
            return;
        }
        
        trackerStatusText.innerText = "Checking directory...";
        trackerSubText.innerText = "";
        trackerActions.style.display = "none";
        
        const response = await eel.get_tracking_status(currentTrackingDir)();
        
        trackerActions.style.display = "flex";
        
        if (response.exists) {
            trackerStatusText.innerText = "Active Baseline Found!";
            trackerStatusText.style.color = "#28a745";
            trackerSubText.innerText = `Last Scanned: ${new Date(response.last_scan).toLocaleString()}\nTracking Game: ${response.game_path}`;
            
            btnBuildBaseline.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Force Rebuild Cache';
            btnBuildBaseline.style.backgroundColor = "transparent";
            btnBuildBaseline.style.border = "1px solid var(--border-color)";
            btnBuildBaseline.style.color = "var(--text-muted)";
            
            btnScanUpdates.style.display = "flex";
        } else {
            trackerStatusText.innerText = "No Baseline Found.";
            trackerStatusText.style.color = "#e8b031";
            trackerSubText.innerText = "You must build an initial cache hash before you can scan for updates. This will take a few minutes.";
            
            btnBuildBaseline.innerHTML = '<i class="fa-solid fa-database"></i> Build Baseline Cache';
            btnBuildBaseline.style.backgroundColor = "#e8b031";
            btnBuildBaseline.style.border = "none";
            btnBuildBaseline.style.color = "#111";
            
            btnScanUpdates.style.display = "none";
        }
    }

    btnBuildBaseline.addEventListener('click', async () => {
        const gamePath = trackerGameSelect.value;
        if (!gamePath || !currentTrackingDir) {
            return window.showToast("Ensure both a Game Installation and Tracking Directory are selected.", true);
        }

        btnBuildBaseline.disabled = true;
        btnScanUpdates.disabled = true;
        showProgressUI();
        
        const response = await eel.build_baseline_cache(gamePath, currentTrackingDir)();
        
        hideProgressUI();
        btnBuildBaseline.disabled = false;
        btnScanUpdates.disabled = false;
        
        if (response.success) {
            window.showToast("Baseline built successfully!");
            checkTrackerStatus();
        } else {
            window.showToast("Error building baseline: " + response.error, true);
        }
    });

    btnScanUpdates.addEventListener('click', async () => {
        const gamePath = trackerGameSelect.value;
        if (!gamePath || !currentTrackingDir) return;

        const runCatalog = document.getElementById('tracker-catalog-toggle').checked;

        btnBuildBaseline.disabled = true;
        btnScanUpdates.disabled = true;
        showProgressUI();
        
        const response = await eel.scan_and_extract_updates(gamePath, currentTrackingDir, runCatalog)();
        
        hideProgressUI();
        btnBuildBaseline.disabled = false;
        btnScanUpdates.disabled = false;
        
        if (response.success) {
            const d = response.details;
            if (d.added === 0 && d.changed === 0 && d.removed === 0) {
                window.showToast("Scan complete. No game updates detected since the last baseline.");
            } else {
                window.showToast(`Update detected and extracted!\n\nAdded: ${d.added}\nChanged: ${d.changed}\nRemoved: ${d.removed}\n\nSaved to: ${d.folder}`);
            }
            checkTrackerStatus();
        } else {
            window.showToast("Error scanning for updates: " + response.error, true);
        }
    });
});