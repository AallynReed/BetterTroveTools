document.addEventListener('modder_tools_loaded', () => {
    console.log("Modder Tools Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
            const PREF_STATE_KEY = 'state_modder_tools';
            let hydratingState = false;

            const activeTab = ref('build');
            let embeddedFileManagerLoaded = false;
            let embeddedFileManagerLoading = null;
            
            const installs = ref([]);
            const selectedGamePath = ref('');
            
            const gameOptions = computed(() => {
                if (installs.value.length === 0) return [[t('Searching...'), '']];
                return installs.value.map(g => [`${g.name} - ${g.path}`, g.path]);
            });

            const tagOptions = ref([
                {id: 'Allies', text: 'Allies'}, {id: 'Banners', text: 'Banners'}, {id: 'Boats and Sails', text: 'Boats and Sails'},
                {id: 'Cosmetics', text: 'Cosmetics'}, {id: 'Costumes', text: 'Costumes'}, {id: 'Dragons', text: 'Dragons'},
                {id: 'Fishing', text: 'Fishing'}, {id: 'GUI', text: 'GUI'}, {id: 'Helmets', text: 'Helmets'},
                {id: 'Language', text: 'Language'}, {id: 'Mag Riders', text: 'Mag Riders'}, {id: 'Mounts', text: 'Mounts'},
                {id: 'NPCs', text: 'NPCs'}, {id: 'Utility', text: 'Utility'}, {id: 'Waypoint', text: 'Waypoint'},
                {id: 'Wings', text: 'Wings'}, {id: 'VFX', text: 'VFX'}
            ]);

            const build = reactive({
                title: '', author: '', version: '1.0', notes: '', tags: [], files: [],
                preview: '', previewName: ''
            });

            const extract = reactive({
                source: '', dest: ''
            });

            const project = reactive({
                dir: '', title: '', author: '', notes: '', tags: [],
                versions: [], activeVersion: '', files: [],
                preview: '', previewName: '', activeOverrides: []
            });

            const softwareCategories = ref({});

            const isWorking = reactive({
                detectingOverrides: false,
                autoStructuringBuild: false,
                buildingTMod: false,
                extracting: false,
                refreshProjectFiles: false,
                autoStructuringProject: false,
                compilingProject: false,
                placingOverrides: false,
                removingOverrides: false
            });

            const applyStateSnapshot = (saved) => {
                if (!saved || typeof saved !== 'object') return;
                if (typeof saved.activeTab === 'string') activeTab.value = saved.activeTab;
                if (typeof saved.selectedGamePath === 'string') selectedGamePath.value = saved.selectedGamePath;
            };

            const persistState = () => {
                if (hydratingState || !window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    activeTab: activeTab.value,
                    selectedGamePath: selectedGamePath.value
                });
            };

            const runQueuedModderOperation = async ({ label, operation, task }) => {
                return window.JobQueue.run({
                    label,
                    task,
                    retryTask: task,
                    cancel: () => eel.cancel_modder_tools_operation(operation)()
                });
            };

            const unwrapResponse = (resp, key = null, fallback = null) => {
                if (key) {
                    if (resp && Object.prototype.hasOwnProperty.call(resp, key)) return resp[key];
                    if (resp && resp.data && Object.prototype.hasOwnProperty.call(resp.data, key)) return resp.data[key];
                }
                if (resp && resp.data !== undefined && resp.success !== undefined) return resp.data;
                return resp ?? fallback;
            };

            const readSettings = async () => {
                const settingsResp = await eel.get_settings()();
                return unwrapResponse(settingsResp, null, {}) || {};
            };

            const scanForGames = async () => {
                try {
                    const response = await eel.get_detected_game_paths()();
                    const settings = await readSettings();
                    const paths = unwrapResponse(response, 'paths', []);
                    const safePaths = Array.isArray(paths) ? paths : [];

                    if (safePaths.length > 0) {
                        installs.value = safePaths;
                        if (settings.last_game_path && installs.value.some(p => p.path === settings.last_game_path)) {
                            selectedGamePath.value = settings.last_game_path;
                        } else {
                            selectedGamePath.value = installs.value[0].path;
                        }
                        return;
                    }

                    installs.value = [];
                    selectedGamePath.value = '';
                    if (response && response.error) {
                        window.showToast(t('Game path detection failed: {error}').replace('{error}', response.error), true);
                    }
                } catch (error) {
                    installs.value = [];
                    selectedGamePath.value = '';
                    window.showToast(t('Game path detection failed.'), true);
                }
            };

            watch(selectedGamePath, async (newVal) => {
                if (!newVal) return;
                const settings = await readSettings();
                settings.last_game_path = newVal;
                await eel.save_settings(settings)();
            });

            watch([activeTab, selectedGamePath], persistState, { deep: true });

            const onBuildPreviewChange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        build.preview = event.target.result;
                        build.previewName = file.name;
                    };
                    reader.readAsDataURL(file);
                }
            };

            const detectBuildOverrides = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a Target Game Installation first."), true);
                
                isWorking.detectingOverrides = true;
                
                const pathsToCheck = build.files.map(f => f.path);
                if (pathsToCheck.length > 0) {
                    const missingResult = await eel.get_missing_files(pathsToCheck)();
                    if (missingResult.success && missingResult.missing) {
                        build.files = build.files.filter(f => !missingResult.missing.includes(f.path));
                    }
                }
                
                let result;
                try {
                    result = await runQueuedModderOperation({
                        label: t('Detect override files'),
                        operation: 'detect_overrides',
                        task: () => eel.detect_override_files(selectedGamePath.value)()
                    });
                } catch (e) {
                    window.showToast(String(e || t('Error detecting overrides.')), true);
                    isWorking.detectingOverrides = false;
                    return;
                }

                if (result.cancelled) {
                    window.showToast(t('Override detection cancelled.'));
                    isWorking.detectingOverrides = false;
                    return;
                }
                if (result.success) {
                    let addedCount = 0;
                    result.files.forEach(f => {
                        if (!build.files.find(existing => existing.path === f.path)) {
                            build.files.push({ internal_path: f.internal_path, path: f.path });
                            addedCount++;
                        }
                    });
                    if (addedCount === 0) window.showToast(t("No new override files found in the source directory."), true);
                    else window.showToast(t("{count} override file(s) successfully detected.").replace("{count}", addedCount));
                } else {
                    window.showToast(t("Error detecting overrides: {error}").replace("{error}", result.error), true);
                }
                isWorking.detectingOverrides = false;
            };

            const addBuildFiles = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a Target Game Installation first."), true);
                try {
                    const result = await eel.ask_add_files(selectedGamePath.value)();
                    if (result && result.success) {
                        if (result.rejected && result.rejected.length > 0) {
                            window.showToast(t("Denied {count} file(s):\nSelected files must be located within the active game path.").replace("{count}", result.rejected.length), true);
                        }
                        if (result.files && result.files.length > 0) {
                            result.files.forEach(f => {
                                if (!build.files.find(existing => existing.path === f.path)) {
                                    build.files.push({ internal_path: f.internal_path, path: f.path });
                                }
                            });
                        }
                    }
                } catch (e) {
                    window.showToast(t("An error occurred while adding files."), true);
                }
            };

            const removeBuildFile = (file) => {
                build.files = build.files.filter(f => f.path !== file.path);
                window.showUndoToast(
                    t('Removed file from build list.'),
                    6,
                    () => {
                        if (!build.files.find(f => f.path === file.path)) {
                            build.files.push(file);
                        }
                    }
                );
            };

            const autoStructureBuild = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a Target Game Installation first."), true);
                isWorking.autoStructuringBuild = true;
                try {
                    const result = await runQueuedModderOperation({
                        label: t('Auto-structure build workspace files'),
                        operation: 'auto_structure_workspace',
                        task: () => eel.auto_structure_workspace(selectedGamePath.value, selectedGamePath.value)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('Auto-structure cancelled.'));
                        return;
                    }
                    if (result.success) window.showToast(t("Successfully auto-structured {count} files!").replace("{count}", result.count));
                    else window.showToast(t("Error structuring files: {error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred while structuring files."), true);
                }
                isWorking.autoStructuringBuild = false;
            };

            const buildTMod = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a target game installation."), true);
                const title = build.title.trim();
                if (/[<>:"/\\|?*]/.test(title)) return window.showToast(t("Mod title contains illegal characters (< > : \" / \\ | ? *).\nPlease remove them to continue."), true);
                if (build.notes.trim().length > 220) return window.showToast(t("Mod notes cannot exceed 220 characters."), true);
                if (!title) return window.showToast(t("Please enter a mod title."), true);
                if (!build.author.trim()) return window.showToast(t("Please enter a mod author."), true);
                if (!build.version.trim()) return window.showToast(t("Please enter a mod version."), true);
                if (!build.notes.trim()) return window.showToast(t("Please enter mod notes or a description."), true);
                if (build.tags.length === 0) return window.showToast(t("Please select at least one tag."), true);
                if (build.files.length === 0) return window.showToast(t("Please add at least one file to your mod!"), true);

                isWorking.buildingTMod = true;
                try {
                    const pathsToCheck = build.files.map(f => f.path);
                    if (pathsToCheck.length > 0) {
                        const missingResult = await eel.get_missing_files(pathsToCheck)();
                        if (missingResult.success && missingResult.missing && missingResult.missing.length > 0) {
                            build.files = build.files.filter(f => !missingResult.missing.includes(f.path));
                            window.showToast(t("Warning: {count} file(s) were missing from disk and have been removed from the list.\n\nPlease review your files and click Build TMod again.").replace("{count}", missingResult.missing.length), true);
                            isWorking.buildingTMod = false;
                            return;
                        }
                    }

                    const payload = {
                        gamePath: selectedGamePath.value,
                        title: title,
                        author: build.author.trim(),
                        version: build.version.trim(),
                        notes: build.notes.trim(),
                        tags: build.tags,
                        previewBase64: build.preview || null,
                        previewName: build.previewName || "preview.png",
                        files: build.files.map(f => ({ internal_path: f.internal_path, abs_path: f.path }))
                    };

                    const result = await runQueuedModderOperation({
                        label: t("Build TMod '{name}'").replace('{name}', title),
                        operation: 'build_tmod',
                        task: () => eel.build_tmod(payload)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('Build cancelled.'));
                        isWorking.buildingTMod = false;
                        return;
                    }
                    if (result.success) window.showToast(t("TMod successfully built!\nSaved to: {path}").replace("{path}", result.path), false);
                    else window.showToast(t("Failed to build TMod:\n{error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred while building the TMod."), true);
                }
                isWorking.buildingTMod = false;
            };

            const browseExtractSource = async () => {
                const fileResp = await eel.ask_tmod_file()();
                const file = fileResp?.value ?? fileResp?.data?.value ?? fileResp;
                if (file) extract.source = file;
            };
            const browseExtractDest = async () => {
                const dirResp = await eel.ask_extract_destination()();
                const dir = dirResp?.value ?? dirResp?.data?.value ?? dirResp;
                if (dir) extract.dest = dir;
            };
            const extractTMod = async () => {
                if (!extract.source) return window.showToast(t("Please select a Source TMod File."), true);
                if (!extract.dest) return window.showToast(t("Please select a Destination Folder."), true);
                
                isWorking.extracting = true;
                try {
                    const result = await runQueuedModderOperation({
                        label: t('Extract TMod archive'),
                        operation: 'extract_tmod',
                        task: () => eel.extract_tmod(extract.source, extract.dest)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('Extraction cancelled.'));
                        isWorking.extracting = false;
                        return;
                    }
                    if (result.success) window.showToast(t("Successfully extracted {count} files to:\n{path}").replace("{count}", result.count).replace("{path}", extract.dest));
                    else window.showToast(t("Failed to extract TMod:\n{error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred during extraction."), true);
                }
                isWorking.extracting = false;
            };

            const onProjectPreviewChange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        project.preview = event.target.result;
                        project.previewName = file.name;
                    };
                    reader.readAsDataURL(file);
                }
            };

            const refreshProjectFiles = async () => {
                if (!project.dir || !project.activeVersion) return;
                isWorking.refreshProjectFiles = true;
                const result = await eel.get_project_files(project.dir, project.activeVersion)();
                if (result.success) project.files = result.files;
                isWorking.refreshProjectFiles = false;
            };

            watch(() => project.activeVersion, () => {
                refreshProjectFiles();
            });

            const loadProjectData = async (dir) => {
                const result = await eel.load_mod_project(dir)();
                if (result.success) {
                    project.title = result.data.title || '';
                    project.author = result.data.author || '';
                    project.notes = result.data.notes || '';
                    project.tags = result.data.tags || [];
                    project.preview = result.data.previewBase64 || '';
                    project.previewName = result.data.previewName || '';
                    
                    project.versions = result.data.versions || ["1.0"];
                    project.activeVersion = result.data.active_version || project.versions[0];
                } else {
                    window.showToast(t("Error loading project: {error}").replace("{error}", result.error), true);
                }
            };

            const browseProject = async () => {
                const dirResp = await eel.ask_mod_source_directory()();
                const dir = dirResp?.value ?? dirResp?.data?.value ?? dirResp;
                if (dir) {
                    project.dir = dir;
                    await loadProjectData(dir);
                }
            };

            const saveProject = async () => {
                if (!project.dir) return;
                if (project.notes.trim().length > 220) return window.showToast(t("Project notes cannot exceed 220 characters."), true);

                const payload = {
                    title: project.title.trim(),
                    author: project.author.trim(),
                    notes: project.notes.trim(),
                    tags: project.tags,
                    active_version: project.activeVersion,
                    previewBase64: project.preview || null,
                    previewName: project.previewName || "preview.png"
                };

                const result = await eel.save_mod_project(project.dir, payload)();
                if (result.success) window.showToast(t("Project metadata saved successfully!"));
                else window.showToast(t("Error saving project: {error}").replace("{error}", result.error), true);
            };

            const newVersion = async () => {
                if (!project.dir) return;
                const nv = prompt(t("Enter new version number (e.g., 1.1):"));
                if (!nv) return;

                const result = await eel.create_project_version(project.dir, nv)();
                if (result.success) {
                    window.showToast(t("New version folder created!"));
                    await loadProjectData(project.dir);
                    project.activeVersion = nv;
                } else window.showToast(t("Error creating version: {error}").replace("{error}", result.error), true);
            };

            const autoStructureProject = async () => {
                if (!project.dir || !project.activeVersion || !selectedGamePath.value) return window.showToast(t("Ensure a project, version, and game path are selected."), true);
                isWorking.autoStructuringProject = true;
                try {
                    const result = await runQueuedModderOperation({
                        label: t('Auto-structure project version files'),
                        operation: 'auto_structure_project',
                        task: () => eel.auto_structure_project_version(project.dir, project.activeVersion, selectedGamePath.value)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('Project auto-structure cancelled.'));
                        return;
                    }
                    if (result.success) {
                        window.showToast(t("Successfully structured {count} files!").replace("{count}", result.count));
                        await refreshProjectFiles();
                    } else window.showToast(t("Error structuring files: {error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred."), true);
                }
                isWorking.autoStructuringProject = false;
            };

            const compileProject = async () => {
                if (!project.dir || !project.activeVersion || !selectedGamePath.value) return window.showToast(t("Ensure a project, version, and game path are selected."), true);
                if (!project.title.trim()) return window.showToast(t("Project title cannot be empty."), true);
                if (project.notes.trim().length > 220) return window.showToast(t("Project notes cannot exceed 220 characters."), true);

                await saveProject();
                
                isWorking.compilingProject = true;
                try {
                    const result = await runQueuedModderOperation({
                        label: t("Compile project '{name}'").replace('{name}', project.title.trim() || t('Untitled')),
                        operation: 'compile_project',
                        task: () => eel.compile_project(project.dir, project.activeVersion, selectedGamePath.value)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('Project compile cancelled.'));
                        isWorking.compilingProject = false;
                        return;
                    }
                    if (result.success) window.showToast(t("Project successfully compiled!\nSaved to: {path}").replace("{path}", result.path), false);
                    else window.showToast(t("Failed to compile project:\n{error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred while compiling the project."), true);
                }
                isWorking.compilingProject = false;
            };

            const placeOverrides = async () => {
                if (!project.dir || !project.activeVersion || !selectedGamePath.value) return window.showToast(t("Ensure a project, version, and game path are selected."), true);
                isWorking.placingOverrides = true;
                try {
                    const result = await runQueuedModderOperation({
                        label: t('Place project overrides into game'),
                        operation: 'place_overrides',
                        task: () => eel.place_project_overrides(project.dir, project.activeVersion, selectedGamePath.value)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('Placing overrides cancelled.'));
                        isWorking.placingOverrides = false;
                        return;
                    }
                    if (result.success) {
                        if (result.count === 0) window.showToast(t("No valid files found to test."));
                        else {
                            project.activeOverrides = result.placed_files;
                            window.showToast(t("{count} files placed in game overrides for testing.").replace("{count}", result.count));
                        }
                    } else window.showToast(t("Error placing overrides: {error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred."), true);
                }
                isWorking.placingOverrides = false;
            };

            const removeOverrides = async () => {
                if (project.activeOverrides.length === 0) return;
                const confirmed = await window.showConfirmModal({
                    title: t('Remove Overrides'),
                    message: t('Remove all currently placed override files from the game?'),
                    confirmLabel: t('Remove'),
                    cancelLabel: t('Cancel'),
                    danger: true
                });
                if (!confirmed) return;

                isWorking.removingOverrides = true;
                try {
                    const removedSnapshot = [...project.activeOverrides];
                    const result = await runQueuedModderOperation({
                        label: t('Remove project overrides from game'),
                        operation: 'remove_overrides',
                        task: () => eel.remove_project_overrides(project.activeOverrides)()
                    });
                    if (result.cancelled) {
                        if (result.undo_token) {
                            window.showUndoToast(
                                t('Removal cancelled. Restore removed files?'),
                                10,
                                async () => {
                                    const undoResult = await eel.undo_remove_project_overrides(result.undo_token)();
                                    if (!undoResult.success) {
                                        window.showToast(t('Undo failed: {error}').replace('{error}', undoResult.error || t('Unknown error occurred')), true);
                                        return;
                                    }
                                    project.activeOverrides = removedSnapshot;
                                    window.showToast(t('Overrides restored.'));
                                }
                            );
                        }
                        window.showToast(t('Removing overrides cancelled.'));
                        isWorking.removingOverrides = false;
                        return;
                    }
                    if (result.success) {
                        window.showToast(t("{count} override files successfully removed from game.").replace("{count}", result.count));
                        project.activeOverrides = [];

                        if (result.undo_token) {
                            window.showUndoToast(
                                t('Overrides removed.'),
                                10,
                                async () => {
                                    const undoResult = await eel.undo_remove_project_overrides(result.undo_token)();
                                    if (!undoResult.success) {
                                        window.showToast(t('Undo failed: {error}').replace('{error}', undoResult.error || t('Unknown error occurred')), true);
                                        return;
                                    }
                                    if (undoResult.restored > 0) {
                                        project.activeOverrides = removedSnapshot;
                                    }
                                    if (undoResult.conflicts && undoResult.conflicts.length > 0) {
                                        window.showToast(t('Undo completed with conflicts for existing files.'), true);
                                    } else {
                                        window.showToast(t('Overrides restored.'));
                                    }
                                }
                            );
                        }
                    } else window.showToast(t("Error removing overrides: {error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred."), true);
                }
                isWorking.removingOverrides = false;
            };

            const loadModdingSoftware = async () => {
                try {
                    const response = await fetch('assets/data/modding_software.json');
                    const data = await response.json();
                    const categoryIcons = { 'blueprints': 'fa-cube', 'vfx': 'fa-wand-magic-sparkles', 'ui': 'fa-layer-group', 'sound': 'fa-headphones', 'textures': 'fa-palette' };
                    
                    for (const [cat, catData] of Object.entries(data)) {
                        catData.icon = categoryIcons[cat] || 'fa-laptop-code';
                    }
                    softwareCategories.value = data;
                } catch (e) { console.error("Failed to load software:", e); }
            };

            const ensureEmbeddedFileManagerLoaded = async () => {
                if (embeddedFileManagerLoaded) return;
                if (embeddedFileManagerLoading) {
                    await embeddedFileManagerLoading;
                    return;
                }

                embeddedFileManagerLoading = (async () => {
                    const host = document.getElementById('modder-tools-file-manager-host');
                    if (!host) return;

                    const response = await fetch('views/file_manager.html', { cache: 'no-store' });
                    if (!response.ok) throw new Error(`Failed to load file manager view (${response.status})`);

                    const html = await response.text();
                    const parsed = new DOMParser().parseFromString(html, 'text/html');
                    const root = parsed.querySelector('#file-manager-vue-app');
                    if (!root) throw new Error('File Manager root element not found');

                    host.innerHTML = '';
                    host.appendChild(root);

                    document.dispatchEvent(new CustomEvent('file_manager_loaded'));
                    embeddedFileManagerLoaded = true;
                })();

                try {
                    await embeddedFileManagerLoading;
                } finally {
                    embeddedFileManagerLoading = null;
                }
            };

            const syncEmbeddedFileManagerTab = (tabName) => {
                document.dispatchEvent(new CustomEvent('file_manager_set_tab', { detail: { tab: tabName } }));
            };

            const handleEmbeddedTabSelection = async (newTab) => {
                if (newTab !== 'file_explorer' && newTab !== 'update_tracker') return;
                await ensureEmbeddedFileManagerLoaded();
                syncEmbeddedFileManagerTab(newTab === 'file_explorer' ? 'tab-explorer' : 'tab-tracker');
            };

            watch(activeTab, (newTab) => {
                handleEmbeddedTabSelection(newTab).catch((e) => {
                    console.error('Failed to load embedded File Manager:', e);
                    window.showToast(t('Failed to load Game File Manager inside Modder Tools.'), true);
                });
            });

            onMounted(async () => {
                hydratingState = true;
                if (window.AppSettings) {
                    await window.AppSettings.load();
                    const saved = window.AppSettings.getPref(PREF_STATE_KEY, null);
                    applyStateSnapshot(saved);
                }
                if (window.pendingModderToolsTab) {
                    activeTab.value = window.pendingModderToolsTab;
                    window.pendingModderToolsTab = null;
                }
                await scanForGames();
                await loadModdingSoftware();
                await handleEmbeddedTabSelection(activeTab.value);
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                hydratingState = false;
            });

            onBeforeUnmount(() => {
                if (window._fileManagerApp && typeof window._fileManagerApp.unmount === 'function') {
                    window._fileManagerApp.unmount();
                    window._fileManagerApp = null;
                }
            });

            return {
                t, activeTab, installs, selectedGamePath, gameOptions,
                tagOptions, build, extract, project, softwareCategories, isWorking,
                scanForGames, onBuildPreviewChange, detectBuildOverrides, addBuildFiles, removeBuildFile, autoStructureBuild, buildTMod,
                browseExtractSource, browseExtractDest, extractTMod,
                onProjectPreviewChange, refreshProjectFiles, browseProject, saveProject, newVersion, autoStructureProject, compileProject, placeOverrides, removeOverrides
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);
    app.component('select2', window.Select2Component);
    
    if (window._modderToolsApp) window._modderToolsApp.unmount();
    window._modderToolsApp = app;
    app.mount('#modder-tools-vue-app');
});