document.addEventListener('modder_projects_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;

    const app = createApp({
        setup() {
            const { store, t } = window.ModderTools;

            const gameOptions = computed(() => window.ModderTools.buildGameOptions());

            const lastCompiledProjectPath = ref('');

            const project = reactive({
                dir: '', title: '', author: '', notes: '', tags: [],
                subtype: '',
                versions: [], activeVersion: '', files: [],
                preview: '', previewName: '', config: '', configName: '', activeOverrides: []
            });

            const validationState = reactive({
                project: false
            });

            const projectValidationError = computed(() => window.ModderTools.validateSpecialFileSelections({
                files: project.files.map(file => ({ internal_path: file.rel_path })),
                previewName: project.previewName,
                hasPreview: Boolean(project.preview),
                hasConfig: Boolean(project.config),
                title: project.title
            }));

            const isProjectFieldInvalid = (field) => {
                if (!validationState.project) return false;
                switch (field) {
                    case 'dir': return !project.dir;
                    case 'gamePath': return !store.selectedGamePath;
                    case 'activeVersion': return !project.activeVersion;
                    case 'title': return !project.title.trim();
                    case 'notes': return project.notes.trim().length > 220;
                    case 'files': return Boolean(projectValidationError.value);
                    default: return false;
                }
            };

            const openSelectedGamePath = async () => {
                await window.ModderTools.openPathInExplorer(store.selectedGamePath);
            };

            const openProjectFolder = async () => {
                await window.ModderTools.openPathInExplorer(project.dir);
            };

            const openCompileOutputFolder = async () => {
                await window.ModderTools.openPathInExplorer(lastCompiledProjectPath.value);
            };

            const openProjectFileLocation = async (file) => {
                await window.ModderTools.openPathInExplorer(file?.abs_path);
            };

            const chooseProjectPreview = async () => {
                if (!store.selectedGamePath) return window.showToast(t("modder_tools.please_select_a_target_game_installation_780071"), true);
                const result = await eel.ask_preview_file(store.selectedGamePath)();
                const file = result?.file;
                if (file) {
                    const nextPreviewName = file.name;
                    const previewPath = window.ModderTools.normalizeInternalPath(window.ModderTools.previewInternalPath(nextPreviewName));
                    if (project.files.some(existing => window.ModderTools.normalizeInternalPath(existing.rel_path) === previewPath)) {
                        window.showToast(t("modder_tools.preview_image_path_cannot_also_be_includ_01ba5d"), true);
                        return;
                    }
                    project.preview = file.data;
                    project.previewName = nextPreviewName;
                }
            };

            const chooseProjectConfig = async () => {
                if (!store.selectedGamePath) return window.showToast(t("modder_tools.please_select_a_target_game_installation_780071"), true);
                const result = await eel.ask_config_file(store.selectedGamePath)();
                const file = result?.file;
                if (file) {
                    project.config = file.data;
                    project.configName = window.ModderTools.configDisplayName(project.title);
                }
            };

            const refreshProjectFiles = async () => {
                if (!project.dir || !project.activeVersion) return;
                store.isWorking.refreshProjectFiles = true;
                const result = await eel.get_project_files(project.dir, project.activeVersion)();
                if (result.success) project.files = result.files;
                store.isWorking.refreshProjectFiles = false;
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
                    project.subtype = result.data.subtype || '';
                    project.preview = result.data.previewBase64 || '';
                    project.previewName = result.data.previewName || '';
                    project.config = result.data.configBase64 || '';
                    project.configName = result.data.configName || '';

                    project.versions = result.data.versions || ["1.0"];
                    project.activeVersion = result.data.active_version || project.versions[0];
                } else {
                    window.showToast(t("modder_tools.error_loading_project_error").replace("{error}", result.error), true);
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
                if (project.notes.trim().length > 220) return window.showToast(t("modder_tools.project_notes_cannot_exceed_220_characte_d36d29"), true);

                const payload = {
                    title: project.title.trim(),
                    author: project.author.trim(),
                    notes: project.notes.trim(),
                    tags: project.tags,
                    subtype: project.subtype || '',
                    active_version: project.activeVersion,
                    previewBase64: project.preview || null,
                    previewName: project.previewName || "preview.png",
                    configBase64: project.config || null,
                    configName: project.config ? (project.configName || "config.cfg") : ""
                };

                const result = await eel.save_mod_project(project.dir, payload)();
                if (result.success) window.showToast(t("modder_tools.project_metadata_saved_successfully"));
                else window.showToast(t("modder_tools.error_saving_project_error").replace("{error}", result.error), true);
            };

            const newVersion = async () => {
                if (!project.dir) return;
                const nv = prompt(t("modder_tools.enter_new_version_number_e_g_1_1"));
                if (!nv) return;

                const result = await eel.create_project_version(project.dir, nv)();
                if (result.success) {
                    window.showToast(t("modder_tools.new_version_folder_created"));
                    await loadProjectData(project.dir);
                    project.activeVersion = nv;
                } else window.showToast(t("modder_tools.error_creating_version_error").replace("{error}", result.error), true);
            };

            const autoStructureProject = async () => {
                if (!project.dir || !project.activeVersion || !store.selectedGamePath) return window.showToast(t("modder_tools.ensure_a_project_version_and_game_path_a_abd5e3"), true);
                store.isWorking.autoStructuringProject = true;
                try {
                    const result = await window.ModderTools.runQueuedModderOperation({
                        label: t('modder_tools.auto_structure_project_version_files'),
                        operation: 'auto_structure_project',
                        task: () => eel.auto_structure_project_version(project.dir, project.activeVersion, store.selectedGamePath)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('modder_tools.project_auto_structure_cancelled'));
                        return;
                    }
                    if (result.success) {
                        window.showToast(t("modder_tools.successfully_structured_count_files").replace("{count}", result.count));
                        await refreshProjectFiles();
                    } else window.showToast(t("modder_tools.error_structuring_files_error").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred"), true);
                }
                store.isWorking.autoStructuringProject = false;
            };

            const compileProject = async () => {
                validationState.project = true;
                if (!project.dir || !project.activeVersion || !store.selectedGamePath) return window.showToast(t("modder_tools.ensure_a_project_version_and_game_path_a_abd5e3"), true);
                if (!project.title.trim()) return window.showToast(t("modder_tools.project_title_cannot_be_empty"), true);
                if (project.notes.trim().length > 220) return window.showToast(t("modder_tools.project_notes_cannot_exceed_220_characte_d36d29"), true);
                if (projectValidationError.value) return window.showToast(t(projectValidationError.value), true);

                await saveProject();

                store.isWorking.compilingProject = true;
                try {
                    const result = await window.ModderTools.runQueuedModderOperation({
                        label: t("modder_tools.compile_project_name").replace('{name}', project.title.trim() || t('modder_tools.untitled')),
                        operation: 'compile_project',
                        task: () => eel.compile_project(project.dir, project.activeVersion, store.selectedGamePath)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('modder_tools.project_compile_cancelled'));
                        store.isWorking.compilingProject = false;
                        return;
                    }
                    if (result.success) {
                        lastCompiledProjectPath.value = result.path || '';
                        window.showToast(t("modder_tools.project_successfully_compiled_saved_to_p_5e5598").replace("{path}", result.path), false);
                    }
                    else window.showToast(t("modder_tools.failed_to_compile_project_error").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred_while_compi_ad5dc7"), true);
                }
                store.isWorking.compilingProject = false;
            };

            const placeOverrides = async () => {
                if (!project.dir || !project.activeVersion || !store.selectedGamePath) return window.showToast(t("modder_tools.ensure_a_project_version_and_game_path_a_abd5e3"), true);
                store.isWorking.placingOverrides = true;
                try {
                    const result = await window.ModderTools.runQueuedModderOperation({
                        label: t('modder_tools.place_project_overrides_into_game'),
                        operation: 'place_overrides',
                        task: () => eel.place_project_overrides(project.dir, project.activeVersion, store.selectedGamePath)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('modder_tools.placing_overrides_cancelled'));
                        store.isWorking.placingOverrides = false;
                        return;
                    }
                    if (result.success) {
                        if (result.count === 0) window.showToast(t("modder_tools.no_valid_files_found_to_test"));
                        else {
                            project.activeOverrides = result.placed_files;
                            window.showToast(t("modder_tools.count_files_placed_in_game_overrides_for_ea0d0d").replace("{count}", result.count));
                        }
                    } else window.showToast(t("modder_tools.error_placing_overrides_error").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred"), true);
                }
                store.isWorking.placingOverrides = false;
            };

            const removeOverrides = async () => {
                if (project.activeOverrides.length === 0) return;
                const confirmed = await window.showConfirmModal({
                    title: t('modder_tools.remove_overrides'),
                    message: t('modder_tools.remove_all_currently_placed_override_fil_f2f7f6'),
                    confirmLabel: t('modder_tools.remove'),
                    cancelLabel: t('common.cancel'),
                    danger: true
                });
                if (!confirmed) return;

                store.isWorking.removingOverrides = true;
                try {
                    const removedSnapshot = [...project.activeOverrides];
                    const result = await window.ModderTools.runQueuedModderOperation({
                        label: t('modder_tools.remove_project_overrides_from_game'),
                        operation: 'remove_overrides',
                        task: () => eel.remove_project_overrides(project.activeOverrides)()
                    });
                    if (result.cancelled) {
                        if (result.undo_token) {
                            window.showUndoToast(
                                t('modder_tools.removal_cancelled_restore_removed_files'),
                                10,
                                async () => {
                                    const undoResult = await eel.undo_remove_project_overrides(result.undo_token)();
                                    if (!undoResult.success) {
                                        window.showToast(t('common.undo_failed_error').replace('{error}', undoResult.error || t('common.unknown_error_occurred')), true);
                                        return;
                                    }
                                    project.activeOverrides = removedSnapshot;
                                    window.showToast(t('modder_tools.overrides_restored'));
                                }
                            );
                        }
                        window.showToast(t('modder_tools.removing_overrides_cancelled'));
                        store.isWorking.removingOverrides = false;
                        return;
                    }
                    if (result.success) {
                        window.showToast(t("modder_tools.count_override_files_successfully_remove_53725e").replace("{count}", result.count));
                        project.activeOverrides = [];

                        if (result.undo_token) {
                            window.showUndoToast(
                                t('modder_tools.overrides_removed'),
                                10,
                                async () => {
                                    const undoResult = await eel.undo_remove_project_overrides(result.undo_token)();
                                    if (!undoResult.success) {
                                        window.showToast(t('common.undo_failed_error').replace('{error}', undoResult.error || t('common.unknown_error_occurred')), true);
                                        return;
                                    }
                                    if (undoResult.restored > 0) {
                                        project.activeOverrides = removedSnapshot;
                                    }
                                    if (undoResult.conflicts && undoResult.conflicts.length > 0) {
                                        window.showToast(t('modder_tools.undo_completed_with_conflicts_for_existi_d69170'), true);
                                    } else {
                                        window.showToast(t('modder_tools.overrides_restored'));
                                    }
                                }
                            );
                        }
                    } else window.showToast(t("modder_tools.error_removing_overrides_error").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred"), true);
                }
                store.isWorking.removingOverrides = false;
            };

            onMounted(() => {
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
            });

            return {
                t, store, gameOptions, lastCompiledProjectPath, project,
                configDisplayName: window.ModderTools.configDisplayName,
                isProjectFieldInvalid,
                openSelectedGamePath, openProjectFolder, openCompileOutputFolder, openProjectFileLocation,
                chooseProjectPreview, chooseProjectConfig, refreshProjectFiles, browseProject, saveProject, newVersion, autoStructureProject, compileProject, placeOverrides, removeOverrides
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);
    app.component('multi-select', window.MultiSelect);

    if (window._modderProjectsApp) window._modderProjectsApp.unmount();
    window._modderProjectsApp = app;
    app.mount('#modder-projects-vue-app-inner');
});
