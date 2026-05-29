document.addEventListener('settings_loaded', async () => {
    console.log("Settings Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, watch, onMounted } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
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
                show_mod_preview_on_info_side: true,
                hide_beta_features: false,
                fps_caps: {}
            });

            const customDirs = ref([]);
            const gameInstalls = ref([]);
            const fpsRepair = ref([]);
            const isFpsRepair = (path) => fpsRepair.value.includes(path);
            // Game-client settings (FPS cap) require local file access -> hide in hosted web mode.
            const isWebMode = window.BTT_WEB_MODE === true;

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
                    settings.hide_beta_features = data.hide_beta_features === true;
                    settings.fps_caps = data.fps_caps || {};
                    customDirs.value = data.custom_directories || [];
                    gameInstalls.value = data.game_installs || [];
                    fpsRepair.value = Array.isArray(data.fps_repair) ? data.fps_repair : [];
                }
            };

            const applyAccentColor = (accentColor) => {
                document.documentElement.style.setProperty('--accent-blue', accentColor);
                const hex = String(accentColor || '').replace('#', '');
                if (hex.length === 6) {
                    const r = parseInt(hex.substring(0, 2), 16);
                    const g = parseInt(hex.substring(2, 4), 16);
                    const b = parseInt(hex.substring(4, 6), 16);
                    document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
                }
            };

            const applyAppFont = (appFont) => {
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
                // Pull in the matching Google Fonts stylesheet if needed (no-op for
                // system / segoe-ui / arial / product-sans).
                if (window.ensureGoogleFont) window.ensureGoogleFont(appFont);
                document.documentElement.style.setProperty('--app-font', fontMap[appFont] || fontMap['system']);
            };

            const previewAccentColor = () => {
                applyAccentColor(settings.accent_color);
            };

            const saveGeneralSettings = async () => {
                applyAccentColor(settings.accent_color);
                applyAppFont(settings.app_font);
                
                const currentSettings = window.AppSettings
                    ? await window.AppSettings.load()
                    : unwrap(await eel.get_settings()());
                Object.assign(currentSettings, settings);
                
                const response = await eel.save_settings(currentSettings)();
                const response_data = unwrap(response);
                
                if (window.AppSettings) {
                    window.AppSettings._cache = { ...response_data };
                }
                
                gameInstalls.value = response_data.game_installs || [];
                fpsRepair.value = Array.isArray(response_data.fps_repair) ? response_data.fps_repair : [];
                document.dispatchEvent(new CustomEvent('app_settings_updated', {
                    detail: { settings: { ...response_data } }
                }));
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
                        addForm.name = response.path.split(/[\\/]/).pop() || t("settings.custom_trove");
                    }
                } else if (response.error) {
                    window.showToast(response.error, true);
                }
                isBrowsing.value = false;
            };

            const saveNewDir = async () => {
                isSaving.value = true;
                const name = addForm.name.trim() || t("settings.custom_trove");
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
                    window.showToast(t("settings.this_directory_is_already_in_your_custom_23315c"), true);
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
                const newName = editForm.name.trim() || t("settings.custom_trove");
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
                        title: t('settings.reset_onboarding_tips'),
                        message: t('settings.show_tutorial_hint_chips_again_for_suppo_4aebcf'),
                        confirmLabel: t('settings.reset_tips'),
                        cancelLabel: t('common.cancel'),
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
                window.showToast(t('settings.onboarding_tips_have_been_reset_they_wil_dbc086'));
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
                isBrowsing, isSaving, previewAccentColor, saveGeneralSettings,
                openAddModal, browseDir, saveNewDir, removeDir, openEditModal, saveEditDir,
                resetOnboardingTips, gameInstalls, isFpsRepair, isWebMode
            };
        }
    });

    if (window._settingsApp) window._settingsApp.unmount();
    window._settingsApp = app;
    app.mount('#settings-vue-app');
});
