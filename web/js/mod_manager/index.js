document.addEventListener('mod_manager_loaded', async () => {
    if (typeof Vue === 'undefined') {
        console.error('Vue.js failed to load!');
        return;
    }

    // Lazy-loaded sub-tabs: each loads its script once on first activation, then
    // fires its `<section>_loaded` event so the (just-attached) listener mounts.
    const lazySections = {
        trovesaurus: { script: 'js/mod_manager/trovesaurus.js', event: 'trovesaurus_loaded', initialized: false },
        mods_hub: { script: 'js/mod_manager/mods_hub.js', event: 'mods_hub_loaded', initialized: false },
        modpacks: { script: 'js/mod_manager/modpacks.js', event: 'modpacks_loaded', initialized: false }
    };
    let activeSection = null;
    const setModManagerSection = (section) => {
        const previousSection = activeSection;
        activeSection = section;
        const buttons = document.querySelectorAll('[data-mm-tab]');
        const panels = document.querySelectorAll('[data-mm-panel]');
        buttons.forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-mm-tab') === section));
        panels.forEach(panel => panel.classList.toggle('active', panel.getAttribute('data-mm-panel') === section));

        const lazy = lazySections[section];
        if (lazy && !lazy.initialized) {
            lazy.initialized = true;
            const fire = () => document.dispatchEvent(new CustomEvent(lazy.event));
            if (window.loadScript) {
                window.loadScript(lazy.script).then(fire).catch((e) => {
                    console.error(`Failed to lazy-load ${lazy.script}:`, e);
                    fire();
                });
            } else {
                fire();
            }
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
            const t = (str, p) => (window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str);
            const uiState = readUiState();

            const installs = ref([]);
            const selectedInstall = ref(uiState.selectedInstall || '');

            const mods = ref([]);
            const isLoading = ref(false);
            const statusText = ref(t('mod_manager.scanning_mod_directory'));

            const searchQuery = ref(uiState.searchQuery || '');
            const activeResultIndex = ref(-1);
            const filterStatus = ref(uiState.filterStatus || 'all');
            const toursEnabled = window.BTT_ENABLE_ONBOARDING_TOURS !== false;
            const showOnboardingTips = ref(toursEnabled && (window.AppSettings ? window.AppSettings.getPref(PREF_TOUR_KEY, '') !== 'dismissed' : true));
            const showSearchShortcutHint = ref(window.AppSettings ? window.AppSettings.getPref(PREF_HINT_KEY, '') !== 'dismissed' : true);
            const showPreviewOnInfoSide = ref(true);

            const isFixingNames = ref(false);
            const isRefreshingUpdates = ref(false);
            const isClearingCache = ref(false);
            const isImportingTpack = ref(false);

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
                if (installs.value.length === 0) return [[t('mod_manager.searching_for_game_installs'), '']];
                return installs.value.map(g => [
                    t('common.name_path')
                        .replace('{name}', t(g.name))
                        .replace('{path}', g.path),
                    g.path
                ]);
            });

            const statusOptions = computed(() => [
                [t('mod_manager.all_mods'), 'all'],
                [t('mod_manager.enabled_only'), 'enabled'],
                [t('mod_manager.disabled_only'), 'disabled'],
                [t('mod_manager.has_conflicts'), 'conflicts'],
                [t('mod_manager.has_updates'), 'has_updates'],
                [t('mod_manager.from_trovesaurus_only'), 'trovesaurus_only']
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
                        window.showToast(t('common.game_path_detection_failed_error').replace('{error}', response.error), true);
                    }
                }
            };

            const openSelectedInstallFolder = async () => {
                if (!selectedInstall.value) {
                    window.showToast(t('common.no_path_selected'), true);
                    return;
                }
                const response = await eel.open_path_in_explorer(selectedInstall.value)();
                if (!response || !response.success) {
                    window.showToast(t('common.failed_to_open_folder_error').replace('{error}', response?.error || t('common.unknown_error_occurred')), true);
                }
            };

            const runManagedJob = async ({ label, task, retryTask = task }) => {
                return window.JobQueue.run({
                    label,
                    task,
                    retryTask
                });
            };

            // Mods Hub is authoritative: a mod resolved here uses hub data (variant
            // branch + variant-scoped update flag) and is excluded from the
            // Trovesaurus enrichment below.
            const applyHubStates = async (token) => {
                if (!selectedInstall.value) return;
                const response = await window.callBackend(eel.get_mods_hub_install_states(selectedInstall.value)(), 'Failed to load Mods Hub state');
                if (!loadGuard.isCurrent(token)) return;
                if (!response.success) return;
                const states = response.data.states || response.raw?.states || {};
                mods.value.forEach(mod => {
                    const s = states[mod.path];
                    if (!s) return;
                    mod.fromHub = true;
                    mod.hubRef = s.ref;                 // "<handle>/<slug>" — the API identifier
                    mod.hubSlug = s.slug;
                    mod.hubHandle = s.handle || null;
                    mod.hubBranch = s.branch || null;
                    mod.hubPageUrl = s.page_url || null;
                    mod.hasUpdate = !!s.has_update;     // variant-scoped: only same-branch updates flag
                    mod.tsUrl = s.page_url || mod.tsUrl; // title links to the hub page
                });
            };

            const applyModUrls = async (token) => {
                if (!selectedInstall.value) return;
                const response = await window.callBackend(eel.get_mod_urls(selectedInstall.value)(), 'Failed to load mod URLs');
                if (!loadGuard.isCurrent(token)) return;
                if (!response.success) return;
                const urls = response.data.urls || response.raw?.urls || {};
                mods.value.forEach(mod => {
                    if (mod.fromHub) return;            // hub mods skip the Trovesaurus check
                    if (urls[mod.path]) mod.tsUrl = urls[mod.path];
                });
            };

            const applyUpdateFlags = async (token, notify) => {
                if (!selectedInstall.value) return;
                const response = await window.callBackend(eel.check_mod_updates(selectedInstall.value)(), 'Failed to check updates');
                if (!loadGuard.isCurrent(token)) return;
                if (!response.success) {
                    if (notify) window.showToast(t('mod_manager.failed_to_refresh_updates_error').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                    return;
                }
                const updates = response.data.updates || response.raw?.updates || {};
                mods.value.forEach(mod => {
                    if (mod.fromHub) return;            // hub update state already set from the hub
                    mod.hasUpdate = !!updates[mod.path];
                });
                if (notify) window.showToast(t('mod_manager.update_state_refreshed'));
            };

            // Resolve hub mods first, then run the Trovesaurus check only for the
            // remaining (non-hub) mods. If everything is from the hub we skip
            // Trovesaurus entirely.
            const applyEnrichment = async (token, notify = false) => {
                await applyHubStates(token);
                if (!loadGuard.isCurrent(token)) return;
                if (mods.value.some(m => !m.fromHub)) {
                    await Promise.all([applyModUrls(token), applyUpdateFlags(token, notify)]);
                } else if (notify) {
                    window.showToast(t('mod_manager.update_state_refreshed'));
                }
            };

            const loadMods = async () => {
                if (!selectedInstall.value) return;
                const token = loadGuard.next();
                isLoading.value = true;
                mods.value = [];

                const settingsResp = await window.callBackend(eel.get_settings()(), 'Failed to load settings');
                const settings = settingsResp.data || settingsResp.raw || {};
                showPreviewOnInfoSide.value = settings.show_mod_preview_on_info_side !== false;

                // Auto-fix names defaults ON: treat an unset value as enabled so a
                // user who never visited Settings still gets name-fixing (and the
                // status text matches what actually runs below).
                const autoFixNames = settings.auto_fix_names !== false;
                let stText = autoFixNames
                    ? t('mod_manager.scanning_mods_and_auto_fixing_names')
                    : t('mod_manager.scanning_mods_and_verifying_configs');
                statusText.value = stText;

                const response = await window.callBackend(
                    eel.get_installed_mods(selectedInstall.value, autoFixNames, true)(),
                    'Failed to load installed mods'
                );

                if (!loadGuard.isCurrent(token)) return;

                if (response.success) {
                    const readOnlyCfgs = response.data.read_only_configs || response.raw?.read_only_configs || [];
                    if (readOnlyCfgs.length) {
                        window.showToast(t('mod_manager.cfg_read_only_skipped').replace('{mods}', readOnlyCfgs.join(', ')), true);
                    }
                    const cachePath = response.data.cached_file || response.raw?.cached_file;
                    try {
                        const fetchRes = await fetch(`${cachePath}?t=${Date.now()}`);
                        const data = await fetchRes.json();
                        if (!loadGuard.isCurrent(token)) return;
                        mods.value = (data.mods || []).map(m => ({
                            ...m,
                            hasUpdate: false,
                            tsUrl: null,
                            fromHub: false,
                            hubRef: null,
                            hubSlug: null,
                            hubHandle: null,
                            hubBranch: null,
                            hubPageUrl: null,
                            isToggling: false,
                            isUpdating: false,
                            isDeleting: false
                        }));
                        // Render the list immediately from local data. Enrichment
                        // (Mods Hub state first, then Trovesaurus for the rest) needs
                        // the network, so run it in the BACKGROUND and never block the
                        // list on it -- offline the mods still show right away, and
                        // tsUrl/hasUpdate fill in reactively if/when requests succeed.
                        if (loadGuard.isCurrent(token)) isLoading.value = false;
                        applyEnrichment(token).catch(() => {});
                    } catch (err) {
                        if (!loadGuard.isCurrent(token)) return;
                        statusText.value = t('mod_manager.error_reading_mod_data_from_cache');
                    }
                } else {
                    statusText.value = t('mod_manager.error_loading_mods_error').replace('{error}', response.error || t('common.unknown_error_occurred'));
                }

                if (loadGuard.isCurrent(token)) isLoading.value = false;
            };

            const refreshInstallState = async () => {
                await window.JobQueue.run({
                    label: t('mod_manager.refresh_mod_install_state'),
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
                    label: t('mod_manager.refresh_mod_updates'),
                    task: async () => {
                        await applyEnrichment(token, true);
                    },
                    retryTask: async () => {
                        const retryToken = loadGuard.next();
                        await applyEnrichment(retryToken, true);
                    }
                });
                isRefreshingUpdates.value = false;
            };

            const clearCache = async () => {
                const confirmed = await window.showConfirmModal({
                    title: t('common.clear_cache'),
                    message: t('mod_manager.clear_mod_manager_cache_files_now'),
                    confirmLabel: t('common.clear'),
                    cancelLabel: t('common.cancel'),
                    danger: false
                });
                if (!confirmed) return;

                isClearingCache.value = true;
                try {
                    const response = await runManagedJob({
                        label: t('mod_manager.clear_mod_manager_cache'),
                        task: async () => window.callBackend(eel.clear_mod_manager_cache()(), 'Failed to clear cache')
                    });
                    if (!response.success) {
                        window.showToast(t('common.failed_to_clear_cache_error').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                    } else {
                        window.showToast(t('mod_manager.mod_manager_cache_cleared'));
                    }
                } finally {
                    isClearingCache.value = false;
                }
            };

            const updateMod = async (mod) => {
                if (mod.isUpdating) return;
                mod.isUpdating = true;
                try {
                    // Hub mods update at the VARIANT level: reinstall the latest
                    // release of the branch the user is on (never silently jump to
                    // another variant). Others use the Trovesaurus updater.
                    const response = await runManagedJob({
                        label: t("common.update_mod_name").replace('{name}', mod.name),
                        task: async () => mod.fromHub
                            ? window.callBackend(eel.install_mods_hub_mod_sync(selectedInstall.value, mod.hubRef, mod.hubBranch || null)(), 'Failed to update mod')
                            : window.callBackend(eel.perform_mod_update(selectedInstall.value, mod.path)(), 'Failed to update mod')
                    });
                    if (!response.success) {
                        window.showToast(t('mod_manager.failed_to_update_mod_error').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                    } else {
                        mod.hasUpdate = false;
                        window.showToast(t("mod_manager.updated_name").replace('{name}', mod.name));
                        await loadMods();
                    }
                } finally {
                    mod.isUpdating = false;
                }
            };

            // --- Mods Hub variant switching (for installed hub mods) ------------
            const variantPicker = reactive({ show: false, mod: null, name: '', variants: [], installedBranch: null });

            const formatBytes = (bytes) => {
                const n = Number(bytes);
                if (!Number.isFinite(n) || n <= 0) return '';
                const units = ['B', 'KB', 'MB', 'GB'];
                let i = 0, v = n;
                while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
                return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
            };

            const openVariantPicker = async (mod) => {
                if (!mod.fromHub || !mod.hubRef) return;
                const resp = await window.callBackend(eel.get_mods_hub_variants(mod.hubRef)(), 'Failed to load variants');
                if (!resp.success) {
                    window.showToast(t('mods_hub.error_error').replace('{error}', resp.error || t('common.unknown_error_occurred')), true);
                    return;
                }
                const variants = resp.data?.variants || resp.raw?.variants || [];
                if (!variants.length) {
                    window.showToast(t('mods_hub.no_releases'), true);
                    return;
                }
                variantPicker.mod = mod;
                variantPicker.name = mod.name;
                variantPicker.variants = variants;
                variantPicker.installedBranch = mod.hubBranch || null;
                variantPicker.show = true;
            };

            const installVariant = async (branch) => {
                const mod = variantPicker.mod;
                variantPicker.show = false;
                if (!mod) return;
                const response = await runManagedJob({
                    label: t("common.update_mod_name").replace('{name}', mod.name),
                    task: async () => window.callBackend(eel.install_mods_hub_mod_sync(selectedInstall.value, mod.hubRef, branch)(), 'Failed to install variant')
                });
                if (!response.success) {
                    window.showToast(t('mods_hub.error_error').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                    return;
                }
                window.showToast(t('common.installed'));
                await loadMods();
            };

            const closeVariantPicker = () => {
                variantPicker.show = false;
                variantPicker.mod = null;
                variantPicker.variants = [];
            };

            const toggleMod = async (mod) => {
                if (mod.isToggling) return;
                mod.isToggling = true;
                try {
                    const nextStateLabel = mod.status === 'enabled' ? t('mod_manager.disable') : t('mod_manager.enable');
                    const response = await runManagedJob({
                        label: t("mod_manager.action_mod_name").replace('{action}', nextStateLabel).replace('{name}', mod.name),
                        task: async () => window.callBackend(eel.toggle_mod(selectedInstall.value, mod.path)(), 'Failed to toggle mod')
                    });
                    if (!response.success) {
                        window.showToast(t('mod_manager.failed_to_toggle_mod_error').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                        return;
                    }

                    mod.status = mod.status === 'enabled' ? 'disabled' : 'enabled';
                    const newPath = response.data.new_path || response.raw?.new_path;
                    if (newPath) {
                        mod.path = newPath;
                    }

                    mods.value.forEach(m => {
                        if (m !== mod && m.conflicts_with) {
                            const conflict = m.conflicts_with.find(c => c.name === mod.name);
                            if (conflict) conflict.enabled = mod.status === 'enabled';
                        }
                    });
                    window.showToast(
                        mod.status === 'enabled'
                            ? t("mod_manager.enabled_name").replace('{name}', mod.name)
                            : t("mod_manager.disabled_name").replace('{name}', mod.name)
                    );
                } finally {
                    mod.isToggling = false;
                }
            };

            // Import a local .tpack modpack file: a native dialog picks the file,
            // the backend decompiles it into the individual .tmods, quarantines
            // same-name conflicts into mods/disabled/, and installs.
            const importTpack = async () => {
                if (!selectedInstall.value) return window.showToast(t('common.select_a_game_first'), true);
                if (isImportingTpack.value) return;
                isImportingTpack.value = true;
                try {
                    const response = await window.JobQueue.run({
                        label: t('mod_manager.import_tpack'),
                        task: async () => window.callBackend(eel.import_tpack_file(selectedInstall.value)(), 'Failed to import modpack')
                    });
                    if (!response.success) {
                        window.showToast(t('mod_manager.import_tpack_failed').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                        return;
                    }
                    const data = response.data || response.raw || {};
                    if (data.cancelled) return;  // user closed the file dialog
                    const installed = data.installed || 0;
                    const quarantined = (data.quarantined || []).length;
                    window.showToast(quarantined
                        ? t('modpacks.installed_with_quarantine').replace('{count}', installed).replace('{disabled}', quarantined)
                        : t('modpacks.installed_summary').replace('{count}', installed));
                    await loadMods();
                } finally {
                    isImportingTpack.value = false;
                }
            };

            const removeModLocally = (mod) => {
                mods.value = mods.value.filter(m => m.path !== mod.path);
                mods.value.forEach(m => {
                    if (Array.isArray(m.conflicts_with)) {
                        m.conflicts_with = m.conflicts_with.filter(c => c.name !== mod.name);
                    }
                });
            };

            const deleteMod = async (mod) => {
                if (mod.isDeleting) return;
                const confirmed = await window.showConfirmModal({
                    title: t('common.delete_mod'),
                    message: t("common.are_you_sure_you_want_to_permanently_del_7a0256").replace('{name}', mod.name),
                    confirmLabel: t('common.delete'),
                    cancelLabel: t('common.cancel'),
                    danger: true
                });
                if (!confirmed) return;

                mod.isDeleting = true;
                const response = await runManagedJob({
                    label: t("common.delete_mod_name").replace('{name}', mod.name),
                    task: async () => window.callBackend(eel.delete_mod(selectedInstall.value, mod.path)(), 'Failed to delete mod')
                });
                mod.isDeleting = false;

                if (!response.success) {
                    window.showToast(t('common.failed_to_delete_mod_error').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                    return;
                }

                const snapshot = { ...mod };
                const undoToken = response.data.undo_token || response.raw?.undo_token;
                removeModLocally(mod);

                if (undoToken) {
                    window.showUndoToast(
                        t("common.deleted_name").replace('{name}', mod.name),
                        8,
                        async () => {
                            const undoResp = await window.callBackend(eel.undo_delete_mod(undoToken)(), 'Failed to undo delete');
                            if (!undoResp.success) {
                                window.showToast(t('common.undo_failed_error').replace('{error}', undoResp.error || t('common.unknown_error_occurred')), true);
                                return;
                            }
                            mods.value.unshift(snapshot);
                            window.showToast(t('common.deletion_undone'));
                        }
                    );
                } else {
                    window.showToast(t("common.deleted_name").replace('{name}', mod.name));
                }
            };

            const fixNames = async () => {
                if (!selectedInstall.value) return window.showToast(t('common.select_a_game_first'), true);
                isFixingNames.value = true;
                try {
                    const response = await runManagedJob({
                        label: t('mod_manager.fix_mod_file_names'),
                        task: async () => window.callBackend(eel.fix_mod_names(selectedInstall.value)(), 'Failed to fix names')
                    });
                    if (response.success) {
                        const count = response.data.fixed_count || response.raw?.fixed_count || 0;
                        window.showToast(t('mod_manager.fixed_count_mod_file_names').replace('{count}', count));
                        await loadMods();
                    } else {
                        window.showToast(t('mod_manager.failed_to_fix_names_error').replace('{error}', response.error || t('common.unknown_error_occurred')), true);
                    }
                } finally {
                    isFixingNames.value = false;
                }
            };

            const getConflictTitle = (mod) => {
                const title = hasActiveConflict(mod) ? t('mod_manager.critical_conflict') : t('mod_manager.potential_conflict');
                const names = (mod.conflicts_with || []).map(c => `${c.name} (${c.enabled ? t('mod_manager.enabled') : t('mod_manager.disabled')})`).join('\n• ');
                return `${title}\n• ${names}`;
            };

            const openUrl = (url) => eel.open_url_in_browser(url)();
            const modNameUrl = (mod) => mod?.tsUrl || null;
            const authorUrl = (mod) => {
                // Hub mods link to the author's hub page; Trovesaurus mods to the TS profile.
                if (mod?.fromHub && mod.hubHandle) {
                    return `https://trove.aallyn.net/mods/${encodeURIComponent(mod.hubHandle)}`;
                }
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

                if (mod.fromHub) {
                    menuItems.push({
                        label: 'Switch Variant…',
                        icon: 'fa-code-branch',
                        action: () => openVariantPicker(mod)
                    });
                }

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
                    action: () => navigator.clipboard.writeText(mod.name)
                        .then(() => window.showToast(t('common.copied_to_clipboard')))
                        .catch(() => window.showToast(t('mod_manager.could_not_copy_to_clipboard'), true))
                });

                window.ContextMenu.show(e, menuItems);
            };

            const openImageModal = (mod) => {
                if (!mod.image) return;
                modal.src = `data:image/png;base64,${mod.image}`;
                modal.caption = mod.name;
                modal.show = true;
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
                const fromCommunityTab = detail.previousSection === 'trovesaurus'
                    || detail.previousSection === 'mods_hub'
                    || detail.previousSection === 'modpacks';
                if (fromCommunityTab && detail.currentSection === 'mod_manager' && selectedInstall.value) {
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
                openSelectedInstallFolder,
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
                isFixingNames,
                isRefreshingUpdates,
                isClearingCache,
                isImportingTpack,
                importTpack,
                modal,
                scanForGames,
                refreshInstallState,
                refreshUpdates,
                clearCache,
                toggleMod,
                updateMod,
                deleteMod,
                fixNames,
                variantPicker,
                openVariantPicker,
                installVariant,
                closeVariantPicker,
                formatBytes,
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
