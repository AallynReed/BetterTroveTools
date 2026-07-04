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
            
            // Default notification config — mirrors defaultSettings.notifications
            // in web_mode.js so the structure round-trips when load misses it.
            // Each rotation has its OWN lead_minutes (>=1) and on_time toggle.
            const defaultNotifications = () => ({
                enabled: false,
                types: {
                    corruxion: { enabled: false, lead_minutes: 15, on_time: false },
                    fluxion: { enabled: false, lead_minutes: 15, on_time: false, phases: ['voting', 'selling'] },
                    mana: { enabled: false, lead_minutes: 15, on_time: false },
                    stampy: { enabled: false, lead_minutes: 15, on_time: false },
                    gardening: { enabled: false, lead_minutes: 15, on_time: false, cycles: ['2', '3'] },
                    weekly_buff: { enabled: false, lead_minutes: 15, on_time: false },
                    chaos_chest: { enabled: false, lead_minutes: 15, on_time: false },
                    d15: { enabled: false, lead_minutes: 15, on_time: false, biomes: [] },
                    daily_reset: { enabled: false, lead_minutes: 15, on_time: false }
                },
                // Desktop (SSE) per-event toggles — keys match the backend event
                // catalog (window.BTT_Notifications.desktopEventKeys()).
                events: {}
            });

            // Desktop event catalog (groups + per-event toggles), from notifications.js.
            const desktopEventCatalog = ref(
                (window.BTT_Notifications && window.BTT_Notifications.desktopEventCatalog)
                    ? window.BTT_Notifications.desktopEventCatalog() : []
            );
            const desktopEventKeys = () =>
                (window.BTT_Notifications && window.BTT_Notifications.desktopEventKeys)
                    ? window.BTT_Notifications.desktopEventKeys() : [];

            const settings = reactive({
                accent_color: '#5ec6ff',
                app_font: 'system',
                ui_scale: 1,
                show_community_content: true,
                show_official_news: true,
                show_player_activity: true,
                auto_fix_names: true,
                show_mod_preview_on_info_side: true,
                hide_beta_features: false,
                enable_legacy_projects: false,
                close_to_tray: true,
                notifications: defaultNotifications()
            });

            const customDirs = ref([]);
            const gameInstalls = ref([]);
            // Custom directory management requires local file access -> hide in hosted web mode.
            const isWebMode = window.BTT_WEB_MODE === true;
            // UI size scaling is only offered on the packaged Android build.
            const isNative = window.BTT_NATIVE === true;
            // Desktop (Windows) rotation reminders: only offered when the backend
            // can actually deliver them (a tray sink exists). Resolved async in
            // onMounted; drives the Notifications tab's visibility alongside isNative.
            const isDesktopNotify = ref(window.BTT_DESKTOP_NOTIFY === true);

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
                    let scale = Number(data.ui_scale);
                    if (!isFinite(scale) || scale <= 0) scale = 1;
                    settings.ui_scale = Math.min(1, Math.max(0.7, scale)); // smaller-or-default only
                    settings.show_community_content = data.show_community_content !== false;
                    settings.show_official_news = data.show_official_news !== false;
                    settings.show_player_activity = data.show_player_activity !== false;
                    settings.auto_fix_names = data.auto_fix_names !== false;
                    settings.show_mod_preview_on_info_side = data.show_mod_preview_on_info_side !== false;
                    settings.hide_beta_features = data.hide_beta_features === true;
                    settings.enable_legacy_projects = data.enable_legacy_projects === true;
                    settings.close_to_tray = data.close_to_tray !== false;
                    // Deep-merge notifications so old saves missing a new field
                    // (e.g. a freshly-added rotation type) pick up its defaults.
                    // Old saves may carry a global notifications.lead_minutes —
                    // fold it into each type that doesn't already specify its own
                    // so users don't lose their previous setting on upgrade.
                    const incoming = data.notifications || {};
                    const merged = defaultNotifications();
                    merged.enabled = incoming.enabled === true;
                    const legacyLead = Number.isFinite(Number(incoming.lead_minutes))
                        ? Math.max(5, Math.floor(Number(incoming.lead_minutes)))
                        : null;
                    const incTypes = incoming.types || {};
                    for (const key of Object.keys(merged.types)) {
                        const cur = incTypes[key] || {};
                        merged.types[key].enabled = cur.enabled === true;
                        merged.types[key].on_time = cur.on_time === true;
                        const lead = Number.isFinite(Number(cur.lead_minutes))
                            ? Math.max(5, Math.floor(Number(cur.lead_minutes)))
                            : (legacyLead !== null ? legacyLead : merged.types[key].lead_minutes);
                        merged.types[key].lead_minutes = lead;
                        if (Array.isArray(cur.phases)) merged.types[key].phases = cur.phases.slice();
                        if (Array.isArray(cur.cycles)) merged.types[key].cycles = cur.cycles.slice();
                        if (Array.isArray(cur.biomes)) merged.types[key].biomes = cur.biomes.slice();
                    }
                    // Desktop SSE per-event toggles: seed every catalog key (default
                    // off) so new events appear unchecked, then apply saved values.
                    const incEvents = incoming.events || {};
                    const events = {};
                    for (const k of desktopEventKeys()) events[k] = incEvents[k] === true;
                    merged.events = events;
                    settings.notifications = merged;
                    customDirs.value = data.custom_directories || [];
                    gameInstalls.value = data.game_installs || [];
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
                // The Directories + Legacy tabs are hidden in web/Android mode — fall
                // back to General so a restored selection doesn't land on an empty page.
                if (isWebMode && (activeTab.value === 'directories' || activeTab.value === 'legacy')) activeTab.value = 'general';
                // Notifications tab only exists on Android or a delivery-capable desktop.
                if (activeTab.value === 'notifications' && !isNative && !isDesktopNotify.value) activeTab.value = 'general';
            };

            watch(activeTab, persistState);

            // --- Notifications (Android only) -----------------------------------
            // The registry + scheduler live in js/notifications.js; the tab is data
            // driven from registryMeta() so this view doesn't bake in rotation names.
            const notifyRegistry = ref([]);
            const d15Biomes = ref([]);
            if (window.BTT_Notifications) {
                notifyRegistry.value = window.BTT_Notifications.registryMeta();
            }
            if (window.BTT_Rotations && window.BTT_Rotations.D15) {
                d15Biomes.value = window.BTT_Rotations.D15.uniqueBiomes();
            }

            // Background health: battery exemption + exact alarms + notification post.
            // Reflective view of the OS state, refreshed when the user returns to the
            // tab (so toggling a system setting and coming back updates the panel).
            const bgStatus = reactive({
                ignoresBatteryOptimizations: null,
                canScheduleExactAlarms: null,
                notificationsEnabled: null,
                loaded: false
            });
            const lastSyncedMs = ref(null);
            const refreshBgStatus = async () => {
                if (!isNative || !window.BTT_Notifications) return;
                const s = await window.BTT_Notifications.getBackgroundStatus();
                if (s) {
                    bgStatus.ignoresBatteryOptimizations = s.ignoresBatteryOptimizations === true;
                    bgStatus.canScheduleExactAlarms = s.canScheduleExactAlarms === true;
                    bgStatus.notificationsEnabled = s.notificationsEnabled === true;
                    bgStatus.loaded = true;
                }
                lastSyncedMs.value = window.BTT_Notifications.getLastSynced();
            };
            const bgAllGreen = () => bgStatus.loaded
                && bgStatus.ignoresBatteryOptimizations
                && bgStatus.canScheduleExactAlarms
                && bgStatus.notificationsEnabled;

            // Human-friendly "X min/hour/day ago" for the last-synced label.
            const lastSyncedText = () => {
                const ms = lastSyncedMs.value;
                if (!ms) return t('settings.notifications_never_synced');
                const ageSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
                if (ageSec < 60) return t('settings.notifications_synced_seconds_ago', { n: ageSec });
                if (ageSec < 3600) return t('settings.notifications_synced_minutes_ago', { n: Math.round(ageSec / 60) });
                if (ageSec < 86400) return t('settings.notifications_synced_hours_ago', { n: Math.round(ageSec / 3600) });
                return t('settings.notifications_synced_days_ago', { n: Math.round(ageSec / 86400) });
            };

            const grantBackgroundAccess = async () => {
                if (!window.BTT_Notifications) return;
                // Snapshot the current status BEFORE opening the system dialog
                // — we'll watch for a change to detect the user's choice.
                const before = { ...bgStatus };
                if (bgStatus.canScheduleExactAlarms === false) {
                    await window.BTT_Notifications.requestExactAlarmPermission();
                } else if (bgStatus.ignoresBatteryOptimizations === false) {
                    await window.BTT_Notifications.requestIgnoreBatteryOptimizations();
                } else if (bgStatus.notificationsEnabled === false) {
                    await window.BTT_Notifications.openAppDetailsSettings();
                }
                // App.resume / visibilitychange usually fire when the user
                // returns from the system dialog — but Android system overlays
                // (especially the targeted-app battery-opt dialog) don't
                // always trigger them reliably. Poll as a safety net: as soon
                // as any status field flips, refresh the panel.
                if (window.BTT_Notifications.pollStatusForChange) {
                    window.BTT_Notifications.pollStatusForChange(before, (next) => {
                        bgStatus.ignoresBatteryOptimizations = next.ignoresBatteryOptimizations === true;
                        bgStatus.canScheduleExactAlarms = next.canScheduleExactAlarms === true;
                        bgStatus.notificationsEnabled = next.notificationsEnabled === true;
                    });
                }
            };

            const refreshNotifications = async () => {
                if (!window.BTT_Notifications) return;
                try {
                    await window.BTT_Notifications.sync();
                    lastSyncedMs.value = window.BTT_Notifications.getLastSynced();
                    if (window.showToast) window.showToast(t('settings.notifications_refreshed'));
                } catch (e) {
                    console.error('[settings] manual refresh failed', e);
                }
            };

            // Refresh status when the page becomes visible again (after returning
            // from a system settings screen, the user expects to see the result).
            // Three triggers on native, because no single one is fully reliable
            // for the targeted Android system dialogs (battery-opt / exact-alarm):
            //   1. document visibilitychange — WebView-level
            //   2. window focus — sometimes the only one that fires
            //   3. Capacitor App.appStateChange — native bridge, most reliable
            // The grantBackgroundAccess flow ALSO polls as a final safety net.
            if (isNative) {
                document.addEventListener('visibilitychange', () => {
                    if (!document.hidden) void refreshBgStatus();
                });
                window.addEventListener('focus', () => { void refreshBgStatus(); });
                const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
                if (App && App.addListener) {
                    App.addListener('appStateChange', (state) => {
                        if (state && state.isActive) void refreshBgStatus();
                    });
                }
            }

            const saveAndSyncNotifications = async () => {
                await saveGeneralSettings();
                if (window.BTT_Notifications) {
                    try {
                        await window.BTT_Notifications.sync();
                    } catch (e) {
                        console.error('[settings] notifications sync failed', e);
                    }
                }
            };

            const sendTestNotification = async () => {
                if (!window.BTT_Notifications) return;
                try {
                    const r = await window.BTT_Notifications.sendTestNotification();
                    if (r && r.skipped === 'permission-denied') {
                        window.showToast && window.showToast(t('settings.notifications_permission_denied'), true);
                    } else if (r && r.delay) {
                        window.showToast && window.showToast(t('settings.notifications_test_sent', { seconds: r.delay }));
                    } else if (r && r.shown) {
                        window.showToast && window.showToast(t('settings.notifications_test_sent_desktop'));
                    }
                } catch (e) {
                    console.error('[settings] test notification failed', e);
                }
            };

            onMounted(async () => {
                // Resolve desktop-delivery capability first so the Notifications
                // tab's visibility (and the restore-state fallback) is settled
                // before the view paints.
                if (window.BTT_Notifications && window.BTT_Notifications.desktopAvailable) {
                    try { isDesktopNotify.value = await window.BTT_Notifications.desktopAvailable(); } catch { /* keep default */ }
                }
                await restoreState();
                await loadSettings();
                await refreshBgStatus();

                // Deep-link: the sidebar bell (and other shortcuts) set
                // window.pendingSettingsTab to jump straight to a sub-tab. Honor
                // it on first mount AND on re-entry to the cached view (settings_shown).
                const applyPendingSettingsTab = () => {
                    const tab = window.pendingSettingsTab;
                    if (!tab) return;
                    window.pendingSettingsTab = null;
                    if (tab === 'notifications' && !isNative && !isDesktopNotify.value) return;
                    activeTab.value = tab;
                };
                applyPendingSettingsTab();
                if (window._settingsShownHandler) {
                    document.removeEventListener('settings_shown', window._settingsShownHandler);
                }
                window._settingsShownHandler = applyPendingSettingsTab;
                document.addEventListener('settings_shown', applyPendingSettingsTab);
            });

            return {
                t, activeTab, settings, customDirs, modals, addForm, editForm,
                isBrowsing, isSaving, previewAccentColor, saveGeneralSettings,
                openAddModal, browseDir, saveNewDir, removeDir, openEditModal, saveEditDir,
                resetOnboardingTips, gameInstalls, isWebMode, isNative, isDesktopNotify,
                notifyRegistry, d15Biomes, saveAndSyncNotifications, sendTestNotification,
                desktopEventCatalog,
                bgStatus, bgAllGreen, lastSyncedText, grantBackgroundAccess, refreshNotifications
            };
        }
    });

    if (window._settingsApp) window._settingsApp.unmount();
    window._settingsApp = app;
    app.mount('#settings-vue-app');
});
