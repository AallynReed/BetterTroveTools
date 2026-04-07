document.addEventListener('mod_manager_loaded', async () => {
    if (typeof Vue === 'undefined') {
        console.error('Vue.js failed to load!');
        return;
    }

    let trovesaurusInitialized = false;
    let activeSection = null;
    const setModManagerSection = (section) => {
        const previousSection = activeSection;
        activeSection = section;
        const buttons = document.querySelectorAll('[data-mm-tab]');
        const panels = document.querySelectorAll('[data-mm-panel]');
        buttons.forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-mm-tab') === section));
        panels.forEach(panel => panel.classList.toggle('active', panel.getAttribute('data-mm-panel') === section));

        if (section === 'trovesaurus' && !trovesaurusInitialized) {
            trovesaurusInitialized = true;
            document.dispatchEvent(new CustomEvent('trovesaurus_loaded'));
        }

        if (previousSection !== section) {
            document.dispatchEvent(new CustomEvent('mod_manager_section_changed', {
                detail: { previousSection, currentSection: section }
            }));
        }
    };

    document.querySelectorAll('[data-mm-tab]').forEach((btn) => {
        btn.addEventListener('click', () => setModManagerSection(btn.getAttribute('data-mm-tab')));
    });

    window.setModManagerSection = setModManagerSection;
    const requestedSection = window.pendingModManagerSection || 'mod_manager';
    window.pendingModManagerSection = null;
    setModManagerSection(requestedSection);

    const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;
    const PREF_STATE_KEY = 'state_mod_manager';
    const PREF_TOUR_KEY = 'onboarding_mod_manager_v1';
    const PREF_HINT_KEY = 'hint_mod_manager_search_shortcuts_v1';

    const readUiState = () => {
        const state = window.AppSettings ? window.AppSettings.getPref(PREF_STATE_KEY, {}) : {};
        return state && typeof state === 'object' ? state : {};
    };

    const app = createApp({
        setup() {
            const t = (str) => (window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str);
            const uiState = readUiState();

            const installs = ref([]);
            const selectedInstall = ref(uiState.selectedInstall || '');

            const mods = ref([]);
            const isLoading = ref(false);
            const statusText = ref(t('Scanning Mod Directory...'));

            const searchQuery = ref(uiState.searchQuery || '');
            const activeResultIndex = ref(-1);
            const filterStatus = ref(uiState.filterStatus || 'all');
            const selectedPaths = ref([]);
            const toursEnabled = window.BTT_ENABLE_ONBOARDING_TOURS !== false;
            const showOnboardingTips = ref(toursEnabled && (window.AppSettings ? window.AppSettings.getPref(PREF_TOUR_KEY, '') !== 'dismissed' : true));
            const showSearchShortcutHint = ref(window.AppSettings ? window.AppSettings.getPref(PREF_HINT_KEY, '') !== 'dismissed' : true);
            const showPreviewOnInfoSide = ref(true);

            const isFixingNames = ref(false);
            const isFixingConfigs = ref(false);
            const isRefreshingUpdates = ref(false);
            const isClearingCache = ref(false);

            const modal = reactive({ show: false, src: '', caption: '' });
            const loadGuard = window.createRequestGuard ? window.createRequestGuard() : { next: () => Date.now(), isCurrent: () => true };

            const persistUiState = () => {
                if (!window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    selectedInstall: selectedInstall.value,
                    searchQuery: searchQuery.value,
                    filterStatus: filterStatus.value
                });
            };

            const installOptions = computed(() => {
                if (installs.value.length === 0) return [[t('Searching for Game Installs...'), '']];
                return installs.value.map(g => [`${g.name} - ${g.path}`, g.path]);
            });

            const statusOptions = computed(() => [
                [t('All Mods'), 'all'],
                [t('Enabled Only'), 'enabled'],
                [t('Disabled Only'), 'disabled'],
                [t('Has Conflicts'), 'conflicts'],
                [t('Has Updates'), 'has_updates'],
                [t('From Trovesaurus Only'), 'trovesaurus_only']
            ]);

            const hasActiveConflict = (mod) => mod.status === 'enabled' && mod.conflicts_with && mod.conflicts_with.some(c => c.enabled);

            const filteredMods = computed(() => {
                const term = searchQuery.value.toLowerCase().trim();
                const stat = filterStatus.value;
                return mods.value.filter(mod => {
                    const haystack = `${mod.name || ''} ${mod.author || ''}`;
                    if (term) {
                        const nameMatch = mod.name.toLowerCase().includes(term);
                        const authorMatch = mod.author.toLowerCase().includes(term);
                        const fuzzy = window.fuzzyIncludes ? window.fuzzyIncludes(haystack, term, 4) : false;
                        if (!nameMatch && !authorMatch && !fuzzy) return false;
                    }
                    if (stat === 'enabled') return mod.status === 'enabled';
                    if (stat === 'disabled') return mod.status === 'disabled';
                    if (stat === 'conflicts') return hasActiveConflict(mod);
                    if (stat === 'has_updates') return !!mod.hasUpdate;
                    if (stat === 'trovesaurus_only') return !!mod.tsUrl;
                    return true;
                });
            });

            const totalCount = computed(() => mods.value.length);
            const filteredCount = computed(() => filteredMods.value.length);
            const shownCount = computed(() => filteredMods.value.length);

            const selectedMods = computed(() => {
                const set = new Set(selectedPaths.value);
                return mods.value.filter(m => set.has(m.path));
            });
            const selectedCount = computed(() => selectedMods.value.length);
            const allPageSelected = computed(() => {
                if (filteredMods.value.length === 0) return false;
                const set = new Set(selectedPaths.value);
                return filteredMods.value.every(m => set.has(m.path));
            });

            const isSelected = (mod) => selectedPaths.value.includes(mod.path);
            const toggleSelect = (mod, checked) => {
                const set = new Set(selectedPaths.value);
                if (checked) set.add(mod.path);
                else set.delete(mod.path);
                selectedPaths.value = [...set];
            };
            const toggleSelectPage = (checked) => {
                const set = new Set(selectedPaths.value);
                filteredMods.value.forEach(mod => {
                    if (checked) set.add(mod.path);
                    else set.delete(mod.path);
                });
                selectedPaths.value = [...set];
            };
            const clearSelection = () => {
                selectedPaths.value = [];
            };

            const dismissSearchShortcutHint = () => {
                showSearchShortcutHint.value = false;
                if (window.AppSettings) window.AppSettings.setPrefSync(PREF_HINT_KEY, 'dismissed');
            };

            const dismissOnboardingTips = () => {
                showOnboardingTips.value = false;
                if (window.AppSettings) window.AppSettings.setPrefSync(PREF_TOUR_KEY, 'dismissed');
            };

            const scanForGames = async () => {
                const response = await window.callBackend(eel.get_detected_game_paths()(), 'Failed to detect games');
                const settingsResp = await window.callBackend(eel.get_settings()(), 'Failed to load settings');
                const paths = response.data.paths || response.raw?.paths || [];
                const settings = settingsResp.data || settingsResp.raw || {};
                if (paths.length > 0) {
                    installs.value = paths;
                    if (selectedInstall.value && paths.some(p => p.path === selectedInstall.value)) return;
                    if (settings.last_game_path && paths.some(p => p.path === settings.last_game_path)) {
                        selectedInstall.value = settings.last_game_path;
                    } else {
                        selectedInstall.value = paths[0].path;
                    }
                } else {
                    installs.value = [];
                    selectedInstall.value = '';
                    if (!response.success && response.error) {
                        window.showToast(t('Game path detection failed: {error}').replace('{error}', response.error), true);
                    }
                }
            };

            const applyModUrls = async (token) => {
                if (!selectedInstall.value) return;
                const response = await window.callBackend(eel.get_mod_urls(selectedInstall.value)(), 'Failed to load mod URLs');
                if (!loadGuard.isCurrent(token)) return;
                if (!response.success) return;
                const urls = response.data.urls || response.raw?.urls || {};
                mods.value.forEach(mod => {
                    if (urls[mod.path]) mod.tsUrl = urls[mod.path];
                });
            };

            const applyUpdateFlags = async (token, notify) => {
                if (!selectedInstall.value) return;
                const response = await window.callBackend(eel.check_mod_updates(selectedInstall.value)(), 'Failed to check updates');
                if (!loadGuard.isCurrent(token)) return;
                if (!response.success) {
                    if (notify) window.showToast(t('Failed to refresh updates: {error}').replace('{error}', response.error || t('Unknown error occurred')), true);
                    return;
                }
                const updates = response.data.updates || response.raw?.updates || {};
                mods.value.forEach(mod => {
                    mod.hasUpdate = !!updates[mod.path];
                });
                if (notify) window.showToast(t('Update state refreshed.'));
            };

            const loadMods = async () => {
                if (!selectedInstall.value) return;
                const token = loadGuard.next();
                isLoading.value = true;
                mods.value = [];
                clearSelection();

                const settingsResp = await window.callBackend(eel.get_settings()(), 'Failed to load settings');
                const settings = settingsResp.data || settingsResp.raw || {};
                showPreviewOnInfoSide.value = settings.show_mod_preview_on_info_side !== false;

                let stText = t('Scanning Mod Directory...');
                if (settings.auto_fix_names || settings.auto_fix_configs) {
                    const fixing = [];
                    if (settings.auto_fix_names) fixing.push(t('Names'));
                    if (settings.auto_fix_configs) fixing.push(t('Configs'));
                    stText = t('Auto-fixing Mod {fixing}...').replace('{fixing}', fixing.join(' & '));
                }
                statusText.value = stText;

                const response = await window.callBackend(
                    eel.get_installed_mods(selectedInstall.value, settings.auto_fix_names === true, settings.auto_fix_configs === true)(),
                    'Failed to load installed mods'
                );

                if (!loadGuard.isCurrent(token)) return;

                if (response.success) {
                    const cachePath = response.data.cached_file || response.raw?.cached_file;
                    try {
                        const fetchRes = await fetch(`${cachePath}?t=${Date.now()}`);
                        const data = await fetchRes.json();
                        if (!loadGuard.isCurrent(token)) return;
                        mods.value = (data.mods || []).map(m => ({
                            ...m,
                            hasUpdate: false,
                            tsUrl: null,
                            isToggling: false,
                            isUpdating: false,
                            isDeleting: false
                        }));
                        await Promise.all([applyModUrls(token), applyUpdateFlags(token, false)]);
                    } catch (err) {
                        if (!loadGuard.isCurrent(token)) return;
                        statusText.value = t('Error reading mod data from cache.');
                    }
                } else {
                    statusText.value = t('Error loading mods: {error}').replace('{error}', response.error || t('Unknown error occurred'));
                }

                if (loadGuard.isCurrent(token)) isLoading.value = false;
            };

            const refreshInstallState = async () => {
                await window.JobQueue.run({
                    label: t('Refresh mod install state'),
                    task: async () => {
                        await loadMods();
                    },
                    retryTask: async () => {
                        await loadMods();
                    }
                });
            };

            const refreshUpdates = async () => {
                if (!selectedInstall.value) return;
                isRefreshingUpdates.value = true;
                const token = loadGuard.next();
                await window.JobQueue.run({
                    label: t('Refresh mod updates'),
                    task: async () => {
                        await applyUpdateFlags(token, true);
                    },
                    retryTask: async () => {
                        const retryToken = loadGuard.next();
                        await applyUpdateFlags(retryToken, true);
                    }
                });
                isRefreshingUpdates.value = false;
            };

            const clearCache = async () => {
                const confirmed = await window.showConfirmModal({
                    title: t('Clear Cache'),
                    message: t('Clear Mod Manager cache files now?'),
                    confirmLabel: t('Clear'),
                    cancelLabel: t('Cancel'),
                    danger: false
                });
                if (!confirmed) return;

                isClearingCache.value = true;
                const response = await window.callBackend(eel.clear_mod_manager_cache()(), 'Failed to clear cache');
                if (!response.success) {
                    window.showToast(t('Failed to clear cache: {error}').replace('{error}', response.error || t('Unknown error occurred')), true);
                } else {
                    window.showToast(t('Cache cleared.'));
                }
                isClearingCache.value = false;
            };

            const updateMod = async (mod) => {
                if (mod.isUpdating) return;
                mod.isUpdating = true;
                try {
                    const response = await window.callBackend(eel.perform_mod_update(selectedInstall.value, mod.path)(), 'Failed to update mod');
                    if (!response.success) {
                        window.showToast(t('Failed to update mod: {error}').replace('{error}', response.error || t('Unknown error occurred')), true);
                    } else {
                        mod.hasUpdate = false;
                        window.showToast(t("Mod '{name}' updated successfully!").replace('{name}', mod.name));
                    }
                } finally {
                    mod.isUpdating = false;
                }
            };

            const toggleMod = async (mod) => {
                if (mod.isToggling) return;
                mod.isToggling = true;
                try {
                    const response = await window.callBackend(eel.toggle_mod(selectedInstall.value, mod.path)(), 'Failed to toggle mod');
                    if (!response.success) {
                        window.showToast(t('Failed to toggle mod: {error}').replace('{error}', response.error || t('Unknown error occurred')), true);
                        return;
                    }

                    mod.status = mod.status === 'enabled' ? 'disabled' : 'enabled';
                    const newPath = response.data.new_path || response.raw?.new_path;
                    if (newPath) {
                        const oldPath = mod.path;
                        mod.path = newPath;
                        selectedPaths.value = selectedPaths.value.map(p => (p === oldPath ? newPath : p));
                    }

                    mods.value.forEach(m => {
                        if (m !== mod && m.conflicts_with) {
                            const conflict = m.conflicts_with.find(c => c.name === mod.name);
                            if (conflict) conflict.enabled = mod.status === 'enabled';
                        }
                    });
                } finally {
                    mod.isToggling = false;
                }
            };

            const removeModLocally = (mod) => {
                mods.value = mods.value.filter(m => m.path !== mod.path);
                selectedPaths.value = selectedPaths.value.filter(p => p !== mod.path);
                mods.value.forEach(m => {
                    if (Array.isArray(m.conflicts_with)) {
                        m.conflicts_with = m.conflicts_with.filter(c => c.name !== mod.name);
                    }
                });
            };

            const deleteMod = async (mod) => {
                if (mod.isDeleting) return;
                const confirmed = await window.showConfirmModal({
                    title: t('Delete Mod'),
                    message: t("Are you sure you want to permanently delete '{name}'?").replace('{name}', mod.name),
                    confirmLabel: t('Delete'),
                    cancelLabel: t('Cancel'),
                    danger: true
                });
                if (!confirmed) return;

                mod.isDeleting = true;
                const response = await window.callBackend(eel.delete_mod(selectedInstall.value, mod.path)(), 'Failed to delete mod');
                mod.isDeleting = false;

                if (!response.success) {
                    window.showToast(t('Failed to delete mod: {error}').replace('{error}', response.error || t('Unknown error occurred')), true);
                    return;
                }

                const snapshot = { ...mod };
                const undoToken = response.data.undo_token || response.raw?.undo_token;
                removeModLocally(mod);

                if (undoToken) {
                    window.showUndoToast(
                        t("Deleted '{name}'").replace('{name}', mod.name),
                        8,
                        async () => {
                            const undoResp = await window.callBackend(eel.undo_delete_mod(undoToken)(), 'Failed to undo delete');
                            if (!undoResp.success) {
                                window.showToast(t('Undo failed: {error}').replace('{error}', undoResp.error || t('Unknown error occurred')), true);
                                return;
                            }
                            mods.value.unshift(snapshot);
                            window.showToast(t('Deletion undone.'));
                        }
                    );
                } else {
                    window.showToast(t("Deleted '{name}'").replace('{name}', mod.name));
                }
            };

            const batchToggle = async (enable) => {
                const targets = selectedMods.value.filter(m => (enable ? m.status !== 'enabled' : m.status === 'enabled'));
                if (targets.length === 0) return;
                for (const mod of targets) {
                    await toggleMod(mod);
                }
                window.showToast(enable ? t('Selected mods enabled.') : t('Selected mods disabled.'));
            };

            const batchUpdate = async () => {
                const targets = selectedMods.value.filter(m => m.hasUpdate);
                if (targets.length === 0) return;
                for (const mod of targets) {
                    await updateMod(mod);
                }
            };

            const batchDelete = async () => {
                if (selectedMods.value.length === 0) return;
                const confirmed = await window.showConfirmModal({
                    title: t('Delete Selected Mods'),
                    message: t('Delete {count} selected mods?').replace('{count}', selectedMods.value.length),
                    confirmLabel: t('Delete All'),
                    cancelLabel: t('Cancel'),
                    danger: true
                });
                if (!confirmed) return;
                const targets = [...selectedMods.value];
                for (const mod of targets) {
                    await deleteMod(mod);
                }
                clearSelection();
            };

            const fixNames = async () => {
                if (!selectedInstall.value) return window.showToast(t('Select a game first.'), true);
                isFixingNames.value = true;
                const response = await window.callBackend(eel.fix_mod_names(selectedInstall.value)(), 'Failed to fix names');
                if (response.success) {
                    const count = response.data.fixed_count || response.raw?.fixed_count || 0;
                    window.showToast(t('Fixed {count} mod names!').replace('{count}', count));
                    await loadMods();
                } else {
                    window.showToast(t('Error: {error}').replace('{error}', response.error || t('Unknown error occurred')), true);
                }
                isFixingNames.value = false;
            };

            const fixConfigs = async () => {
                if (!selectedInstall.value) return window.showToast(t('Select a game first.'), true);
                isFixingConfigs.value = true;
                const response = await window.callBackend(eel.fix_mod_configs(selectedInstall.value)(), 'Failed to fix configs');
                if (response.success) {
                    const count = response.data.configs_ensured || response.raw?.configs_ensured || 0;
                    window.showToast(t('Verified configs for {count} mods!').replace('{count}', count));
                    await loadMods();
                } else {
                    window.showToast(t('Error: {error}').replace('{error}', response.error || t('Unknown error occurred')), true);
                }
                isFixingConfigs.value = false;
            };

            const getConflictTitle = (mod) => {
                const title = hasActiveConflict(mod) ? t('CRITICAL CONFLICT') : t('POTENTIAL CONFLICT');
                const names = (mod.conflicts_with || []).map(c => `${c.name} (${c.enabled ? t('ENABLED') : t('Disabled')})`).join('\n• ');
                return `${title}\n• ${names}`;
            };

            const openUrl = (url) => eel.open_url_in_browser(url)();
            const modNameUrl = (mod) => mod?.tsUrl || null;
            const authorUrl = (mod) => {
                const authorId = String(mod?.author_id || '').trim();
                if (!authorId) return null;
                return `https://trovesaurus.com/user=${encodeURIComponent(authorId)}`;
            };
            const openAuthor = (mod) => {
                const url = authorUrl(mod);
                if (!url) return;
                openUrl(url);
            };

            const showContextMenu = (e, mod) => {
                if (!window.ContextMenu) return;
                const isEnabled = mod.status === 'enabled';
                const menuItems = [
                    {
                        label: isEnabled ? 'Disable Mod' : 'Enable Mod',
                        icon: isEnabled ? 'fa-ban' : 'fa-check',
                        action: () => toggleMod(mod)
                    }
                ];

                if (mod.hasUpdate) {
                    menuItems.push({
                        label: 'Install Update',
                        icon: 'fa-cloud-arrow-down',
                        action: () => updateMod(mod)
                    });
                }

                menuItems.push({
                    label: isSelected(mod) ? 'Unselect' : 'Select',
                    icon: isSelected(mod) ? 'fa-square-minus' : 'fa-square-check',
                    action: () => toggleSelect(mod, !isSelected(mod))
                });

                menuItems.push({ separator: true });
                menuItems.push({
                    label: 'Delete Mod',
                    icon: 'fa-trash',
                    danger: true,
                    action: () => deleteMod(mod)
                });
                menuItems.push({ separator: true });
                menuItems.push({
                    label: 'Copy Mod Name',
                    icon: 'fa-copy',
                    action: () => navigator.clipboard.writeText(mod.name).then(() => window.showToast(t('Copied to clipboard!')))
                });

                window.ContextMenu.show(e, menuItems);
            };

            const openImageModal = (mod) => {
                if (!mod.image) return;
                modal.src = `data:image/png;base64,${mod.image}`;
                modal.caption = mod.name;
                modal.show = true;
            };

            const handleCardDoubleClick = (event, mod) => {
                const target = event?.target;
                if (target && target.closest('button, a, input, label, .mod-preview-img, .mod-card-delete-hover')) return;
                toggleSelect(mod, !isSelected(mod));
            };

            const escapeHtml = (text) => String(text || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');

            const highlightSearch = (text) => {
                const q = searchQuery.value.trim();
                const safe = escapeHtml(text || '');
                if (!q) return safe;
                const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(`(${escaped})`, 'ig');
                return safe.replace(re, '<mark>$1</mark>');
            };

            const setActiveResult = (index) => {
                const cards = Array.from(document.querySelectorAll('#mod-manager-vue-app .mod-card'));
                cards.forEach(c => c.classList.remove('kbd-active-result'));
                if (!cards.length) {
                    activeResultIndex.value = -1;
                    return;
                }
                const normalized = ((index % cards.length) + cards.length) % cards.length;
                activeResultIndex.value = normalized;
                cards[normalized].classList.add('kbd-active-result');
                cards[normalized].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            };

            const nextSearchResult = () => setActiveResult(activeResultIndex.value + 1);
            const prevSearchResult = () => setActiveResult(activeResultIndex.value - 1);

            const focusSearchInput = () => {
                const input = document.getElementById('mod-search-input');
                if (!input) return;
                input.focus();
                input.select();
            };

            const onKeyDown = (e) => {
                const root = document.getElementById('mod-manager-vue-app');
                if (!root || root.offsetParent === null) return;
                if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'f') {
                    const input = document.getElementById('mod-search-input');
                    if (input) {
                        e.preventDefault();
                        input.focus();
                        input.select();
                    }
                    return;
                }
                const activeEl = document.activeElement;
                if (activeEl && activeEl.id === 'mod-search-input') {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        nextSearchResult();
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        prevSearchResult();
                    }
                }
            };

            const onSectionChanged = async (e) => {
                const detail = e && e.detail ? e.detail : {};
                if (detail.previousSection === 'trovesaurus' && detail.currentSection === 'mod_manager' && selectedInstall.value) {
                    await loadMods();
                }
            };

            const closeImageModal = () => {
                modal.show = false;
                setTimeout(() => {
                    modal.src = '';
                }, 200);
            };

            watch(selectedInstall, async (newVal) => {
                if (!newVal) return;
                const settingsResp = await window.callBackend(eel.get_settings()(), 'Failed to load settings');
                const settings = settingsResp.data || settingsResp.raw || {};
                settings.last_game_path = newVal;
                await eel.save_settings(settings)();
                await loadMods();
            });

            watch(filteredMods, () => {
                const validPaths = new Set(mods.value.map(m => m.path));
                selectedPaths.value = selectedPaths.value.filter(p => validPaths.has(p));
                activeResultIndex.value = -1;
            });

            watch([searchQuery, filterStatus, selectedInstall], persistUiState);

            onMounted(async () => {
                await scanForGames();
                if (selectedInstall.value) {
                    await loadMods();
                }
                document.addEventListener('keydown', onKeyDown);
                document.addEventListener('mod_manager_section_changed', onSectionChanged);
                nextTick(() => {
                    if (window.applyCustomDropdowns) window.applyCustomDropdowns();
                });
            });

            onBeforeUnmount(() => {
                document.removeEventListener('keydown', onKeyDown);
                document.removeEventListener('mod_manager_section_changed', onSectionChanged);
            });

            return {
                t,
                installs,
                selectedInstall,
                installOptions,
                mods,
                filteredMods,
                isLoading,
                statusText,
                searchQuery,
                filterStatus,
                statusOptions,
                totalCount,
                filteredCount,
                shownCount,
                selectedCount,
                selectedPaths,
                allPageSelected,
                isFixingNames,
                isFixingConfigs,
                isRefreshingUpdates,
                isClearingCache,
                modal,
                scanForGames,
                refreshInstallState,
                refreshUpdates,
                clearCache,
                toggleMod,
                updateMod,
                deleteMod,
                isSelected,
                toggleSelect,
                toggleSelectPage,
                clearSelection,
                batchToggle,
                batchUpdate,
                batchDelete,
                fixNames,
                fixConfigs,
                hasActiveConflict,
                getConflictTitle,
                openUrl,
                modNameUrl,
                authorUrl,
                openAuthor,
                showContextMenu,
                highlightSearch,
                nextSearchResult,
                prevSearchResult,
                focusSearchInput,
                showSearchShortcutHint,
                dismissSearchShortcutHint,
                showPreviewOnInfoSide,
                showOnboardingTips,
                dismissOnboardingTips,
                handleCardDoubleClick,
                openImageModal,
                closeImageModal
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);

    if (window._modManagerApp) window._modManagerApp.unmount();
    window._modManagerApp = app;
    app.mount('#mod-manager-vue-app');
});
