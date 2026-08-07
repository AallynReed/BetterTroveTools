document.addEventListener('modder_build_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, onMounted, nextTick } = Vue;

    const app = createApp({
        setup() {
            const { store, t } = window.ModderTools;

            const gameOptions = computed(() => window.ModderTools.buildGameOptions());

            const lastBuildOutputPath = ref('');

            const build = reactive({
                title: '', author: '', version: '1.0', notes: '', tags: [], files: [],
                preview: '', previewName: '', config: '', configName: '', subtype: ''
            });

            const validationState = reactive({
                build: false
            });

            const buildValidationError = computed(() => window.ModderTools.validateSpecialFileSelections({
                files: build.files,
                previewName: build.previewName,
                hasPreview: Boolean(build.preview),
                hasConfig: Boolean(build.config),
                title: build.title
            }));

            const isBuildFieldInvalid = (field) => {
                if (!validationState.build) return false;
                switch (field) {
                    case 'gamePath': return !store.selectedGamePath;
                    case 'title': return !build.title.trim() || window.ModderTools.hasIllegalTitleChars(build.title);
                    case 'author': return !build.author.trim();
                    case 'version': return !build.version.trim();
                    case 'notes': return !build.notes.trim() || build.notes.trim().length > 220;
                    case 'tags': return build.tags.length === 0;
                    case 'files': return build.files.length === 0 || Boolean(buildValidationError.value);
                    default: return false;
                }
            };

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
                if (!store.selectedGamePath) return window.showToast(t("modder_tools.please_select_a_target_game_installation_780071"), true);
                const result = await eel.ask_preview_file(store.selectedGamePath)();
                const file = result?.file;
                if (file) {
                    const nextPreviewName = file.name;
                    const previewPath = window.ModderTools.normalizeInternalPath(window.ModderTools.previewInternalPath(nextPreviewName));
                    if (build.files.some(existing => window.ModderTools.normalizeInternalPath(existing.internal_path) === previewPath)) {
                        window.showToast(t("modder_tools.preview_image_path_cannot_also_be_includ_01ba5d"), true);
                        return;
                    }
                    build.preview = file.data;
                    build.previewName = nextPreviewName;
                }
            };

            const chooseBuildConfig = async () => {
                if (!store.selectedGamePath) return window.showToast(t("modder_tools.please_select_a_target_game_installation_780071"), true);
                const result = await eel.ask_config_file(store.selectedGamePath)();
                const file = result?.file;
                if (file) {
                    build.config = file.data;
                    build.configName = window.ModderTools.configDisplayName(build.title);
                }
            };

            const detectBuildOverrides = async () => {
                if (!store.selectedGamePath) return window.showToast(t("modder_tools.please_select_a_target_game_installation_780071"), true);

                store.isWorking.detectingOverrides = true;

                const pathsToCheck = build.files.map(f => f.path);
                if (pathsToCheck.length > 0) {
                    const missingResult = await eel.get_missing_files(pathsToCheck)();
                    if (missingResult.success && missingResult.missing) {
                        build.files = build.files.filter(f => !missingResult.missing.includes(f.path));
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
                    store.isWorking.detectingOverrides = false;
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
                    const validationError = window.ModderTools.validateSpecialFileSelections({
                        files: build.files,
                        previewName: build.previewName,
                        hasPreview: Boolean(build.preview),
                        hasConfig: Boolean(build.config),
                        title: build.title
                    });
                    if (validationError) {
                        build.files = build.files.filter(file => !result.files.some(added => added.path === file.path));
                        window.showToast(t(validationError), true);
                        store.isWorking.detectingOverrides = false;
                        return;
                    }
                    if (addedCount === 0) window.showToast(t("modder_tools.no_new_override_files_found_in_the_sourc_a8f847"), true);
                    else window.showToast(t("modder_tools.count_override_file_s_successfully_detec_216c6d").replace("{count}", addedCount));
                } else {
                    window.showToast(t("modder_tools.error_detecting_overrides_error").replace("{error}", result.error), true);
                }
                store.isWorking.detectingOverrides = false;
            };

            const addBuildFiles = async () => {
                if (!store.selectedGamePath) return window.showToast(t("modder_tools.please_select_a_target_game_installation_780071"), true);
                try {
                    const result = await eel.ask_add_files(store.selectedGamePath)();
                    if (result && result.success) {
                        if (result.rejected && result.rejected.length > 0) {
                            window.showToast(t("modder_tools.denied_count_file_s_selected_files_must_6dca21").replace("{count}", result.rejected.length), true);
                        }
                        if (result.rejected_cfg && result.rejected_cfg.length > 0) {
                            window.showToast(t("modder_tools.denied_count_file_s_cfg_files_must_be_ad_7eabd1").replace("{count}", result.rejected_cfg.length), true);
                        }
                        if (result.files && result.files.length > 0) {
                            const newFiles = [];
                            result.files.forEach(f => {
                                if (!build.files.find(existing => existing.path === f.path)) {
                                    newFiles.push({ internal_path: f.internal_path, path: f.path });
                                }
                            });
                            build.files.push(...newFiles);
                            const validationError = window.ModderTools.validateSpecialFileSelections({
                                files: build.files,
                                previewName: build.previewName,
                                hasPreview: Boolean(build.preview),
                                hasConfig: Boolean(build.config),
                                title: build.title
                            });
                            if (validationError) {
                                build.files = build.files.filter(file => !newFiles.some(added => added.path === file.path));
                                window.showToast(t(validationError), true);
                            }
                        }
                    }
                } catch (e) {
                    window.showToast(t("modder_tools.an_error_occurred_while_adding_files"), true);
                }
            };

            const removeBuildFile = (file) => {
                build.files = build.files.filter(f => f.path !== file.path);
                window.showUndoToast(
                    t('modder_tools.removed_file_from_build_list'),
                    6,
                    () => {
                        if (!build.files.find(f => f.path === file.path)) {
                            build.files.push(file);
                        }
                    }
                );
            };

            const autoStructureBuild = async () => {
                if (!store.selectedGamePath) return window.showToast(t("modder_tools.please_select_a_target_game_installation_780071"), true);
                store.isWorking.autoStructuringBuild = true;
                try {
                    const result = await window.ModderTools.runQueuedModderOperation({
                        label: t('modder_tools.auto_structure_build_workspace_files'),
                        operation: 'auto_structure_workspace',
                        task: () => eel.auto_structure_workspace(store.selectedGamePath, store.selectedGamePath)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('modder_tools.auto_structure_cancelled'));
                        return;
                    }
                    if (result.success) window.showToast(t("modder_tools.successfully_auto_structured_count_files").replace("{count}", result.count));
                    else window.showToast(t("modder_tools.error_structuring_files_error").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred_while_struc_cc3923"), true);
                }
                store.isWorking.autoStructuringBuild = false;
            };

            const buildTMod = async () => {
                validationState.build = true;
                if (!store.selectedGamePath) return window.showToast(t("modder_tools.please_select_a_target_game_installation"), true);
                const title = build.title.trim();
                if (/[<>:"/\\|?*]/.test(title)) return window.showToast(t("modder_tools.mod_title_contains_illegal_characters_pl_768e5c"), true);
                if (build.notes.trim().length > 220) return window.showToast(t("modder_tools.mod_notes_cannot_exceed_220_characters"), true);
                if (!title) return window.showToast(t("modder_tools.please_enter_a_mod_title"), true);
                if (!build.author.trim()) return window.showToast(t("modder_tools.please_enter_a_mod_author"), true);
                if (!build.version.trim()) return window.showToast(t("modder_tools.please_enter_a_mod_version"), true);
                if (!build.notes.trim()) return window.showToast(t("modder_tools.please_enter_mod_notes_or_a_description"), true);
                if (build.tags.length === 0) return window.showToast(t("modder_tools.please_select_at_least_one_tag"), true);
                if (build.files.length === 0) return window.showToast(t("modder_tools.please_add_at_least_one_file_to_your_mod"), true);
                if (buildValidationError.value) return window.showToast(t(buildValidationError.value), true);

                store.isWorking.buildingTMod = true;
                try {
                    const pathsToCheck = build.files.map(f => f.path);
                    if (pathsToCheck.length > 0) {
                        const missingResult = await eel.get_missing_files(pathsToCheck)();
                        if (missingResult.success && missingResult.missing && missingResult.missing.length > 0) {
                            build.files = build.files.filter(f => !missingResult.missing.includes(f.path));
                            window.showToast(t("modder_tools.warning_count_file_s_were_missing_from_d_a16fd4").replace("{count}", missingResult.missing.length), true);
                            store.isWorking.buildingTMod = false;
                            return;
                        }
                    }

                    const payload = {
                        gamePath: store.selectedGamePath,
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
                        files: build.files.map(f => ({ internal_path: f.internal_path, abs_path: f.path }))
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
            });

            return {
                t, store, gameOptions, lastBuildOutputPath, build,
                configDisplayName: window.ModderTools.configDisplayName,
                isBuildFieldInvalid,
                openSelectedGamePath, openBuildOutputFolder, openBuildFileLocation,
                chooseBuildPreview, chooseBuildConfig, detectBuildOverrides, addBuildFiles, removeBuildFile, autoStructureBuild, buildTMod
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);
    app.component('multi-select', window.MultiSelect);

    if (window._modderBuildApp) window._modderBuildApp.unmount();
    window._modderBuildApp = app;
    app.mount('#modder-build-vue-app-inner');
});
