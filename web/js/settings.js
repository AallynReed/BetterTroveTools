document.addEventListener('settings_loaded', async () => {
    console.log("Settings Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, watch, onMounted } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
            const PREF_STATE_KEY = 'state_settings';
            const unwrap = (raw) => {
                if (raw && typeof raw === 'object' && raw.success !== undefined && raw.data && typeof raw.data === 'object') {
                    return raw.data;
                }
                return raw || {};
            };

            const activeTab = ref('general');
            
            const settings = reactive({
                accent_color: '#5ec6ff',
                app_font: 'system',
                show_community_content: true,
                show_official_news: true,
                auto_fix_names: false,
                show_mod_preview_on_info_side: true
            });

            const customDirs = ref([]);

            const modals = reactive({
                add: false,
                edit: false
            });

            const addForm = reactive({ name: '', path: '' });
            const editForm = reactive({ name: '', path: '' });
            
            const isBrowsing = ref(false);
            const isSaving = ref(false);

            const loadSettings = async () => {
                const data = window.AppSettings
                    ? await window.AppSettings.load(true)
                    : unwrap(await eel.get_settings()());
                if (data) {
                    settings.accent_color = data.accent_color || '#5ec6ff';
                    settings.app_font = data.app_font || 'system';
                    settings.show_community_content = data.show_community_content !== false;
                    settings.show_official_news = data.show_official_news !== false;
                    settings.auto_fix_names = data.auto_fix_names === true;
                    settings.show_mod_preview_on_info_side = data.show_mod_preview_on_info_side !== false;
                    customDirs.value = data.custom_directories || [];
                }
            };

            const saveGeneralSettings = async () => {
                document.documentElement.style.setProperty('--accent-blue', settings.accent_color);
                const hex = settings.accent_color.replace('#', '');
                if (hex.length === 6) {
                    const r = parseInt(hex.substring(0, 2), 16);
                    const g = parseInt(hex.substring(2, 4), 16);
                    const b = parseInt(hex.substring(4, 6), 16);
                    document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
                }
                
                // Apply font globally
                const fontMap = {
                    'system': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                    'product-sans': '"Product Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                    'noto-sans': '"Noto Sans", sans-serif',
                    'inter': 'Inter, sans-serif',
                    'roboto': 'Roboto, sans-serif',
                    'segoe-ui': '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
                    'arial': 'Arial, Helvetica, sans-serif'
                };
                document.documentElement.style.setProperty('--app-font', fontMap[settings.app_font] || fontMap['system']);
                
                const currentSettings = window.AppSettings
                    ? await window.AppSettings.load()
                    : unwrap(await eel.get_settings()());
                Object.assign(currentSettings, settings);
                await eel.save_settings(currentSettings)();
                if (window.AppSettings) {
                    window.AppSettings._cache = { ...currentSettings };
                }
            };

            const openAddModal = () => {
                addForm.name = '';
                addForm.path = '';
                modals.add = true;
            };

            const browseDir = async () => {
                isBrowsing.value = true;
                const response = await eel.browse_for_game_dir()();
                if (response.success) {
                    addForm.path = response.path;
                    if (!addForm.name.trim()) {
                        addForm.name = response.path.split(/[\\/]/).pop() || t("Custom Trove");
                    }
                } else if (response.error) {
                    window.showToast(response.error, true);
                }
                isBrowsing.value = false;
            };

            const saveNewDir = async () => {
                isSaving.value = true;
                const name = addForm.name.trim() || t("Custom Trove");
                const exists = customDirs.value.some(d => d.path === addForm.path);
                if (!exists) {
                    const currentSettings = window.AppSettings
                        ? await window.AppSettings.load()
                        : unwrap(await eel.get_settings()());
                    if (!currentSettings.custom_directories) currentSettings.custom_directories = [];
                    currentSettings.custom_directories.push({ name: name, path: addForm.path });
                    await eel.save_settings(currentSettings)();
                    if (window.AppSettings) {
                        window.AppSettings._cache = { ...currentSettings };
                    }
                    await loadSettings();
                    modals.add = false;
                } else {
                    window.showToast(t("This directory is already in your custom list."), true);
                }
                isSaving.value = false;
            };

            const removeDir = async (path) => {
                const currentSettings = window.AppSettings
                    ? await window.AppSettings.load()
                    : unwrap(await eel.get_settings()());
                currentSettings.custom_directories = (currentSettings.custom_directories || []).filter(d => d.path !== path);
                await eel.save_settings(currentSettings)();
                if (window.AppSettings) {
                    window.AppSettings._cache = { ...currentSettings };
                }
                await loadSettings();
            };

            const openEditModal = (dir) => {
                editForm.name = dir.name;
                editForm.path = dir.path;
                modals.edit = true;
            };

            const saveEditDir = async () => {
                isSaving.value = true;
                const newName = editForm.name.trim() || t("Custom Trove");
                const currentSettings = window.AppSettings
                    ? await window.AppSettings.load()
                    : unwrap(await eel.get_settings()());
                for (let d of currentSettings.custom_directories || []) {
                    if (d.path === editForm.path) { d.name = newName; break; }
                }
                await eel.save_settings(currentSettings)();
                if (window.AppSettings) {
                    window.AppSettings._cache = { ...currentSettings };
                }
                await loadSettings();
                modals.edit = false;
                isSaving.value = false;
            };

            const resetOnboardingTips = async () => {
                let confirmed = true;
                if (typeof window.showConfirmModal === 'function') {
                    confirmed = await window.showConfirmModal({
                        title: t('Reset Onboarding Tips'),
                        message: t('Show tutorial hint chips again for supported tools?'),
                        confirmLabel: t('Reset Tips'),
                        cancelLabel: t('Cancel'),
                        danger: false
                    });
                }
                if (!confirmed) return;

                if (window.AppSettings) {
                    const settingsData = await window.AppSettings.load();
                    const prefs = settingsData.ui_preferences || {};
                    Object.keys(prefs).forEach((key) => {
                        if (key.startsWith('onboarding_') || key.startsWith('hint_')) {
                            delete prefs[key];
                        }
                    });
                    settingsData.ui_preferences = prefs;
                    await window.AppSettings.save();
                }
                window.showToast(t('Onboarding tips have been reset. They will appear again in supported tools.'));
            };

            const persistState = () => {
                if (!window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    activeTab: activeTab.value
                });
            };

            const restoreState = async () => {
                if (!window.AppSettings) return;
                await window.AppSettings.load();
                const saved = window.AppSettings.getPref(PREF_STATE_KEY, null);
                if (saved && typeof saved === 'object' && typeof saved.activeTab === 'string') {
                    activeTab.value = saved.activeTab;
                }
            };

            watch(activeTab, persistState);

            onMounted(async () => {
                await restoreState();
                await loadSettings();
            });

            return {
                t, activeTab, settings, customDirs, modals, addForm, editForm,
                isBrowsing, isSaving, saveGeneralSettings,
                openAddModal, browseDir, saveNewDir, removeDir, openEditModal, saveEditDir,
                resetOnboardingTips
            };
        }
    });

    if (window._settingsApp) window._settingsApp.unmount();
    window._settingsApp = app;
    app.mount('#settings-vue-app');
});
