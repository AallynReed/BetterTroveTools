document.addEventListener('modder_edit_tmod_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, onMounted, nextTick } = Vue;

    const app = createApp({
        setup() {
            const { store, t } = window.ModderTools;

            const editTmod = reactive({
                loaded: false,
                tmodPath: '',
                fileName: '',
                title: '',
                author: '',
                version: '1.0',
                notes: '',
                tags: [],
                subtype: '',
                files: [],
                preview: '',
                previewName: '',
                config: '',
                configName: ''
            });

            const validationState = reactive({
                editTmod: false
            });

            const previousEditTmodSnapshot = ref(null);
            const originalLoadedEditTmodSnapshot = ref(null);

            const resetEditTmod = () => {
                editTmod.loaded = false;
                editTmod.fileName = '';
                editTmod.title = '';
                editTmod.author = '';
                editTmod.version = '1.0';
                editTmod.notes = '';
                editTmod.tags = [];
                editTmod.subtype = '';
                editTmod.files = [];
                editTmod.preview = '';
                editTmod.previewName = '';
                editTmod.config = '';
                editTmod.configName = '';
            };

            const createEditTmodSnapshot = () => ({
                loaded: Boolean(editTmod.loaded),
                tmodPath: editTmod.tmodPath || '',
                fileName: editTmod.fileName || '',
                title: editTmod.title || '',
                author: editTmod.author || '',
                version: editTmod.version || '1.0',
                notes: editTmod.notes || '',
                tags: Array.isArray(editTmod.tags) ? [...editTmod.tags] : [],
                subtype: editTmod.subtype || '',
                files: Array.isArray(editTmod.files)
                    ? editTmod.files.map(file => ({ ...file }))
                    : [],
                preview: editTmod.preview || '',
                previewName: editTmod.previewName || '',
                config: editTmod.config || '',
                configName: editTmod.configName || ''
            });

            const applyEditTmodSnapshot = (snapshot) => {
                if (!snapshot || typeof snapshot !== 'object') return;
                editTmod.loaded = Boolean(snapshot.loaded);
                editTmod.tmodPath = snapshot.tmodPath || '';
                editTmod.fileName = snapshot.fileName || '';
                editTmod.title = snapshot.title || '';
                editTmod.author = snapshot.author || '';
                editTmod.version = snapshot.version || '1.0';
                editTmod.notes = snapshot.notes || '';
                editTmod.tags = Array.isArray(snapshot.tags) ? [...snapshot.tags] : [];
                editTmod.subtype = snapshot.subtype || '';
                editTmod.files = Array.isArray(snapshot.files)
                    ? snapshot.files.map(file => ({ ...file }))
                    : [];
                editTmod.preview = snapshot.preview || '';
                editTmod.previewName = snapshot.previewName || '';
                editTmod.config = snapshot.config || '';
                editTmod.configName = snapshot.configName || '';
            };

            const restorePreviousEditTmod = () => {
                if (!previousEditTmodSnapshot.value) return;
                applyEditTmodSnapshot(previousEditTmodSnapshot.value);
                window.showToast(t('modder_tools.previous_edit_tmod_session_restored'));
            };

            const cloneEditTmodFile = (file) => ({ ...file });
            const getActiveEditTmodFiles = (files = editTmod.files) => (files || []).filter(file => !file?.removed);

            const findOriginalEditTmodFile = (internalPath) => {
                const files = originalLoadedEditTmodSnapshot.value?.files || [];
                return files.find(file => window.ModderTools.normalizeInternalPath(file.internal_path) === window.ModderTools.normalizeInternalPath(internalPath)) || null;
            };

            const hasEditTmodFieldChanged = (field) => {
                const original = originalLoadedEditTmodSnapshot.value;
                if (!original) return false;
                switch (field) {
                    case 'title': return editTmod.title !== (original.title || '');
                    case 'author': return editTmod.author !== (original.author || '');
                    case 'version': return editTmod.version !== (original.version || '1.0');
                    case 'notes': return editTmod.notes !== (original.notes || '');
                    case 'tags': return JSON.stringify(editTmod.tags || []) !== JSON.stringify(original.tags || []);
                    case 'subtype': return (editTmod.subtype || '') !== (original.subtype || '');
                    case 'preview': return (editTmod.preview || '') !== (original.preview || '') || (editTmod.previewName || '') !== (original.previewName || '');
                    case 'config': return (editTmod.config || '') !== (original.config || '') || (editTmod.configName || '') !== (original.configName || '');
                    default: return false;
                }
            };

            const restoreEditTmodField = (field) => {
                const original = originalLoadedEditTmodSnapshot.value;
                if (!original) return;
                switch (field) {
                    case 'title':
                        editTmod.title = original.title || '';
                        break;
                    case 'author':
                        editTmod.author = original.author || '';
                        break;
                    case 'version':
                        editTmod.version = original.version || '1.0';
                        break;
                    case 'notes':
                        editTmod.notes = original.notes || '';
                        break;
                    case 'tags':
                        editTmod.tags = Array.isArray(original.tags) ? [...original.tags] : [];
                        break;
                    case 'subtype':
                        editTmod.subtype = original.subtype || '';
                        break;
                    case 'preview':
                        editTmod.preview = original.preview || '';
                        editTmod.previewName = original.previewName || '';
                        break;
                    case 'config':
                        editTmod.config = original.config || '';
                        editTmod.configName = original.configName || '';
                        break;
                    default:
                        return;
                }
                window.showToast(t('modder_tools.field_restored'));
            };

            const canRestoreOriginalEditTmodFile = (file) => {
                const original = findOriginalEditTmodFile(file?.internal_path);
                if (!original) return false;
                return JSON.stringify(file || {}) !== JSON.stringify(original);
            };

            const isEditTmodFileRemoved = (file) => Boolean(file?.removed);

            const restoreRemovedEditTmodFile = (file) => {
                const index = editTmod.files.findIndex(existing => window.ModderTools.normalizeInternalPath(existing.internal_path) === window.ModderTools.normalizeInternalPath(file.internal_path));
                if (index < 0) return;
                editTmod.files.splice(index, 1, { ...editTmod.files[index], removed: false });
                window.showToast(t('modder_tools.file_restored_to_in_memory_build'));
            };

            const restoreOriginalEditTmodFile = (file) => {
                const original = findOriginalEditTmodFile(file?.internal_path);
                if (!original) return;
                const index = editTmod.files.findIndex(existing => window.ModderTools.normalizeInternalPath(existing.internal_path) === window.ModderTools.normalizeInternalPath(file.internal_path));
                if (index < 0) return;
                editTmod.files.splice(index, 1, { ...cloneEditTmodFile(original), removed: false });
                window.showToast(t('modder_tools.original_file_restored_from_loaded_archi_0ae641'));
            };

            const editTmodValidationError = computed(() => window.ModderTools.validateSpecialFileSelections({
                files: getActiveEditTmodFiles(),
                previewName: editTmod.previewName,
                hasPreview: Boolean(editTmod.preview),
                hasConfig: Boolean(editTmod.config),
                title: editTmod.title
            }));

            const editTmodDisplayFiles = computed(() => {
                const files = Array.isArray(editTmod.files) ? editTmod.files : [];
                const activeFiles = [];
                const removedFiles = [];
                for (const file of files) {
                    if (file?.removed) {
                        removedFiles.push(file);
                    } else {
                        activeFiles.push(file);
                    }
                }
                return [...activeFiles, ...removedFiles];
            });

            const isEditTmodFieldInvalid = (field) => {
                if (!validationState.editTmod) return false;
                switch (field) {
                    case 'source': return !editTmod.tmodPath || !editTmod.loaded;
                    case 'title': return !editTmod.title.trim() || window.ModderTools.hasIllegalTitleChars(editTmod.title);
                    case 'author': return !editTmod.author.trim();
                    case 'version': return !editTmod.version.trim();
                    case 'notes': return !editTmod.notes.trim() || editTmod.notes.trim().length > 220;
                    case 'tags': return editTmod.tags.length === 0;
                    case 'files': return getActiveEditTmodFiles().length === 0 || Boolean(editTmodValidationError.value);
                    default: return false;
                }
            };

            const browseEditTmodSource = async () => {
                const fileResp = await eel.ask_tmod_file()();
                const file = fileResp?.value ?? fileResp?.data?.value ?? fileResp;
                if (!file) return;
                const priorSnapshot = (editTmod.loaded || editTmod.tmodPath || editTmod.title || editTmod.files.length)
                    ? createEditTmodSnapshot()
                    : null;
                if (priorSnapshot) previousEditTmodSnapshot.value = priorSnapshot;
                resetEditTmod();
                editTmod.tmodPath = file;
                await loadEditTmod();
                if (editTmod.loaded && priorSnapshot) {
                    window.showUndoToast(
                        t('modder_tools.loaded_a_new_tmod_restore_previous_in_me_60035d'),
                        10,
                        () => restorePreviousEditTmod()
                    );
                }
            };

            const loadEditTmod = async () => {
                validationState.editTmod = true;
                if (!editTmod.tmodPath) return window.showToast(t("modder_tools.please_select_a_source_tmod_file"), true);
                store.isWorking.loadingEditTmod = true;
                try {
                    const result = await eel.load_tmod_for_edit(editTmod.tmodPath)();
                    if (!result.success) {
                        window.showToast(t("modder_tools.failed_to_load_tmod_error").replace("{error}", result.error), true);
                        store.isWorking.loadingEditTmod = false;
                        return;
                    }

                    const data = result.data || {};
                    editTmod.loaded = true;
                    editTmod.tmodPath = data.tmodPath || editTmod.tmodPath;
                    editTmod.fileName = data.fileName || '';
                    editTmod.title = data.title || '';
                    editTmod.author = data.author || '';
                    editTmod.version = data.version || '1.0';
                    editTmod.notes = data.notes || '';
                    editTmod.tags = Array.isArray(data.tags) ? [...data.tags] : [];
                    editTmod.subtype = data.subtype || '';
                    editTmod.preview = data.previewBase64 || '';
                    editTmod.previewName = data.previewName || '';
                    editTmod.config = data.configBase64 || '';
                    editTmod.configName = data.configName || '';
                    editTmod.files = Array.isArray(data.files) ? data.files.map(file => ({
                        internal_path: file.internal_path,
                        name: file.name || '',
                        source: file.source || 'archive',
                        path: file.path || '',
                        data: file.data || '',
                        removed: false
                    })) : [];
                    originalLoadedEditTmodSnapshot.value = createEditTmodSnapshot();

                    window.showToast(t("modder_tools.tmod_loaded_into_memory_and_ready_to_edi_fd4dba"));
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred_while_loadi_340a61"), true);
                }
                store.isWorking.loadingEditTmod = false;
            };

            const chooseEditTmodPreview = async () => {
                if (!store.selectedGamePath) return window.showToast(t("modder_tools.please_select_a_target_game_installation_780071"), true);
                const result = await eel.ask_preview_file(store.selectedGamePath)();
                const file = result?.file;
                if (file) {
                    const previousPreview = editTmod.preview;
                    const previousPreviewName = editTmod.previewName;
                    const nextPreviewName = file.name;
                    const previewPath = window.ModderTools.normalizeInternalPath(window.ModderTools.previewInternalPath(editTmod.title, nextPreviewName));
                    if (editTmod.files.some(existing => window.ModderTools.normalizeInternalPath(existing.internal_path) === previewPath)) {
                        window.showToast(t("modder_tools.preview_image_path_cannot_also_be_includ_01ba5d"), true);
                        return;
                    }
                    editTmod.preview = file.data;
                    editTmod.previewName = nextPreviewName;
                    window.showUndoToast(
                        t('modder_tools.preview_updated_restore_previous_preview'),
                        8,
                        () => {
                            editTmod.preview = previousPreview;
                            editTmod.previewName = previousPreviewName;
                        }
                    );
                }
            };

            const chooseEditTmodConfig = async () => {
                if (!store.selectedGamePath) return window.showToast(t("modder_tools.please_select_a_target_game_installation_780071"), true);
                const result = await eel.ask_config_file(store.selectedGamePath)();
                const file = result?.file;
                if (file) {
                    const previousConfig = editTmod.config;
                    const previousConfigName = editTmod.configName;
                    editTmod.config = file.data;
                    editTmod.configName = window.ModderTools.configDisplayName(editTmod.title);
                    window.showUndoToast(
                        t('modder_tools.config_updated_restore_previous_config'),
                        8,
                        () => {
                            editTmod.config = previousConfig;
                            editTmod.configName = previousConfigName;
                        }
                    );
                }
            };

            const addEditTmodFiles = async () => {
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
                            const previousFiles = editTmod.files.map(cloneEditTmodFile);
                            const merged = [...editTmod.files];
                            result.files.forEach(f => {
                                const existingIndex = merged.findIndex(existing => window.ModderTools.normalizeInternalPath(existing.internal_path) === window.ModderTools.normalizeInternalPath(f.internal_path));
                                const nextFile = {
                                    internal_path: f.internal_path,
                                    name: f.internal_path.split('/').pop(),
                                    source: 'disk',
                                    path: f.path,
                                    data: '',
                                    removed: false
                                };
                                if (existingIndex >= 0) merged.splice(existingIndex, 1, nextFile);
                                else merged.push(nextFile);
                            });

                            const validationError = window.ModderTools.validateSpecialFileSelections({
                                files: merged,
                                previewName: editTmod.previewName,
                                hasPreview: Boolean(editTmod.preview),
                                hasConfig: Boolean(editTmod.config),
                                title: editTmod.title
                            });
                            if (validationError) {
                                window.showToast(t(validationError), true);
                                return;
                            }
                            editTmod.files = merged;
                            window.showUndoToast(
                                t('modder_tools.file_list_updated_restore_previous_file_f38f25'),
                                8,
                                () => {
                                    editTmod.files = previousFiles.map(cloneEditTmodFile);
                                }
                            );
                        }
                    }
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred_while_addin_86eef6"), true);
                }
            };

            const addEditTmodFilesFromTmod = async () => {
                if (!editTmod.loaded || !editTmod.tmodPath) return window.showToast(t("modder_tools.please_load_a_tmod_first"), true);
                try {
                    const fileResp = await eel.ask_tmod_file()();
                    const sourcePath = fileResp?.value ?? fileResp?.data?.value ?? fileResp;
                    if (!sourcePath) return;

                    const result = await eel.load_tmod_for_edit(sourcePath)();
                    if (!result.success) {
                        window.showToast(t("modder_tools.failed_to_read_source_tmod_error").replace("{error}", result.error), true);
                        return;
                    }

                    const importedFiles = Array.isArray(result.data?.files)
                        ? result.data.files.map(file => ({
                            internal_path: file.internal_path,
                            name: file.name || file.internal_path.split('/').pop(),
                            source: 'tmod',
                            imported_from: sourcePath,
                            path: '',
                            data: file.data || '',
                            removed: false
                        }))
                        : [];

                    if (importedFiles.length === 0) {
                        window.showToast(t("modder_tools.the_selected_tmod_has_no_regular_archive_bcf2ca"), true);
                        return;
                    }

                    const previousFiles = editTmod.files.map(cloneEditTmodFile);
                    const merged = [...editTmod.files];
                    let replaceAllRemaining = false;
                    for (const file of importedFiles) {
                        const existingIndex = merged.findIndex(existing => window.ModderTools.normalizeInternalPath(existing.internal_path) === window.ModderTools.normalizeInternalPath(file.internal_path));
                        if (existingIndex >= 0) {
                            if (!replaceAllRemaining) {
                                const decision = await window.showConfirmModal({
                                    title: t('modder_tools.file_conflict'),
                                    message: t("modder_tools.a_file_already_exists_at_path_keep_the_c_04ce6f").replace("{path}", file.internal_path).replace("{source}", sourcePath),
                                    confirmLabel: t('modder_tools.replace'),
                                    cancelLabel: t('modder_tools.keep_current'),
                                    extraActionLabel: t('modder_tools.replace_all_remaining'),
                                    danger: true
                                });
                                if (decision === false) {
                                    continue;
                                }
                                if (decision === 'extra') {
                                    replaceAllRemaining = true;
                                }
                            }
                            merged.splice(existingIndex, 1, file);
                        } else {
                            merged.push(file);
                        }
                    }

                    const validationError = window.ModderTools.validateSpecialFileSelections({
                        files: merged,
                        previewName: editTmod.previewName,
                        hasPreview: Boolean(editTmod.preview),
                        hasConfig: Boolean(editTmod.config),
                        title: editTmod.title
                    });
                    if (validationError) {
                        window.showToast(t(validationError), true);
                        return;
                    }

                    editTmod.files = merged;
                    window.showUndoToast(
                        t('modder_tools.imported_files_from_another_tmod_restore_37f81b'),
                        8,
                        () => {
                            editTmod.files = previousFiles.map(cloneEditTmodFile);
                        }
                    );
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred_while_impor_ccf24d"), true);
                }
            };

            const replaceEditTmodFile = async (targetFile) => {
                const result = await eel.ask_import_file(store.selectedGamePath || null)();
                const file = result?.file;
                if (!file) return;

                const index = editTmod.files.findIndex(existing => window.ModderTools.normalizeInternalPath(existing.internal_path) === window.ModderTools.normalizeInternalPath(targetFile.internal_path));
                if (index < 0) return;

                const previousFile = cloneEditTmodFile(editTmod.files[index]);
                editTmod.files.splice(index, 1, {
                    ...editTmod.files[index],
                    source: 'disk',
                    path: file.path,
                    data: file.data,
                    removed: false
                });
                window.showUndoToast(
                    t('modder_tools.file_replaced_restore_previous_file_data'),
                    8,
                    () => {
                        editTmod.files.splice(index, 1, previousFile);
                    }
                );
            };

            const removeEditTmodFile = (targetFile) => {
                editTmod.files = editTmod.files.map(file => {
                    if (window.ModderTools.normalizeInternalPath(file.internal_path) !== window.ModderTools.normalizeInternalPath(targetFile.internal_path)) return file;
                    return { ...file, removed: true };
                });
            };

            const saveEditTmod = async () => {
                validationState.editTmod = true;
                if (!editTmod.loaded || !editTmod.tmodPath) return window.showToast(t("modder_tools.please_load_a_tmod_first"), true);
                const title = editTmod.title.trim();
                if (/[<>:"/\\|?*]/.test(title)) return window.showToast(t("modder_tools.mod_title_contains_illegal_characters_pl_768e5c"), true);
                if (!title) return window.showToast(t("modder_tools.please_enter_a_mod_title"), true);
                if (!editTmod.author.trim()) return window.showToast(t("modder_tools.please_enter_a_mod_author"), true);
                if (!editTmod.version.trim()) return window.showToast(t("modder_tools.please_enter_a_mod_version"), true);
                if (!editTmod.notes.trim()) return window.showToast(t("modder_tools.please_enter_mod_notes_or_a_description"), true);
                if (editTmod.notes.trim().length > 220) return window.showToast(t("modder_tools.mod_notes_cannot_exceed_220_characters"), true);
                if (editTmod.tags.length === 0) return window.showToast(t("modder_tools.please_select_at_least_one_tag"), true);
                if (getActiveEditTmodFiles().length === 0) return window.showToast(t("modder_tools.please_keep_at_least_one_file_in_your_mo_a6ee09"), true);

                if (editTmodValidationError.value) return window.showToast(t(editTmodValidationError.value), true);

                store.isWorking.savingEditTmod = true;
                try {
                    const runSave = async (requestPayload) => window.ModderTools.runQueuedModderOperation({
                        label: t("modder_tools.compile_tmod_in_place_name").replace('{name}', title),
                        operation: 'build_tmod',
                        task: () => eel.save_tmod_in_place(requestPayload)()
                    });

                    const payload = {
                        tmodPath: editTmod.tmodPath,
                        title,
                        author: editTmod.author.trim(),
                        version: editTmod.version.trim(),
                        notes: editTmod.notes.trim(),
                        tags: [...editTmod.tags],
                        subtype: editTmod.subtype || '',
                        previewBase64: editTmod.preview || null,
                        previewName: editTmod.previewName || 'preview.png',
                        configBase64: editTmod.config || null,
                        files: getActiveEditTmodFiles().map(file => ({
                            internal_path: file.internal_path,
                            name: file.name || file.internal_path.split('/').pop(),
                            path: file.path || '',
                            data: file.data || ''
                        }))
                    };

                    let result = await runSave(payload);
                    if (!result.cancelled && !result.success && result.code === 'FILE_EXISTS') {
                        const overwriteConfirmed = await window.showConfirmModal({
                            title: t('modder_tools.overwrite_existing_tmod'),
                            message: t('modder_tools.a_file_with_the_title_based_file_name_al_bd480d'),
                            confirmLabel: t('common.overwrite'),
                            cancelLabel: t('common.cancel'),
                            danger: true
                        });

                        if (!overwriteConfirmed) {
                            store.isWorking.savingEditTmod = false;
                            window.showToast(t('modder_tools.tmod_compile_cancelled'));
                            return;
                        }

                        result = await runSave({ ...payload, overwrite: true });
                    }

                    if (result.cancelled) {
                        window.showToast(t('modder_tools.tmod_compile_cancelled'));
                        store.isWorking.savingEditTmod = false;
                        return;
                    }
                    if (result.success) {
                        editTmod.tmodPath = result.path || editTmod.tmodPath;
                        editTmod.fileName = result.fileName || editTmod.fileName;
                        window.showToast(t("modder_tools.tmod_successfully_compiled_in_place_save_04c434").replace("{path}", result.path));
                        await loadEditTmod();
                    } else {
                        window.showToast(t("modder_tools.failed_to_compile_tmod_error").replace("{error}", result.error), true);
                    }
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred_while_compi_69a943"), true);
                }
                store.isWorking.savingEditTmod = false;
            };

            onMounted(() => {
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
            });

            return {
                t, store, editTmod, editTmodDisplayFiles, previousEditTmodSnapshot,
                configDisplayName: window.ModderTools.configDisplayName,
                isEditTmodFieldInvalid, hasEditTmodFieldChanged, restoreEditTmodField, canRestoreOriginalEditTmodFile, restoreOriginalEditTmodFile, isEditTmodFileRemoved,
                browseEditTmodSource, loadEditTmod, restorePreviousEditTmod, restoreRemovedEditTmodFile, chooseEditTmodPreview, chooseEditTmodConfig, addEditTmodFiles, addEditTmodFilesFromTmod, replaceEditTmodFile, removeEditTmodFile, saveEditTmod
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);
    app.component('multi-select', window.MultiSelect);

    if (window._modderEditTmodApp) window._modderEditTmodApp.unmount();
    window._modderEditTmodApp = app;
    app.mount('#modder-edit-tmod-vue-app-inner');
});
