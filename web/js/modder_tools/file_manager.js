document.addEventListener('file_manager_loaded', () => {
    console.log("High-Performance File Manager Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }
    
    const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
            const PREF_STATE_KEY = 'state_file_manager';
            let hydratingState = false;

            const activeTab = ref('tab-explorer');
            
            const installs = ref([]);
            const installOptions = computed(() => {
                if (installs.value.length === 0) return [[t('common.searching'), '']];
                return installs.value.map(g => [
                    t('common.name_path')
                        .replace('{name}', t(g.name))
                        .replace('{path}', g.path),
                    g.path
                ]);
            });
            const selectedInstall = ref('');
            const selectedTrackerGame = ref('');
            const toursEnabled = window.BTT_ENABLE_ONBOARDING_TOURS !== false;
            const showOnboardingTips = ref(toursEnabled && (window.AppSettings ? window.AppSettings.getPref('onboarding_file_manager_explorer_v1', '') !== 'dismissed' : true));
            const showTrackerOnboardingTips = ref(toursEnabled && (window.AppSettings ? window.AppSettings.getPref('onboarding_file_manager_tracker_v1', '') !== 'dismissed' : true));
            const showSearchShortcutHint = ref(window.AppSettings ? window.AppSettings.getPref('hint_file_manager_search_shortcuts_v1', '') !== 'dismissed' : true);

            const treeContainerRef = ref(null);
            const isTreeLoaded = ref(false);
            const isLoadingTree = ref(false);
            const treePlaceholderText = ref(t('file_manager.select_a_game_installation_to_view_files'));
            let fileCache = [];
            let fullFileTree = {};
            let fileIdCounter = 0;
            let totalFileBytes = 0;
            let bulkSelectionMode = 'none';
            let bulkSelectionExceptions = new Set();
            
            const isSearching = ref(false);
            const isSearchPending = ref(false);
            const isSelectionPending = ref(false);
            const searchQuery = ref('');
            const searchCountText = ref('');
            let searchTimeout = null;

            const selectedFilesCount = ref(0);
            const selectedFilesSize = ref(0);
            const isMassExtracting = ref(false);
            const progress = reactive({
                active: false,
                percent: 0,
                filename: '',
                elapsed: '',
                eta: '',
                status: '',
                detailsOpen: false
            });
            const activeJobId = ref(null);

            const trackingDirs = ref([]);
            const trackingDirOptions = computed(() => {
                if (trackingDirs.value.length === 0) return [[t('file_manager.no_paths_saved_add_one'), '']];
                return trackingDirs.value.map(d => {
                    let text = `${d.name} (${d.path})`;
                    if (d.last_used) text += ` - ${t("file_manager.last_used")} ${timeSince(d.last_used)}`;
                    return [text, d.path];
                });
            });
            const selectedTrackingDir = ref('');
            const runCatalogMode = ref(false);
            const showTrackerAdvanced = ref(false);
            const searchMatchIds = ref([]);
            const activeSearchMatchIndex = ref(-1);
            const isTrackerWorking = computed(() => trackerStatus.isBuilding || trackerStatus.isScanning);
            const isExplorerWorking = computed(() => isLoadingTree.value || isMassExtracting.value);
            const isAnyOperationRunning = computed(() => isExplorerWorking.value || isTrackerWorking.value);
            
            const trackerStatus = reactive({
                state: 'empty', // 'empty', 'none', 'baseline'
                text: t('file_manager.select_a_tracking_directory_to_continue'),
                subText: '',
                isBuilding: false,
                isScanning: false
            });

            const trackerStatusColor = computed(() => {
                if (trackerStatus.state === 'empty') return 'var(--text-main)';
                if (trackerStatus.state === 'baseline') return '#28a745';
                return '#e8b031';
            });

            const trackerNextAction = computed(() => {
                if (!selectedTrackerGame.value) return t('file_manager.next_step_pick_trove_path');
                if (!selectedTrackingDir.value) return t('file_manager.next_step_pick_tracking_folder');
                if (trackerStatus.state !== 'baseline') return t('file_manager.next_step_build_baseline_cache');
                return t('file_manager.next_step_scan_extract_updates');
            });

            const modals = reactive({ addTracker: false });
            const newTrackerForm = reactive({ name: '', path: '' });
            const isBrowsingTracker = ref(false);

            const timeSince = (dateString) => {
                if (!dateString) return "";
                const date = new Date(dateString);
                const seconds = Math.floor((new Date() - date) / 1000);
                let interval = seconds / 31536000;
                if (interval > 1) return Math.floor(interval) + " " + t("file_manager.years_ago");
                interval = seconds / 2592000;
                if (interval > 1) return Math.floor(interval) + " " + t("file_manager.months_ago");
                interval = seconds / 86400;
                if (interval > 1) return Math.floor(interval) + " " + t("file_manager.days_ago");
                interval = seconds / 3600;
                if (interval > 1) return Math.floor(interval) + " " + t("file_manager.hours_ago");
                interval = seconds / 60;
                if (interval > 1) return Math.floor(interval) + " " + t("file_manager.minutes_ago");
                return t("common.just_now");
            };

            const formatTime = (totalSeconds) => {
                if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds)) return "";
                const m = Math.floor(totalSeconds / 60);
                const s = Math.floor(totalSeconds % 60);
                const mStr = t("common.count_minutes").replace("{count}", m);
                const sStr = t("file_manager.count_seconds").replace("{count}", s);
                if (m > 0) return `${mStr} ${sStr}`;
                return sStr;
            };

            window._fmAppUpdateProgress = (current, total, filename, statusKey, etaSeconds, elapsedSeconds) => {
                progress.percent = total > 0 ? Math.round((current / total) * 100) : 0;
                progress.filename = filename || "";
                progress.status = statusKey ? t(statusKey) : '';
                progress.elapsed = (elapsedSeconds !== null && elapsedSeconds !== "") ? formatTime(elapsedSeconds) : '';
                progress.eta = (etaSeconds !== null && etaSeconds !== "") ? formatTime(etaSeconds) : '';

                if (activeJobId.value && window.JobQueue && window.JobQueue.patch) {
                    window.JobQueue.patch(activeJobId.value, {
                        meta: {
                            progressPercent: progress.percent,
                            current: progress.filename,
                            status: progress.status,
                            elapsed: progress.elapsed,
                            eta: progress.eta
                        }
                    });
                }
            };

            const runQueuedFileManagerOperation = async ({ label, operation, task }) => {
                return window.JobQueue.run({
                    label,
                    task,
                    retryTask: task,
                    cancel: async () => {
                        const cancelRaw = await eel.cancel_file_manager_operation(operation)();
                        const cancelResp = window.normalizeApiResponse ? window.normalizeApiResponse(cancelRaw) : cancelRaw;
                        if (!cancelResp || !cancelResp.success) {
                            throw new Error(cancelResp?.error || t('file_manager.failed_to_send_cancel_request'));
                        }
                    },
                    onStart: (id) => {
                        activeJobId.value = id;
                    }
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

            const applyStateSnapshot = (saved) => {
                if (!saved || typeof saved !== 'object') return;
                // activeTab (explorer vs tracker) is owned by the modder_tools
                // orchestrator via the `file_manager_set_tab` sync — NOT restored
                // here, so the embedded tab can never desync from the modder tab.
                if (typeof saved.selectedInstall === 'string') selectedInstall.value = saved.selectedInstall;
                if (typeof saved.selectedTrackerGame === 'string') selectedTrackerGame.value = saved.selectedTrackerGame;
                if (typeof saved.selectedTrackingDir === 'string') selectedTrackingDir.value = saved.selectedTrackingDir;
                if (saved.runCatalogMode !== undefined) runCatalogMode.value = !!saved.runCatalogMode;
                if (saved.showTrackerAdvanced !== undefined) showTrackerAdvanced.value = !!saved.showTrackerAdvanced;
            };

            const persistState = () => {
                if (hydratingState || !window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    activeTab: activeTab.value,
                    selectedInstall: selectedInstall.value,
                    selectedTrackerGame: selectedTrackerGame.value,
                    selectedTrackingDir: selectedTrackingDir.value,
                    runCatalogMode: runCatalogMode.value,
                    showTrackerAdvanced: showTrackerAdvanced.value
                });
            };

            const scanForGames = async () => {
                if (isAnyOperationRunning.value) {
                    window.showToast(t('file_manager.please_wait_for_the_current_operation_to_5a80ba'), true);
                    return;
                }
                try {
                    const response = await eel.get_detected_game_paths()();
                    const settings = await readSettings();
                    const paths = unwrapResponse(response, 'paths', []);
                    const safePaths = Array.isArray(paths) ? paths : [];

                    if (safePaths.length > 0) {
                        installs.value = safePaths;
                        if (settings.last_game_path && installs.value.some(p => p.path === settings.last_game_path)) {
                            selectedInstall.value = settings.last_game_path;
                            selectedTrackerGame.value = settings.last_game_path;
                        } else {
                            selectedInstall.value = installs.value[0].path;
                            selectedTrackerGame.value = installs.value[0].path;
                        }
                        return;
                    }

                    installs.value = [];
                    selectedInstall.value = '';
                    selectedTrackerGame.value = '';
                    if (response && response.error) {
                        window.showToast(t('common.game_path_detection_failed_error').replace('{error}', response.error), true);
                    }
                } catch (error) {
                    installs.value = [];
                    selectedInstall.value = '';
                    selectedTrackerGame.value = '';
                    window.showToast(t('common.game_path_detection_failed'), true);
                }
            };

            watch(selectedInstall, async (newVal) => {
                if (!newVal) return;
                const settings = await readSettings();
                settings.last_game_path = newVal;
                selectedTrackerGame.value = newVal;
                await eel.save_settings(settings)();
            });
            watch(selectedTrackerGame, async (newVal) => {
                if (!newVal) return;
                const settings = await readSettings();
                settings.last_game_path = newVal;
                selectedInstall.value = newVal;
                await eel.save_settings(settings)();
            });

            const openPathInExplorer = async (path) => {
                if (!path) {
                    window.showToast(t('common.no_path_selected'), true);
                    return;
                }
                const response = await eel.open_path_in_explorer(path)();
                if (!response || !response.success) {
                    window.showToast(t('common.failed_to_open_folder_error').replace('{error}', response?.error || t('common.unknown_error_occurred')), true);
                }
            };

            const openSelectedInstallFolder = async () => {
                await openPathInExplorer(selectedInstall.value);
            };

            const openSelectedTrackerGameFolder = async () => {
                await openPathInExplorer(selectedTrackerGame.value);
            };

            const openSelectedTrackingDirFolder = async () => {
                await openPathInExplorer(selectedTrackingDir.value);
            };

            const loadTree = async () => {
                if (!selectedInstall.value) return window.showToast(t("common.select_a_game_first"), true);
                if (isAnyOperationRunning.value && !isLoadingTree.value) {
                    return window.showToast(t('file_manager.please_wait_for_the_current_operation_to_5a80ba'), true);
                }
                isLoadingTree.value = true;
                isTreeLoaded.value = false;
                treePlaceholderText.value = t("file_manager.parsing") + " " + selectedInstall.value + "...";
                if (treeContainerRef.value) treeContainerRef.value.innerHTML = '';
                
                fileCache = [];
                fileIdCounter = 0;
                totalFileBytes = 0;
                fullFileTree = {};
                bulkSelectionMode = 'none';
                bulkSelectionExceptions = new Set();
                searchQuery.value = '';
                isSearching.value = false;
                isSearchPending.value = false;
                selectedFilesCount.value = 0;
                selectedFilesSize.value = 0;

                try {
                    const response = await runQueuedFileManagerOperation({
                        label: t('file_manager.load_game_archive_tree'),
                        operation: 'load_tree',
                        task: () => eel.load_entire_game_tree(selectedInstall.value)()
                    });
                    if (response.cancelled) {
                        treePlaceholderText.value = t('file_manager.archive_loading_cancelled');
                        window.showToast(t('file_manager.archive_loading_cancelled'));
                        return;
                    }
                    if (response.success) {
                        const cacheFile = response.cached_file || response?.data?.cached_file || '/api/cache/temp_tree.json';
                        const fetchRes = await fetch(cacheFile + '?t=' + new Date().getTime());
                        if (!fetchRes.ok) {
                            throw new Error(t('file_manager.failed_to_read_archive_cache_file'));
                        }
                        fullFileTree = await fetchRes.json();
                        
                        // Iterative walk: large game installs can hold hundreds of
                        // thousands of files. The previous recursion built a fresh
                        // closure per folder and pushed deep call stacks, which
                        // showed up as 1-2 s of "Load tree" stutter on the largest
                        // installs. An explicit stack with one allocation per node
                        // keeps the work in tight loops the JIT can unroll.
                        const stack = [{ node: fullFileTree, path: '' }];
                        while (stack.length > 0) {
                            const { node, path } = stack.pop();
                            const files = node.files;
                            if (files) {
                                for (let i = 0; i < files.length; i++) {
                                    const fileNode = files[i];
                                    const id = `f-${fileIdCounter++}`;
                                    const fullPath = path ? `${path}/${fileNode.name}` : fileNode.name;
                                    fileNode.id = id;
                                    fileNode.fullPath = fullPath;
                                    const size = fileNode.size || 0;
                                    totalFileBytes += size;
                                    fileCache.push({
                                        id,
                                        name: fileNode.name.toLowerCase(),
                                        path: fullPath.toLowerCase(),
                                        fullPath,
                                        archive: fileNode.archive_index,
                                        offset: fileNode.offset,
                                        tfi: fileNode.tfi_parent,
                                        size,
                                    });
                                }
                            }
                            const children = node.children;
                            if (children) {
                                for (const key in children) {
                                    stack.push({ node: children[key], path: path ? `${path}/${key}` : key });
                                }
                            }
                        }

                        renderLazyTree(fullFileTree, treeContainerRef.value);
                        isTreeLoaded.value = true;
                        treePlaceholderText.value = t("file_manager.select_a_game_installation_to_view_files");
                    } else {
                        const errorMessage = response.error || t("file_manager.unknown_error");
                        treePlaceholderText.value = t("file_manager.error_parsing_game_tree") + " " + errorMessage;
                        window.showToast(t("file_manager.error_parsing_game_tree") + " " + errorMessage, true);
                    }
                } catch (error) {
                    const errorMessage = String(error && error.message ? error.message : error || t('file_manager.unknown_error'));
                    treePlaceholderText.value = t("file_manager.error_loading_parsed_game_files") + " " + errorMessage;
                    window.showToast(t("file_manager.error_loading_parsed_game_files") + " " + errorMessage, true);
                } finally {
                    isLoadingTree.value = false;
                }
            };

            const getNodeFromPath = (path) => {
                if (!path) return fullFileTree;
                const parts = path.split('/');
                let currentNode = fullFileTree;
                for (const part of parts) {
                    if (currentNode && currentNode.children && currentNode.children[part]) {
                        currentNode = currentNode.children[part];
                    } else {
                        return null;
                    }
                }
                return currentNode;
            };

            const buildFolderHTML = (name, node, fullPath) => {
                const dirCount = node.dir_count_total || 0;
                const fileCount = node.file_count_total || 0;
                const meta = `(${dirCount} ${t('file_manager.dirs')}, ${fileCount} ${t('file_manager.files_a1f13b')})`;
                return `<details class="folder" data-path="${fullPath}">
                    <summary>
                        <div class="checkbox-container">
                            <input type="checkbox" class="folder-check">
                            <span><i class="fa-solid fa-folder"></i> ${name}</span>
                        </div>
                        <span class="folder-meta">${meta}</span>
                    </summary>
                    <div class="folder-content"><div class="lazy-placeholder">${t("file_manager.loading")}</div></div>
                </details>`;
            };

            const buildFilesGroupHTML = (node, fullPath) => {
                const fileCount = node.file_count_direct || 0;
                if (fileCount === 0) return '';
                return `<details class="files-group" data-path="${fullPath}" data-is-files-group="true">
                    <summary>
                        <div class="checkbox-container">
                            <input type="checkbox" class="folder-check">
                            <span><i class="fa-regular fa-folder-open"></i> ${t("file_manager.files")} (${fileCount})</span>
                        </div>
                    </summary>
                    <div class="folder-content"><div class="lazy-placeholder">${t("file_manager.loading")}</div></div>
                </details>`;
            };

            const buildFileItemHTML = (fileNode, fullPath) => {
                const id = fileNode.id;
                const sizeStr = fileNode.size > 1048576 ? (fileNode.size / 1048576).toFixed(2) + ' MB' : (fileNode.size / 1024).toFixed(2) + ' KB';
                const isChecked = bulkSelectionMode === 'all' && !bulkSelectionExceptions.has(fullPath);
                return `<div class="file-item" id="${id}">
                    <div class="checkbox-container">
                        <input type="checkbox" class="file-check" ${isChecked ? 'checked' : ''} data-archive="${fileNode.archive_index}" data-offset="${fileNode.offset}" data-tfi="${fileNode.tfi_parent}" data-size="${fileNode.size}" data-filepath="${fullPath}">
                        <div class="file-label">
                            <span class="file-name"><i class="fa-regular fa-file"></i> ${fileNode.name}</span>
                        </div>
                    </div>
                    <div class="file-actions">
                        <span class="file-meta">archive${fileNode.archive_index}.tfa | ${sizeStr}</span>
                    </div>
                </div>`;
            };

            const renderLazyTree = (node, parentElement) => {
                let treeHTML = `<div class="file-tree">`;
                const sortedFolderKeys = Object.keys(node.children || {});
                for (const key of sortedFolderKeys) {
                    treeHTML += buildFolderHTML(key, node.children[key], key);
                }
                if (node.files && node.files.length > 0) {
                    treeHTML += buildFilesGroupHTML(node, '');
                }
                treeHTML += `</div>`;
                parentElement.innerHTML = treeHTML;
            };

            const populateNode = (details) => {
                if (details.dataset.populated === 'true') return;
                const path = details.dataset.path;
                const isFilesGroup = details.dataset.isFilesGroup === 'true';
                const node = getNodeFromPath(path);
                const contentElement = details.querySelector('.folder-content');

                if (!node || !contentElement) return;

                let childrenHTML = '';
                if (isFilesGroup) {
                    for (const fileNode of node.files) {
                        childrenHTML += buildFileItemHTML(fileNode, fileNode.fullPath);
                    }
                } else {
                    const sortedFolderKeys = Object.keys(node.children || {});
                    for (const key of sortedFolderKeys) {
                        const childNode = node.children[key];
                        const childPath = path ? `${path}/${key}` : key;
                        childrenHTML += buildFolderHTML(key, childNode, childPath);
                    }
                    if (node.files && node.files.length > 0) {
                        childrenHTML += buildFilesGroupHTML(node, path);
                    }
                }
                contentElement.innerHTML = childrenHTML;
                details.dataset.populated = 'true';
                if (bulkSelectionMode === 'all') {
                    const content = details.querySelector('.folder-content');
                    if (content) {
                        content.querySelectorAll('input[type="checkbox"]').forEach((box) => {
                            if (box.classList.contains('file-check')) {
                                box.checked = !bulkSelectionExceptions.has(box.getAttribute('data-filepath'));
                            } else {
                                box.checked = true;
                                box.indeterminate = false;
                            }
                        });
                    }
                    syncFolderCheckboxStates();
                }
            };

            const onTreeToggle = (e) => {
                const details = e.target;
                if (!details.open || !details.closest('.file-tree')) return;
                if (details.dataset.populated !== 'true') {
                    populateNode(details);
                }
                if (isSearching.value) {
                    applySearch();
                }
            };

            const syncFolderCheckboxStates = () => {
                if (!treeContainerRef.value) return;
                const allDetails = Array.from(treeContainerRef.value.querySelectorAll('details'));

                allDetails.reverse().forEach((details) => {
                    const folderCheckbox = details.querySelector(':scope > summary .folder-check');
                    const content = details.querySelector(':scope > .folder-content');
                    if (!folderCheckbox || !content) return;

                    const childCheckboxes = Array.from(
                        content.querySelectorAll(':scope > .file-item .file-check, :scope > details > summary .folder-check')
                    );

                    if (childCheckboxes.length === 0) {
                        folderCheckbox.checked = false;
                        folderCheckbox.indeterminate = false;
                        return;
                    }

                    const allChecked = childCheckboxes.every((box) => box.checked);
                    const anyChecked = childCheckboxes.some((box) => box.checked || box.indeterminate);

                    folderCheckbox.checked = allChecked;
                    folderCheckbox.indeterminate = anyChecked && !allChecked;
                });
            };

            const updateSelectionSummary = () => {
                if (bulkSelectionMode === 'all') {
                    let excludedBytes = 0;
                    bulkSelectionExceptions.forEach((fullPath) => {
                        const file = fileCache.find((entry) => entry.fullPath === fullPath);
                        if (file) excludedBytes += file.size;
                    });
                    selectedFilesCount.value = Math.max(0, fileCache.length - bulkSelectionExceptions.size);
                    selectedFilesSize.value = Math.max(0, totalFileBytes - excludedBytes);
                    return;
                }

                if (!treeContainerRef.value) {
                    selectedFilesCount.value = 0;
                    selectedFilesSize.value = 0;
                    return;
                }

                let totalFiles = 0;
                let totalBytes = 0;
                treeContainerRef.value.querySelectorAll('.file-check:checked').forEach(box => {
                    totalFiles++;
                    totalBytes += parseInt(box.getAttribute('data-size'));
                });

                selectedFilesCount.value = totalFiles;
                selectedFilesSize.value = totalBytes;
            };

            const getFileMatchesForDetails = (details) => {
                const path = details?.dataset?.path || '';
                const isFilesGroup = details?.dataset?.isFilesGroup === 'true';

                return fileCache.filter((file) => {
                    if (isFilesGroup) {
                        const parentPath = file.fullPath.includes('/') ? file.fullPath.substring(0, file.fullPath.lastIndexOf('/')) : '';
                        return parentPath === path;
                    }
                    return path ? file.fullPath.startsWith(`${path}/`) : true;
                });
            };

            const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

            const runSelectionMutation = async (work) => {
                isSelectionPending.value = true;
                await nextTick();
                await yieldToUI();
                try {
                    await work();
                } finally {
                    syncFolderCheckboxStates();
                    updateSelectionSummary();
                    await nextTick();
                    isSelectionPending.value = false;
                }
            };

            const onTreeChange = async (e) => {
                if (isSelectionPending.value) {
                    return;
                }

                if (e.target.classList.contains('folder-check')) {
                    await runSelectionMutation(async () => {
                        const isChecked = e.target.checked;
                        e.target.indeterminate = false;
                        const details = e.target.closest('details');
                        
                        if (isChecked) {
                            const queue = [details];
                            let processedNodes = 0;
                            while(queue.length > 0) {
                                const current = queue.shift();
                                populateNode(current);
                                const childDetails = current.querySelectorAll(':scope > .folder-content > details');
                                childDetails.forEach(child => queue.push(child));
                                processedNodes++;
                                if (processedNodes % 25 === 0) {
                                    await yieldToUI();
                                }
                            }
                        }

                        const content = e.target.closest('details').querySelector('.folder-content');
                        content.querySelectorAll('input[type="checkbox"]').forEach(box => box.checked = isChecked);

                        if (bulkSelectionMode === 'all') {
                            const matchingFiles = getFileMatchesForDetails(details);
                            matchingFiles.forEach((file) => {
                                if (isChecked) {
                                    bulkSelectionExceptions.delete(file.fullPath);
                                } else {
                                    bulkSelectionExceptions.add(file.fullPath);
                                }
                            });
                        }
                    });
                    return;
                }

                if (e.target.classList.contains('file-check') && bulkSelectionMode === 'all') {
                    const fullPath = e.target.getAttribute('data-filepath');
                    if (fullPath) {
                        if (e.target.checked) {
                            bulkSelectionExceptions.delete(fullPath);
                        } else {
                            bulkSelectionExceptions.add(fullPath);
                        }
                    }
                }

                syncFolderCheckboxStates();
                updateSelectionSummary();
            };

            const collapseAll = () => {
                if (isAnyOperationRunning.value) return;
                if (!treeContainerRef.value) return;
                const openFolders = treeContainerRef.value.querySelectorAll('details.folder[open]');
                openFolders.forEach(f => { f.open = false; });
                isSearching.value = false;
                searchQuery.value = "";
                searchCountText.value = "";
                searchMatchIds.value = [];
                activeSearchMatchIndex.value = -1;
            };

            const clearSelectedFiles = () => {
                bulkSelectionMode = 'none';
                bulkSelectionExceptions = new Set();
                if (treeContainerRef.value) {
                    treeContainerRef.value.querySelectorAll('input[type="checkbox"]').forEach(b => {
                        b.checked = false;
                        b.indeterminate = false;
                    });
                }
                syncFolderCheckboxStates();
                updateSelectionSummary();
            };

            const selectVisible = () => {
                if (!treeContainerRef.value || !isSearching.value) return;
                const fileCheckboxes = treeContainerRef.value.querySelectorAll('.file-item.is-match .file-check');

                if (fileCheckboxes.length === 0) return;
                const shouldCheck = Array.from(fileCheckboxes).some(cb => !cb.checked);
                fileCheckboxes.forEach(cb => cb.checked = shouldCheck);
                fileCheckboxes[0].dispatchEvent(new Event('change', { bubbles: true }));
            };

            const selectAllFiles = () => {
                if (!treeContainerRef.value || fileCache.length === 0) return;
                const shouldCheck = selectedFilesCount.value !== fileCache.length;

                if (!shouldCheck) {
                    clearSelectedFiles();
                    return;
                }

                runSelectionMutation(async () => {
                    bulkSelectionMode = 'all';
                    bulkSelectionExceptions = new Set();
                    treeContainerRef.value.querySelectorAll('.file-check').forEach((box) => {
                        box.checked = true;
                    });
                    treeContainerRef.value.querySelectorAll('.folder-check').forEach((box) => {
                        box.checked = true;
                        box.indeterminate = false;
                    });
                });
            };

            const clearSearch = () => {
                searchQuery.value = "";
                debouncedSearch();
            };

            const nextSearchMatch = () => moveSearchMatch(1);
            const prevSearchMatch = () => moveSearchMatch(-1);

            const focusSearchInput = () => {
                const input = document.getElementById('tree-search');
                if (!input) return;
                input.focus();
                input.select();
            };

            const dismissOnboardingTips = () => {
                showOnboardingTips.value = false;
                if (window.AppSettings) window.AppSettings.setPrefSync('onboarding_file_manager_explorer_v1', 'dismissed');
            };

            const dismissTrackerOnboardingTips = () => {
                showTrackerOnboardingTips.value = false;
                if (window.AppSettings) window.AppSettings.setPrefSync('onboarding_file_manager_tracker_v1', 'dismissed');
            };

            const setActiveSearchMatch = (nextIndex) => {
                const ids = searchMatchIds.value;
                if (!ids.length || !treeContainerRef.value) {
                    activeSearchMatchIndex.value = -1;
                    return;
                }

                treeContainerRef.value.querySelectorAll('.file-item.is-active-match').forEach((node) => {
                    node.classList.remove('is-active-match');
                });

                const normalizedIndex = ((nextIndex % ids.length) + ids.length) % ids.length;
                activeSearchMatchIndex.value = normalizedIndex;
                const targetEl = document.getElementById(ids[normalizedIndex]);
                if (!targetEl) return;
                targetEl.classList.add('is-active-match');
                targetEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            };

            const moveSearchMatch = (delta) => {
                if (!searchMatchIds.value.length) return;
                const base = activeSearchMatchIndex.value >= 0 ? activeSearchMatchIndex.value : 0;
                setActiveSearchMatch(base + delta);
            };

            const resetSearchClasses = () => {
                if (!treeContainerRef.value) return;
                treeContainerRef.value.querySelectorAll('.is-match, .has-match').forEach((node) => {
                    node.classList.remove('is-match', 'has-match');
                });
                treeContainerRef.value.querySelectorAll('.file-item.is-active-match').forEach((node) => {
                    node.classList.remove('is-active-match');
                });
            };

            const ensurePathVisible = (fullPath) => {
                if (!treeContainerRef.value) return;
                const pathParts = fullPath.split('/');
                let currentPath = '';
                let parentEl = treeContainerRef.value.querySelector('.file-tree');

                for (let i = 0; i < pathParts.length - 1; i++) {
                    const part = pathParts[i];
                    currentPath = currentPath ? `${currentPath}/${part}` : part;

                    const detailsEl = parentEl?.querySelector(`:scope > details[data-path="${currentPath}"]`);
                    if (!detailsEl) return;

                    detailsEl.classList.add('has-match');
                    if (!detailsEl.dataset.populated) {
                        populateNode(detailsEl);
                    }
                    detailsEl.open = true;
                    parentEl = detailsEl.querySelector('.folder-content');
                }

                const filesGroupEl = parentEl?.querySelector(`:scope > details[data-is-files-group="true"]`);
                if (filesGroupEl) {
                    filesGroupEl.classList.add('has-match');
                    if (!filesGroupEl.dataset.populated) {
                        populateNode(filesGroupEl);
                    }
                    filesGroupEl.open = true;
                }

            };

            const applySearch = () => {
                const term = searchQuery.value.toLowerCase().trim();

                if (!treeContainerRef.value) {
                    isSearchPending.value = false;
                    return;
                }

                resetSearchClasses();
                searchMatchIds.value = [];
                activeSearchMatchIndex.value = -1;

                if (term.length < 4) {
                    isSearching.value = false;
                    isSearchPending.value = false;
                    searchCountText.value = term.length > 0 ? t("file_manager.minimum_4_characters_required") : "";
                    return;
                }

                isSearching.value = true;
                const matches = fileCache.filter((f) => f.name.includes(term) || f.path.includes(term));
                const visibleMatchIds = [];

                matches.forEach((match) => {
                    ensurePathVisible(match.fullPath);
                    const fileEl = document.getElementById(match.id);
                    if (fileEl) {
                        fileEl.classList.add('is-match');
                        visibleMatchIds.push(match.id);
                    }
                });

                searchMatchIds.value = visibleMatchIds;
                if (visibleMatchIds.length > 0) {
                    setActiveSearchMatch(0);
                }

                searchCountText.value = `${t("file_manager.found")} ${matches.length} ${t("file_manager.matches")}`;
                isSearchPending.value = false;
            };

            const debouncedSearch = () => {
                clearTimeout(searchTimeout);
                if (!treeContainerRef.value) return;

                const term = searchQuery.value.toLowerCase().trim();
                isSearchPending.value = term.length >= 4;
                if (term.length < 4) {
                    applySearch();
                    return;
                }

                searchTimeout = setTimeout(() => {
                    applySearch();
                }, 300);
            };

            const massExtract = async () => {
                if (!treeContainerRef.value) return;
                if (isAnyOperationRunning.value && !isMassExtracting.value) {
                    return window.showToast(t('file_manager.please_wait_for_the_current_operation_to_5a80ba'), true);
                }
                const destDirResp = await eel.ask_extraction_directory()();
                const destDir = destDirResp?.value ?? destDirResp?.data?.value ?? destDirResp;
                if (!destDir) return;

                const filesToExtract = bulkSelectionMode === 'all'
                    ? fileCache
                        .filter((file) => !bulkSelectionExceptions.has(file.fullPath))
                        .map((file) => ({
                            tfi: file.tfi,
                            archive: parseInt(file.archive),
                            offset: parseInt(file.offset),
                            size: parseInt(file.size),
                            filepath: file.fullPath
                        }))
                    : Array.from(treeContainerRef.value.querySelectorAll('.file-check:checked')).map(box => ({
                        tfi: box.getAttribute('data-tfi'),
                        archive: parseInt(box.getAttribute('data-archive')),
                        offset: parseInt(box.getAttribute('data-offset')),
                        size: parseInt(box.getAttribute('data-size')),
                        filepath: box.getAttribute('data-filepath')
                    }));

                filesToExtract.sort((a, b) => a.tfi.localeCompare(b.tfi) || a.archive - b.archive);

                progress.active = true;
                isMassExtracting.value = true;
                progress.percent = 0;

                let response;
                try {
                    response = await runQueuedFileManagerOperation({
                        label: t('file_manager.extract_selected_game_files'),
                        operation: 'mass_extract',
                        task: () => eel.mass_extract_files(destDir, filesToExtract)()
                    });
                } catch (e) {
                    window.showToast(String(e || t('file_manager.extraction_failed')), true);
                    progress.active = false;
                    isMassExtracting.value = false;
                    return;
                }

                if (response.cancelled) {
                    window.showToast(t('common.extraction_cancelled'));
                    progress.active = false;
                    isMassExtracting.value = false;
                    activeJobId.value = null;
                    return;
                }

                if (response.success) {
                    progress.text = t("file_manager.complete");
                    progress.percent = 100;
                    setTimeout(() => {
                        clearSelectedFiles();
                        progress.active = false;
                        isMassExtracting.value = false;
                        activeJobId.value = null;
                    }, 2000);
                } else {
                    window.showToast(t("file_manager.error_during_extraction") + (response.error || ""), true);
                    progress.active = false;
                    isMassExtracting.value = false;
                    activeJobId.value = null;
                }
            };

            const loadTrackingDirectories = async () => {
                const res = await eel.get_tracking_directories()();
                if (res.success) {
                    trackingDirs.value = res.directories;
                    if (res.directories.length > 0) {
                        trackingDirs.value.sort((a, b) => {
                            const timeA = a.last_used ? new Date(a.last_used).getTime() : 0;
                            const timeB = b.last_used ? new Date(b.last_used).getTime() : 0;
                            return timeB - timeA;
                        });
                        
                        if (res.last_used && trackingDirs.value.some(d => d.path === res.last_used)) {
                            selectedTrackingDir.value = res.last_used;
                        } else {
                            selectedTrackingDir.value = trackingDirs.value[0].path;
                            eel.set_last_tracking_directory(selectedTrackingDir.value)();
                        }
                    } else {
                        selectedTrackingDir.value = '';
                    }
                    checkTrackerStatus();
                }
            };

            watch(selectedTrackingDir, (newVal) => {
                if (newVal) eel.set_last_tracking_directory(newVal)();
                checkTrackerStatus();
            });

            watch(activeTab, (newTab) => {
                if (newTab === 'tab-tracker') {
                    clearSelectedFiles();
                }
            });

            watch([activeTab, selectedInstall, selectedTrackerGame, selectedTrackingDir, runCatalogMode, showTrackerAdvanced], persistState, { deep: true });

            const setActiveTab = (tabName) => {
                if (tabName === activeTab.value) return;
                if (isAnyOperationRunning.value) {
                    window.showToast(t('file_manager.cannot_switch_tabs_while_an_operation_is_e191df'), true);
                    return;
                }
                activeTab.value = tabName;
            };

            const onExternalSetTab = (event) => {
                const requested = event && event.detail ? event.detail.tab : null;
                if (requested === 'tab-explorer' || requested === 'tab-tracker') {
                    setActiveTab(requested);
                }
            };

            const checkTrackerStatus = async () => {
                if (!selectedTrackingDir.value) {
                    trackerStatus.state = 'empty';
                    trackerStatus.text = t("file_manager.select_or_add_a_tracking_directory_to_co_f836db");
                    trackerStatus.subText = "";
                    return;
                }
                
                trackerStatus.state = 'none';
                trackerStatus.text = t("file_manager.checking_directory");
                trackerStatus.subText = "";
                
                const response = await eel.get_tracking_status(selectedTrackingDir.value)();
                
                if (response.exists) {
                    trackerStatus.state = 'baseline';
                    trackerStatus.text = t("file_manager.baseline_ready");
                    trackerStatus.subText = `${t("file_manager.last_scanned")} ${new Date(response.last_scan).toLocaleString()}\n${t("file_manager.tracking_game")} ${response.game_path}\n${t("file_manager.you_can_now_compare_future_patches_again_e54fe0")}`;
                } else {
                    trackerStatus.state = 'none';
                    trackerStatus.text = t("file_manager.no_baseline_found_yet");
                    trackerStatus.subText = t("file_manager.build_the_initial_cache_once_for_this_fo_e7f9e9");
                }
            };

            const browseTrackerDir = async () => {
                if (isAnyOperationRunning.value) return;
                isBrowsingTracker.value = true;
                const response = await eel.select_tracking_directory()();
                if (response.success && response.path) {
                    newTrackerForm.path = response.path;
                    if (!newTrackerForm.name) {
                        newTrackerForm.name = response.path.split('\\').pop().split('/').pop();
                    }
                }
                isBrowsingTracker.value = false;
            };

            const saveTrackerDir = async () => {
                if (isAnyOperationRunning.value) {
                    return window.showToast(t('file_manager.please_wait_for_the_current_operation_to_5a80ba'), true);
                }
                const name = newTrackerForm.name.trim();
                const path = newTrackerForm.path.trim();
                if (!name || !path) return window.showToast(t("file_manager.please_provide_both_a_name_and_a_valid_p_75f358"), true);
                
                await eel.save_tracking_directory(name, path)();
                modals.addTracker = false;
                await loadTrackingDirectories();
                window.showToast(t("file_manager.tracking_directory_saved"));
            };

            const buildBaseline = async () => {
                const gamePath = selectedTrackerGame.value;
                if (!gamePath || !selectedTrackingDir.value) return window.showToast(t("file_manager.ensure_both_a_game_installation_and_trac_2e37fa"), true);
                if (isAnyOperationRunning.value && !trackerStatus.isBuilding) {
                    return window.showToast(t('file_manager.please_wait_for_the_current_operation_to_5a80ba'), true);
                }

                trackerStatus.isBuilding = true;
                progress.active = true;
                progress.percent = 0;
                
                let response;
                try {
                    response = await runQueuedFileManagerOperation({
                        label: t('file_manager.build_baseline_cache_fa045c'),
                        operation: 'build_baseline',
                        task: () => eel.build_baseline_cache(gamePath, selectedTrackingDir.value)()
                    });
                } catch (e) {
                    progress.active = false;
                    trackerStatus.isBuilding = false;
                    window.showToast(String(e || t('file_manager.baseline_build_failed')), true);
                    return;
                }
                
                progress.active = false;
                trackerStatus.isBuilding = false;

                if (response.cancelled) {
                    window.showToast(t('file_manager.baseline_build_cancelled'));
                    activeJobId.value = null;
                    return;
                }
                
                if (response.success) {
                    window.showToast(t("file_manager.baseline_built_successfully"));
                    checkTrackerStatus();
                } else {
                    window.showToast(t("file_manager.error_building_baseline") + " " + response.error, true);
                }
                activeJobId.value = null;
            };

            const scanUpdates = async () => {
                const gamePath = selectedTrackerGame.value;
                if (!gamePath || !selectedTrackingDir.value) return;
                if (isAnyOperationRunning.value && !trackerStatus.isScanning) {
                    return window.showToast(t('file_manager.please_wait_for_the_current_operation_to_5a80ba'), true);
                }

                trackerStatus.isScanning = true;
                progress.active = true;
                progress.percent = 0;
                
                let response;
                try {
                    response = await runQueuedFileManagerOperation({
                        label: t('file_manager.scan_and_extract_game_updates'),
                        operation: 'scan_updates',
                        task: () => eel.scan_and_extract_updates(gamePath, selectedTrackingDir.value, runCatalogMode.value)()
                    });
                } catch (e) {
                    progress.active = false;
                    trackerStatus.isScanning = false;
                    window.showToast(String(e || t('file_manager.update_scan_failed')), true);
                    return;
                }
                
                progress.active = false;
                trackerStatus.isScanning = false;

                if (response.cancelled) {
                    window.showToast(t('file_manager.update_scan_cancelled'));
                    activeJobId.value = null;
                    return;
                }
                
                if (response.success) {
                    const d = response.details || response.data?.details || { added: 0, changed: 0, removed: 0, folder: null };
                    if (d.added === 0 && d.changed === 0 && d.removed === 0) {
                        window.showToast(t("file_manager.scan_complete_no_game_updates_detected_s_32dfc1"));
                    } else {
                        window.showToast(`${t("file_manager.update_detected_and_extracted")}\n\n${t("file_manager.added")} ${d.added}\n${t("file_manager.changed")} ${d.changed}\n${t("file_manager.removed")} ${d.removed}\n\n${t("file_manager.saved_to")} ${d.folder}`);
                    }
                    checkTrackerStatus();
                } else {
                    window.showToast(t("file_manager.error_scanning_for_updates") + " " + response.error, true);
                }
                activeJobId.value = null;
            };

            const cancelTrackerOperation = async () => {
                if (!trackerStatus.isBuilding && !trackerStatus.isScanning) return;

                if (activeJobId.value && window.JobQueue && window.JobQueue.cancelById) {
                    window.JobQueue.cancelById(activeJobId.value);
                    window.showToast(t('file_manager.cancelling_operation'));
                    return;
                }

                const op = trackerStatus.isScanning ? 'scan_updates' : 'build_baseline';
                try {
                    await eel.cancel_file_manager_operation(op)();
                    window.showToast(t('file_manager.cancelling_operation'));
                } catch {
                    window.showToast(t('file_manager.failed_to_send_cancel_request'), true);
                }
            };

            const dismissSearchShortcutHint = () => {
                showSearchShortcutHint.value = false;
                if (window.AppSettings) window.AppSettings.setPrefSync('hint_file_manager_search_shortcuts_v1', 'dismissed');
            };

            const isFileManagerVisible = () => {
                const root = document.getElementById('file-manager-vue-app');
                return !!(root && root.offsetParent !== null);
            };

            const onKeyDown = (e) => {
                if (!isFileManagerVisible()) return;

                const key = String(e.key || '').toLowerCase();
                const isFind = (e.ctrlKey || e.metaKey) && key === 'f';
                if (isFind && activeTab.value === 'tab-explorer') {
                    e.preventDefault();
                    focusSearchInput();
                    return;
                }

                if (modals.addTracker) {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        modals.addTracker = false;
                        return;
                    }
                    if (e.key === 'Enter') {
                        const targetTag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
                        if (targetTag !== 'textarea' && !isAnyOperationRunning.value) {
                            e.preventDefault();
                            saveTrackerDir();
                        }
                        return;
                    }
                }

                const activeEl = document.activeElement;
                if (activeTab.value === 'tab-explorer' && activeEl && activeEl.id === 'tree-search' && searchMatchIds.value.length > 0) {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        moveSearchMatch(1);
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        moveSearchMatch(-1);
                    }
                }
            };

            onMounted(async () => {
                hydratingState = true;
                // Register the external tab-sync listener FIRST. The modder_tools
                // orchestrator dispatches `file_manager_set_tab` right after this app
                // mounts -- before the awaits below resolve. Registering it late (the
                // old bug) meant that sync was missed, so the embedded tab desynced
                // from the modder tab the user actually clicked.
                document.addEventListener('file_manager_set_tab', onExternalSetTab);
                if (window.AppSettings) {
                    await window.AppSettings.load();
                    const saved = window.AppSettings.getPref(PREF_STATE_KEY, null);
                    applyStateSnapshot(saved);
                }
                // Installs detection and tracking-directory loading don't depend on
                // each other -- the previous sequential await chain doubled cold
                // open time. Promise.all halves it.
                await Promise.all([scanForGames(), loadTrackingDirectories()]);
                document.addEventListener('keydown', onKeyDown);
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
                hydratingState = false;
            });

            onBeforeUnmount(() => {
                document.removeEventListener('keydown', onKeyDown);
                document.removeEventListener('file_manager_set_tab', onExternalSetTab);
            });

            return {
                t, activeTab, setActiveTab,
                installs, installOptions, selectedInstall, selectedTrackerGame, scanForGames,
                openSelectedInstallFolder, openSelectedTrackerGameFolder, openSelectedTrackingDirFolder,
                treeContainerRef, isTreeLoaded, isLoadingTree, treePlaceholderText, loadTree,
                searchQuery, searchCountText, isSearching, isSearchPending, isSelectionPending, debouncedSearch, clearSearch, nextSearchMatch, prevSearchMatch,
                focusSearchInput,
                showSearchShortcutHint, dismissSearchShortcutHint,
                showOnboardingTips, dismissOnboardingTips, showTrackerOnboardingTips, dismissTrackerOnboardingTips,
                onTreeToggle, onTreeChange, collapseAll, selectVisible, selectAllFiles,
                selectedFilesCount, selectedFilesSize, isMassExtracting, massExtract, clearSelectedFiles, progress,
                trackingDirs, trackingDirOptions, selectedTrackingDir, runCatalogMode, showTrackerAdvanced,
                trackerStatus, trackerStatusColor, trackerNextAction, isTrackerWorking, isAnyOperationRunning, isExplorerWorking, buildBaseline, scanUpdates, cancelTrackerOperation,
                modals, newTrackerForm, isBrowsingTracker, browseTrackerDir, saveTrackerDir
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);

    if (window._fileManagerApp) window._fileManagerApp.unmount();
    window._fileManagerApp = app;
    app.mount('#file-manager-vue-app');
});

eel.expose(update_progress_ui, 'update_progress_ui');
function update_progress_ui(current, total, filename, statusKey, etaSeconds = null, elapsedSeconds = null) {
    if (window._fmAppUpdateProgress) {
        window._fmAppUpdateProgress(current, total, filename, statusKey, etaSeconds, elapsedSeconds);
    }
}
