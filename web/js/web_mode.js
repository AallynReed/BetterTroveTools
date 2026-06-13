(function () {
    const params = new URLSearchParams(window.location.search);
    const forceWebMode = params.get('web') === '1' || params.get('mode') === 'web';
    const hasEelBridge = !!window.eel && typeof window.eel.expose === 'function';

    window.BTT_WEB_MODE = forceWebMode || !hasEelBridge;
    // Running inside the packaged native (Android) app. Used to HIDE desktop-only
    // views/tools entirely here (the web build instead badges them with "Desktop App").
    window.BTT_NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
        && window.Capacitor.isNativePlatform());
    // Hosted web build (BTT_WEB_MODE && !BTT_NATIVE) keeps Modder Tools available
    // — only the Extract TMod tab is exposed there (see web/views/modder_tools.html)
    // and Extract runs entirely in the browser via TmodUnpacker. Android still
    // hides the whole view (no DecompressionStream issues, but no file I/O either).
    window.BTT_UNAVAILABLE_WEB_VIEWS = window.BTT_WEB_MODE
        ? [
            'mod_manager', 'codexes', 'allies', 'mounts', 'dragons', 'mementos', 'recipes', 'items',
            ...(window.BTT_NATIVE ? ['modder_tools'] : []),
        ]
        : [];
    // Flag the document so CSS can hide desktop-only affordances (e.g. Ctrl+K
    // shortcut tips) without each rule needing a JS gate.
    if (window.BTT_NATIVE) document.documentElement.classList.add('btt-native');

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

    // POST helper for write endpoints (currently just /misc/feedback). Body
    // can be a plain object (sent as JSON) OR a FormData (sent as multipart).
    //
    // Transport story:
    //   web / desktop  → fetch() — handles both JSON and FormData natively
    //   Android native → CapacitorHttp.post — bypasses CORS, BUT (per the v7
    //                    plugin docs) "data can only be a string or JSON on
    //                    Android/iOS", so File/Blob inside FormData would be
    //                    silently corrupted. We serialize text-only FormData
    //                    into a multipart/form-data string and post that; the
    //                    feedback UI hides the attachment picker on Android
    //                    so the FormData arriving here has no File entries.
    //
    // On non-2xx, the rejection's .status mirrors the HTTP code (callers care
    // most about 429 from the per-IP rate limit).
    const _isFormData = (v) => (typeof FormData !== 'undefined' && v instanceof FormData);
    const _formHasFiles = (fd) => {
        for (const v of fd.values()) {
            if (typeof File !== 'undefined' && v instanceof File) return true;
            if (typeof Blob !== 'undefined' && v instanceof Blob) return true;
        }
        return false;
    };
    // Build a multipart/form-data body string from text-only FormData. Uses a
    // boundary unlikely to appear in any caller's input (timestamped + random).
    const _serializeMultipartText = (fd) => {
        const boundary = '----BTTFormBoundary' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        let body = '';
        for (const [name, value] of fd.entries()) {
            body += `--${boundary}\r\n`;
            body += `Content-Disposition: form-data; name="${name}"\r\n\r\n`;
            body += String(value) + '\r\n';
        }
        body += `--${boundary}--\r\n`;
        return { boundary, body };
    };
    const kiwiPost = async (path, body) => {
        const url = `${KIWI_BASE}/${path}`;
        const isForm = _isFormData(body);
        const http = capacitorHttp();
        if (http) {
            if (isForm) {
                if (_formHasFiles(body)) {
                    // The Android feedback UI hides attachments precisely so we
                    // never hit this path. If we do, fail loudly instead of
                    // letting the file bytes get mangled mid-flight.
                    throw new Error('Multipart with files is not supported on Android via CapacitorHttp.');
                }
                const { boundary, body: serialized } = _serializeMultipartText(body);
                const res = await http.post({
                    url,
                    headers: {
                        'Content-Type': `multipart/form-data; boundary=${boundary}`,
                        'Accept': 'application/json',
                    },
                    data: serialized,
                });
                if (res.status < 200 || res.status >= 300) {
                    const err = new Error(`HTTP ${res.status}`); err.status = res.status; err.data = res.data; throw err;
                }
                return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            }
            const res = await http.post({
                url,
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                data: body,
            });
            if (res.status < 200 || res.status >= 300) {
                const err = new Error(`HTTP ${res.status}`); err.status = res.status; err.data = res.data; throw err;
            }
            return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        }
        // fetch() path (web + desktop). Don't set Content-Type for FormData —
        // the browser must set it including the boundary parameter.
        const init = isForm
            ? { method: 'POST', headers: { 'Accept': 'application/json' }, body }
            : { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) };
        const res = await fetch(url, init);
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`);
            err.status = res.status;
            try { err.data = await res.json(); } catch { /* ignore */ }
            throw err;
        }
        return res.json();
    };

    // Surface the Kiwi GET/POST helpers so consumers outside this IIFE (e.g. main.js
    // update-check, feedback modal) can reuse the native-HTTP-on-Android path.
    // CapacitorHttp bypasses the WebView's CORS check, which is necessary because
    // the packaged app serves from https://localhost — an origin the API doesn't
    // currently allowlist (and that I shouldn't change from the client side).
    window.BTT_Kiwi = { get: kiwiGet, post: kiwiPost, base: KIWI_BASE };

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
        // Android-only rotation reminders (see js/notifications.js). Each rotation
        // has its OWN lead_minutes (>= 1 = fires N minutes before the rotation
        // starts) and on_time toggle (also fires at the rotation start). A rotation
        // can have both — same event triggers two notifications.
        notifications: {
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
            }
        },
        ui_preferences: {}
    };

    const languages = [
        { code: 'en_US', name: 'English', percent: 100 },
        { code: 'de_DE', name: 'Deutsch', percent: 100 },
        { code: 'es_ES', name: 'Espanol', percent: 100 },
        { code: 'fr_FR', name: 'Francais', percent: 100 },
        { code: 'ja_JP', name: 'Japanese', percent: 100 },
        { code: 'ko_KR', name: 'Korean', percent: 100 },
        { code: 'pt_PT', name: 'Português', percent: 100 },
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

    // --- Deterministic biome rotations (mirror backend/home.py) — computed locally
    // so gardening / wild-mana / stampy / chaos-window / calendar work offline and
    // cover the full schedule instead of the API's truncated window. ---
    const DAY_SEC = 86400, WEEK_SEC = 7 * 86400, HOUR_SEC = 3600;
    const _mod = (n, m) => ((n % m) + m) % m;
    const MANA_BIOMES = ['Neon City', 'Jurassic Jungle', 'Dragonfire Peaks', 'Forbidden Spires', 'Sundered Uplands', 'Medieval Highlands', 'Permafrost', 'Cursed Vale', 'Desert Frontier', 'Fae Forest', 'Candoria'];
    const STAMPY_BIOMES = ['Desert Frontier', 'The Lost Isles', 'Geode Topside', 'Neon City', 'Dragonfire Peaks', 'Permafrost', 'Candoria', 'Cursed Vale', 'Forbidden Spires', 'Fae Forest', 'Medieval Highlands', 'Jurassic Jungle', 'Sundered Uplands'];
    const MANA_ICON_FALLBACK = { 'Neon City': 'neon', 'Jurassic Jungle': 'dinosaur', 'Dragonfire Peaks': 'dragon', 'Forbidden Spires': 'spires', 'Sundered Uplands': 'giantland', 'Medieval Highlands': 'forest', 'Permafrost': 'tundra', 'Cursed Vale': 'undead', 'Desert Frontier': 'frontier', 'Fae Forest': 'fae', 'Candoria': 'candy' };
    const STAMPY_ICON_FALLBACK = { ...MANA_ICON_FALLBACK, 'Geode Topside': 'dunes', 'The Lost Isles': 'pirate' };
    const buildBiomeIconMap = (subbiomes) => { const m = {}; for (const k in subbiomes) { const p = subbiomes[k] && subbiomes[k].biome; if (p && !(p in m)) m[p] = subbiomes[k].icon || 'unknown'; } return m; };
    const biomeIcon = (name, iconMap, fallback) => iconMap[name] || fallback[name] || 'unknown';

    // D15 (Delve depth-15) 3-hour biome rotation — three independent sequences off
    // a fixed epoch. Lifted to module scope so get_d15_rotation AND the notification
    // scheduler share one definition.
    // 2024-06-18 14:00 UTC — kept in lockstep with backend/home.py's
    // `system_epoch = datetime(2024, 6, 18, 14, 0, 0, tzinfo=UTC)`. If you
    // bump one, bump the other in the same commit or the desktop and
    // web/Android builds will disagree on which slot is current.
    const D15_EPOCH = 1718719200, D15_INTERVAL = 3 * HOUR_SEC;
    const D15_BIOME1 = ['Sundered Uplands', 'Cerise Sandsea', 'Deep Forest', 'Alkali Flats', 'Dead of Winter', 'Sundered Uplands', 'Firefly Party', 'Desert of Secrets', 'Weathered Wastelands', 'Frozen Wastes', "Frigga's Fjord", 'Abandoned Boneyard'];
    const D15_BIOME2 = ['Cursed Vale', 'Hollow Dunes', 'Bewitching Wood', 'Primal Preserve', 'Hollow Dunes', 'Ancient Heights', 'Viking Burial Grounds', 'Spellbound Thicket', 'Saurian Swamp', 'Restless Range', 'Uncanny Valley'];
    const D15_BIOME3 = ['Sugar Steppes', 'Volcanic Fields', 'The Lost Isles', 'Luminopolis', 'The Lost Isles', 'Blazing Emberlands', 'Cocoa Craters', 'Data Spires', 'The Lost Isles', 'Cupcake Canyon', "Dragon's Teeth", 'Luminopolis', 'The Lost Isles', 'Data Spires'];
    const d15UniqueBiomes = () => [...new Set([...D15_BIOME1, ...D15_BIOME2, ...D15_BIOME3])].sort();
    const d15BiomesAt = (offset) => [D15_BIOME1[_mod(offset, D15_BIOME1.length)], D15_BIOME2[_mod(offset, D15_BIOME2.length)], D15_BIOME3[_mod(offset, D15_BIOME3.length)]];

    // Shared rotation-event generator: flattens the deterministic schedule into a
    // list of typed, timed events over [startSec, endSec). The yearly calendar AND
    // the Android notification scheduler both consume this — one source of truth for
    // rotation timing, no duplicated epoch math. ctx = { iconMap?, weeklyBuffs? }.
    const computeRotationEvents = (startSec, endSec, ctx = {}) => {
        const iconMap = ctx.iconMap || {};
        const weeklyBuffs = ctx.weeklyBuffs || {};
        const nowTs = Date.now() / 1000;
        const events = [];

        // weekly buffs (current index from the 4-week cycle since 2020-03-23)
        const wkeys = Object.keys(weeklyBuffs).sort((a, b) => Number(a) - Number(b));
        if (wkeys.length) {
            const wi = _mod(Math.floor((nowTs - Date.UTC(2020, 2, 23) / 1000) / WEEK_SEC), 4);
            const curName = (weeklyBuffs[String(wi)] || {}).name;
            let curIdx = 0; for (const k of wkeys) { if (weeklyBuffs[k].name === curName) { curIdx = Number(k); break; } }
            const d = new Date(nowTs * 1000);
            const todayUTC11 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11, 0, 0) / 1000;
            let cws = todayUTC11 - ((d.getUTCDay() + 6) % 7) * DAY_SEC; if (nowTs < cws) cws -= WEEK_SEC;
            for (let wo = -55; wo < 55; wo++) {
                const sw = cws + wo * WEEK_SEC, ew = sw + WEEK_SEC;
                if (ew > startSec && sw < endSec) { const b = weeklyBuffs[wkeys[_mod(curIdx + wo, wkeys.length)]] || {}; events.push({ type: 'weekly_buff', start: sw, end: ew, name: b.name || 'Weekly Buff', color: b.color || 'fbc02d' }); }
            }
        }
        // stampy (weekly 48h, 1 biome)
        const baseStampy = Date.UTC(2023, 8, 30, 11, 0, 0) / 1000;
        let wS = Math.floor((startSec - baseStampy) / WEEK_SEC), s = baseStampy + wS * WEEK_SEC;
        while (s < endSec) { const e = s + 48 * HOUR_SEC; if (e > startSec) { const b = STAMPY_BIOMES[_mod(wS, 13)]; events.push({ type: 'stampy', start: s, end: e, name: 'Stampy', icons: [biomeIcon(b, iconMap, STAMPY_ICON_FALLBACK)], biome_names: [b] }); } s += WEEK_SEC; wS++; }
        // wild mana (weekly, 3 biomes)
        const baseMana = Date.UTC(2023, 10, 20, 11, 0, 0) / 1000;
        let wM = Math.floor((startSec - baseMana) / WEEK_SEC); s = baseMana + wM * WEEK_SEC;
        while (s < endSec) { const e = s + WEEK_SEC; if (e > startSec) { const bb = [MANA_BIOMES[_mod(wM, 11)], MANA_BIOMES[_mod(wM - 1, 11)], MANA_BIOMES[_mod(wM - 2, 11)]]; events.push({ type: 'mana', start: s, end: e, name: 'Wild Mana', icons: bb.map((x) => biomeIcon(x, iconMap, STAMPY_ICON_FALLBACK)), biome_names: bb }); } s += WEEK_SEC; wM++; }
        // corruxion (14-day cycle, 3-day window)
        { const base = Date.UTC(2023, 11, 8, 11, 0, 0) / 1000; let ss = base + Math.floor((startSec - base) / (14 * DAY_SEC)) * 14 * DAY_SEC; while (ss < endSec) { const e = ss + 3 * DAY_SEC; if (e > startSec) events.push({ type: 'corruxion', start: ss, end: e, name: 'Corruxion' }); ss += 14 * DAY_SEC; } }
        // fluxion (14-day cycle: voting then selling 7 days later)
        { const base = Date.UTC(2023, 11, 5, 11, 0, 0) / 1000; let sf = base + Math.floor((startSec - base) / (14 * DAY_SEC)) * 14 * DAY_SEC; while (sf < endSec) { const sv = sf, ev = sv + 3 * DAY_SEC, sl = sf + 7 * DAY_SEC, el = sl + 3 * DAY_SEC; if (ev > startSec) events.push({ type: 'fluxion', start: sv, end: ev, name: 'Fluxion (Voting)', phase: 'voting', color: '5ca8cc' }); if (el > startSec && sl < endSec) events.push({ type: 'fluxion', start: sl, end: el, name: 'Fluxion (Selling)', phase: 'selling', color: '02679e' }); sf += 14 * DAY_SEC; } }
        // gardening (2-day + 3-day cycles)
        { const base = Date.UTC(2025, 4, 23) / 1000 + TROVE_OFFSET_SEC; let s2 = base + Math.floor((startSec - base) / (2 * DAY_SEC)) * 2 * DAY_SEC; while (s2 < endSec) { const hs = s2 + DAY_SEC, he = s2 + 2 * DAY_SEC; if (he > startSec && hs < endSec) events.push({ type: 'gardening_2', start: hs, end: he, name: '2-day plants', color: '8bc34a' }); s2 += 2 * DAY_SEC; } let s3 = base + Math.floor((startSec - base) / (3 * DAY_SEC)) * 3 * DAY_SEC; while (s3 < endSec) { const hs = s3 + 2 * DAY_SEC, he = s3 + 3 * DAY_SEC; if (he > startSec && hs < endSec) events.push({ type: 'gardening_3', start: hs, end: he, name: '3-day plants', color: '4caf50' }); s3 += 3 * DAY_SEC; } }

        return events;
    };

    const loadRotationCtx = async () => {
        const [subbiomes, weeklyBuffs] = await Promise.all([
            fetchJson('assets/data/biomes.json', {}),
            fetchJson('assets/data/weekly_buffs.json', {})
        ]);
        return { iconMap: buildBiomeIconMap(subbiomes), weeklyBuffs };
    };

    // Surface the deterministic rotation math for js/notifications.js (Android).
    window.BTT_Rotations = {
        computeRotationEvents,
        loadCtx: loadRotationCtx,
        TROVE_OFFSET_SEC, FIRST_FLUXION_SEC, DAY_SEC, WEEK_SEC, HOUR_SEC,
        chaosBaseSec: FIRST_FLUXION_SEC + TROVE_OFFSET_SEC,
        D15: { EPOCH: D15_EPOCH, INTERVAL: D15_INTERVAL, biomesAt: d15BiomesAt, uniqueBiomes: d15UniqueBiomes }
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
        // Feeds now come from the Kiwi API (api.aallyn.net/v1/feeds/*), mapped to the
        // shapes the home page already consumes (news/youtube/bilibili match 1:1;
        // twitch + events get a small field rename).
        get_trove_news: makeFeedFn('receive_trove_news', `${KIWI_BASE}/feeds/news`, (d) => asJson(d).items || []),
        get_youtube_videos: makeFeedFn('receive_youtube_videos', `${KIWI_BASE}/feeds/youtube`, (d) => asJson(d).items || []),
        get_twitch_streams: makeFeedFn('receive_twitch_streams', `${KIWI_BASE}/feeds/twitch`, (d) => (asJson(d).items || []).map((v) => ({ user_login: v.login, user_name: v.channel, viewer_count: v.viewers, thumbnail_url: v.thumbnail, title: v.title, url: v.url, game_name: v.game, started_at: v.started_at }))),
        get_bilibili_videos: makeFeedFn('receive_bilibili_videos', `${KIWI_BASE}/feeds/bilibili`, (d) => asJson(d).items || []),
        get_trovesaurus_events: makeFeedFn('receive_events_data', `${KIWI_BASE}/feeds/events`, (d) => { const e = (asJson(d).items || []).map((x) => ({ ...x, id: x.event_id, startdate: x.starts_at, enddate: x.ends_at })); e.sort((a, b) => parseInt(a.startdate) - parseInt(b.startdate)); return e; }),
        // /v1/giveaways/{ongoing,upcoming,ended} all return a bare array of
        // GiveawayPublicView (not wrapped in {items}).
        get_giveaways: makeFeedFn('receive_giveaways', `${KIWI_BASE}/giveaways/ongoing`, (d) => { const v = asJson(d); return Array.isArray(v) ? v : (v && v.items) || []; }),
        get_upcoming_giveaways: makeFeedFn('receive_upcoming_giveaways', `${KIWI_BASE}/giveaways/upcoming`, (d) => { const v = asJson(d); return Array.isArray(v) ? v : (v && v.items) || []; }),
        get_ended_giveaways: makeFeedFn('receive_ended_giveaways', `${KIWI_BASE}/giveaways/ended?days=7`, (d) => { const v = asJson(d); return Array.isArray(v) ? v : (v && v.items) || []; }),
        // /v1/activity/current returns one object with 1h / 24h / 7d rollups; we
        // drop by_board so the eel-receive payload mirrors the desktop trim.
        get_player_activity: makeFeedFn('receive_player_activity', `${KIWI_BASE}/activity/current`, (d) => {
            const p = asJson(d) || {};
            return {
                estimate: p.estimate, estimate_24h: p.estimate_24h, estimate_7d: p.estimate_7d,
                duration_hours: p.duration_hours, span_24h_hours: p.span_24h_hours, span_7d_hours: p.span_7d_hours,
                window_end: p.window_end, computed_at: p.computed_at, methodology: p.methodology
            };
        }),
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
            // The weekly window is deterministic (first_fluxion + 11h) -> compute it
            // locally so the dates show offline. Only the featured item needs the API.
            const realBase = FIRST_FLUXION_SEC + TROVE_OFFSET_SEC;
            const nowTs = Date.now() / 1000;
            const start = realBase + Math.floor((nowTs - realBase) / WEEK_SEC) * WEEK_SEC;
            const end = start + WEEK_SEC;
            const fallback_times = { start, end };
            let data = null;
            try {
                const c = await kiwiGet('rotations/chaos-chest');
                const item = c && c.item;
                if (item) data = { name: item.name, identifier: item.identifier, blueprint: item.blueprint, end };
            } catch (e) { /* offline: window-only, frontend falls back to fallback_times */ }
            return { success: true, data, fallback_times };
        }, { localOnly: true }),
        get_merchant_schedules: makeEelFn('get_merchant_schedules', () => ({ success: true })),
        get_yearly_calendar_data: makeEelFn('get_yearly_calendar_data', async () => {
            try {
                // Every recurring rotation is deterministic -> compute the ±365-day
                // calendar locally (mirrors backend get_yearly_calendar_data).
                const [subbiomes, weeklyBuffs] = await Promise.all([
                    fetchJson('assets/data/biomes.json', {}),
                    fetchJson('assets/data/weekly_buffs.json', {})
                ]);
                const iconMap = buildBiomeIconMap(subbiomes);
                const nowTs = Date.now() / 1000;
                // Shared generator (also feeds the Android rotation notifier) — one
                // source of truth for the deterministic rotation timing.
                const events = computeRotationEvents(nowTs - 365 * DAY_SEC, nowTs + 365 * DAY_SEC, { iconMap, weeklyBuffs });
                return { success: true, data: events, events };
            } catch (err) {
                return { success: false, error: String(err && err.message || err), code: 'CALENDAR_FAILED' };
            }
        }, { localOnly: true }),
        get_gardening_rotation: makeEelFn('get_gardening_rotation', () => {
            try {
                // Deterministic 2-day / 3-day cycles from first_gardening + 11h.
                const base = Date.UTC(2025, 4, 23) / 1000 + TROVE_OFFSET_SEC;
                const nowTs = Date.now() / 1000;
                const c2 = Math.floor((nowTs - base) / (2 * DAY_SEC)), cur2 = base + c2 * 2 * DAY_SEC;
                const two_day = { name: '2-day plants', active: (cur2 + DAY_SEC) <= nowTs && nowTs < (cur2 + 2 * DAY_SEC), start: cur2 + DAY_SEC, end: cur2 + 2 * DAY_SEC };
                const c3 = Math.floor((nowTs - base) / (3 * DAY_SEC)), cur3 = base + c3 * 3 * DAY_SEC;
                const three_day = { name: '3-day plants', active: (cur3 + 2 * DAY_SEC) <= nowTs && nowTs < (cur3 + 3 * DAY_SEC), start: cur3 + 2 * DAY_SEC, end: cur3 + 3 * DAY_SEC };
                const future = [];
                for (let i = 0; i < 8; i++) {
                    const a2 = cur2 + i * 2 * DAY_SEC + DAY_SEC; if (a2 > nowTs) future.push({ name: '2-day plants', start: a2, end: a2 + DAY_SEC });
                    const a3 = cur3 + i * 3 * DAY_SEC + 2 * DAY_SEC; if (a3 > nowTs) future.push({ name: '3-day plants', start: a3, end: a3 + DAY_SEC });
                }
                future.sort((x, y) => x.start - y.start);
                return { success: true, two_day, three_day, future: future.slice(0, 10) };
            } catch (err) { return { success: false, error: String(err && err.message || err), code: 'GARDENING_FAILED' }; }
        }, { localOnly: true }),
        get_d15_rotation: makeEelFn('get_d15_rotation', async () => {
            // Deterministic 3-hour biome rotation (mirrors backend get_d15_rotation):
            // computed locally so it works offline AND covers the full ~8-day window.
            // The API's `upcoming` only returns ~2 days, which left the modal half-empty.
            try {
                const subbiomes = await fetchJson('assets/data/biomes.json', {});
                const subOf = (name) => subbiomes[name] || { name, final_name: name, icon: 'unknown' };
                const nowSec = Date.now() / 1000;
                const consumed = Math.floor((nowSec - D15_EPOCH) / D15_INTERVAL);
                const startSec = D15_EPOCH + consumed * D15_INTERVAL;
                const rotations = [];
                for (let i = -8; i < 56; i++) {
                    const s = startSec + i * D15_INTERVAL;
                    rotations.push({ start: s, end: s + D15_INTERVAL, biomes: d15BiomesAt(consumed + i).map(subOf) });
                }
                const current = rotations.find((r) => r.start <= nowSec && nowSec < r.end) || null;
                return { success: true, current, rotations };
            } catch (err) { return { success: false, error: String(err && err.message || err), code: 'D15_FAILED' }; }
        }, { localOnly: true }),
        get_wild_mana_rotation: makeEelFn('get_wild_mana_rotation', async () => {
            try {
                // Deterministic weekly rotation (3 biomes) from 2023-11-20 11:00 UTC.
                const iconMap = buildBiomeIconMap(await fetchJson('assets/data/biomes.json', {}));
                const START = Date.UTC(2023, 10, 20, 11, 0, 0) / 1000;
                const nowTs = Date.now() / 1000;
                const ws = Math.floor((nowTs - START) / WEEK_SEC);
                let current = null; const future = [];
                for (let i = 0; i < 8; i++) {
                    const w = ws + i, s = START + w * WEEK_SEC;
                    const bs = [MANA_BIOMES[_mod(w, 11)], MANA_BIOMES[_mod(w - 1, 11)], MANA_BIOMES[_mod(w - 2, 11)]];
                    const rot = { start: s, end: s + WEEK_SEC, biomes: bs.map((b) => ({ name: b, final_name: b, icon: biomeIcon(b, iconMap, MANA_ICON_FALLBACK) })) };
                    if (i === 0) current = rot; else future.push(rot);
                }
                return { success: true, current, future };
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
                // Deterministic weekly 48h rotation (1 biome) from 2023-09-30 11:00 UTC.
                const iconMap = buildBiomeIconMap(await fetchJson('assets/data/biomes.json', {}));
                const BASE = Date.UTC(2023, 8, 30, 11, 0, 0) / 1000;
                const nowTs = Date.now() / 1000;
                const wo = Math.floor((nowTs - BASE) / WEEK_SEC);
                const events = [];
                for (let w = wo - 1; w < wo + 10; w++) {
                    const s = BASE + w * WEEK_SEC, e = s + 48 * HOUR_SEC;
                    if (e > nowTs) { const b = STAMPY_BIOMES[_mod(w, 13)]; events.push({ start: s, end: e, biomes: [{ name: b, final_name: b, icon: biomeIcon(b, iconMap, STAMPY_ICON_FALLBACK) }] }); if (events.length === 8) break; }
                }
                if (!events.length) return { success: false, error: 'No valid Stampy events found', code: 'STAMPY_EVENTS_NOT_FOUND' };
                return { success: true, current: events[0], future: events.slice(1) };
            } catch (err) { return { success: false, error: String(err && err.message || err), code: 'STAMPY_FAILED' }; }
        }, { localOnly: true })
    };
})();
