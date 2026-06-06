// Android rotation notifications.
//
// Schedules Capacitor LocalNotifications for the deterministic Trove rotations
// computed by js/web_mode.js's BTT_Rotations namespace. One REGISTRY drives both
// the Settings → Notifications tab (controls) AND this scheduler (events) so
// adding a rotation is a single entry, not duplicated across UI + scheduling
// logic. Web-mode (browser) and desktop builds: no-op.
//
// Per-rotation knobs (each row in the Settings tab):
//   • enabled       — master per-rotation switch
//   • lead_minutes  — fire N minutes BEFORE the rotation starts (>= 1)
//   • on_time       — ALSO fire exactly at the rotation start (independent)
// A rotation with both set produces TWO notifications per event with distinct
// copy ("starts in 60m" vs "is here now").

(function () {
    'use strict';

    const NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
    const plugin = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
    const rot = () => window.BTT_Rotations || null;

    // Look ahead this far when computing pending events. Android caps the number
    // of pending alarms, and we re-sync on every app open + settings change, so a
    // rolling 14-day window covers the next reminder cycle comfortably.
    const WINDOW_DAYS = 14;
    // Hard ceiling on simultaneously-scheduled notifications. We sort by
    // soonest-first and cap so the most imminent reminders always win.
    const MAX_PENDING = 50;
    // Test-button delay (seconds).
    const TEST_DELAY = 10;
    // Minimum lead time the UI lets users set; mirrored here as a safety net.
    // Anything below this is rounded up — sub-5-minute alarms don't really pay
    // off (notification delivery jitter + the user has barely any time to act).
    const MIN_LEAD_MIN = 5;
    // localStorage key for the last successful sync timestamp (epoch ms). The
    // settings tab shows this so users can tell when their reminders were last
    // queued (and notice if they need to open the app to refresh).
    const LAST_SYNC_KEY = 'btt.notifications.last_synced_ms';
    // Android: monochrome notification icon resource (lives at
    // android/app/src/main/res/drawable/ic_stat_btt.xml). Passed on every
    // schedule call so Android doesn't fall back to the generic info glyph.
    const SMALL_ICON = 'ic_stat_btt';
    // Read the app's accent color (the user-customizable theme color) and use
    // it to tint the notification icon. Falls back to the default blue if the
    // CSS variable hasn't been set yet.
    const iconColorHex = () => {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-blue').trim();
            return v || '#5ec6ff';
        } catch { return '#5ec6ff'; }
    };

    // ---- helpers ----------------------------------------------------------
    const i18n = (id, params) => (window.I18nManager && window.I18nManager.t ? window.I18nManager.t(id, params) : id);

    // Stable 31-bit positive int from a string — Capacitor LocalNotifications
    // requires Java-int ids and idempotent re-syncs need deterministic ids.
    const hashId = (key) => {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < key.length; i++) {
            h ^= key.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        return h & 0x7fffffff;
    };

    const troveWeekdayIndex = (sec) => {
        const t = (sec - 11 * 3600) * 1000;
        const d = new Date(t);
        return (d.getUTCDay() + 6) % 7;
    };

    // ---- registry (single source of truth) --------------------------------
    // Each entry:
    //   id           — settings key + i18n suffix
    //   icon         — fontawesome class for the tab row
    //   subOptions   — optional sub-controls the tab will render
    //
    //   events(start, end, ctx, opts)
    //     yields RAW rotation events: { at, key, variant?, ...semanticFields }
    //     `at` is the rotation START time. The scheduler builds the actual
    //     notifications (lead and/or on-time) from these.
    //
    //   copy(event, mode, ctx, leadMin)
    //     returns { title, body } for the given mode ('start' | 'lead').
    //     `leadMin` is the lead minutes for 'lead' mode (ignored for 'start').
    //
    // Most generators reuse BTT_Rotations.computeRotationEvents and just filter
    // by type/sub-option — no rotation math is re-implemented here.
    const buildRegistry = () => {
        const R = rot();
        if (!R) return [];

        const calendarOf = (type, start, end, ctx) =>
            R.computeRotationEvents(start, end, ctx).filter((e) => e.type === type);

        // Common copy helper: pick start vs lead text based on `mode`.
        const pick = (mode, startKey, leadKey, leadParams) =>
            mode === 'start' ? i18n(startKey) : i18n(leadKey, leadParams);

        return [
            {
                id: 'corruxion',
                icon: 'fa-solid fa-dragon',
                events(start, end, ctx) {
                    return calendarOf('corruxion', start, end, ctx).map((e) => ({
                        at: e.start, key: `corruxion:${e.start}`
                    }));
                },
                copy(_e, mode, _ctx, lead) {
                    return {
                        title: pick(mode, 'notifications.corruxion.title_start', 'notifications.corruxion.title_lead', { minutes: lead }),
                        body: pick(mode, 'notifications.corruxion.body_start', 'notifications.corruxion.body_lead', { minutes: lead })
                    };
                }
            },
            {
                id: 'fluxion',
                icon: 'fa-solid fa-coins',
                subOptions: {
                    kind: 'checkbox-set',
                    key: 'phases',
                    values: [
                        { value: 'voting', labelKey: 'notifications.fluxion.phase_voting' },
                        { value: 'selling', labelKey: 'notifications.fluxion.phase_selling' }
                    ]
                },
                events(start, end, ctx, opts) {
                    const phases = new Set(opts.phases || []);
                    return calendarOf('fluxion', start, end, ctx)
                        .filter((e) => phases.has(e.phase))
                        .map((e) => ({
                            at: e.start, variant: e.phase,
                            key: `fluxion:${e.phase}:${e.start}`
                        }));
                },
                copy(e, mode, _ctx, lead) {
                    const isVoting = e.variant === 'voting';
                    return {
                        title: pick(
                            mode,
                            isVoting ? 'notifications.fluxion.title_start_voting' : 'notifications.fluxion.title_start_selling',
                            isVoting ? 'notifications.fluxion.title_lead_voting' : 'notifications.fluxion.title_lead_selling',
                            { minutes: lead }
                        ),
                        body: pick(mode, 'notifications.fluxion.body_start', 'notifications.fluxion.body_lead', { minutes: lead })
                    };
                }
            },
            {
                id: 'mana',
                icon: 'fa-solid fa-bolt',
                events(start, end, ctx) {
                    return calendarOf('mana', start, end, ctx).map((e) => ({
                        at: e.start, biomes: e.biome_names || [], key: `mana:${e.start}`
                    }));
                },
                copy(e, mode, _ctx, lead) {
                    const body = (e.biomes || []).join(', ');
                    return {
                        title: pick(mode, 'notifications.mana.title_start', 'notifications.mana.title_lead', { minutes: lead }),
                        body
                    };
                }
            },
            {
                id: 'stampy',
                icon: 'fa-solid fa-stamp',
                events(start, end, ctx) {
                    return calendarOf('stampy', start, end, ctx).map((e) => ({
                        at: e.start, biome: (e.biome_names || [])[0] || '', key: `stampy:${e.start}`
                    }));
                },
                copy(e, mode, _ctx, lead) {
                    return {
                        title: pick(mode, 'notifications.stampy.title_start', 'notifications.stampy.title_lead', { minutes: lead }),
                        body: e.biome || ''
                    };
                }
            },
            {
                id: 'gardening',
                icon: 'fa-solid fa-seedling',
                subOptions: {
                    kind: 'checkbox-set',
                    key: 'cycles',
                    values: [
                        { value: '2', labelKey: 'notifications.gardening.cycle_2' },
                        { value: '3', labelKey: 'notifications.gardening.cycle_3' }
                    ]
                },
                events(start, end, ctx, opts) {
                    const cycles = new Set((opts.cycles || []).map(String));
                    const all = R.computeRotationEvents(start, end, ctx);
                    return all
                        .filter((e) => (e.type === 'gardening_2' && cycles.has('2')) || (e.type === 'gardening_3' && cycles.has('3')))
                        .map((e) => ({
                            at: e.start, variant: e.type === 'gardening_2' ? '2' : '3',
                            key: `${e.type}:${e.start}`
                        }));
                },
                copy(e, mode, _ctx, lead) {
                    const is2 = e.variant === '2';
                    return {
                        title: pick(
                            mode,
                            is2 ? 'notifications.gardening.title_start_2' : 'notifications.gardening.title_start_3',
                            is2 ? 'notifications.gardening.title_lead_2' : 'notifications.gardening.title_lead_3',
                            { minutes: lead }
                        ),
                        body: pick(mode, 'notifications.gardening.body_start', 'notifications.gardening.body_lead', { minutes: lead })
                    };
                }
            },
            {
                id: 'weekly_buff',
                icon: 'fa-solid fa-calendar-week',
                events(start, end, ctx) {
                    return calendarOf('weekly_buff', start, end, ctx).map((e) => ({
                        at: e.start, name: e.name || '', key: `weekly_buff:${e.start}`
                    }));
                },
                copy(e, mode, _ctx, lead) {
                    return {
                        title: pick(mode, 'notifications.weekly_buff.title_start', 'notifications.weekly_buff.title_lead', { minutes: lead }),
                        body: e.name || ''
                    };
                }
            },
            {
                id: 'chaos_chest',
                icon: 'fa-solid fa-treasure-chest',
                events(start, end) {
                    const base = R.chaosBaseSec;
                    const out = [];
                    let s = base + Math.floor((start - base) / R.WEEK_SEC) * R.WEEK_SEC;
                    while (s < end) {
                        if (s >= start) out.push({ at: s, key: `chaos_chest:${s}` });
                        s += R.WEEK_SEC;
                    }
                    return out;
                },
                copy(_e, mode, _ctx, lead) {
                    return {
                        title: pick(mode, 'notifications.chaos_chest.title_start', 'notifications.chaos_chest.title_lead', { minutes: lead }),
                        body: pick(mode, 'notifications.chaos_chest.body_start', 'notifications.chaos_chest.body_lead', { minutes: lead })
                    };
                }
            },
            {
                id: 'd15',
                icon: 'fa-solid fa-mountain',
                subOptions: {
                    kind: 'biome-multi',
                    key: 'biomes',
                    optionsFrom: 'd15Biomes'
                },
                events(start, end, _ctx, opts) {
                    const wanted = new Set(opts.biomes || []);
                    if (!wanted.size) return [];
                    const { EPOCH, INTERVAL, biomesAt } = R.D15;
                    const out = [];
                    const firstOffset = Math.floor((start - EPOCH) / INTERVAL);
                    const lastOffset = Math.ceil((end - EPOCH) / INTERVAL);
                    for (let off = firstOffset; off < lastOffset; off++) {
                        const at = EPOCH + off * INTERVAL;
                        if (at < start || at >= end) continue;
                        const biomes = biomesAt(off);
                        const hit = biomes.filter((b) => wanted.has(b));
                        if (!hit.length) continue;
                        out.push({ at, biomes: hit, key: `d15:${at}` });
                    }
                    return out;
                },
                copy(e, mode, _ctx, lead) {
                    return {
                        title: pick(mode, 'notifications.d15.title_start', 'notifications.d15.title_lead', { minutes: lead }),
                        body: (e.biomes || []).join(', ')
                    };
                }
            },
            {
                id: 'daily_reset',
                icon: 'fa-solid fa-sun',
                events(start, end, ctx) {
                    const daily = (ctx && ctx.dailyBuffs) || {};
                    const out = [];
                    const firstDayUTC = new Date(start * 1000);
                    firstDayUTC.setUTCHours(11, 0, 0, 0);
                    let at = firstDayUTC.getTime() / 1000;
                    if (at < start) at += 86400;
                    while (at < end) {
                        const idx = troveWeekdayIndex(at);
                        const buff = daily[String(idx)] || {};
                        out.push({ at, buffName: buff.name || '', key: `daily_reset:${Math.floor(at)}` });
                        at += 86400;
                    }
                    return out;
                },
                copy(e, mode, _ctx, lead) {
                    const buffKey = e.buffName ? 'notifications.daily_reset.body_with_buff' : 'notifications.daily_reset.body_plain';
                    return {
                        title: pick(mode, 'notifications.daily_reset.title_start', 'notifications.daily_reset.title_lead', { minutes: lead }),
                        body: i18n(buffKey, { buff: e.buffName })
                    };
                }
            }
        ];
    };

    // ---- permissions ------------------------------------------------------
    const ensurePermission = async () => {
        const LN = plugin();
        if (!LN) return false;
        try {
            const cur = await LN.checkPermissions();
            if (cur && cur.display === 'granted') return true;
            const req = await LN.requestPermissions();
            return !!(req && req.display === 'granted');
        } catch {
            return false;
        }
    };

    // ---- scheduling -------------------------------------------------------
    // For each enabled rotation, fan out every raw event into 0/1/2 actual
    // notifications based on the per-rotation lead_minutes + on_time toggles.
    const computePending = async (settings, registry) => {
        const R = rot();
        if (!R) return [];
        const now = Date.now() / 1000;
        const horizon = now + WINDOW_DAYS * 86400;
        const types = settings.types || {};

        const baseCtx = await R.loadCtx();
        let dailyBuffs = {};
        try {
            const resp = await fetch('assets/data/daily_buffs.json', { cache: 'no-cache' });
            if (resp.ok) dailyBuffs = await resp.json();
        } catch { /* notification just omits the buff name */ }
        const ctx = { ...baseCtx, dailyBuffs };

        const tint = iconColorHex();
        const pending = [];
        for (const entry of registry) {
            const opts = types[entry.id] || {};
            if (!opts.enabled) continue;
            const leadMin = Math.max(MIN_LEAD_MIN, Math.floor(Number(opts.lead_minutes) || MIN_LEAD_MIN));
            const wantLead = leadMin >= MIN_LEAD_MIN;        // lead is implicit-on whenever this rotation is enabled
            const wantStart = opts.on_time === true;          // on-time is explicit opt-in
            if (!wantLead && !wantStart) continue;
            const events = entry.events(now, horizon, ctx, opts) || [];
            for (const ev of events) {
                if (wantLead) {
                    const fireAt = ev.at - leadMin * 60;
                    if (fireAt > now + 5) {
                        const { title, body } = entry.copy(ev, 'lead', ctx, leadMin);
                        pending.push({
                            id: hashId(`${ev.key}:lead:${leadMin}`),
                            title, body: body || '',
                            smallIcon: SMALL_ICON, iconColor: tint,
                            schedule: { at: new Date(fireAt * 1000) }
                        });
                    }
                }
                if (wantStart) {
                    if (ev.at > now + 5) {
                        const { title, body } = entry.copy(ev, 'start', ctx, 0);
                        pending.push({
                            id: hashId(`${ev.key}:start`),
                            title, body: body || '',
                            smallIcon: SMALL_ICON, iconColor: tint,
                            schedule: { at: new Date(ev.at * 1000) }
                        });
                    }
                }
            }
        }

        pending.sort((a, b) => a.schedule.at.getTime() - b.schedule.at.getTime());
        const seen = new Set();
        const deduped = [];
        for (const p of pending) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            deduped.push(p);
            if (deduped.length >= MAX_PENDING) break;
        }
        return deduped;
    };

    const cancelAllPending = async (LN) => {
        try {
            const cur = await LN.getPending();
            const ids = (cur && cur.notifications) || [];
            if (ids.length) {
                await LN.cancel({ notifications: ids.map((n) => ({ id: n.id })) });
            }
        } catch { /* nothing to cancel or plugin unavailable */ }
    };

    const sync = async () => {
        if (!NATIVE) return { skipped: 'not-native' };
        const LN = plugin();
        if (!LN) return { skipped: 'no-plugin' };

        const all = (window.AppSettings ? await window.AppSettings.load() : {}) || {};
        const settings = all.notifications || {};
        if (!settings.enabled) {
            await cancelAllPending(LN);
            return { scheduled: 0, cancelledAll: true };
        }

        const granted = await ensurePermission();
        if (!granted) {
            await cancelAllPending(LN);
            return { skipped: 'permission-denied' };
        }

        const registry = buildRegistry();
        const pending = await computePending(settings, registry);

        await cancelAllPending(LN);
        if (pending.length) {
            try {
                await LN.schedule({ notifications: pending });
            } catch (err) {
                console.error('[BTT_Notifications] schedule failed', err);
                return { error: String(err && err.message || err), scheduled: 0 };
            }
        }
        try { localStorage.setItem(LAST_SYNC_KEY, String(Date.now())); } catch {}
        return { scheduled: pending.length };
    };

    // Read the persisted "last sync" timestamp so the settings tab can show
    // when reminders were last queued. Null = never.
    const getLastSynced = () => {
        try {
            const v = Number(localStorage.getItem(LAST_SYNC_KEY));
            return Number.isFinite(v) && v > 0 ? v : null;
        } catch { return null; }
    };

    // Status surface for the Notifications tab — battery exemption, exact alarms,
    // notification posting. All zero-side-effect calls; safe to poll on view open.
    const getBackgroundStatus = async () => {
        if (!NATIVE) return null;
        const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BttBattery;
        if (!p) return null;
        try { return await p.getStatus(); } catch { return null; }
    };

    const requestIgnoreBatteryOptimizations = async () => {
        const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BttBattery;
        if (p && p.requestIgnoreBatteryOptimizations) await p.requestIgnoreBatteryOptimizations();
    };
    const requestExactAlarmPermission = async () => {
        const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BttBattery;
        if (p && p.requestExactAlarmPermission) await p.requestExactAlarmPermission();
    };
    const openAppDetailsSettings = async () => {
        const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BttBattery;
        if (p && p.openAppDetailsSettings) await p.openAppDetailsSettings();
    };

    // Belt-and-suspenders refresh: poll getStatus() for up to N seconds, calling
    // `onChange(newStatus)` whenever any field flips. Used right after the user
    // taps "Grant background access" — visibilitychange / App.resume should fire
    // when they return from the system dialog, but Android system overlays don't
    // always trigger those reliably, so this poll guarantees the UI catches up.
    const pollStatusForChange = async (initialStatus, onChange, { intervalMs = 500, timeoutMs = 12000 } = {}) => {
        if (!NATIVE) return;
        const start = Date.now();
        const baseline = initialStatus || {};
        while (Date.now() - start < timeoutMs) {
            await new Promise((r) => setTimeout(r, intervalMs));
            const next = await getBackgroundStatus();
            if (!next) continue;
            const changed =
                next.ignoresBatteryOptimizations !== baseline.ignoresBatteryOptimizations ||
                next.canScheduleExactAlarms !== baseline.canScheduleExactAlarms ||
                next.notificationsEnabled !== baseline.notificationsEnabled;
            if (changed) { onChange(next); return; }
        }
    };

    const sendTestNotification = async () => {
        if (!NATIVE) return { skipped: 'not-native' };
        const LN = plugin();
        if (!LN) return { skipped: 'no-plugin' };
        const granted = await ensurePermission();
        if (!granted) return { skipped: 'permission-denied' };
        const at = new Date(Date.now() + TEST_DELAY * 1000);
        await LN.schedule({
            notifications: [{
                id: hashId(`test:${at.getTime()}`),
                title: i18n('notifications.test.title'),
                body: i18n('notifications.test.body', { seconds: TEST_DELAY }),
                smallIcon: SMALL_ICON, iconColor: iconColorHex(),
                schedule: { at }
            }]
        });
        return { scheduled: 1, delay: TEST_DELAY };
    };

    // Metadata for the Settings tab — no event generators, no plugin access.
    // settings.js renders rows from this list; the scheduler uses buildRegistry()
    // for the events + copy.
    const registryMeta = () => buildRegistry().map((e) => ({
        id: e.id,
        icon: e.icon,
        subOptions: e.subOptions || null,
        labelKey: `notifications.${e.id}.label`,
        descKey: `notifications.${e.id}.desc`
    }));

    window.BTT_Notifications = {
        sync,
        sendTestNotification,
        registryMeta,
        isNative: () => NATIVE,
        MIN_LEAD_MIN,
        getLastSynced,
        getBackgroundStatus,
        pollStatusForChange,
        requestIgnoreBatteryOptimizations,
        requestExactAlarmPermission,
        openAppDetailsSettings,
        _computePending: computePending,
        _hashId: hashId
    };
})();
