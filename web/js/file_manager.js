document.addEventListener('file_manager_loaded', () => {
    console.log("High-Performance File Manager initialized!");

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

    let fileCache = [];
    let fileIdCounter = 0;
    let searchTimeout = null;

    async function scanForGames() {
        installSelect.innerHTML = `<option value="">Searching...</option>`;
        const response = await eel.get_detected_game_paths()();
        installSelect.innerHTML = ""; 
        if (response.success && response.paths.length > 0) {
            response.paths.forEach(game => {
                let option = document.createElement('option');
                option.value = game.path; 
                option.textContent = `${game.name} - ${game.path}`;
                installSelect.appendChild(option);
            });
        } else {
            installSelect.innerHTML = `<option value="">No installations found.</option>`;
        }
    }
    scanForGames();
    if (refreshBtn) refreshBtn.addEventListener('click', scanForGames);

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
            if (!selectedPath) return alert("Select a game first.");

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

    eel.expose(update_progress_ui);
    function update_progress_ui(current, total, filename, etaStr) {
        document.getElementById('progress-fill').style.width = Math.round((current / total) * 100) + '%';
        document.getElementById('progress-text').innerText = `${Math.round((current / total) * 100)}% | ETA: ${etaStr} | ${filename}`;
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

    const collapseBtn = document.getElementById('btn-collapse-all');

    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            const openFolders = treeContainer.querySelectorAll('details.folder[open]');
            
            openFolders.forEach(folder => {
                folder.open = false;
            });
            
            treeContainer.classList.remove('searching');
            searchInput.value = "";
            searchCount.innerText = "";
            
            console.log(`Collapsed ${openFolders.length} folders.`);
        });
    }
});