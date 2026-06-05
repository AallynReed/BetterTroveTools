(function () {
    const params = new URLSearchParams(window.location.search);
    const forceWebMode = params.get('web') === '1' || params.get('mode') === 'web';
    const hasEelBridge = !!window.eel && typeof window.eel.expose === 'function';

    window.BTT_WEB_MODE = forceWebMode || !hasEelBridge;
    window.BTT_UNAVAILABLE_WEB_VIEWS = window.BTT_WEB_MODE
        ? ['mod_manager', 'modder_tools', 'codexes', 'allies', 'mounts', 'dragons', 'mementos', 'recipes', 'items']
        : [];
    // Running inside the packaged native (Android) app. Used to HIDE desktop-only
    // views/tools entirely here (the web build instead badges them with "Desktop App").
    window.BTT_NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
        && window.Capacitor.isNativePlatform());

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

    const callCompatApi = async (name, args) => {
        const response = await fetch(`api/eel/${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ args })
        });
        if (!response.ok) throw new Error(`Compat API returned HTTP ${response.status}`);
        return response.json();
    };

    // --- Home feeds ----------------------------------------------------------
    // Both the web build and the packaged Android app fetch the home feeds
    // (news/videos/events) from the SAME public urls the desktop uses. In the
    // packaged app we go through Capacitor's native HTTP, which runs the request
    // from the native layer (like the desktop's Python requests) and so bypasses
    // CORS. On the plain web build we use fetch(), which is subject to each feed
    // server's CORS policy (a server that doesn't send Access-Control-Allow-Origin
    // will leave that feed empty there until CORS is enabled on it).
    const capacitorHttp = () => (window.Capacitor && window.Capacitor.Plugins
        && window.Capacitor.Plugins.CapacitorHttp) || null;

    const feedGet = async (url) => {
        const http = capacitorHttp();
        if (http) {
            const res = await http.get({ url, headers: { 'User-Agent': 'BetterTroveTools/1.0' } });
            if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
            return res.data; // object for JSON, string for XML/RSS
        }
        const res = await fetch(url, { headers: { 'Accept': 'application/json, text/xml, */*' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text(); // string; the transforms (asJson / parseTroveNews) handle it
    };

    const asJson = (data) => (typeof data === 'string' ? JSON.parse(data) : data);

    const _stripHtml = (html) => {
        const d = document.createElement('div');
        d.innerHTML = html || '';
        return (d.textContent || d.innerText || '').replace(/\s+/g, ' ').trim();
    };
    const _truncate = (text, n) => (text && text.length > n ? text.slice(0, n - 1).trimEnd() + '…' : (text || ''));

    // Mirror backend.home.get_trove_news's RSS -> item shape.
    const parseTroveNews = (xmlText) => {
        const doc = new DOMParser().parseFromString(typeof xmlText === 'string' ? xmlText : '', 'application/xml');
        const NS_MEDIA = 'http://search.yahoo.com/mrss/';
        const NS_DC = 'http://purl.org/dc/elements/1.1/';
        const items = [];
        const nodes = doc.querySelectorAll('channel > item');
        for (let i = 0; i < nodes.length && items.length < 20; i++) {
            const item = nodes[i];
            const txt = (sel) => { const el = item.querySelector(sel); return el ? el.textContent.trim() : ''; };
            const creator = item.getElementsByTagNameNS(NS_DC, 'creator')[0];
            const mediaContent = item.getElementsByTagNameNS(NS_MEDIA, 'content')[0];
            const mediaThumb = item.getElementsByTagNameNS(NS_MEDIA, 'thumbnail')[0];
            const categories = [...item.querySelectorAll('category')].map(c => (c.textContent || '').trim()).filter(Boolean);
            const pubRaw = txt('pubDate');
            let published_at = pubRaw;
            const dt = new Date(pubRaw);
            if (!isNaN(dt.getTime())) published_at = dt.toISOString();
            let image = mediaContent ? mediaContent.getAttribute('url') : null;
            if (!image && mediaThumb) image = mediaThumb.getAttribute('url');
            items.push({
                title: txt('title'),
                url: txt('link'),
                author: (creator ? creator.textContent.trim() : '') || 'Team Trove',
                published_at,
                summary: _truncate(_stripHtml(txt('description')), 220),
                category: categories[0] || 'News',
                categories,
                image
            });
        }
        return items;
    };

    // A feed function that fetches the desktop's url directly (native HTTP in the
    // app, fetch on the web build) and invokes the receive_* callback.
    const makeFeedFn = (callbackName, url, transform) => () => async () => {
        let response;
        try {
            response = { success: true, data: transform(await feedGet(url)) };
        } catch (e) {
            response = { success: false, error: String(e && e.message || e), code: 'FEED_FAILED' };
        }
        if (typeof window[callbackName] === 'function') window[callbackName](response);
        return response;
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
        get_trove_news: makeFeedFn('receive_trove_news', 'https://trovegame.com/feed', parseTroveNews),
        get_youtube_videos: makeFeedFn('receive_youtube_videos', 'https://trovesaurus.aallyn.net/youtube_videos', asJson),
        get_twitch_streams: makeFeedFn('receive_twitch_streams', 'https://trovesaurus.aallyn.net/twitch_streams', asJson),
        get_bilibili_videos: makeFeedFn('receive_bilibili_videos', 'https://trovesaurus.aallyn.net/bilibili_videos', asJson),
        get_trovesaurus_events: makeFeedFn('receive_events_data', 'https://trovesaurus.com/calendar/feed', (d) => { const e = asJson(d) || []; if (Array.isArray(e)) e.sort((a, b) => parseInt(a.startdate) - parseInt(b.startdate)); return e; }),
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
