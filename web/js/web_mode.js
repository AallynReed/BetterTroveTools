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

    // Kiwi API (api.aallyn.net) — public rotations/feeds, fetched via the same
    // native-HTTP-or-fetch path so it works in the packaged app today (CORS-free)
    // and on the web build once the API allowlists the web origin.
    const KIWI_BASE = 'https://api.aallyn.net/v1';
    const kiwiGet = async (path) => asJson(await feedGet(`${KIWI_BASE}/${path}`));

    // --- Delve helpers (mirror backend.home delve week math + depth normalize) ---
    // Delve rotations roll over on Trove server reset (UTC + 11h), base 2025-11-03.
    const DELVE_BASE_MS = Date.UTC(2025, 10, 3); // 2025-11-03 00:00 UTC
    const DELVE_OFFSET_MS = 11 * 3600 * 1000;
    const DELVE_WEEK_MS = 7 * 24 * 3600 * 1000;
    const delveCurrentWeekId = (nowMs) => {
        const current = (nowMs == null ? Date.now() : nowMs) - DELVE_OFFSET_MS;
        return Math.max(1, Math.floor((current - DELVE_BASE_MS) / DELVE_WEEK_MS) + 1);
    };
    const delveWeekWindow = (weekId) => {
        const start = DELVE_BASE_MS + Math.max(0, weekId - 1) * DELVE_WEEK_MS + DELVE_OFFSET_MS;
        return { start: Math.floor(start / 1000), end: Math.floor((start + DELVE_WEEK_MS) / 1000) };
    };
    const normalizeDelveEnemy = (e) => (e && typeof e === 'object')
        ? { name: e.n || 'Unknown', bans: e.b || [], count: e.c || 0 }
        : { name: 'Unknown', bans: [], count: 0 };
    const normalizeDelveDepth = (d) => {
        const enemies = (d.enemies || []).map(normalizeDelveEnemy);
        const rooms = [];
        (d.roomDetails || []).forEach((room, i) => {
            if (!room || typeof room !== 'object' || Array.isArray(room)) return;
            const ei = room.e;
            const enemy = (typeof ei === 'number' && ei >= 0 && ei < enemies.length) ? enemies[ei] : null;
            rooms.push({ room: i + 1, enemyIndex: ei, enemy });
        });
        const boss = d.boss || {};
        return {
            id: d.id, depth: d.depth, biome: d.biome, zone: d.zone,
            boss: { name: boss.n || 'Unknown', bans: boss.b || [] },
            objective: d.objective, objectiveText: d.objectiveText,
            killType: d.killType, killAmount: d.killAmount, killString: d.killString,
            isVaultFloor: !!d.isVaultFloor, submittedBy: d.submittedBy,
            enemies, rooms,
        };
    };

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
        ui_scale: 1,
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

    // Deterministic Trove server-time math (mirrors utils/trove/server_time.py).
    // Corruxion (dragon) + Fluxion rotate on fixed epochs, so they compute locally
    // with no network — keeping the home merchants available offline.
    const TROVE_OFFSET_SEC = 11 * 3600;
    const DRAGON_DURATION_SEC = 3 * 86400;
    const DRAGON_INTERVAL_SEC = 14 * 86400;
    const FLUXION_INTERVAL_SEC = 7 * 86400;
    const FIRST_CORRUXION_SEC = Date.UTC(2024, 2, 8) / 1000;
    const FIRST_FLUXION_SEC = Date.UTC(2023, 6, 18) / 1000;
    const troveNowSec = () => Date.now() / 1000 - TROVE_OFFSET_SEC;
    const corruxionInfo = (nowSec) => {
        const delta = Math.trunc(nowSec - FIRST_CORRUXION_SEC);
        const completed = Math.floor(delta / DRAGON_INTERVAL_SEC);
        const current = delta - completed * DRAGON_INTERVAL_SEC;
        const nextDragon = FIRST_CORRUXION_SEC + (completed + 1) * DRAGON_INTERVAL_SEC;
        const active = current < DRAGON_DURATION_SEC;
        const end = active ? (nextDragon - DRAGON_INTERVAL_SEC + DRAGON_DURATION_SEC) : (nextDragon + DRAGON_DURATION_SEC);
        return { active, time: active ? (end - nowSec) : (nextDragon - nowSec) };
    };
    const fluxionInfo = (nowSec) => {
        const delta = nowSec - FIRST_FLUXION_SEC;
        const completed = Math.floor(delta / DRAGON_INTERVAL_SEC);
        let current = delta - completed * DRAGON_INTERVAL_SEC;
        const phase = Math.floor(current / FLUXION_INTERVAL_SEC);
        current = current - phase * FLUXION_INTERVAL_SEC;
        const nextPhase = FIRST_FLUXION_SEC + (completed * 2 + (phase + 1)) * FLUXION_INTERVAL_SEC;
        const active = current < DRAGON_DURATION_SEC;
        const end = active ? (nextPhase - FLUXION_INTERVAL_SEC + DRAGON_DURATION_SEC) : (nextPhase + DRAGON_DURATION_SEC);
        return { active, state: active ? (phase === 0 ? 'Voting' : 'Selling') : 'Away', time: active ? (end - nowSec) : (nextPhase - nowSec) };
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
        get_app_metadata: makeEelFn('get_app_metadata', async () => {
            // Mirror web_server.py / desktop: read the bundled metadata.json so the
            // sidebar shows the real app version offline (Android) too, instead of
            // a "Web" placeholder. web/metadata.json is a copy of the root file.
            const meta = await fetchJson('metadata.json', null);
            if (meta && meta.APP_VERSION) {
                return { APP_NAME: meta.APP_NAME || 'Better Trove Tools', APP_VERSION: meta.APP_VERSION };
            }
            return { APP_NAME: 'Better Trove Tools', APP_VERSION: 'Unknown' };
        }),
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
        parse_star_chart_code: makeEelFn('parse_star_chart_code', async (base64Code) => {
            try {
                if (!window.GemBuildOptimizer) return fail(t('web.star_chart_needs_desktop'));
                const parsed = await window.GemBuildOptimizer.parseStarChart(base64Code);
                return { success: true, data: parsed, ...parsed };
            } catch (err) {
                return { success: false, data: { stats: {}, abilities: [] }, stats: {}, abilities: [], error: String(err && err.message || err), code: 'PARSE_STAR_CHART_CODE_FAILED' };
            }
        }, { localOnly: true }),
        calculate_gem_builds: makeEelFn('calculate_gem_builds', async (config) => {
            try {
                if (!window.GemBuildOptimizer) return fail(t('web.gem_builds_needs_desktop'));
                const builds = await window.GemBuildOptimizer.calculateBuilds(config || {});
                return { success: true, data: { builds }, builds };
            } catch (err) {
                return { success: false, error: String(err && err.message || err), code: 'CALCULATE_GEM_BUILDS_FAILED' };
            }
        }, { localOnly: true }),
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
            // Mirror backend format_timedelta: ">0 days" -> "Xd Yh", else "Xh Ym"
            const fmtDur = (secs) => {
                const total = Math.max(0, Math.floor(Number(secs) || 0));
                const days = Math.floor(total / 86400);
                const hours = Math.floor((total % 86400) / 3600);
                const minutes = Math.floor((total % 3600) / 60);
                return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
            };
            // Corruxion + Fluxion are deterministic (server_time epochs) -> compute
            // locally so the home merchants work offline, with no API call.
            const nowSec = troveNowSec();
            const corr = corruxionInfo(nowSec);
            const flux = fluxionInfo(nowSec);
            const merchants = {
                corruxion: { active: corr.active, time_str: fmtDur(corr.time), action: corr.active ? 'Leaves in' : 'Arrives in' },
                fluxion: { active: flux.active, state: flux.state, time_str: fmtDur(flux.time), action: flux.active ? 'Ends in' : 'Starts in' }
            };
            return { success: true, daily, weekly, merchants };
        }, { localOnly: true }),
        get_chaos_chest_data: makeEelFn('get_chaos_chest_data', async () => {
            try {
                const c = await kiwiGet('rotations/chaos-chest');
                const item = c.item || null;
                return {
                    success: true,
                    data: item ? { name: item.name, identifier: item.identifier, blueprint: item.blueprint, end: c.ends_at } : null,
                    fallback_times: { start: c.starts_at, end: c.ends_at }
                };
            } catch (err) { return { success: false, error: String(err && err.message || err), code: 'CHAOS_FAILED' }; }
        }, { localOnly: true }),
        get_merchant_schedules: makeEelFn('get_merchant_schedules', () => ({ success: true })),
        get_yearly_calendar_data: makeEelFn('get_yearly_calendar_data', async () => {
            try {
                const data = await kiwiGet('rotations/calendar');
                // Kiwi: {type,name,starts_at,ends_at,color?,state?,biomes?:[{name,icon}]}
                // Frontend: {type,name,color,start,end,icons[],biome_names[]} (unix seconds)
                const events = (data.events || []).map(e => ({
                    type: e.type, name: e.name, color: e.color || null,
                    start: e.starts_at, end: e.ends_at,
                    icons: (e.biomes || []).map(b => b.icon),
                    biome_names: (e.biomes || []).map(b => b.name)
                }));
                return { success: true, data: events, events };
            } catch (err) {
                return { success: false, error: String(err && err.message || err), code: 'CALENDAR_FAILED' };
            }
        }, { localOnly: true }),
        get_gardening_rotation: makeEelFn('get_gardening_rotation', async () => {
            try {
                const g = await kiwiGet('rotations/gardening');
                const w = (x) => x ? { active: !!x.active, start: x.starts_at, end: x.ends_at } : { active: false, start: 0, end: 0 };
                // Modal reads rot.start/rot.end/rot.name — map the API's starts_at/ends_at.
                const future = (g.upcoming || []).map((x) => ({ start: x.starts_at, end: x.ends_at, name: x.name, active: !!x.active }));
                return { success: true, two_day: w(g.two_day), three_day: w(g.three_day), future };
            } catch (err) { return { success: false, error: String(err && err.message || err), code: 'GARDENING_FAILED' }; }
        }, { localOnly: true }),
        get_d15_rotation: makeEelFn('get_d15_rotation', async () => {
            // Deterministic 3-hour biome rotation (mirrors backend get_d15_rotation):
            // computed locally so it works offline AND covers the full ~8-day window.
            // The API's `upcoming` only returns ~2 days, which left the modal half-empty.
            try {
                const subbiomes = await fetchJson('assets/data/biomes.json', {});
                const D15_EPOCH = 1718708400, D15_INTERVAL = 3 * 3600;
                const biome1 = ['Sundered Uplands', 'Cerise Sandsea', 'Deep Forest', 'Alkali Flats', 'Dead of Winter', 'Sundered Uplands', 'Firefly Party', 'Desert of Secrets', 'Weathered Wastelands', 'Frozen Wastes', "Frigga's Fjord", 'Abandoned Boneyard'];
                const biome2 = ['Cursed Vale', 'Hollow Dunes', 'Bewitching Wood', 'Primal Preserve', 'Hollow Dunes', 'Ancient Heights', 'Viking Burial Grounds', 'Spellbound Thicket', 'Saurian Swamp', 'Restless Range', 'Uncanny Valley'];
                const biome3 = ['Sugar Steppes', 'Volcanic Fields', 'The Lost Isles', 'Luminopolis', 'The Lost Isles', 'Blazing Emberlands', 'Cocoa Craters', 'Data Spires', 'The Lost Isles', 'Cupcake Canyon', "Dragon's Teeth", 'Luminopolis', 'The Lost Isles', 'Data Spires'];
                const mod = (n, m) => ((n % m) + m) % m;
                const subOf = (name) => subbiomes[name] || { name, final_name: name, icon: 'unknown' };
                const nowSec = Date.now() / 1000;
                const consumed = Math.floor((nowSec - D15_EPOCH) / D15_INTERVAL);
                const startSec = D15_EPOCH + consumed * D15_INTERVAL;
                const rotations = [];
                for (let i = -8; i < 56; i++) {
                    const offset = consumed + i;
                    const s = startSec + i * D15_INTERVAL;
                    rotations.push({ start: s, end: s + D15_INTERVAL, biomes: [subOf(biome1[mod(offset, biome1.length)]), subOf(biome2[mod(offset, biome2.length)]), subOf(biome3[mod(offset, biome3.length)])] });
                }
                const current = rotations.find((r) => r.start <= nowSec && nowSec < r.end) || null;
                return { success: true, current, rotations };
            } catch (err) { return { success: false, error: String(err && err.message || err), code: 'D15_FAILED' }; }
        }, { localOnly: true }),
        get_wild_mana_rotation: makeEelFn('get_wild_mana_rotation', async () => {
            try {
                const r = await kiwiGet('rotations/wild-mana');
                const cur = r.current;
                const future = (r.upcoming || []).map((x) => ({ start: x.starts_at, end: x.ends_at, biomes: x.biomes }));
                return { success: true, current: cur ? { start: cur.starts_at, end: cur.ends_at, biomes: cur.biomes } : null, future };
            } catch (err) { return { success: false, error: String(err && err.message || err), code: 'MANA_FAILED' }; }
        }, { localOnly: true }),
        get_delve_status: makeEelFn('get_delve_status', () => {
            const currentWeekId = delveCurrentWeekId();
            const { start, end } = delveWeekWindow(currentWeekId);
            return { success: true, currentWeekId, start, end };
        }, { localOnly: true }),
        get_delve_rotation: makeEelFn('get_delve_rotation', async () => {
            try {
                const idx = await kiwiGet('rotations/delves/weeks');
                const currentWeekId = idx.current_week || delveCurrentWeekId();
                const minWeek = Math.max(1, currentWeekId - 7);
                const totals = {};
                (idx.items || []).forEach((it) => { totals[it.week] = it.total || it.count || 0; });

                const weekIds = [];
                for (let w = currentWeekId; w >= minWeek; w--) weekIds.push(w);

                const weeks = await Promise.all(weekIds.map(async (wid) => {
                    const { start, end } = delveWeekWindow(wid);
                    const base = { weekId: wid, isCurrent: wid === currentWeekId, start, end };
                    if ((totals[wid] || 0) <= 0) return { ...base, depths: [], depthCount: 0, hasData: false };
                    try {
                        const wk = await kiwiGet(`rotations/delves?week=${wid}`);
                        const depths = (wk.depths || []).map(normalizeDelveDepth);
                        return { ...base, depths, depthCount: depths.length, hasData: depths.length > 0 };
                    } catch (e) {
                        return { ...base, depths: [], depthCount: 0, hasData: false };
                    }
                }));

                if (!weeks.length) return { success: false, error: 'No delve data found', code: 'DELVE_ROTATION_NOT_FOUND' };
                weeks.sort((a, b) => (b.weekId || 0) - (a.weekId || 0));
                const current = weeks.find((w) => w.isCurrent) || weeks[0];
                return { success: true, currentWeekId, current, weeks };
            } catch (err) {
                return { success: false, error: String(err && err.message || err), code: 'DELVE_ROTATION_FAILED' };
            }
        }, { localOnly: true }),
        get_stampy_rotation: makeEelFn('get_stampy_rotation', async () => {
            try {
                const r = await kiwiGet('rotations/stampy');
                const cur = r.current;
                const future = (r.upcoming || []).map((x) => ({ start: x.starts_at, end: x.ends_at, biomes: x.biomes }));
                return { success: true, current: cur ? { start: cur.starts_at, end: cur.ends_at, biomes: cur.biomes } : null, future };
            } catch (err) { return { success: false, error: String(err && err.message || err), code: 'STAMPY_FAILED' }; }
        }, { localOnly: true })
    };
})();
