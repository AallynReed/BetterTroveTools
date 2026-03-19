document.addEventListener('modder_tools_loaded', () => {
    console.log("Modder Tools view initialized!");

    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    // Tab Switching Logic
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            // 1. Remove active state from all tabs and contents
            tabButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            // 2. Add active state to clicked tab
            btn.classList.add('active');
            
            // 3. Show the corresponding content panel
            const targetId = btn.getAttribute('data-tab');
            const targetContent = document.getElementById(targetId);
            if (targetContent) {
                targetContent.classList.add('active');
            }
        });
    });

    // --- Image Preview Logic ---
    const previewContainer = document.getElementById('preview-picker-container');
    const previewInput = document.getElementById('build-preview-input');
    const previewImg = document.getElementById('build-mod-preview');

    if (previewContainer && previewInput) {
        previewContainer.addEventListener('click', () => {
            previewInput.click();
        });

        previewInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => previewImg.src = event.target.result;
                reader.readAsDataURL(file);
            }
        });
    }

    // --- Init Select2 ---
    if (typeof jQuery !== 'undefined' && $.fn.select2) {
        $('#build-mod-tags').select2({
            placeholder: "Select categories...",
            width: '100%'
        });
    }

    // --- Game Select Logic ---
    async function scanForGames() {
        const gameSelect = document.getElementById('build-game-select');
        if (!gameSelect) return;
        gameSelect.innerHTML = `<option value="">Searching...</option>`;
        const response = await eel.get_detected_game_paths()();
        const settings = await eel.get_settings()();
        gameSelect.innerHTML = ""; 
        if (response.success && response.paths.length > 0) {
            response.paths.forEach(game => {
                let option = document.createElement('option');
                option.value = game.path; 
                option.textContent = `${game.name} - ${game.path}`;
                gameSelect.appendChild(option);
            });
            if (settings.last_game_path && response.paths.some(p => p.path === settings.last_game_path)) {
                gameSelect.value = settings.last_game_path;
            }
        } else {
            gameSelect.innerHTML = `<option value="">No installations found.</option>`;
        }
    }
    scanForGames();

    const buildGameSelect = document.getElementById('build-game-select');
    if (buildGameSelect) {
        buildGameSelect.addEventListener('change', async () => {
            const settings = await eel.get_settings()();
            settings.last_game_path = buildGameSelect.value;
            await eel.save_settings(settings)();
        });
    }

    // --- Files Table Logic ---
    const btnAddFile = document.getElementById('btn-add-file');
    const btnDetectOverrides = document.getElementById('btn-detect-overrides');
    const filesList = document.getElementById('build-files-list');

    // Create a hidden file input for selecting files
    const hiddenFileInput = document.createElement('input');
    hiddenFileInput.type = 'file';
    hiddenFileInput.multiple = true;
    hiddenFileInput.style.display = 'none';
    document.body.appendChild(hiddenFileInput);

    if (btnAddFile) {
        btnAddFile.addEventListener('click', () => {
            hiddenFileInput.click();
        });

        hiddenFileInput.addEventListener('change', (e) => {
            Array.from(e.target.files).forEach(file => {
                const filePath = file.path || file.name;
                
                let internalPath = file.name; // Direct file adds use the file name as the internal path
                const existing = Array.from(filesList.querySelectorAll('tr')).find(tr => tr.fileData && tr.fileData.path === filePath);
                if (existing) return;

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td title="Source: ${filePath}" style="color: var(--text-main); font-size: 13px; word-break: break-all;">
                        <div>${internalPath}</div>
                        <div style="color: var(--text-muted); font-size: 11px;">${filePath}</div>
                    </td>
                    <td style="text-align: right;"><button class="icon-btn-small danger remove-file" title="Remove File"><i class="fa-solid fa-trash"></i></button></td>
                `;
                tr.fileData = { name: internalPath, path: filePath, fileObj: file };
                filesList.appendChild(tr);
                tr.querySelector('.remove-file').addEventListener('click', () => tr.remove());
            });
            hiddenFileInput.value = '';
        });
    }

    if (btnDetectOverrides) {
        btnDetectOverrides.addEventListener('click', async () => {
            const gamePath = document.getElementById('build-game-select').value;
            if (!gamePath) {
                showToast("Please select a Target Game Installation first.", true);
                return;
            }
            
            const originalHtml = btnDetectOverrides.innerHTML;
            btnDetectOverrides.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Detecting...';
            btnDetectOverrides.disabled = true;
            
            // --- Check and remove any existing files that were deleted from disk ---
            const currentRows = Array.from(filesList.querySelectorAll('tr'));
            const pathsToCheck = [];
            currentRows.forEach(tr => {
                if (tr.fileData && tr.fileData.path) {
                    // Only verify absolute paths to avoid accidentally deleting valid in-memory File objects
                    if (tr.fileData.path.includes(':') || tr.fileData.path.startsWith('/')) {
                        pathsToCheck.push(tr.fileData.path);
                    }
                }
            });

            if (pathsToCheck.length > 0) {
                const missingResult = await eel.get_missing_files(pathsToCheck)();
                if (missingResult.success && missingResult.missing) {
                    currentRows.forEach(tr => {
                        if (tr.fileData && tr.fileData.path && missingResult.missing.includes(tr.fileData.path)) {
                            tr.remove();
                        }
                    });
                }
            }
            
            const result = await eel.detect_override_files(gamePath)();
            if (result.success) {
                let addedCount = 0;
                result.files.forEach(f => {
                    const existing = Array.from(filesList.querySelectorAll('tr')).find(tr => tr.fileData && tr.fileData.path === f.path);
                    if (existing) return;
                    
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td title="Source: ${f.path}" style="color: var(--text-main); font-size: 13px; word-break: break-all;">
                            <div>${f.internal_path}</div>
                            <div style="color: var(--text-muted); font-size: 11px;">${f.path}</div>
                        </td>
                        <td style="text-align: right;"><button class="icon-btn-small danger remove-file" title="Remove File"><i class="fa-solid fa-trash"></i></button></td>
                    `;
                    tr.fileData = { name: f.internal_path, path: f.path };
                    filesList.appendChild(tr);
                    tr.querySelector('.remove-file').addEventListener('click', () => tr.remove());
                    addedCount++;
                });
                if (addedCount === 0) {
                    showToast("No new override files found in the source directory.", true);
                }
            } else {
                showToast("Error detecting overrides: " + result.error, true);
            }
            
            btnDetectOverrides.innerHTML = originalHtml;
            btnDetectOverrides.disabled = false;
        });
    }

    // --- Build TMod Execution Logic ---
    const btnBuildTMod = document.getElementById('btn-build-tmod');
    if (btnBuildTMod) {
        btnBuildTMod.addEventListener('click', async () => {
            btnBuildTMod.disabled = true;
            const originalText = btnBuildTMod.innerHTML;
            btnBuildTMod.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Compiling TMod...';
            
            try {
                const gamePath = document.getElementById('build-game-select').value;
                const title = document.getElementById('build-mod-title').value.trim();
                const author = document.getElementById('build-mod-author').value.trim();
                const version = document.getElementById('build-mod-version').value.trim();
                const notes = document.getElementById('build-mod-notes').value.trim();
                const tags = $('#build-mod-tags').val() || [];

                if (!gamePath) { showToast("Please select a target game installation.", true); return; }
                if (!title) { showToast("Please enter a mod title.", true); return; }
                if (!author) { showToast("Please enter a mod author.", true); return; }
                if (!version) { showToast("Please enter a mod version.", true); return; }
                if (!notes) { showToast("Please enter mod notes or a description.", true); return; }
                if (tags.length === 0) { showToast("Please select at least one tag.", true); return; }
                if (document.querySelectorAll('#build-files-list tr').length === 0) { showToast("Please add at least one file to your mod!", true); return; }

                const previewImg = document.getElementById('build-mod-preview');
                let previewBase64 = null;
                if (previewImg.src.startsWith('data:image')) {
                    previewBase64 = previewImg.src;
                }

                // --- Check for missing files before building ---
                const currentRows = Array.from(document.querySelectorAll('#build-files-list tr'));
                const pathsToCheck = [];
                currentRows.forEach(tr => {
                    if (tr.fileData && tr.fileData.path) {
                        if (tr.fileData.path.includes(':') || tr.fileData.path.startsWith('/')) {
                            pathsToCheck.push(tr.fileData.path);
                        }
                    }
                });

                if (pathsToCheck.length > 0) {
                    const missingResult = await eel.get_missing_files(pathsToCheck)();
                    if (missingResult.success && missingResult.missing && missingResult.missing.length > 0) {
                        currentRows.forEach(tr => {
                            if (tr.fileData && tr.fileData.path && missingResult.missing.includes(tr.fileData.path)) {
                                tr.remove();
                            }
                        });
                        showToast(`Warning: ${missingResult.missing.length} file(s) were missing from disk and have been removed from the list.\n\nPlease review your files and click Build TMod again.`, true);
                        btnBuildTMod.disabled = false;
                        btnBuildTMod.innerHTML = originalText;
                        return;
                    }
                }

                const filesData = [];
                const rows = document.querySelectorAll('#build-files-list tr');
                
                for (let row of rows) {
                    const fileData = row.fileData;
                    if (fileData) {
                        if (!fileData.fileObj && fileData.path) {
                            filesData.push({ internal_path: fileData.name, abs_path: fileData.path });
                        } else if (fileData.fileObj) {
                            if (fileData.fileObj.path) {
                                filesData.push({ internal_path: fileData.name, abs_path: fileData.fileObj.path });
                            } else {
                                const base64 = await new Promise((resolve) => {
                                    const reader = new FileReader();
                                    reader.onload = (e) => resolve(e.target.result);
                                    reader.readAsDataURL(fileData.fileObj);
                                });
                                filesData.push({ internal_path: fileData.name, data: base64 });
                            }
                        }
                    }
                }

                if (filesData.length === 0) { showToast("Please add at least one file to your mod!", true); return; }

                const payload = { gamePath, title, author, version, notes, tags, previewBase64, files: filesData };
                const result = await eel.build_tmod(payload)();

                if (result.success) {
                    showToast("TMod successfully built!\nSaved to: " + result.path, false);
                } else {
                    showToast("Failed to build TMod:\n" + result.error, true);
                }
            } catch (err) {
                console.error(err);
                showToast("An unexpected error occurred while building the TMod.", true);
            } finally {
                btnBuildTMod.disabled = false;
                btnBuildTMod.innerHTML = originalText;
            }
        });
    }

    // --- Extract TMod Logic ---
    const btnBrowseExtractSource = document.getElementById('btn-browse-extract-source');
    const inputExtractSource = document.getElementById('extract-source-file');
    
    if (btnBrowseExtractSource) {
        btnBrowseExtractSource.addEventListener('click', async () => {
            const file = await eel.ask_tmod_file()();
            if (file) inputExtractSource.value = file;
        });
    }

    const btnBrowseExtractDest = document.getElementById('btn-browse-extract-dest');
    const inputExtractDest = document.getElementById('extract-dest-dir');
    
    if (btnBrowseExtractDest) {
        btnBrowseExtractDest.addEventListener('click', async () => {
            const dir = await eel.ask_extract_destination()();
            if (dir) inputExtractDest.value = dir;
        });
    }

    const btnExtractTmod = document.getElementById('btn-extract-tmod');
    if (btnExtractTmod) {
        btnExtractTmod.addEventListener('click', async () => {
            const sourceFile = inputExtractSource.value;
            const destDir = inputExtractDest.value;
            
            if (!sourceFile) { showToast("Please select a Source TMod File.", true); return; }
            if (!destDir) { showToast("Please select a Destination Folder.", true); return; }
            
            btnExtractTmod.disabled = true;
            const originalText = btnExtractTmod.innerHTML;
            btnExtractTmod.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Extracting...';
            
            try {
                const result = await eel.extract_tmod(sourceFile, destDir)();
                if (result.success) {
                    showToast(`Successfully extracted ${result.count} files to:\n${destDir}`);
                } else {
                    showToast("Failed to extract TMod:\n" + result.error, true);
                }
            } catch (err) {
                console.error(err);
                showToast("An unexpected error occurred during extraction.", true);
            } finally {
                btnExtractTmod.disabled = false;
                btnExtractTmod.innerHTML = originalText;
            }
        });
    }
});