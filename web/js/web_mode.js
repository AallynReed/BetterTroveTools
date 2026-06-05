(function () {
    const params = new URLSearchParams(window.location.search);
    const forceWebMode = params.get('web') === '1' || params.get('mode') === 'web';
    const hasEelBridge = !!window.eel && typeof window.eel.expose === 'function';

    window.BTT_WEB_MODE = forceWebMode || !hasEelBridge;
    window.BTT_UNAVAILABLE_WEB_VIEWS = window.BTT_WEB_MODE
        ? ['mod_manager', 'modder_tools', 'codexes', 'allies', 'mounts', 'dragons', 'mementos', 'recipes', 'items']
        : [];

    if (!window.BTT_WEB_MODE || (hasEelBridge && !forceWebMode)) return;

    const SETTINGS_KEY = 'btt.web.settings.v1';
    const GEM_STORAGE_KEY = 'btt.web.gem_storage.v1';
    const STAR_TEMPLATES_KEY = 'btt.web.star_chart_templates.v1';

    const ok = (data = {}) => ({ success: true, data, ...data });
    const fail = (error, code = 'WEB_MODE_UNAVAILABLE') => ({ success: false, error, code });
    const clone = (value) => JSON.parse(JSON.stringify(value));

    // Resolve a translation id at call time (i18n is loaded by the time any of
    // these shim functions actually run, so these user-facing "unavailable on
    // web" messages get localized instead of being hardcoded English).
    const t = (id, params) => (window.I18nManager && window.I18nManager.t ? window.I18nManager.t(id, params) : id);

    // The Gem Simulator runs fully client-side via js/gems_and_builds/gem_engine.js
    // (a port of the Python gem model), so it works offline / on Android. Fall back
    // to the desktop-only message only if that engine somehow failed to load.
    const gemCall = (method, ...args) => (window.GemEngine && window.GemEngine[method])
        ? window.GemEngine[method](...args)
        : fail(t('web.gem_sim_needs_desktop'));

    const readJson = (key, fallback) => {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : clone(fallback);
        } catch {
            return clone(fallback);
        }
    };

    const writeJson = (key, value) => {
        localStorage.setItem(key, JSON.stringify(value || {}));
    };

    const fetchJson = async (url, fallback = null) => {
        try {
            const response = await fetch(url, { cache: 'no-cache' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch {
            return clone(fallback);
        }
    };

    // Server-proxied feeds (news, videos, Trovesaurus events) need the backend's
    // api/eel endpoints. The hosted web build serves them same-origin; a packaged
    // native app (Android) has no local backend, so it reaches the hosted backend
    // instead. NOTE: for this to work over the network the backend must send CORS
    // headers (Access-Control-Allow-Origin) allowing the app's origin. If it
    // can't reach the backend it falls back to the existing empty state.
    const HOSTED_BACKEND = 'https://trove.aallyn.net';
    const isNativeApp = () => !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
        && window.Capacitor.isNativePlatform());

    const callCompatApi = async (name, args) => {
        const path = `api/eel/${encodeURIComponent(name)}`;
        const url = isNativeApp() ? `${HOSTED_BACKEND}/${path}` : path;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args })
        });
        if (!response.ok) throw new Error(`Compat API returned HTTP ${response.status}`);
        return response.json();
    };

    const makeEelFn = (name, fn, options = {}) => (...args) => async () => {
        if (!options.localOnly) {
            try {
                return await callCompatApi(name, args);
            } catch {}
        }
        return fn(...args);
    };

    const makeCallbackEelFn = (name, callbackName, fallbackData = []) => (...args) => async () => {
        let response;
        try {
            response = await callCompatApi(name, args);
        } catch {
            response = { success: true, data: clone(fallbackData) };
        }
        if (typeof window[callbackName] === 'function') {
            window[callbackName](response);
        }
        return response;
    };

    const defaultSettings = {
        locale: 'en_US',
        accent_color: '#5ec6ff',
        app_font: 'system',
        show_community_content: true,
        show_official_news: true,
        hide_beta_features: false,
        custom_directories: [],
        ui_preferences: {}
    };

    const languages = [
        { code: 'en_US', name: 'English', percent: 100 },
        { code: 'de_DE', name: 'Deutsch', percent: 100 },
        { code: 'es_ES', name: 'Espanol', percent: 100 },
        { code: 'fr_FR', name: 'Francais', percent: 100 },
        { code: 'ja_JP', name: 'Japanese', percent: 100 },
        { code: 'ko_KR', name: 'Korean', percent: 100 },
        { code: 'pt_BR', name: 'Portuguese', percent: 100 },
        { code: 'ru_RU', name: 'Russian', percent: 100 },
        { code: 'zh_CN', name: 'Chinese', percent: 100 }
    ];

    const rotate = (origin, point, angle) => {
        const [ox, oy] = origin;
        const [px, py] = point;
        return [
            ox + Math.cos(angle) * (px - ox) - Math.sin(angle) * (py - oy),
            oy + Math.sin(angle) * (px - ox) + Math.cos(angle) * (py - oy)
        ];
    };

    const buildBranch = (backRotate, lastPosition, distance, stars) => {
        const totalAngle = 193;
        const division = totalAngle / ((stars || []).length + 1);
        (stars || []).forEach((child, index) => {
            const finalRotation = division * (index + 1) + backRotate;
            const childPosition = [lastPosition[0] - distance, lastPosition[1]];
            const rotatedPosition = rotate(lastPosition, childPosition, finalRotation * Math.PI / 180);
            child.Coords = rotatedPosition;
            if (child.Stars) {
                buildBranch(-((totalAngle / 2) - finalRotation), rotatedPosition, distance, child.Stars);
            }
        });
    };

    const rotateBranch = (star, origin, angle) => {
        if (!star || !star.Stars) return;
        star.Stars.forEach((child) => {
            child.Coords = rotate(origin, child.Coords || [0, 0], angle);
            rotateBranch(child, origin, angle);
        });
    };

    const getCalculatedStarChart = async () => {
        const starChart = await fetchJson('assets/data/star_chart.json', {});
        const origin = [500, 500];
        const constellations = ['Combat', 'Gathering', 'Pve'];
        const backs = [0, -2, -4];

        constellations.forEach((name, index) => {
            if (!starChart[name]) return;
            const branchRotation = (360 / constellations.length) * index;
            const position = [origin[0], origin[1] - 60];
            starChart[name].Coords = rotate(origin, position, branchRotation * Math.PI / 180);
            buildBranch(backs[index], position, 47, starChart[name].Stars || []);
            rotateBranch(starChart[name], origin, branchRotation * Math.PI / 180);
        });

        return { success: true, data: starChart, origin };
    };

    const getCurrentBuffs = async () => {
        const [dailyBuffs, weeklyBuffs] = await Promise.all([
            fetchJson('assets/data/daily_buffs.json', {}),
            fetchJson('assets/data/weekly_buffs.json', {})
        ]);
        const utcMs = Date.now() + (new Date().getTimezoneOffset() * 60000);
        const troveMs = utcMs - (11 * 3600000);
        const currentDayIndex = (new Date(troveMs).getDay() + 6) % 7;
        const daily = dailyBuffs[String(currentDayIndex)] || Object.values(dailyBuffs)[0] || {};
        const weeklyKeys = Object.keys(weeklyBuffs).sort((a, b) => Number(a) - Number(b));
        const weeklyIndex = weeklyKeys.length
            ? weeklyKeys[Math.floor(Date.now() / (7 * 24 * 3600 * 1000)) % weeklyKeys.length]
            : null;
        const weekly = weeklyIndex !== null ? weeklyBuffs[weeklyIndex] : {};
        return { daily, weekly };
    };

    const localOnlyMessage = () => t('web.desktop_only_action');

    window.eel = {
        expose(fn, name) {
            if (name && typeof fn === 'function') window[name] = fn;
        },
        get_settings: makeEelFn('get_settings', () => readJson(SETTINGS_KEY, defaultSettings), { localOnly: true }),
        save_settings: makeEelFn('save_settings', (settings) => {
            const merged = { ...defaultSettings, ...(settings || {}) };
            if (!merged.ui_preferences || typeof merged.ui_preferences !== 'object') merged.ui_preferences = {};
            writeJson(SETTINGS_KEY, merged);
            return ok(merged);
        }, { localOnly: true }),
        get_available_languages: makeEelFn('get_available_languages', () => languages),
        get_app_metadata: makeEelFn('get_app_metadata', () => ({ APP_NAME: 'Better Trove Tools', APP_VERSION: 'Web' })),
        get_startup_url: makeEelFn('get_startup_url', () => null),
        open_url_in_browser: makeEelFn('open_url_in_browser', (url) => {
            if (url) window.open(url, '_blank', 'noopener,noreferrer');
            return ok();
        }, { localOnly: true }),
        start_self_update: makeEelFn('start_self_update', () => fail(localOnlyMessage()), { localOnly: true }),
        finalize_self_update_exit: makeEelFn('finalize_self_update_exit', () => ok(), { localOnly: true }),
        browse_for_game_dir: makeEelFn('browse_for_game_dir', () => fail(localOnlyMessage()), { localOnly: true }),
        get_detected_game_paths: makeEelFn('get_detected_game_paths', () => ok({ paths: [], detected: [] })),
        get_system_info: makeEelFn('get_system_info', () => ok({ app_mode: 'web', platform: navigator.platform || 'browser' })),
        get_app_license: makeEelFn('get_app_license', async () => ok({ text: await fetch('LICENSE').then(r => r.ok ? r.text() : '').catch(() => '') })),
        load_gem_storage: makeEelFn('load_gem_storage', () => {
            const gemData = readJson(GEM_STORAGE_KEY, {});
            return { success: true, data: gemData, gem_simulator: gemData };
        }, { localOnly: true }),
        save_gem_storage: makeEelFn('save_gem_storage', (gemData) => {
            writeJson(GEM_STORAGE_KEY, gemData || {});
            return ok();
        }, { localOnly: true }),
        get_star_chart_templates: makeEelFn('get_star_chart_templates', () => {
            const templates = readJson(STAR_TEMPLATES_KEY, {});
            return { success: true, data: templates, templates };
        }, { localOnly: true }),
        save_star_chart_template: makeEelFn('save_star_chart_template', (name, base64Code) => {
            const templates = readJson(STAR_TEMPLATES_KEY, {});
            templates[name] = base64Code;
            writeJson(STAR_TEMPLATES_KEY, templates);
            return ok();
        }, { localOnly: true }),
        delete_star_chart_template: makeEelFn('delete_star_chart_template', (name) => {
            const templates = readJson(STAR_TEMPLATES_KEY, {});
            delete templates[name];
            writeJson(STAR_TEMPLATES_KEY, templates);
            return ok();
        }, { localOnly: true }),
        get_calculated_star_chart: makeEelFn('get_calculated_star_chart', getCalculatedStarChart),
        parse_star_chart_code: makeEelFn('parse_star_chart_code', () => fail(t('web.star_chart_needs_desktop'))),
        calculate_gem_builds: makeEelFn('calculate_gem_builds', () => fail(t('web.gem_builds_needs_desktop'))),
        get_trove_classes: makeEelFn('get_trove_classes', async () => {
            const classes = await fetchJson('assets/data/classes.json', []);
            return ok((classes || []).map(cls => ({ name: cls.name, value: cls.name })));
        }),
        get_food_data: makeEelFn('get_food_data', async () => ok(await fetchJson('assets/data/builds/food.json', {}))),
        get_ally_data: makeEelFn('get_ally_data', async () => ok(await fetchJson('assets/data/builds/ally.json', {}))),
        get_gem_lookups: makeEelFn('get_gem_lookups', () => gemCall('getLookups'), { localOnly: true }),
        get_gem_stat_range: makeEelFn('get_gem_stat_range', () => fail(t('web.gem_stat_range_needs_desktop'))),
        simulate_next_focus: makeEelFn('simulate_next_focus', () => fail(t('web.focus_sim_needs_desktop'))),
        create_gem: makeEelFn('create_gem', (data) => gemCall('createGem', data), { localOnly: true }),
        mass_update_gems: makeEelFn('mass_update_gems', (gems) => gemCall('massUpdate', gems), { localOnly: true }),
        level_up_gem: makeEelFn('level_up_gem', (gem) => gemCall('levelUpGem', gem), { localOnly: true }),
        augment_gem: makeEelFn('augment_gem', (gem, statId, augmentId) => gemCall('augmentGem', gem, statId, augmentId), { localOnly: true }),
        spark_gem: makeEelFn('spark_gem', (gem, statId) => gemCall('sparkGem', gem, statId), { localOnly: true }),
        flare_gem: makeEelFn('flare_gem', (gem, statId) => gemCall('flareGem', gem, statId), { localOnly: true }),
        cancel_home_fetches: makeEelFn('cancel_home_fetches', () => ok()),
        get_trove_news: makeCallbackEelFn('get_trove_news', 'receive_trove_news', []),
        get_youtube_videos: makeCallbackEelFn('get_youtube_videos', 'receive_youtube_videos', []),
        get_twitch_streams: makeCallbackEelFn('get_twitch_streams', 'receive_twitch_streams', []),
        get_bilibili_videos: makeCallbackEelFn('get_bilibili_videos', 'receive_bilibili_videos', []),
        get_trovesaurus_events: makeCallbackEelFn('get_trovesaurus_events', 'receive_events_data', []),
        get_current_server_data: makeEelFn('get_current_server_data', async () => {
            const { daily, weekly } = await getCurrentBuffs();
            return { success: true, daily, weekly, merchants: [] };
        }),
        get_chaos_chest_data: makeEelFn('get_chaos_chest_data', () => ({ success: true, rewards: [], current: null })),
        get_merchant_schedules: makeEelFn('get_merchant_schedules', () => ({ success: true })),
        get_yearly_calendar_data: makeEelFn('get_yearly_calendar_data', () => ({ success: true, events: [] })),
        get_gardening_rotation: makeEelFn('get_gardening_rotation', () => {
            const now = Math.floor(Date.now() / 1000);
            return {
                success: true,
                two_day: { active: false, start: now + 3600, end: now + 86400 },
                three_day: { active: false, start: now + 7200, end: now + 172800 },
                future: []
            };
        }),
        get_d15_rotation: makeEelFn('get_d15_rotation', () => ({ success: true, rotations: [] })),
        get_wild_mana_rotation: makeEelFn('get_wild_mana_rotation', () => ({ success: true, future: [] })),
        get_delve_status: makeEelFn('get_delve_status', () => ({ success: true, current: null, next: null })),
        get_delve_rotation: makeEelFn('get_delve_rotation', () => ({ success: true, weeks: [], currentWeekId: null })),
        get_stampy_rotation: makeEelFn('get_stampy_rotation', () => ({ success: true, future: [] }))
    };
})();
