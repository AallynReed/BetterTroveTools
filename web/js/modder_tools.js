document.addEventListener('modder_tools_loaded', () => {
    console.log("Modder Tools Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;

    // Vue wrapper for Select2 (jQuery)
    const Select2Component = {
        props: ['options', 'modelValue', 'placeholder'],
        template: '<select multiple style="width: 100%;"></select>',
        mounted() {
            const vm = this;
            $(this.$el).select2({
                data: this.options,
                placeholder: this.placeholder,
                allowClear: true
            })
            .val(this.modelValue).trigger('change')
            .on('change', function() {
                vm.$emit('update:modelValue', $(this).val() || []);
            });
        },
        watch: {
            modelValue(value) {
                if ([...$(this.$el).val() || []].join(',') !== [...value || []].join(',')) {
                    $(this.$el).val(value).trigger('change');
                }
            },
            options(newOptions) {
                $(this.$el).empty().select2({
                    data: newOptions,
                    placeholder: this.placeholder,
                    allowClear: true
                }).val(this.modelValue).trigger('change');
            }
        },
        unmounted() {
            $(this.$el).select2('destroy');
        }
    };

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

            const activeTab = ref('build');
            
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

            // --- Game Paths ---
            const scanForGames = async () => {
                const response = await eel.get_detected_game_paths()();
                const settings = await eel.get_settings()();
                if (response.success && response.paths.length > 0) {
                    installs.value = response.paths;
                    if (settings.last_game_path && installs.value.some(p => p.path === settings.last_game_path)) {
                        selectedGamePath.value = settings.last_game_path;
                    } else {
                        selectedGamePath.value = installs.value[0].path;
                    }
                } else {
                    installs.value = [];
                    selectedGamePath.value = '';
                }
            };

            watch(selectedGamePath, async (newVal) => {
                if (!newVal) return;
                const settings = await eel.get_settings()();
                settings.last_game_path = newVal;
                await eel.save_settings(settings)();
            });

            // --- Build TMod Methods ---
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
                
                const result = await eel.detect_override_files(selectedGamePath.value)();
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
            };

            const autoStructureBuild = async () => {
                if (!selectedGamePath.value) return window.showToast(t("Please select a Target Game Installation first."), true);
                isWorking.autoStructuringBuild = true;
                try {
                    const result = await eel.auto_structure_workspace(selectedGamePath.value, selectedGamePath.value)();
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

                    const result = await eel.build_tmod(payload)();
                    if (result.success) window.showToast(t("TMod successfully built!\nSaved to: {path}").replace("{path}", result.path), false);
                    else window.showToast(t("Failed to build TMod:\n{error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred while building the TMod."), true);
                }
                isWorking.buildingTMod = false;
            };

            // --- Extract TMod Methods ---
            const browseExtractSource = async () => {
                const file = await eel.ask_tmod_file()();
                if (file) extract.source = file;
            };
            const browseExtractDest = async () => {
                const dir = await eel.ask_extract_destination()();
                if (dir) extract.dest = dir;
            };
            const extractTMod = async () => {
                if (!extract.source) return window.showToast(t("Please select a Source TMod File."), true);
                if (!extract.dest) return window.showToast(t("Please select a Destination Folder."), true);
                
                isWorking.extracting = true;
                try {
                    const result = await eel.extract_tmod(extract.source, extract.dest)();
                    if (result.success) window.showToast(t("Successfully extracted {count} files to:\n{path}").replace("{count}", result.count).replace("{path}", extract.dest));
                    else window.showToast(t("Failed to extract TMod:\n{error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred during extraction."), true);
                }
                isWorking.extracting = false;
            };

            // --- Project Methods ---
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
                const dir = await eel.ask_mod_source_directory()();
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
                    const result = await eel.auto_structure_project_version(project.dir, project.activeVersion, selectedGamePath.value)();
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

                await saveProject(); // Auto save metadata before compiling
                
                isWorking.compilingProject = true;
                try {
                    const result = await eel.compile_project(project.dir, project.activeVersion, selectedGamePath.value)();
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
                    const result = await eel.place_project_overrides(project.dir, project.activeVersion, selectedGamePath.value)();
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
                isWorking.removingOverrides = true;
                try {
                    const result = await eel.remove_project_overrides(project.activeOverrides)();
                    if (result.success) {
                        window.showToast(t("{count} override files successfully removed from game.").replace("{count}", result.count));
                        project.activeOverrides = [];
                    } else window.showToast(t("Error removing overrides: {error}").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("An unexpected error occurred."), true);
                }
                isWorking.removingOverrides = false;
            };

            // --- Software Tab ---
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

            onMounted(async () => {
                await scanForGames();
                await loadModdingSoftware();
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
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

    if (window.CustomVueSelect) {
        app.component('custom-vue-select', window.CustomVueSelect);
    } else {
        app.component('custom-vue-select', {
            props: ['modelValue', 'options', 'disabled'],
            setup(props, { emit }) {
                const isOpen = ref(false);
                const isDropUp = ref(false);
                const maxH = ref(250);
                const wrapperRef = ref(null);
                const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
                const currentLabel = computed(() => {
                    const found = props.options.find(opt => opt[1] === props.modelValue);
                    return found ? found[0] : '';
                });
                const toggle = () => {
                    if (props.disabled) return;
                    isOpen.value = !isOpen.value;
                    if (isOpen.value && wrapperRef.value) {
                        const rect = wrapperRef.value.getBoundingClientRect();
                        const spaceBelow = window.innerHeight - rect.bottom;
                        const spaceAbove = rect.top;
                        if (spaceBelow < 250 && spaceAbove > spaceBelow) {
                            isDropUp.value = true;
                            maxH.value = Math.max(100, Math.min(spaceAbove - 20, 250));
                        } else {
                            isDropUp.value = false;
                            maxH.value = Math.max(100, Math.min(spaceBelow - 20, 250));
                        }
                    }
                };
                const selectOpt = (val) => { emit('update:modelValue', val); isOpen.value = false; };
                const handleKey = (e) => {
                    if (props.disabled) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
                    else if (e.key === 'Escape') isOpen.value = false;
                    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        if (!props.options || props.options.length === 0) return;
                        let currentIdx = props.options.findIndex(opt => opt[1] === props.modelValue);
                        if (e.key === 'ArrowDown' && currentIdx < props.options.length - 1) currentIdx++;
                        if (e.key === 'ArrowUp' && currentIdx > 0) currentIdx--;
                        if (currentIdx > -1) selectOpt(props.options[currentIdx][1]);
                    }
                };
                onMounted(() => { document.addEventListener('click', (e) => { if (wrapperRef.value && !wrapperRef.value.contains(e.target)) isOpen.value = false; }); });
                return { isOpen, isDropUp, maxH, wrapperRef, t, currentLabel, toggle, selectOpt, handleKey };
            },
            template: `
                <div ref="wrapperRef" class="custom-select-wrapper" :class="{ disabled: disabled, open: isOpen, 'drop-up': isDropUp }" @click.stop="toggle" tabindex="0" @keydown="handleKey">
                    <div class="custom-select-trigger">
                        <span class="custom-select-trigger-text">{{ currentLabel }}</span>
                        <i class="fa-solid fa-chevron-down"></i>
                    </div>
                    <div class="custom-select-options" :style="{ maxHeight: maxH + 'px' }">
                        <div v-for="opt in options" :key="opt[1]" class="custom-select-option" :class="{ selected: modelValue === opt[1] }" @click.stop="selectOpt(opt[1])">
                            {{ opt[0] }}
                        </div>
                    </div>
                </div>
            `
        });
    }

    app.component('select2', Select2Component);
    
    if (window._modderToolsApp) window._modderToolsApp.unmount();
    window._modderToolsApp = app;
    app.mount('#modder-tools-vue-app');
});