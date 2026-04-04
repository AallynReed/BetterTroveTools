document.addEventListener('file_manager_loaded', () => {
    console.log("High-Performance File Manager Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }
    
    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

            // State
            const activeTab = ref('tab-explorer');
            
            const installs = ref([]);
            const installOptions = computed(() => {
                if (installs.value.length === 0) return [[t('Searching...'), '']];
                return installs.value.map(g => [`${g.name} - ${g.path}`, g.path]);
            });
            const selectedInstall = ref('');
            const selectedTrackerGame = ref('');

            // Tree State
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

            // Extraction
            const selectedFilesCount = ref(0);
            const selectedFilesSize = ref(0);
            const isMassExtracting = ref(false);
            const progress = reactive({
                active: false,
                percent: 0,
                text: '',
                filename: ''
            });

            // Tracker
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
            const isTrackerWorking = computed(() => trackerStatus.isBuilding || trackerStatus.isScanning);
            
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

            const modals = reactive({ addTracker: false });
            const newTrackerForm = reactive({ name: '', path: '' });
            const isBrowsingTracker = ref(false);

            // Utilities
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
                const timeText = [];
                if (statusKey) timeText.push(t(statusKey));
                if (elapsedSeconds !== null && elapsedSeconds !== "") timeText.push(`${t("Elapsed:")} ${formatTime(elapsedSeconds)}`);
                if (etaSeconds !== null && etaSeconds !== "") timeText.push(`${t("ETA:")} ${formatTime(etaSeconds)}`);
                progress.text = `${progress.percent}% | ${timeText.join(' | ')}`;
            };

            // Install & Config Load
            const scanForGames = async () => {
                const response = await eel.get_detected_game_paths()();
                const settings = await eel.get_settings()();
                if (response.success && response.paths.length > 0) {
                    installs.value = response.paths;
                    if (settings.last_game_path && installs.value.some(p => p.path === settings.last_game_path)) {
                        selectedInstall.value = settings.last_game_path;
                        selectedTrackerGame.value = settings.last_game_path;
                    } else {
                        selectedInstall.value = installs.value[0].path;
                        selectedTrackerGame.value = installs.value[0].path;
                    }
                } else {
                    installs.value = [];
                }
            };

            watch(selectedInstall, async (newVal) => {
                if (!newVal) return;
                const settings = await eel.get_settings()();
                settings.last_game_path = newVal;
                selectedTrackerGame.value = newVal;
                await eel.save_settings(settings)();
            });
            watch(selectedTrackerGame, async (newVal) => {
                if (!newVal) return;
                const settings = await eel.get_settings()();
                settings.last_game_path = newVal;
                selectedInstall.value = newVal;
                await eel.save_settings(settings)();
            });

            // Tree Methods
            const loadTree = async () => {
                if (!selectedInstall.value) return window.showToast(t("Select a game first."), true);
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
                    const response = await eel.load_entire_game_tree(selectedInstall.value)();
                    if (response.success) {
                        const fetchRes = await fetch('/api/cache/temp_tree.json?t=' + new Date().getTime());
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
                    } else {
                        treePlaceholderText.value = t("Error parsing game tree:") + " " + (response.error || "Unknown error");
                    }
                } catch (error) {
                    treePlaceholderText.value = t("Error loading parsed game files.");
                } finally {
                    isLoadingTree.value = false;
                    treePlaceholderText.value = t("Select a game installation to view files.");
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
                if (!treeContainerRef.value) return;
                const openFolders = treeContainerRef.value.querySelectorAll('details.folder[open]');
                openFolders.forEach(f => { f.open = false; });
                isSearching.value = false;
                searchQuery.value = "";
                searchCountText.value = "";
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

                    searchCountText.value = `${t("Found")} ${matches.length} ${t("matches")}`;
                }, 300);
            };

            // Mass Extract
            const massExtract = async () => {
                if (!treeContainerRef.value) return;
                const destDir = await eel.ask_extraction_directory()();
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
                progress.text = t("Starting extraction...");
                progress.percent = 0;

                const response = await eel.mass_extract_files(destDir, filesToExtract)();

                if (response.success) {
                    progress.text = t("Complete!");
                    progress.percent = 100;
                    setTimeout(() => {
                        treeContainerRef.value.querySelectorAll('input[type="checkbox"]').forEach(b => b.checked = false);
                        selectedFilesCount.value = 0;
                        selectedFilesSize.value = 0;
                        progress.active = false;
                        isMassExtracting.value = false;
                    }, 2000);
                } else {
                    window.showToast(t("Error during extraction: ") + (response.error || ""), true);
                    progress.active = false;
                    isMassExtracting.value = false;
                }
            };

            // Tracker Methods
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
                    trackerStatus.text = t("Active Baseline Found!");
                    trackerStatus.subText = `${t("Last Scanned:")} ${new Date(response.last_scan).toLocaleString()}\n${t("Tracking Game:")} ${response.game_path}`;
                } else {
                    trackerStatus.state = 'none';
                    trackerStatus.text = t("No Baseline Found.");
                    trackerStatus.subText = t("You must build an initial cache hash before you can scan for updates. This will take a few minutes.");
                }
            };

            const browseTrackerDir = async () => {
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

                trackerStatus.isBuilding = true;
                progress.active = true;
                progress.percent = 0;
                progress.text = t("Building Baseline Cache...");
                
                const response = await eel.build_baseline_cache(gamePath, selectedTrackingDir.value)();
                
                progress.active = false;
                trackerStatus.isBuilding = false;
                
                if (response.success) {
                    window.showToast(t("Baseline built successfully!"));
                    checkTrackerStatus();
                } else {
                    window.showToast(t("Error building baseline:") + " " + response.error, true);
                }
            };

            const scanUpdates = async () => {
                const gamePath = selectedTrackerGame.value;
                if (!gamePath || !selectedTrackingDir.value) return;

                trackerStatus.isScanning = true;
                progress.active = true;
                progress.percent = 0;
                progress.text = t("Scanning for Updates...");
                
                const response = await eel.scan_and_extract_updates(gamePath, selectedTrackingDir.value, runCatalogMode.value)();
                
                progress.active = false;
                trackerStatus.isScanning = false;
                
                if (response.success) {
                    const d = response.details;
                    if (d.added === 0 && d.changed === 0 && d.removed === 0) {
                        window.showToast(t("Scan complete. No game updates detected since the last baseline."));
                    } else {
                        window.showToast(`${t("Update detected and extracted!")}\n\n${t("Added:")} ${d.added}\n${t("Changed:")} ${d.changed}\n${t("Removed:")} ${d.removed}\n\n${t("Saved to:")} ${d.folder}`);
                    }
                    checkTrackerStatus();
                } else {
                    window.showToast(t("Error scanning for updates:") + " " + response.error, true);
                }
            };

            onMounted(async () => {
                await scanForGames();
                await loadTrackingDirectories();
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
            });

            return {
                t, activeTab,
                installs, installOptions, selectedInstall, selectedTrackerGame, scanForGames,
                treeContainerRef, isTreeLoaded, isLoadingTree, treePlaceholderText, loadTree,
                searchQuery, searchCountText, isSearching, debouncedSearch, clearSearch,
                onTreeToggle, onTreeChange, collapseAll, selectVisible,
                selectedFilesCount, selectedFilesSize, isMassExtracting, massExtract, progress,
                trackingDirs, trackingDirOptions, selectedTrackingDir, runCatalogMode,
                trackerStatus, trackerStatusColor, isTrackerWorking, buildBaseline, scanUpdates,
                modals, newTrackerForm, isBrowsingTracker, browseTrackerDir, saveTrackerDir
            };
        }
    });

    // Register custom-vue-select globally for this app
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