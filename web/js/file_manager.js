document.addEventListener('file_manager_loaded', () => {
    console.log("High-Performance File Manager Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }
    
    const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
            const PREF_STATE_KEY = 'state_file_manager';
            let hydratingState = false;

            const activeTab = ref('tab-explorer');
            
            const installs = ref([]);
            const installOptions = computed(() => {
                if (installs.value.length === 0) return [[t('Searching...'), '']];
                return installs.value.map(g => [
                    t('{name} - {path}')
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
            const treePlaceholderText = ref(t('Select a game installation to view files.'));
            let fileCache = [];
            let fullFileTree = {};
            let fileIdCounter = 0;
            
            const isSearching = ref(false);
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
                if (trackingDirs.value.length === 0) return [[t('No paths saved. Add one...'), '']];
                return trackingDirs.value.map(d => {
                    let text = `${d.name} (${d.path})`;
                    if (d.last_used) text += ` - ${t("Last used:")} ${timeSince(d.last_used)}`;
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
                text: t('Select a tracking directory to continue.'),
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
                if (!selectedTrackerGame.value) return t('Next step: Pick Trove Path');
                if (!selectedTrackingDir.value) return t('Next step: Pick Tracking Folder');
                if (trackerStatus.state !== 'baseline') return t('Next step: Build Baseline Cache');
                return t('Next step: Scan & Extract Updates');
            });

            const modals = reactive({ addTracker: false });
            const newTrackerForm = reactive({ name: '', path: '' });
            const isBrowsingTracker = ref(false);

            const timeSince = (dateString) => {
                if (!dateString) return "";
                const date = new Date(dateString);
                const seconds = Math.floor((new Date() - date) / 1000);
                let interval = seconds / 31536000;
                if (interval > 1) return Math.floor(interval) + " " + t("years ago");
                interval = seconds / 2592000;
                if (interval > 1) return Math.floor(interval) + " " + t("months ago");
                interval = seconds / 86400;
                if (interval > 1) return Math.floor(interval) + " " + t("days ago");
                interval = seconds / 3600;
                if (interval > 1) return Math.floor(interval) + " " + t("hours ago");
                interval = seconds / 60;
                if (interval > 1) return Math.floor(interval) + " " + t("minutes ago");
                return t("Just now");
            };

            const formatTime = (totalSeconds) => {
                if (totalSeconds === null || totalSeconds === undefined || isNaN(totalSeconds)) return "";
                const m = Math.floor(totalSeconds / 60);
                const s = Math.floor(totalSeconds % 60);
                const mStr = t("{count} minutes").replace("{count}", m);
                const sStr = t("{count} seconds").replace("{count}", s);
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
                            throw new Error(cancelResp?.error || t('Failed to send cancel request.'));
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
                if (typeof saved.activeTab === 'string') activeTab.value = saved.activeTab;
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
                    window.showToast(t('Please wait for the current operation to finish.'), true);
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
                        window.showToast(t('Game path detection failed: {error}').replace('{error}', response.error), true);
                    }
                } catch (error) {
                    installs.value = [];
                    selectedInstall.value = '';
                    selectedTrackerGame.value = '';
                    window.showToast(t('Game path detection failed.'), true);
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
                    window.showToast(t('No path selected.'), true);
                    return;
                }
                const response = await eel.open_path_in_explorer(path)();
                if (!response || !response.success) {
                    window.showToast(t('Failed to open folder: {error}').replace('{error}', response?.error || t('Unknown error occurred')), true);
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
                if (!selectedInstall.value) return window.showToast(t("Select a game first."), true);
                if (isAnyOperationRunning.value && !isLoadingTree.value) {
                    return window.showToast(t('Please wait for the current operation to finish.'), true);
                }
                isLoadingTree.value = true;
                isTreeLoaded.value = false;
                treePlaceholderText.value = t("Parsing") + " " + selectedInstall.value + "...";
                if (treeContainerRef.value) treeContainerRef.value.innerHTML = '';
                
                fileCache = [];
                fileIdCounter = 0;
                fullFileTree = {};
                searchQuery.value = '';
                isSearching.value = false;
                selectedFilesCount.value = 0;
                selectedFilesSize.value = 0;

                try {
                    const response = await runQueuedFileManagerOperation({
                        label: t('Load game archive tree'),
                        operation: 'load_tree',
                        task: () => eel.load_entire_game_tree(selectedInstall.value)()
                    });
                    if (response.cancelled) {
                        treePlaceholderText.value = t('Archive loading cancelled.');
                        window.showToast(t('Archive loading cancelled.'));
                        return;
                    }
                    if (response.success) {
                        const cacheFile = response.cached_file || response?.data?.cached_file || '/api/cache/temp_tree.json';
                        const fetchRes = await fetch(cacheFile + '?t=' + new Date().getTime());
                        if (!fetchRes.ok) {
                            throw new Error(t('Failed to read archive cache file.'));
                        }
                        fullFileTree = await fetchRes.json();
                        
                        const cacheAllFiles = (node, currentPath = "") => {
                            if (node.files) {
                                for (const fileNode of node.files) {
                                    const id = `f-${fileIdCounter++}`;
                                    const fullPath = currentPath ? `${currentPath}/${fileNode.name}` : fileNode.name;
                                    fileNode.id = id;
                                    fileNode.fullPath = fullPath;
                                    fileCache.push({ id, name: fileNode.name.toLowerCase(), path: fullPath.toLowerCase(), fullPath });
                                }
                            }
                            if (node.children) {
                                for (const key in node.children) {
                                    const childPath = currentPath ? `${currentPath}/${key}` : key;
                                    cacheAllFiles(node.children[key], childPath);
                                }
                            }
                        };
                        cacheAllFiles(fullFileTree);

                        renderLazyTree(fullFileTree, treeContainerRef.value);
                        isTreeLoaded.value = true;
                        treePlaceholderText.value = t("Select a game installation to view files.");
                    } else {
                        const errorMessage = response.error || t("Unknown error");
                        treePlaceholderText.value = t("Error parsing game tree:") + " " + errorMessage;
                        window.showToast(t("Error parsing game tree:") + " " + errorMessage, true);
                    }
                } catch (error) {
                    const errorMessage = String(error && error.message ? error.message : error || t('Unknown error'));
                    treePlaceholderText.value = t("Error loading parsed game files:") + " " + errorMessage;
                    window.showToast(t("Error loading parsed game files:") + " " + errorMessage, true);
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
                const meta = `(${dirCount} ${t('dirs')}, ${fileCount} ${t('files')})`;
                return `<details class="folder" data-path="${fullPath}">
                    <summary>
                        <div class="checkbox-container">
                            <input type="checkbox" class="folder-check">
                            <span><i class="fa-solid fa-folder"></i> ${name}</span>
                        </div>
                        <span class="folder-meta">${meta}</span>
                    </summary>
                    <div class="folder-content"><div class="lazy-placeholder">${t("Loading...")}</div></div>
                </details>`;
            };

            const buildFilesGroupHTML = (node, fullPath) => {
                const fileCount = node.file_count_direct || 0;
                if (fileCount === 0) return '';
                return `<details class="files-group" data-path="${fullPath}" data-is-files-group="true">
                    <summary>
                        <div class="checkbox-container">
                            <input type="checkbox" class="folder-check">
                            <span><i class="fa-regular fa-folder-open"></i> ${t("Files")} (${fileCount})</span>
                        </div>
                    </summary>
                    <div class="folder-content"><div class="lazy-placeholder">${t("Loading...")}</div></div>
                </details>`;
            };

            const buildFileItemHTML = (fileNode, fullPath) => {
                const id = fileNode.id;
                const sizeStr = fileNode.size > 1048576 ? (fileNode.size / 1048576).toFixed(2) + ' MB' : (fileNode.size / 1024).toFixed(2) + ' KB';
                return `<div class="file-item" id="${id}">
                    <div class="checkbox-container">
                        <input type="checkbox" class="file-check" data-archive="${fileNode.archive_index}" data-offset="${fileNode.offset}" data-tfi="${fileNode.tfi_parent}" data-size="${fileNode.size}" data-filepath="${fullPath}">
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
            };

            const onTreeToggle = (e) => {
                const details = e.target;
                if (!details.open || details.dataset.populated === 'true' || !details.closest('.file-tree')) return;
                populateNode(details);
            };

            const onTreeChange = (e) => {
                if (e.target.classList.contains('folder-check')) {
                    const isChecked = e.target.checked;
                    const details = e.target.closest('details');
                    
                    if (isChecked) {
                        const queue = [details];
                        while(queue.length > 0) {
                            const current = queue.shift();
                            populateNode(current);
                            const childDetails = current.querySelectorAll(':scope > .folder-content > details');
                            childDetails.forEach(child => queue.push(child));
                        }
                    }

                    const content = e.target.closest('details').querySelector('.folder-content');
                    content.querySelectorAll('input[type="checkbox"]').forEach(box => box.checked = isChecked);
                }

                let totalFiles = 0, totalBytes = 0;
                treeContainerRef.value.querySelectorAll('.file-check:checked').forEach(box => {
                    totalFiles++;
                    totalBytes += parseInt(box.getAttribute('data-size'));
                });
                
                selectedFilesCount.value = totalFiles;
                selectedFilesSize.value = totalBytes;
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
                if (treeContainerRef.value) {
                    treeContainerRef.value.querySelectorAll('input[type="checkbox"]').forEach(b => {
                        b.checked = false;
                    });
                }
                selectedFilesCount.value = 0;
                selectedFilesSize.value = 0;
            };

            const selectVisible = () => {
                if (!treeContainerRef.value) return;
                const fileCheckboxes = isSearching.value 
                    ? treeContainerRef.value.querySelectorAll('.file-item.is-match .file-check')
                    : treeContainerRef.value.querySelectorAll('.file-check');

                if (fileCheckboxes.length === 0) return;
                const shouldCheck = Array.from(fileCheckboxes).some(cb => !cb.checked);
                fileCheckboxes.forEach(cb => cb.checked = shouldCheck);
                treeContainerRef.value.dispatchEvent(new Event('change', { bubbles: true }));
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

            const debouncedSearch = () => {
                clearTimeout(searchTimeout);
                const term = searchQuery.value.toLowerCase().trim();

                if (!treeContainerRef.value) return;
                
                isSearching.value = false;
                treeContainerRef.value.querySelectorAll('.is-match, .has-match').forEach(n => {
                    n.classList.remove('is-match', 'has-match');
                });

                if (term.length < 4) {
                    searchCountText.value = term.length > 0 ? t("Minimum 4 characters required...") : "";
                    searchMatchIds.value = [];
                    activeSearchMatchIndex.value = -1;
                    return;
                }

                treeContainerRef.value.querySelectorAll('details[open]').forEach(d => d.open = false);

                searchTimeout = setTimeout(() => {
                    isSearching.value = true;
                    
                    const matches = fileCache.filter(f => f.name.includes(term) || f.fullPath.toLowerCase().includes(term));
                    
                    matches.forEach(match => {
                        const pathParts = match.fullPath.split('/');
                        let currentPath = '';
                        let parentEl = treeContainerRef.value.querySelector('.file-tree');

                        for (let i = 0; i < pathParts.length - 1; i++) {
                            const part = pathParts[i];
                            currentPath = currentPath ? `${currentPath}/${part}` : part;
                            
                            let detailsEl = parentEl.querySelector(`:scope > details[data-path="${currentPath}"]`);
                            if (detailsEl) {
                                if (!detailsEl.open) detailsEl.open = true;
                                detailsEl.classList.add('has-match');
                                parentEl = detailsEl.querySelector('.folder-content');
                            } else {
                                break;
                            }
                        }

                        const filesGroupEl = parentEl.querySelector(`:scope > details[data-is-files-group="true"]`);
                        if (filesGroupEl) {
                            if (!filesGroupEl.open) filesGroupEl.open = true;
                            filesGroupEl.classList.add('has-match');
                        }

                        const fileEl = document.getElementById(match.id);
                        if (fileEl) fileEl.classList.add('is-match');
                    });

                    searchMatchIds.value = matches.map(m => m.id).filter(id => !!document.getElementById(id));
                    setActiveSearchMatch(0);

                    searchCountText.value = `${t("Found")} ${matches.length} ${t("matches")}`;
                }, 300);
            };

            const massExtract = async () => {
                if (!treeContainerRef.value) return;
                if (isAnyOperationRunning.value && !isMassExtracting.value) {
                    return window.showToast(t('Please wait for the current operation to finish.'), true);
                }
                const destDirResp = await eel.ask_extraction_directory()();
                const destDir = destDirResp?.value ?? destDirResp?.data?.value ?? destDirResp;
                if (!destDir) return;

                const filesToExtract = Array.from(treeContainerRef.value.querySelectorAll('.file-check:checked')).map(box => ({
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
                        label: t('Extract selected game files'),
                        operation: 'mass_extract',
                        task: () => eel.mass_extract_files(destDir, filesToExtract)()
                    });
                } catch (e) {
                    window.showToast(String(e || t('Extraction failed.')), true);
                    progress.active = false;
                    isMassExtracting.value = false;
                    return;
                }

                if (response.cancelled) {
                    window.showToast(t('Extraction cancelled.'));
                    progress.active = false;
                    isMassExtracting.value = false;
                    activeJobId.value = null;
                    return;
                }

                if (response.success) {
                    progress.text = t("Complete!");
                    progress.percent = 100;
                    setTimeout(() => {
                        clearSelectedFiles();
                        progress.active = false;
                        isMassExtracting.value = false;
                        activeJobId.value = null;
                    }, 2000);
                } else {
                    window.showToast(t("Error during extraction: ") + (response.error || ""), true);
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
                    window.showToast(t('Cannot switch tabs while an operation is running.'), true);
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
                    trackerStatus.text = t("Select or add a tracking directory to continue.");
                    trackerStatus.subText = "";
                    return;
                }
                
                trackerStatus.state = 'none';
                trackerStatus.text = t("Checking directory...");
                trackerStatus.subText = "";
                
                const response = await eel.get_tracking_status(selectedTrackingDir.value)();
                
                if (response.exists) {
                    trackerStatus.state = 'baseline';
                    trackerStatus.text = t("Baseline ready.");
                    trackerStatus.subText = `${t("Last Scanned:")} ${new Date(response.last_scan).toLocaleString()}\n${t("Tracking Game:")} ${response.game_path}\n${t("You can now compare future patches against this baseline.")}`;
                } else {
                    trackerStatus.state = 'none';
                    trackerStatus.text = t("No baseline found yet.");
                    trackerStatus.subText = t("Build the initial cache once for this folder, then future scans can extract only the files changed by patches.");
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
                    return window.showToast(t('Please wait for the current operation to finish.'), true);
                }
                const name = newTrackerForm.name.trim();
                const path = newTrackerForm.path.trim();
                if (!name || !path) return window.showToast(t("Please provide both a name and a valid path."), true);
                
                await eel.save_tracking_directory(name, path)();
                modals.addTracker = false;
                await loadTrackingDirectories();
                window.showToast(t("Tracking directory saved!"));
            };

            const buildBaseline = async () => {
                const gamePath = selectedTrackerGame.value;
                if (!gamePath || !selectedTrackingDir.value) return window.showToast(t("Ensure both a Game Installation and Tracking Directory are selected."), true);
                if (isAnyOperationRunning.value && !trackerStatus.isBuilding) {
                    return window.showToast(t('Please wait for the current operation to finish.'), true);
                }

                trackerStatus.isBuilding = true;
                progress.active = true;
                progress.percent = 0;
                
                let response;
                try {
                    response = await runQueuedFileManagerOperation({
                        label: t('Build baseline cache'),
                        operation: 'build_baseline',
                        task: () => eel.build_baseline_cache(gamePath, selectedTrackingDir.value)()
                    });
                } catch (e) {
                    progress.active = false;
                    trackerStatus.isBuilding = false;
                    window.showToast(String(e || t('Baseline build failed.')), true);
                    return;
                }
                
                progress.active = false;
                trackerStatus.isBuilding = false;

                if (response.cancelled) {
                    window.showToast(t('Baseline build cancelled.'));
                    activeJobId.value = null;
                    return;
                }
                
                if (response.success) {
                    window.showToast(t("Baseline built successfully!"));
                    checkTrackerStatus();
                } else {
                    window.showToast(t("Error building baseline:") + " " + response.error, true);
                }
                activeJobId.value = null;
            };

            const scanUpdates = async () => {
                const gamePath = selectedTrackerGame.value;
                if (!gamePath || !selectedTrackingDir.value) return;
                if (isAnyOperationRunning.value && !trackerStatus.isScanning) {
                    return window.showToast(t('Please wait for the current operation to finish.'), true);
                }

                trackerStatus.isScanning = true;
                progress.active = true;
                progress.percent = 0;
                
                let response;
                try {
                    response = await runQueuedFileManagerOperation({
                        label: t('Scan and extract game updates'),
                        operation: 'scan_updates',
                        task: () => eel.scan_and_extract_updates(gamePath, selectedTrackingDir.value, runCatalogMode.value)()
                    });
                } catch (e) {
                    progress.active = false;
                    trackerStatus.isScanning = false;
                    window.showToast(String(e || t('Update scan failed.')), true);
                    return;
                }
                
                progress.active = false;
                trackerStatus.isScanning = false;

                if (response.cancelled) {
                    window.showToast(t('Update scan cancelled.'));
                    activeJobId.value = null;
                    return;
                }
                
                if (response.success) {
                    const d = response.details || response.data?.details || { added: 0, changed: 0, removed: 0, folder: null };
                    if (d.added === 0 && d.changed === 0 && d.removed === 0) {
                        window.showToast(t("Scan complete. No game updates detected since the last baseline."));
                    } else {
                        window.showToast(`${t("Update detected and extracted!")}\n\n${t("Added:")} ${d.added}\n${t("Changed:")} ${d.changed}\n${t("Removed:")} ${d.removed}\n\n${t("Saved to:")} ${d.folder}`);
                    }
                    checkTrackerStatus();
                } else {
                    window.showToast(t("Error scanning for updates:") + " " + response.error, true);
                }
                activeJobId.value = null;
            };

            const cancelTrackerOperation = async () => {
                if (!trackerStatus.isBuilding && !trackerStatus.isScanning) return;

                if (activeJobId.value && window.JobQueue && window.JobQueue.cancelById) {
                    window.JobQueue.cancelById(activeJobId.value);
                    window.showToast(t('Cancelling operation...'));
                    return;
                }

                const op = trackerStatus.isScanning ? 'scan_updates' : 'build_baseline';
                try {
                    await eel.cancel_file_manager_operation(op)();
                    window.showToast(t('Cancelling operation...'));
                } catch {
                    window.showToast(t('Failed to send cancel request.'), true);
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
                if (window.AppSettings) {
                    await window.AppSettings.load();
                    const saved = window.AppSettings.getPref(PREF_STATE_KEY, null);
                    applyStateSnapshot(saved);
                }
                await scanForGames();
                await loadTrackingDirectories();
                document.addEventListener('keydown', onKeyDown);
                document.addEventListener('file_manager_set_tab', onExternalSetTab);
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
                searchQuery, searchCountText, isSearching, debouncedSearch, clearSearch, nextSearchMatch, prevSearchMatch,
                focusSearchInput,
                showSearchShortcutHint, dismissSearchShortcutHint,
                showOnboardingTips, dismissOnboardingTips, showTrackerOnboardingTips, dismissTrackerOnboardingTips,
                onTreeToggle, onTreeChange, collapseAll, selectVisible,
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
