document.addEventListener('settings_loaded', async () => {
    console.log("Settings Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, onMounted } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

            const activeTab = ref('general');
            
            const settings = reactive({
                accent_color: '#5ec6ff',
                show_community_content: true,
                auto_fix_names: false,
                auto_fix_configs: false
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
                const data = await eel.get_settings()();
                if (data) {
                    settings.accent_color = data.accent_color || '#5ec6ff';
                    settings.show_community_content = data.show_community_content !== false;
                    settings.auto_fix_names = data.auto_fix_names === true;
                    settings.auto_fix_configs = data.auto_fix_configs === true;
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
                const currentSettings = await eel.get_settings()();
                Object.assign(currentSettings, settings);
                await eel.save_settings(currentSettings)();
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
                    const currentSettings = await eel.get_settings()();
                    if (!currentSettings.custom_directories) currentSettings.custom_directories = [];
                    currentSettings.custom_directories.push({ name: name, path: addForm.path });
                    await eel.save_settings(currentSettings)();
                    await loadSettings();
                    modals.add = false;
                } else {
                    window.showToast(t("This directory is already in your custom list."), true);
                }
                isSaving.value = false;
            };

            const removeDir = async (path) => {
                const currentSettings = await eel.get_settings()();
                currentSettings.custom_directories = (currentSettings.custom_directories || []).filter(d => d.path !== path);
                await eel.save_settings(currentSettings)();
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
                const currentSettings = await eel.get_settings()();
                for (let d of currentSettings.custom_directories || []) {
                    if (d.path === editForm.path) { d.name = newName; break; }
                }
                await eel.save_settings(currentSettings)();
                await loadSettings();
                modals.edit = false;
                isSaving.value = false;
            };

            onMounted(loadSettings);

            return {
                t, activeTab, settings, customDirs, modals, addForm, editForm,
                isBrowsing, isSaving, saveGeneralSettings,
                openAddModal, browseDir, saveNewDir, removeDir, openEditModal, saveEditDir
            };
        }
    });

    if (window._settingsApp) window._settingsApp.unmount();
    window._settingsApp = app;
    app.mount('#settings-vue-app');
});