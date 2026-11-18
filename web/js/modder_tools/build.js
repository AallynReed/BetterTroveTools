document.addEventListener('modder_build_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;
    const SOURCE_PREF_KEY = 'modder_build_source';

    const app = createApp({
        setup() {
            const { store, t } = window.ModderTools;

            const gameOptions = computed(() => [
                [t('modder_tools.no_game_reference'), ''],
                ...store.installs.map(g => [t('common.name_path').replace('{name}', t(g.name)).replace('{path}', g.path), g.path])
            ]);
            const outputOptions = computed(() => [
                ['game', store.selectedGamePath ? t('modder_tools.game_mods_folder') : t('modder_tools.game_mods_folder_no_game')],
                ['ask', t('modder_tools.choose_location')]
            ].map(([value, label]) => [label, value]));

            const lastBuildOutputPath = ref('');

            const build = reactive({
                title: '', author: '', version: '1.0', notes: '', tags: [],
                preview: '', previewName: '', config: '', configName: '', subtype: '', output: 'game'
            });

            const savedSource = (window.AppSettings && window.AppSettings.getPref(SOURCE_PREF_KEY, null)) || {};
            const source = reactive({
                mode: savedSource.mode === 'virtual' ? 'virtual' : 'folder',
                dir: typeof savedSource.dir === 'string' ? savedSource.dir : '',
                gameTypesOnly: savedSource.gameTypesOnly !== false,
                scanning: false,
                error: ''
            });
            // Files the user placed by hand: auto-fix never moves them again.
            const pinned = new Set(Array.isArray(savedSource.pinned) ? savedSource.pinned.filter(p => typeof p === 'string') : []);
            const folderFiles = ref([]);
            const virtualFiles = ref([]);
            const problems = reactive({ clashes: [] });
            const dropActive = ref(false);

            const activeFiles = computed(() => source.mode === 'folder' ? folderFiles.value : virtualFiles.value);

            const persistSource = () => {
                if (window.AppSettings) window.AppSettings.setPrefSync(SOURCE_PREF_KEY, { mode: source.mode, dir: source.dir, gameTypesOnly: source.gameTypesOnly, pinned: [...pinned].slice(-500) });
            };

            const validationState = reactive({
                build: false
            });

            const buildValidationError = computed(() => window.ModderTools.validateSpecialFileSelections({
                files: activeFiles.value,
                previewName: build.previewName,
                hasPreview: Boolean(build.preview),
                hasConfig: Boolean(build.config),
                title: build.title
            }));

            const isBuildFieldInvalid = (field) => {
                if (!validationState.build) return false;
                switch (field) {
                    case 'source': return source.mode === 'folder' && !source.dir;
                    case 'title': return !build.title.trim() || window.ModderTools.hasIllegalTitleChars(build.title);
                    case 'author': return !build.author.trim();
                    case 'version': return !build.version.trim();
                    case 'notes': return !build.notes.trim() || build.notes.trim().length > 220;
                    case 'tags': return build.tags.length === 0;
                    case 'files': return activeFiles.value.length === 0 || Boolean(buildValidationError.value);
                    default: return false;
                }
            };

            const pickerStartDir = () => (source.mode === 'folder' && source.dir) || store.selectedGamePath || null;

            // --- folder source ---------------------------------------------------------

            let rescanQueued = false;
            const scanFolder = async (manual = false) => {
                if (source.mode !== 'folder' || !source.dir) return;
                if (source.scanning || store.isWorking.buildingTMod) {
                    rescanQueued = true;
                    return;
                }
                source.scanning = true;
                const dir = source.dir;
                try {
                    const keep = [...folderFiles.value.map(f => f.path), ...pinned];
                    const result = await eel.scan_build_source(dir, store.selectedGamePath || null, true, keep, source.gameTypesOnly)();
                    if (dir !== source.dir) return;
                    if (!result || !result.success) {
                        source.error = result?.error || t('modder_tools.could_not_read_source_folder');
                        folderFiles.value = [];
                        problems.clashes = [];
                        return;
                    }
                    source.error = '';
                    folderFiles.value = result.files || [];
                    problems.clashes = result.clashes || [];
                    if (result.moved > 0) window.showToast(t('modder_tools.moved_count_files_into_game_folders').replace('{count}', result.moved));
                    else if (manual) window.showToast(t('modder_tools.folder_rescanned_count_files').replace('{count}', folderFiles.value.length));
                } catch (e) {
                    source.error = String(e || t('modder_tools.could_not_read_source_folder'));
                } finally {
                    source.scanning = false;
                    if (rescanQueued) {
                        rescanQueued = false;
                        scanFolder();
                    }
                }
            };

            const syncWatcher = () => {
                const dir = source.mode === 'folder' && source.dir ? source.dir : null;
                eel.watch_build_source(dir)();
            };

            eel.expose((dir) => {
                if (source.mode === 'folder' && dir === source.dir) scanFolder();
            }, 'receive_build_source_changed');

            const chooseSourceDir = async () => {
                const dir = await eel.ask_build_source_directory(source.dir || null)();
                if (!dir) return;
                source.dir = dir;
                source.error = '';
            };

            const openSourceDir = async () => {
                await window.ModderTools.openPathInExplorer(source.dir);
            };

            const setSourceMode = (mode) => {
                if (source.mode === mode) return;
                source.mode = mode;
                problems.clashes = [];
            };

            watch(() => source.dir, () => {
                folderFiles.value = [];
                problems.clashes = [];
            }, { flush: 'sync' });
            watch(() => [source.mode, source.dir], () => {
                persistSource();
                syncWatcher();
                if (source.mode === 'folder') scanFolder();
            });
            watch(() => source.gameTypesOnly, () => {
                persistSource();
                if (source.mode === 'folder') scanFolder();
            });
            watch(() => store.selectedGamePath, () => {
                if (!store.selectedGamePath && build.output === 'game') build.output = 'ask';
                if (source.mode === 'folder') scanFolder();
            });
            watch(() => store.isWorking.buildingTMod, (busy) => {
                if (!busy && rescanQueued) {
                    rescanQueued = false;
                    scanFolder();
                }
            });

            // --- adding files ----------------------------------------------------------

            const mergeVirtual = (files) => {
                const before = virtualFiles.value.length;
                const next = [...virtualFiles.value];
                for (const f of files) {
                    if (!next.find(existing => existing.path === f.path)) next.push({ internal_path: f.internal_path, path: f.path, matched: f.matched });
                }
                const validationError = window.ModderTools.validateSpecialFileSelections({
                    files: next,
                    previewName: build.previewName,
                    hasPreview: Boolean(build.preview),
                    hasConfig: Boolean(build.config),
                    title: build.title
                });
                if (validationError) {
                    window.showToast(t(validationError), true);
                    return 0;
                }
                virtualFiles.value = next;
                return next.length - before;
            };

            const addPaths = async (paths) => {
                if (!paths || paths.length === 0) return;
                try {
                    if (source.mode === 'folder') {
                        if (!source.dir) return window.showToast(t('modder_tools.pick_a_source_folder_first'), true);
                        const result = await eel.copy_into_build_source(paths, source.dir)();
                        if (!result?.success) return window.showToast(result?.error || t('modder_tools.an_error_occurred_while_adding_files'), true);
                        if (result.copied > 0) window.showToast(t('modder_tools.copied_count_files_into_folder').replace('{count}', result.copied));
                        if (result.skipped?.length) window.showToast(t('modder_tools.skipped_count_files_already_in_folder').replace('{count}', result.skipped.length), true);
                        scanFolder();
                        return;
                    }
                    const result = await eel.resolve_build_files(paths, store.selectedGamePath || null, source.gameTypesOnly)();
                    if (!result?.success) return window.showToast(result?.error || t('modder_tools.an_error_occurred_while_adding_files'), true);
                    const added = mergeVirtual(result.files || []);
                    if (added > 0) window.showToast(t('modder_tools.added_count_files').replace('{count}', added));
                    else window.showToast(t('modder_tools.no_new_files_to_add'), true);
                } catch (e) {
                    window.showToast(t("modder_tools.an_error_occurred_while_adding_files"), true);
                }
            };

            const addBuildFiles = async () => {
                const paths = await eel.ask_build_files(pickerStartDir())();
                await addPaths(paths);
            };

            const clearVirtualFiles = () => {
                const snapshot = [...virtualFiles.value];
                virtualFiles.value = [];
                if (!snapshot.length) return;
                window.showUndoToast(t('modder_tools.file_list_cleared'), 6, () => { virtualFiles.value = snapshot; });
            };

            const cleanInternalPath = (value) => {
                const parts = String(value || '').replaceAll('\\', '/').split('/').map(p => p.trim()).filter(p => p && p !== '.');
                if (!parts.length || parts.some(p => p === '..' || p.includes(':'))) return null;
                return parts.join('/');
            };

            const editFilePath = async (file, value, input) => {
                const next = cleanInternalPath(value);
                const revert = () => { if (input) input.value = file.internal_path; };
                if (!next) {
                    revert();
                    return window.showToast(t('modder_tools.that_path_is_not_valid'), true);
                }
                if (next === file.internal_path) return revert();
                const lower = next.toLowerCase();
                if (activeFiles.value.some(f => f !== file && f.internal_path.toLowerCase() === lower)) {
                    revert();
                    return window.showToast(t('modder_tools.same_file_path_added_more_than_once'), true);
                }
                if (source.mode === 'virtual') {
                    virtualFiles.value = virtualFiles.value.map(f => f === file ? { ...f, internal_path: next, matched: undefined } : f);
                    return;
                }
                const result = await eel.move_build_file(source.dir, file.path, next)();
                if (!result?.success) {
                    revert();
                    return window.showToast(result?.error || t('modder_tools.that_path_is_not_valid'), true);
                }
                pinned.delete(file.path);
                pinned.add(result.path);
                persistSource();
                folderFiles.value = folderFiles.value.map(f => f === file ? { ...f, path: result.path, internal_path: next, matched: undefined } : f);
                scanFolder();
            };

            const removeBuildFile = (file) => {
                virtualFiles.value = virtualFiles.value.filter(f => f.path !== file.path);
                window.showUndoToast(
                    t('modder_tools.removed_file_from_build_list'),
                    6,
                    () => {
                        if (!virtualFiles.value.find(f => f.path === file.path)) virtualFiles.value = [...virtualFiles.value, file];
                    }
                );
            };

            // Native drops carry real paths; HTML5 drag-and-drop inside the page is untouched.
            const rootEl = () => document.getElementById('modder-build-vue-app-inner');
            const isBuildVisible = () => {
                const el = rootEl();
                return Boolean(el && el.offsetParent !== null && !document.hidden);
            };
            const setupNativeDrop = () => {
                const webview = window.__TAURI__?.webview?.getCurrentWebview?.();
                if (!webview || window._modderBuildDropUnlisten) return;
                window._modderBuildDropUnlisten = webview.onDragDropEvent((event) => {
                    const handler = window._modderBuildDropHandler;
                    if (handler) handler(event.payload || {});
                });
            };
            window._modderBuildDropHandler = (payload) => {
                if (payload.type === 'leave' || !isBuildVisible()) {
                    dropActive.value = false;
                    return;
                }
                if (payload.type === 'enter' || payload.type === 'over') {
                    dropActive.value = true;
                    return;
                }
                if (payload.type === 'drop') {
                    dropActive.value = false;
                    addPaths(payload.paths || []);
                }
            };

            // --- other controls --------------------------------------------------------

            const openSelectedGamePath = async () => {
                await window.ModderTools.openPathInExplorer(store.selectedGamePath);
            };

            const openBuildOutputFolder = async () => {
                await window.ModderTools.openPathInExplorer(lastBuildOutputPath.value);
            };

            const openBuildFileLocation = async (file) => {
                await window.ModderTools.openPathInExplorer(file?.path);
            };

            const chooseBuildPreview = async () => {
                const result = await eel.ask_preview_file(pickerStartDir())();
                const file = result?.file;
                if (file) {
                    const nextPreviewName = file.name;
                    const previewPath = window.ModderTools.normalizeInternalPath(window.ModderTools.previewInternalPath(build.title, nextPreviewName));
                    if (activeFiles.value.some(existing => window.ModderTools.normalizeInternalPath(existing.internal_path) === previewPath)) {
                        window.showToast(t("modder_tools.preview_image_path_cannot_also_be_includ_01ba5d"), true);
                        return;
                    }
                    build.preview = file.data;
                    build.previewName = nextPreviewName;
                }
            };

            const chooseBuildConfig = async () => {
                const result = await eel.ask_config_file(pickerStartDir())();
                const file = result?.file;
                if (file) {
                    build.config = file.data;
                    build.configName = window.ModderTools.configDisplayName(build.title);
                }
            };

            const detectBuildOverrides = async () => {
                if (!store.selectedGamePath) return window.showToast(t("modder_tools.please_select_a_target_game_installation_780071"), true);

                store.isWorking.detectingOverrides = true;

                const pathsToCheck = virtualFiles.value.map(f => f.path);
                if (pathsToCheck.length > 0) {
                    const missingResult = await eel.get_missing_files(pathsToCheck)();
                    if (missingResult.success && missingResult.missing) {
                        virtualFiles.value = virtualFiles.value.filter(f => !missingResult.missing.includes(f.path));
                    }
                }

                let result;
                try {
                    result = await window.ModderTools.runQueuedModderOperation({
                        label: t('modder_tools.detect_override_files'),
                        operation: 'detect_overrides',
                        task: () => eel.detect_override_files(store.selectedGamePath)()
                    });
                } catch (e) {
                    window.showToast(String(e || t('modder_tools.error_detecting_overrides')), true);
                    store.isWorking.detectingOverrides = false;
                    return;
                }

                if (result.cancelled) {
                    window.showToast(t('modder_tools.override_detection_cancelled'));
                } else if (result.success) {
                    const addedCount = mergeVirtual(result.files);
                    if (addedCount === 0) window.showToast(t("modder_tools.no_new_override_files_found_in_the_sourc_a8f847"), true);
                    else window.showToast(t("modder_tools.count_override_file_s_successfully_detec_216c6d").replace("{count}", addedCount));
                } else {
                    window.showToast(t("modder_tools.error_detecting_overrides_error").replace("{error}", result.error), true);
                }
                store.isWorking.detectingOverrides = false;
            };

            const clearBuildFields = () => {
                const snapshot = {
                    title: build.title, author: build.author, version: build.version,
                    notes: build.notes, tags: [...build.tags],
                    preview: build.preview, previewName: build.previewName,
                    config: build.config, configName: build.configName, subtype: build.subtype
                };
                const files = [...virtualFiles.value];
                const hadContent = Boolean(
                    snapshot.title || snapshot.author || snapshot.notes || snapshot.subtype ||
                    snapshot.preview || snapshot.config || snapshot.tags.length || files.length
                );

                Object.assign(build, {
                    title: '', author: '', version: '1.0', notes: '', tags: [],
                    preview: '', previewName: '', config: '', configName: '', subtype: ''
                });
                virtualFiles.value = [];
                validationState.build = false;
                lastBuildOutputPath.value = '';

                if (!hadContent) return;
                window.showUndoToast(
                    t('modder_tools.build_fields_cleared'),
                    6,
                    () => {
                        Object.assign(build, { ...snapshot, tags: [...snapshot.tags] });
                        virtualFiles.value = files;
                    }
                );
            };

            const buildTMod = async () => {
                validationState.build = true;
                const title = build.title.trim();
                if (source.mode === 'folder' && !source.dir) return window.showToast(t('modder_tools.pick_a_source_folder_first'), true);
                if (/[<>:"/\\|?*]/.test(title)) return window.showToast(t("modder_tools.mod_title_contains_illegal_characters_pl_768e5c"), true);
                if (build.notes.trim().length > 220) return window.showToast(t("modder_tools.mod_notes_cannot_exceed_220_characters"), true);
                if (!title) return window.showToast(t("modder_tools.please_enter_a_mod_title"), true);
                if (!build.author.trim()) return window.showToast(t("modder_tools.please_enter_a_mod_author"), true);
                if (!build.version.trim()) return window.showToast(t("modder_tools.please_enter_a_mod_version"), true);
                if (!build.notes.trim()) return window.showToast(t("modder_tools.please_enter_mod_notes_or_a_description"), true);
                if (build.tags.length === 0) return window.showToast(t("modder_tools.please_select_at_least_one_tag"), true);
                if (activeFiles.value.length === 0) return window.showToast(t("modder_tools.please_add_at_least_one_file_to_your_mod"), true);
                if (buildValidationError.value) return window.showToast(t(buildValidationError.value), true);

                let outputPath = null;
                if (build.output === 'ask' || !store.selectedGamePath) {
                    outputPath = await eel.ask_tmod_save_path(title, pickerStartDir())();
                    if (!outputPath) return;
                }

                store.isWorking.buildingTMod = true;
                try {
                    const pathsToCheck = activeFiles.value.map(f => f.path);
                    if (pathsToCheck.length > 0) {
                        const missingResult = await eel.get_missing_files(pathsToCheck)();
                        if (missingResult.success && missingResult.missing && missingResult.missing.length > 0) {
                            if (source.mode === 'virtual') virtualFiles.value = virtualFiles.value.filter(f => !missingResult.missing.includes(f.path));
                            window.showToast(t("modder_tools.warning_count_file_s_were_missing_from_d_a16fd4").replace("{count}", missingResult.missing.length), true);
                            store.isWorking.buildingTMod = false;
                            if (source.mode === 'folder') scanFolder();
                            return;
                        }
                    }

                    const payload = {
                        gamePath: store.selectedGamePath || null,
                        outputPath,
                        overwrite: Boolean(outputPath),
                        title: title,
                        author: build.author.trim(),
                        version: build.version.trim(),
                        notes: build.notes.trim(),
                        tags: build.tags,
                        subtype: build.subtype || '',
                        previewBase64: build.preview || null,
                        previewName: build.previewName || "preview.png",
                        configBase64: build.config || null,
                        configName: build.configName || "config.cfg",
                        files: activeFiles.value.map(f => ({ internal_path: f.internal_path, abs_path: f.path }))
                    };

                    const runBuild = async (requestPayload) => window.ModderTools.runQueuedModderOperation({
                        label: t("modder_tools.build_tmod_name").replace('{name}', title),
                        operation: 'build_tmod',
                        task: () => eel.build_tmod(requestPayload)()
                    });

                    let result = await runBuild(payload);
                    if (!result.cancelled && !result.success && result.code === 'FILE_EXISTS') {
                        const overwriteConfirmed = await window.showConfirmModal({
                            title: t('modder_tools.overwrite_existing_tmod'),
                            message: t('modder_tools.a_file_with_this_name_already_exists_do_b77724'),
                            confirmLabel: t('common.overwrite'),
                            cancelLabel: t('common.cancel'),
                            danger: true
                        });

                        if (!overwriteConfirmed) {
                            store.isWorking.buildingTMod = false;
                            window.showToast(t('modder_tools.build_cancelled'));
                            return;
                        }

                        result = await runBuild({ ...payload, overwrite: true });
                    }

                    if (result.cancelled) {
                        window.showToast(t('modder_tools.build_cancelled'));
                        store.isWorking.buildingTMod = false;
                        return;
                    }
                    if (result.success) {
                        lastBuildOutputPath.value = result.path || '';
                        window.showToast(t("modder_tools.tmod_successfully_built_saved_to_path").replace("{path}", result.path), false);
                    }
                    else window.showToast(t("modder_tools.failed_to_build_tmod_error").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred_while_build_a03c95"), true);
                }
                store.isWorking.buildingTMod = false;
            };

            onMounted(() => {
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                setupNativeDrop();
                syncWatcher();
                if (source.mode === 'folder') scanFolder();
            });

            return {
                t, store, gameOptions, outputOptions, lastBuildOutputPath, build,
                source, folderFiles, virtualFiles, activeFiles, problems, dropActive,
                configDisplayName: window.ModderTools.configDisplayName,
                isBuildFieldInvalid,
                openSelectedGamePath, openBuildOutputFolder, openBuildFileLocation,
                chooseSourceDir, openSourceDir, setSourceMode, scanFolder, clearVirtualFiles, editFilePath,
                chooseBuildPreview, chooseBuildConfig, detectBuildOverrides, addBuildFiles, removeBuildFile, clearBuildFields, buildTMod
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);
    app.component('multi-select', window.MultiSelect);

    if (window._modderBuildApp) window._modderBuildApp.unmount();
    window._modderBuildApp = app;
    app.mount('#modder-build-vue-app-inner');
});
