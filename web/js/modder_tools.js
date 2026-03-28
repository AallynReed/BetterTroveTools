document.addEventListener('modder_tools_loaded', () => {
    console.log("Modder Tools view initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

    // --- TABS LOGIC ---
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            
            const targetId = btn.getAttribute('data-tab');
            const targetContent = document.getElementById(targetId);
            if (targetContent) {
                targetContent.classList.add('active');
            }
        });
    });

    // --- SELECT2 INITIALIZATION ---
    if (typeof jQuery !== 'undefined' && $.fn.select2) {
        $('#build-mod-tags').select2({
            placeholder: t("Select categories..."),
            width: '100%'
        });
        $('#project-mod-tags').select2({
            placeholder: t("Select categories..."),
            width: '100%'
        });
    }

    // --- GLOBAL GAME SCANNING ---
    const buildGameSelect = document.getElementById('build-game-select');
    const projectGameSelect = document.getElementById('project-game-select');

    async function scanForGames() {
        if (buildGameSelect) buildGameSelect.innerHTML = `<option value="">${t("Searching...")}</option>`;
        if (projectGameSelect) projectGameSelect.innerHTML = `<option value="">${t("Searching...")}</option>`;
        
        const response = await eel.get_detected_game_paths()();
        const settings = await eel.get_settings()();
        
        if (buildGameSelect) buildGameSelect.innerHTML = ""; 
        if (projectGameSelect) projectGameSelect.innerHTML = "";
        
        if (response.success && response.paths.length > 0) {
            response.paths.forEach(game => {
                let option = document.createElement('option');
                option.value = game.path; 
                option.textContent = `${game.name} - ${game.path}`;
                
                if (buildGameSelect) buildGameSelect.appendChild(option.cloneNode(true));
                if (projectGameSelect) projectGameSelect.appendChild(option.cloneNode(true));
            });
            
            if (settings.last_game_path && response.paths.some(p => p.path === settings.last_game_path)) {
                if (buildGameSelect) buildGameSelect.value = settings.last_game_path;
                if (projectGameSelect) projectGameSelect.value = settings.last_game_path;
            }
        } else {
            const noGamesStr = `<option value="">${t("No installations found.")}</option>`;
            if (buildGameSelect) buildGameSelect.innerHTML = noGamesStr;
            if (projectGameSelect) projectGameSelect.innerHTML = noGamesStr;
        }
    }
    scanForGames();

    if (buildGameSelect) {
        buildGameSelect.addEventListener('change', async () => {
            const settings = await eel.get_settings()();
            settings.last_game_path = buildGameSelect.value;
            if (projectGameSelect) projectGameSelect.value = buildGameSelect.value;
            await eel.save_settings(settings)();
        });
    }

    if (projectGameSelect) {
        projectGameSelect.addEventListener('change', async () => {
            const settings = await eel.get_settings()();
            settings.last_game_path = projectGameSelect.value;
            if (buildGameSelect) buildGameSelect.value = projectGameSelect.value;
            await eel.save_settings(settings)();
        });
    }

    // ==========================================
    // BUILD TMOD TAB
    // ==========================================
    const previewContainer = document.getElementById('preview-picker-container');
    const previewInput = document.getElementById('build-preview-input');
    const previewImg = document.getElementById('build-mod-preview');
    const btnRemoveBuildPreview = document.getElementById('btn-remove-build-preview');

    if (previewContainer && previewInput) {
        previewContainer.addEventListener('click', () => previewInput.click());
        previewInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    previewImg.src = event.target.result;
                    if (btnRemoveBuildPreview) btnRemoveBuildPreview.style.display = 'flex';
                };
                reader.readAsDataURL(file);
            }
        });
    }

    if (btnRemoveBuildPreview) {
        btnRemoveBuildPreview.addEventListener('click', (e) => {
            e.stopPropagation(); 
            previewImg.src = "assets/images/no_preview.png";
            previewInput.value = "";
            btnRemoveBuildPreview.style.display = 'none';
        });
    }

    const btnAddFile = document.getElementById('btn-add-file');
    const btnDetectOverrides = document.getElementById('btn-detect-overrides');
    const btnAutoStructure = document.getElementById('btn-auto-structure');
    const filesList = document.getElementById('build-files-list');

    if (btnAddFile) {
        btnAddFile.addEventListener('click', async () => {
            const gamePath = buildGameSelect ? buildGameSelect.value : "";
            if (!gamePath) {
                window.showToast(t("Please select a Target Game Installation first."), true);
                return;
            }
            
            try {
                const result = await eel.ask_add_files(gamePath)();
                if (result && result.success) {
                    if (result.rejected && result.rejected.length > 0) {
                        window.showToast(t("Denied {count} file(s):\nSelected files must be located within the active game path.").replace("{count}", result.rejected.length), true);
                    }

                    if (result.files && result.files.length > 0) {
                        result.files.forEach(f => {
                            const existing = Array.from(filesList.querySelectorAll('tr')).find(tr => tr.fileData && tr.fileData.path === f.path);
                            if (existing) return;

                            const tr = document.createElement('tr');
                            tr.innerHTML = `
                                <td title="Source: ${f.path}" style="color: var(--text-main); font-size: 13px; word-break: break-all;">
                                    <div>${f.internal_path}</div>
                                    <div style="color: var(--text-muted); font-size: 11px;">${f.path}</div>
                                </td>
                                <td style="text-align: right;"><button class="icon-btn-small danger remove-file" title="${t("Remove File")}"><i class="fa-solid fa-trash"></i></button></td>
                            `;
                            tr.fileData = { name: f.internal_path, path: f.path };
                            filesList.appendChild(tr);
                            tr.querySelector('.remove-file').addEventListener('click', () => tr.remove());
                        });
                    }
                }
            } catch (error) {
                console.error("Error adding files:", error);
                window.showToast(t("An error occurred while adding files."), true);
            }
        });
    }

    if (btnAutoStructure) {
        btnAutoStructure.addEventListener('click', async () => {
            const gamePath = buildGameSelect.value;
            if (!gamePath) {
                window.showToast(t("Please select a Target Game Installation first."), true);
                return;
            }
            
            const workspaceDir = await eel.ask_mod_source_directory()();
            if (!workspaceDir) return;
            
            const originalHtml = btnAutoStructure.innerHTML;
            btnAutoStructure.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Structuring...")}`;
            btnAutoStructure.disabled = true;
            
            try {
                const result = await eel.auto_structure_workspace(workspaceDir, gamePath)();
                if (result.success) {
                    window.showToast(t("Successfully auto-structured {count} files!").replace("{count}", result.count));
                } else {
                    window.showToast(t("Error structuring files: {error}").replace("{error}", result.error), true);
                }
            } catch (err) {
                console.error(err);
                window.showToast(t("An unexpected error occurred while structuring files."), true);
            } finally {
                btnAutoStructure.innerHTML = originalHtml;
                btnAutoStructure.disabled = false;
            }
        });
    }

    if (btnDetectOverrides) {
        btnDetectOverrides.addEventListener('click', async () => {
            const gamePath = buildGameSelect.value;
            if (!gamePath) {
                window.showToast(t("Please select a Target Game Installation first."), true);
                return;
            }
            
            const originalHtml = btnDetectOverrides.innerHTML;
            btnDetectOverrides.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Detecting...")}`;
            btnDetectOverrides.disabled = true;
            
            const currentRows = Array.from(filesList.querySelectorAll('tr'));
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
                if (missingResult.success && missingResult.missing) {
                    currentRows.forEach(tr => {
                        if (tr.fileData && tr.fileData.path && missingResult.missing.includes(tr.fileData.path)) {
                            tr.remove();
                        }
                    });
                }
            }
            
            const sourceDir = await eel.ask_mod_source_directory()();
            if (!sourceDir) {
                btnDetectOverrides.innerHTML = originalHtml;
                btnDetectOverrides.disabled = false;
                return;
            }

            const result = await eel.detect_override_files(sourceDir)();
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
                        <td style="text-align: right;"><button class="icon-btn-small danger remove-file" title="${t("Remove File")}"><i class="fa-solid fa-trash"></i></button></td>
                    `;
                    tr.fileData = { name: f.internal_path, path: f.path };
                    filesList.appendChild(tr);
                    tr.querySelector('.remove-file').addEventListener('click', () => tr.remove());
                    addedCount++;
                });
                if (addedCount === 0) {
                    window.showToast(t("No new override files found in the source directory."), true);
                } else {
                    window.showToast(t("{count} override file(s) successfully detected.").replace("{count}", addedCount));
                }
            } else {
                window.showToast(t("Error detecting overrides: {error}").replace("{error}", result.error), true);
            }
            
            btnDetectOverrides.innerHTML = originalHtml;
            btnDetectOverrides.disabled = false;
        });
    }

    const btnBuildTMod = document.getElementById('btn-build-tmod');
    if (btnBuildTMod) {
        btnBuildTMod.addEventListener('click', async () => {
            const titleInput = document.getElementById('build-mod-title');
            const title = titleInput.value.trim();
            const notes = document.getElementById('build-mod-notes').value.trim();
            
            const illegalChars = /[<>:"/\\|?*]/;
            if (illegalChars.test(title)) {
                window.showToast(t("Mod title contains illegal characters (< > : \" / \\ | ? *).\nPlease remove them to continue."), true);
                return;
            }

            if (notes.length > 220) {
                window.showToast(t("Mod notes cannot exceed 220 characters."), true);
                return;
            }

            btnBuildTMod.disabled = true;
            const originalText = btnBuildTMod.innerHTML;
            btnBuildTMod.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Compiling TMod...")}`;
            
            try {
                const gamePath = buildGameSelect.value;
                const author = document.getElementById('build-mod-author').value.trim();
                const version = document.getElementById('build-mod-version').value.trim();
                const tags = $('#build-mod-tags').val() || [];

                if (!gamePath) { window.showToast(t("Please select a target game installation."), true); return; }
                if (!title) { window.showToast(t("Please enter a mod title."), true); return; }
                if (!author) { window.showToast(t("Please enter a mod author."), true); return; }
                if (!version) { window.showToast(t("Please enter a mod version."), true); return; }
                if (!notes) { window.showToast(t("Please enter mod notes or a description."), true); return; }
                if (tags.length === 0) { window.showToast(t("Please select at least one tag."), true); return; }
                if (document.querySelectorAll('#build-files-list tr').length === 0) { window.showToast(t("Please add at least one file to your mod!"), true); return; }

                let previewBase64 = null;
                let previewName = "preview.png";
                if (previewImg.src.startsWith('data:image') && !previewImg.src.includes('no_preview.png')) {
                    previewBase64 = previewImg.src;
                    if (previewInput.files && previewInput.files.length > 0) {
                        previewName = previewInput.files[0].name;
                    }
                }

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
                        window.showToast(t("Warning: {count} file(s) were missing from disk and have been removed from the list.\n\nPlease review your files and click Build TMod again.").replace("{count}", missingResult.missing.length), true);
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

                if (filesData.length === 0) { window.showToast(t("Please add at least one file to your mod!"), true); return; }

                const payload = { gamePath, title, author, version, notes, tags, previewBase64, previewName, files: filesData };
                const result = await eel.build_tmod(payload)();

                if (result.success) {
                    window.showToast(t("TMod successfully built!\nSaved to: {path}").replace("{path}", result.path), false);
                } else {
                    window.showToast(t("Failed to build TMod:\n{error}").replace("{error}", result.error), true);
                }
            } catch (err) {
                console.error(err);
                window.showToast(t("An unexpected error occurred while building the TMod."), true);
            } finally {
                btnBuildTMod.disabled = false;
                btnBuildTMod.innerHTML = originalText;
            }
        });
    }

    // ==========================================
    // EXTRACT TMOD TAB
    // ==========================================
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
            
            if (!sourceFile) { window.showToast(t("Please select a Source TMod File."), true); return; }
            if (!destDir) { window.showToast(t("Please select a Destination Folder."), true); return; }
            
            btnExtractTmod.disabled = true;
            const originalText = btnExtractTmod.innerHTML;
            btnExtractTmod.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Extracting...")}`;
            
            try {
                const result = await eel.extract_tmod(sourceFile, destDir)();
                if (result.success) {
                    window.showToast(t("Successfully extracted {count} files to:\n{path}").replace("{count}", result.count).replace("{path}", destDir));
                } else {
                    window.showToast(t("Failed to extract TMod:\n{error}").replace("{error}", result.error), true);
                }
            } catch (err) {
                console.error(err);
                window.showToast(t("An unexpected error occurred during extraction."), true);
            } finally {
                btnExtractTmod.disabled = false;
                btnExtractTmod.innerHTML = originalText;
            }
        });
    }

    // ==========================================
    // SOFTWARE TAB
    // ==========================================
    async function loadModdingSoftware() {
        const container = document.getElementById('software-list-container');
        if (!container) return;

        try {
            const response = await fetch('assets/data/modding_software.json');
            const data = await response.json();

            const categoryIcons = {
                'blueprints': 'fa-cube',
                'vfx': 'fa-wand-magic-sparkles',
                'ui': 'fa-layer-group',
                'sound': 'fa-headphones',
                'textures': 'fa-palette'
            };

            container.innerHTML = '';
            container.style.display = 'block';

            for (const [categoryKey, categoryData] of Object.entries(data)) {
                const catHeader = document.createElement('h4');
                catHeader.style.marginTop = '20px';
                catHeader.style.marginBottom = '10px';
                catHeader.style.color = 'var(--text-main)';
                catHeader.style.textTransform = 'capitalize';
                catHeader.style.borderBottom = '1px solid var(--border-color)';
                catHeader.style.paddingBottom = '5px';
                catHeader.innerHTML = `<i class="fa-solid ${categoryIcons[categoryKey] || 'fa-laptop-code'}" style="color: var(--text-muted); margin-right: 5px;"></i> ${t(categoryKey)}`;
                container.appendChild(catHeader);

                const badgeWrapper = document.createElement('div');
                badgeWrapper.style.display = 'flex';
                badgeWrapper.style.flexWrap = 'wrap';
                badgeWrapper.style.gap = '10px';

                categoryData.software.forEach(sw => {
                    const badge = document.createElement('a');
                    badge.className = 'software-badge';
                    badge.href = sw.url;
                    badge.target = '_blank';
                    badge.title = t(sw.description);

                    let priceTagHtml = '';
                    if (sw.free) {
                        priceTagHtml = `<span class="sw-price-tag free">${t("Free")}</span>`;
                    } else {
                        priceTagHtml = `<span class="sw-price-tag paid">${t("Paid")}</span>`;
                    }

                    badge.innerHTML = `
                        <i class="fa-solid ${categoryIcons[categoryKey] || 'fa-laptop-code'}"></i>
                        <span class="software-name">${sw.name}</span>
                        ${priceTagHtml}
                    `;
                    badgeWrapper.appendChild(badge);
                });
                container.appendChild(badgeWrapper);
            }
        } catch (error) {
            console.error("Failed to load modding software data:", error);
            container.innerHTML = `<p class="help-text" style="color: #ff5555;">${t("Failed to load software list. Make sure the JSON file exists.")}</p>`;
        }
    }
    loadModdingSoftware();

    // ==========================================
    // PROJECTS TAB LOGIC
    // ==========================================
    const btnBrowseProject = document.getElementById('btn-browse-project');
    const projectDirInput = document.getElementById('project-dir-input');
    const projectWorkspace = document.getElementById('project-workspace');
    const btnSaveProject = document.getElementById('btn-save-project');
    const btnNewVersion = document.getElementById('btn-new-version');
    const versionSelect = document.getElementById('project-version-select');
    const btnCompileProject = document.getElementById('btn-compile-project');
    
    const projPreviewContainer = document.getElementById('project-preview-container');
    const projPreviewInput = document.getElementById('project-preview-input');
    const projPreviewImg = document.getElementById('project-mod-preview');
    const btnRemoveProjectPreview = document.getElementById('btn-remove-project-preview');

    const btnRefreshProjectFiles = document.getElementById('btn-refresh-project-files');
    const btnProjectAutoStructure = document.getElementById('btn-project-auto-structure');
    const projectFilesList = document.getElementById('project-files-list');

    const btnPlaceOverrides = document.getElementById('btn-place-overrides');
    const btnRemoveOverrides = document.getElementById('btn-remove-overrides');
    let activeOverrides = []; 

    if (projPreviewContainer && projPreviewInput) {
        projPreviewContainer.addEventListener('click', () => projPreviewInput.click());
        projPreviewInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    projPreviewImg.src = event.target.result;
                    if (btnRemoveProjectPreview) btnRemoveProjectPreview.style.display = 'flex';
                };
                reader.readAsDataURL(file);
            }
        });
    }

    if (btnRemoveProjectPreview) {
        btnRemoveProjectPreview.addEventListener('click', (e) => {
            e.stopPropagation();
            projPreviewImg.src = "assets/images/no_preview.png";
            projPreviewInput.value = "";
            btnRemoveProjectPreview.style.display = 'none';
        });
    }

    async function refreshProjectFiles() {
        const dir = projectDirInput.value;
        const version = versionSelect.value;
        if (!dir || !version) return;

        projectFilesList.innerHTML = `<tr><td style="padding: 10px; text-align: center; color: var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> ${t("Loading files...")}</td></tr>`;
        
        const result = await eel.get_project_files(dir, version)();
        if (result.success) {
            projectFilesList.innerHTML = '';
            if (result.files.length === 0) {
                projectFilesList.innerHTML = `<tr><td style="padding: 10px; text-align: center; color: var(--text-muted);">${t("No files found in this version folder.")}</td></tr>`;
            } else {
                result.files.forEach(f => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `<td style="padding: 8px 10px; color: var(--text-main); font-family: monospace;">${f.rel_path}</td>`;
                    projectFilesList.appendChild(tr);
                });
            }
        } else {
            projectFilesList.innerHTML = `<tr><td style="padding: 10px; text-align: center; color: #ff5555;">${t("Error loading files.")}</td></tr>`;
        }
    }

    if (btnRefreshProjectFiles) {
        btnRefreshProjectFiles.addEventListener('click', refreshProjectFiles);
    }
    if (versionSelect) {
        versionSelect.addEventListener('change', refreshProjectFiles);
    }

    async function loadProjectData(folderPath) {
        const result = await eel.load_mod_project(folderPath)();
        if (result.success) {
            projectWorkspace.style.display = 'block';
            
            document.getElementById('project-mod-title').value = result.data.title || '';
            document.getElementById('project-mod-author').value = result.data.author || '';
            document.getElementById('project-mod-notes').value = result.data.notes || '';
            
            if (result.data.tags) {
                $('#project-mod-tags').val(result.data.tags).trigger('change');
            } else {
                $('#project-mod-tags').val(null).trigger('change');
            }

            if (result.data.previewBase64) {
                projPreviewImg.src = result.data.previewBase64;
                if (btnRemoveProjectPreview) btnRemoveProjectPreview.style.display = 'flex';
            } else {
                projPreviewImg.src = "assets/images/no_preview.png";
                if (btnRemoveProjectPreview) btnRemoveProjectPreview.style.display = 'none';
            }

            versionSelect.innerHTML = '';
            if (result.data.versions && result.data.versions.length > 0) {
                result.data.versions.forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v;
                    opt.textContent = `Version ${v}`;
                    versionSelect.appendChild(opt);
                });
                versionSelect.value = result.data.active_version || result.data.versions[0];
            } else {
                const opt = document.createElement('option');
                opt.value = "1.0";
                opt.textContent = `Version 1.0 (Default)`;
                versionSelect.appendChild(opt);
            }
            
            await refreshProjectFiles();
        } else {
            window.showToast(t("Error loading project: {error}").replace("{error}", result.error), true);
        }
    }

    if (btnBrowseProject) {
        btnBrowseProject.addEventListener('click', async () => {
            const dir = await eel.ask_mod_source_directory()();
            if (dir) {
                projectDirInput.value = dir;
                await loadProjectData(dir);
            }
        });
    }

    if (btnSaveProject) {
        btnSaveProject.addEventListener('click', async () => {
            const dir = projectDirInput.value;
            if (!dir) return;

            const notes = document.getElementById('project-mod-notes').value.trim();
            if (notes.length > 220) {
                window.showToast(t("Project notes cannot exceed 220 characters."), true);
                return;
            }

            const payload = {
                title: document.getElementById('project-mod-title').value.trim(),
                author: document.getElementById('project-mod-author').value.trim(),
                notes: notes,
                tags: $('#project-mod-tags').val() || [],
                active_version: versionSelect.value
            };

            if (projPreviewImg.src.startsWith('data:image') && !projPreviewImg.src.includes('no_preview.png')) {
                payload.previewBase64 = projPreviewImg.src;
                if (projPreviewInput.files && projPreviewInput.files.length > 0) {
                    payload.previewName = projPreviewInput.files[0].name;
                }
            } else {
                payload.previewBase64 = null; 
            }

            const result = await eel.save_mod_project(dir, payload)();
            if (result.success) {
                window.showToast(t("Project metadata saved successfully!"));
            } else {
                window.showToast(t("Error saving project: {error}").replace("{error}", result.error), true);
            }
        });
    }

    if (btnNewVersion) {
        btnNewVersion.addEventListener('click', async () => {
            const dir = projectDirInput.value;
            if (!dir) return;

            const newVersion = prompt(t("Enter new version number (e.g., 1.1):"));
            if (!newVersion) return;

            const result = await eel.create_project_version(dir, newVersion)();
            if (result.success) {
                window.showToast(t("New version folder created!"));
                await loadProjectData(dir);
                versionSelect.value = newVersion;
            } else {
                window.showToast(t("Error creating version: {error}").replace("{error}", result.error), true);
            }
        });
    }

    if (btnProjectAutoStructure) {
        btnProjectAutoStructure.addEventListener('click', async () => {
            const dir = projectDirInput.value;
            const version = versionSelect.value;
            const gamePath = projectGameSelect.value;
            
            if (!dir || !version || !gamePath) {
                window.showToast(t("Ensure a project, version, and game path are selected."), true);
                return;
            }

            const originalHtml = btnProjectAutoStructure.innerHTML;
            btnProjectAutoStructure.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Structuring...")}`;
            btnProjectAutoStructure.disabled = true;

            try {
                const result = await eel.auto_structure_project_version(dir, version, gamePath)();
                if (result.success) {
                    window.showToast(t("Successfully structured {count} files!").replace("{count}", result.count));
                    await refreshProjectFiles();
                } else {
                    window.showToast(t("Error structuring files: {error}").replace("{error}", result.error), true);
                }
            } catch (err) {
                window.showToast(t("An unexpected error occurred."), true);
            } finally {
                btnProjectAutoStructure.innerHTML = originalHtml;
                btnProjectAutoStructure.disabled = false;
            }
        });
    }

    if (btnCompileProject) {
        btnCompileProject.addEventListener('click', async () => {
            const dir = projectDirInput.value;
            const version = versionSelect.value;
            const gamePath = projectGameSelect.value;

            if (!dir || !version || !gamePath) {
                window.showToast(t("Ensure a project, version, and game path are selected."), true);
                return;
            }

            const title = document.getElementById('project-mod-title').value.trim();
            if (!title) {
                window.showToast(t("Project title cannot be empty."), true);
                return;
            }

            const notes = document.getElementById('project-mod-notes').value.trim();
            if (notes.length > 220) {
                window.showToast(t("Project notes cannot exceed 220 characters."), true);
                return;
            }

            const payload = {
                title: title,
                author: document.getElementById('project-mod-author').value.trim(),
                notes: notes,
                tags: $('#project-mod-tags').val() || [],
                active_version: version
            };
            
            if (projPreviewImg.src.startsWith('data:image') && !projPreviewImg.src.includes('no_preview.png')) {
                payload.previewBase64 = projPreviewImg.src;
                if (projPreviewInput.files && projPreviewInput.files.length > 0) {
                    payload.previewName = projPreviewInput.files[0].name;
                }
            } else {
                payload.previewBase64 = null;
            }
            await eel.save_mod_project(dir, payload)();

            const originalHtml = btnCompileProject.innerHTML;
            btnCompileProject.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Compiling...")}`;
            btnCompileProject.disabled = true;

            try {
                const result = await eel.compile_project(dir, version, gamePath)();
                if (result.success) {
                    window.showToast(t("Project successfully compiled!\nSaved to: {path}").replace("{path}", result.path), false);
                } else {
                    window.showToast(t("Failed to compile project:\n{error}").replace("{error}", result.error), true);
                }
            } catch (err) {
                console.error(err);
                window.showToast(t("An unexpected error occurred while compiling the project."), true);
            } finally {
                btnCompileProject.innerHTML = originalHtml;
                btnCompileProject.disabled = false;
            }
        });
    }

    if (btnPlaceOverrides && btnRemoveOverrides) {
        btnPlaceOverrides.addEventListener('click', async () => {
            const dir = projectDirInput.value;
            const version = versionSelect.value;
            const gamePath = projectGameSelect.value;
            
            if (!dir || !version || !gamePath) {
                window.showToast(t("Ensure a project, version, and game path are selected."), true);
                return;
            }

            const originalHtml = btnPlaceOverrides.innerHTML;
            btnPlaceOverrides.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Placing...")}`;
            btnPlaceOverrides.disabled = true;

            try {
                const result = await eel.place_project_overrides(dir, version, gamePath)();
                if (result.success) {
                    if (result.count === 0) {
                        window.showToast(t("No valid files found to test."));
                        btnPlaceOverrides.disabled = false;
                    } else {
                        activeOverrides = result.placed_files;
                        window.showToast(t("{count} files placed in game overrides for testing.").replace("{count}", result.count));
                        btnRemoveOverrides.disabled = false;
                    }
                } else {
                    window.showToast(t("Error placing overrides: {error}").replace("{error}", result.error), true);
                    btnPlaceOverrides.disabled = false;
                }
            } catch (err) {
                window.showToast(t("An unexpected error occurred."), true);
                btnPlaceOverrides.disabled = false;
            } finally {
                btnPlaceOverrides.innerHTML = originalHtml;
            }
        });

        btnRemoveOverrides.addEventListener('click', async () => {
            if (activeOverrides.length === 0) return;

            const originalHtml = btnRemoveOverrides.innerHTML;
            btnRemoveOverrides.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Removing...")}`;
            btnRemoveOverrides.disabled = true;

            try {
                const result = await eel.remove_project_overrides(activeOverrides)();
                if (result.success) {
                    window.showToast(t("{count} override files successfully removed from game.").replace("{count}", result.count));
                    activeOverrides = [];
                    btnPlaceOverrides.disabled = false;
                } else {
                    window.showToast(t("Error removing overrides: {error}").replace("{error}", result.error), true);
                    btnRemoveOverrides.disabled = false; 
                }
            } catch (err) {
                window.showToast(t("An unexpected error occurred."), true);
                btnRemoveOverrides.disabled = false;
            } finally {
                btnRemoveOverrides.innerHTML = originalHtml;
            }
        });
    }
});