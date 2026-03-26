document.addEventListener('modder_tools_loaded', () => {
    console.log("Modder Tools view initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

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

    if (typeof jQuery !== 'undefined' && $.fn.select2) {
        $('#build-mod-tags').select2({
            placeholder: t("Select categories..."),
            width: '100%'
        });
    }

    async function scanForGames() {
        const gameSelect = document.getElementById('build-game-select');
        if (!gameSelect) return;
        gameSelect.innerHTML = `<option value="">${t("Searching...")}</option>`;
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
            gameSelect.innerHTML = `<option value="">${t("No installations found.")}</option>`;
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

    const btnAddFile = document.getElementById('btn-add-file');
    const btnDetectOverrides = document.getElementById('btn-detect-overrides');
    const filesList = document.getElementById('build-files-list');

    if (btnAddFile) {
        btnAddFile.addEventListener('click', async () => {
            const gameSelect = document.getElementById('build-game-select');
            const gamePath = gameSelect ? gameSelect.value : "";
            
            if (!gamePath) {
                window.showToast(t("Please select a Target Game Installation first."), true);
                return;
            }
            
            try {
                const result = await eel.ask_add_files(gamePath)();
                
                if (result && result.success) {
                    if (result.rejected && result.rejected.length > 0) {
                        window.showToast(`${t("Denied")} ${result.rejected.length} ${t("file(s):")}\n${t("Selected files must be located within the active game path.")}`, true);
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

    if (btnDetectOverrides) {
        btnDetectOverrides.addEventListener('click', async () => {
            const gamePath = document.getElementById('build-game-select').value;
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
                        <td style="text-align: right;"><button class="icon-btn-small danger remove-file" title="${t("Remove File")}"><i class="fa-solid fa-trash"></i></button></td>
                    `;
                    tr.fileData = { name: f.internal_path, path: f.path };
                    filesList.appendChild(tr);
                    tr.querySelector('.remove-file').addEventListener('click', () => tr.remove());
                    addedCount++;
                });
                if (addedCount === 0) {
                    window.showToast(t("No new override files found in the source directory."), true);
                }
            } else {
                window.showToast(`${t("Error detecting overrides:")} ${result.error}`, true);
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
            
            const illegalChars = /[<>:"/\\|?*]/;
            if (illegalChars.test(title)) {
                window.showToast(t("Mod title contains illegal characters (< > : \" / \\ | ? *).\nPlease remove them to continue."), true);
                return;
            }

            btnBuildTMod.disabled = true;
            const originalText = btnBuildTMod.innerHTML;
            btnBuildTMod.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Compiling TMod...")}`;
            
            try {
                const gamePath = document.getElementById('build-game-select').value;
                const author = document.getElementById('build-mod-author').value.trim();
                const version = document.getElementById('build-mod-version').value.trim();
                const notes = document.getElementById('build-mod-notes').value.trim();
                const tags = $('#build-mod-tags').val() || [];

                if (!gamePath) { window.showToast(t("Please select a target game installation."), true); return; }
                if (!title) { window.showToast(t("Please enter a mod title."), true); return; }
                if (!author) { window.showToast(t("Please enter a mod author."), true); return; }
                if (!version) { window.showToast(t("Please enter a mod version."), true); return; }
                if (!notes) { window.showToast(t("Please enter mod notes or a description."), true); return; }
                if (tags.length === 0) { window.showToast(t("Please select at least one tag."), true); return; }
                if (document.querySelectorAll('#build-files-list tr').length === 0) { window.showToast(t("Please add at least one file to your mod!"), true); return; }

                const previewImg = document.getElementById('build-mod-preview');
                const previewInputElem = document.getElementById('build-preview-input');
                let previewBase64 = null;
                let previewName = "preview.png";
                
                if (previewImg.src.startsWith('data:image')) {
                    previewBase64 = previewImg.src;
                    if (previewInputElem && previewInputElem.files && previewInputElem.files.length > 0) {
                        previewName = previewInputElem.files[0].name;
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
                        window.showToast(`${t("Warning:")} ${missingResult.missing.length} ${t("file(s) were missing from disk and have been removed from the list.\n\nPlease review your files and click Build TMod again.")}`, true);
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
                    window.showToast(`${t("TMod successfully built!")}\n${t("Saved to:")} ${result.path}`, false);
                } else {
                    window.showToast(`${t("Failed to build TMod:")}\n${result.error}`, true);
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
                    window.showToast(`${t("Successfully extracted")} ${result.count} ${t("files to:")}\n${destDir}`);
                } else {
                    window.showToast(`${t("Failed to extract TMod:")}\n${result.error}`, true);
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
});