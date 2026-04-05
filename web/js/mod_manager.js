document.addEventListener('mod_manager_loaded', async () => {
    console.log("Mod Manager Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

            const installs = ref([]);
            const selectedInstall = ref('');
            
            const mods = ref([]);
            const isLoading = ref(false);
            const statusText = ref(t('Scanning Mod Directory...'));
            
            const searchQuery = ref('');
            const filterStatus = ref('all');
            const currentPage = ref(1);
            const pageSize = ref(24);

            const isFixingNames = ref(false);
            const isFixingConfigs = ref(false);

            const modal = reactive({ show: false, src: '', caption: '' });

            const installOptions = computed(() => {
                if (installs.value.length === 0) return [[t('Searching for Game Installs...'), '']];
                return installs.value.map(g => [`${g.name} - ${g.path}`, g.path]);
            });

            const statusOptions = computed(() => [
                [t('All Mods'), 'all'],
                [t('Enabled Only'), 'enabled'],
                [t('Disabled Only'), 'disabled'],
                [t('Active Conflicts (Red)'), 'conflicts']
            ]);

            const hasActiveConflict = (mod) => {
                return mod.status === 'enabled' && mod.conflicts_with && mod.conflicts_with.some(c => c.enabled);
            };

            const filteredMods = computed(() => {
                const term = searchQuery.value.toLowerCase().trim();
                const stat = filterStatus.value;

                return mods.value.filter(mod => {
                    const nameMatch = mod.name.toLowerCase().includes(term);
                    const authorMatch = mod.author.toLowerCase().includes(term);
                    if (term && !nameMatch && !authorMatch) return false;

                    if (stat === 'enabled') return mod.status === 'enabled';
                    if (stat === 'disabled') return mod.status === 'disabled';
                    if (stat === 'conflicts') return hasActiveConflict(mod);
                    return true;
                });
            });

            const maxPages = computed(() => Math.max(1, Math.ceil(filteredMods.value.length / pageSize.value)));

            const paginatedMods = computed(() => {
                const start = (currentPage.value - 1) * pageSize.value;
                return filteredMods.value.slice(start, start + pageSize.value);
            });

            const totalCount = computed(() => mods.value.length);
            const filteredCount = computed(() => filteredMods.value.length);
            const shownCount = computed(() => paginatedMods.value.length);

            const goToPage = (page) => {
                const safePage = Math.max(1, Math.min(page, maxPages.value));
                if (safePage === currentPage.value) return;
                currentPage.value = safePage;

                const vc = document.getElementById('view-container');
                if (vc) vc.scrollTo({ top: 0, behavior: 'smooth' });
            };

            const scanForGames = async () => {
                const response = await eel.get_detected_game_paths()();
                const settings = await eel.get_settings()();
                if (response.success && response.paths.length > 0) {
                    installs.value = response.paths;
                    if (settings.last_game_path && installs.value.some(p => p.path === settings.last_game_path)) {
                        selectedInstall.value = settings.last_game_path;
                    } else {
                        selectedInstall.value = installs.value[0].path;
                    }
                } else {
                    installs.value = [];
                    selectedInstall.value = '';
                }
            };

            const loadMods = async () => {
                if (!selectedInstall.value) return;
                
                isLoading.value = true;
                mods.value = [];
                
                const settings = await eel.get_settings()();
                let stText = t("Scanning Mod Directory...");
                if (settings.auto_fix_names || settings.auto_fix_configs) {
                    let fixing = [];
                    if (settings.auto_fix_names) fixing.push(t("Names"));
                    if (settings.auto_fix_configs) fixing.push(t("Configs"));
                    stText = t("Auto-fixing Mod {fixing}...").replace("{fixing}", fixing.join(" & "));
                }
                statusText.value = stText;

                const response = await eel.get_installed_mods(selectedInstall.value, settings.auto_fix_names === true, settings.auto_fix_configs === true)();
                
                if (response.success) {
                    try {
                        const fetchRes = await fetch(response.cached_file + '?t=' + new Date().getTime());
                        const data = await fetchRes.json();
                        mods.value = data.mods.map(m => ({ ...m, hasUpdate: false, tsUrl: null, isToggling: false, isUpdating: false, isDeleting: false }));
                        currentPage.value = 1;
                        
                        getModUrls();
                        checkForUpdates();
                    } catch (err) {
                        console.error("Failed to load mod cache:", err);
                        statusText.value = t("Error reading mod data from cache.");
                    }
                } else {
                    statusText.value = t("Error loading mods: {error}").replace("{error}", response.error);
                }
                isLoading.value = false;
            };

            const getModUrls = async () => {
                if (!selectedInstall.value) return;
                const response = await eel.get_mod_urls(selectedInstall.value)();
                if (response.success && response.urls) {
                    mods.value.forEach(mod => {
                        if (response.urls[mod.path]) {
                            mod.tsUrl = response.urls[mod.path];
                        }
                    });
                }
            };

            const checkForUpdates = async () => {
                if (!selectedInstall.value) return;
                const response = await eel.check_mod_updates(selectedInstall.value)();
                if (response.success && response.updates) {
                    mods.value.forEach(mod => {
                        if (response.updates[mod.path]) {
                            mod.hasUpdate = true;
                        }
                    });
                }
            };

            const toggleMod = async (mod) => {
                if (mod.isToggling) return;
                mod.isToggling = true;
                const response = await eel.toggle_mod(selectedInstall.value, mod.path)();
                if (response.success) {
                mod.status = mod.status === 'enabled' ? 'disabled' : 'enabled';
                if (response.new_path) mod.path = response.new_path;
                
                mods.value.forEach(m => {
                    if (m !== mod && m.conflicts_with) {
                        const conflict = m.conflicts_with.find(c => c.name === mod.name);
                        if (conflict) conflict.enabled = (mod.status === 'enabled');
                    }
                });
                
                mod.isToggling = false;
                } else {
                    window.showToast(t("Failed to toggle mod: {error}").replace("{error}", response.error), true);
                    mod.isToggling = false;
                }
            };

            const updateMod = async (mod) => {
                if (mod.isUpdating) return;
                mod.isUpdating = true;
                const response = await eel.perform_mod_update(selectedInstall.value, mod.path)();
                if (response.success) {
                mod.hasUpdate = false;
                mod.isUpdating = false;
                window.showToast(t("Mod '{name}' updated successfully!").replace("{name}", mod.name));
                } else {
                    window.showToast(t("Failed to update mod: {error}").replace("{error}", response.error), true);
                    mod.isUpdating = false;
                }
            };

            const deleteMod = async (mod) => {
                if (mod.isDeleting) return;

                const confirmed = window.confirm(
                    t("Are you sure you want to permanently delete '{name}'?").replace("{name}", mod.name)
                );
                if (!confirmed) return;

                mod.isDeleting = true;
                const response = await eel.delete_mod(selectedInstall.value, mod.path)();

                if (response.success) {
                    const oldPath = mod.path;
                    mods.value = mods.value.filter(m => m.path !== oldPath);

                    // Remove stale conflict references pointing to the deleted mod.
                    mods.value.forEach(m => {
                        if (Array.isArray(m.conflicts_with)) {
                            m.conflicts_with = m.conflicts_with.filter(c => c.name !== mod.name);
                        }
                    });

                    window.showToast(t("Deleted '{name}'").replace("{name}", mod.name));
                } else {
                    mod.isDeleting = false;
                    window.showToast(t("Failed to delete mod: {error}").replace("{error}", response.error || t("Unknown error occurred")), true);
                }
            };

            const fixNames = async () => {
                if (!selectedInstall.value) return window.showToast(t("Select a game first."), true);
                isFixingNames.value = true;
                const response = await eel.fix_mod_names(selectedInstall.value)();
                if (response.success) {
                    window.showToast(t("Fixed {count} mod names!").replace("{count}", response.fixed_count));
                    await loadMods();
                } else {
                    window.showToast(t("Error: {error}").replace("{error}", response.error), true);
                }
                isFixingNames.value = false;
            };

            const fixConfigs = async () => {
                if (!selectedInstall.value) return window.showToast(t("Select a game first."), true);
                isFixingConfigs.value = true;
                const response = await eel.fix_mod_configs(selectedInstall.value)();
                if (response.success) {
                    window.showToast(t("Verified configs for {count} mods!").replace("{count}", response.configs_ensured));
                    await loadMods();
                } else {
                    window.showToast(t("Error: {error}").replace("{error}", response.error), true);
                }
                isFixingConfigs.value = false;
            };

            const getConflictTitle = (mod) => {
                const isCrit = hasActiveConflict(mod);
                const names = mod.conflicts_with.map(c => `${c.name} (${c.enabled ? t('ENABLED') : t('Disabled')})`).join('\n• ');
                const title = isCrit ? t('CRITICAL CONFLICT') : t('POTENTIAL CONFLICT');
                return `${title}\n• ${names}`;
            };

            const openUrl = (url) => eel.open_url_in_browser(url)();

            const showContextMenu = (e, mod) => {
                if (!window.ContextMenu) return;
                const isEnabled = mod.status === 'enabled';
                
                let menuItems = [{
                    label: isEnabled ? 'Disable Mod' : 'Enable Mod',
                    icon: isEnabled ? 'fa-ban' : 'fa-check',
                    action: () => toggleMod(mod)
                }];
                
                if (mod.hasUpdate) {
                    menuItems.push({
                        label: 'Install Update',
                        icon: 'fa-cloud-arrow-down',
                        action: () => updateMod(mod)
                    });
                }
                
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
                    action: () => navigator.clipboard.writeText(mod.name).then(() => window.showToast(t("Copied to clipboard!")))
                });
                
                window.ContextMenu.show(e, menuItems);
            };

            const openImageModal = (mod) => {
                if (mod.image) {
                    modal.src = 'data:image/png;base64,' + mod.image;
                    modal.caption = mod.name;
                    modal.show = true;
                }
            };

            const closeImageModal = () => {
                modal.show = false;
                setTimeout(() => { modal.src = ''; }, 200);
            };

            watch(selectedInstall, async (newVal) => {
                if (!newVal) return;
                const settings = await eel.get_settings()();
                settings.last_game_path = newVal;
                await eel.save_settings(settings)();
                await loadMods();
            });

            watch([searchQuery, filterStatus], () => {
                currentPage.value = 1;
            });

            watch(filteredMods, () => {
                if (currentPage.value > maxPages.value) currentPage.value = maxPages.value;
                if (currentPage.value < 1) currentPage.value = 1;
            });

            onMounted(async () => {
                await scanForGames();
                nextTick(() => { if (window.applyCustomDropdowns) window.applyCustomDropdowns(); });
            });

            return {
                t, installs, selectedInstall, installOptions,
                mods, filteredMods, paginatedMods, isLoading, statusText,
                searchQuery, filterStatus, statusOptions,
                totalCount, filteredCount, shownCount, currentPage, maxPages,
                isFixingNames, isFixingConfigs, modal,
                scanForGames, goToPage, toggleMod, updateMod, deleteMod, fixNames, fixConfigs,
                hasActiveConflict, getConflictTitle, openUrl, showContextMenu,
                openImageModal, closeImageModal
            };
        }
    });

    app.component('custom-vue-select', window.CustomVueSelect);

    if (window._modManagerApp) window._modManagerApp.unmount();
    window._modManagerApp = app;
    app.mount('#mod-manager-vue-app');
});