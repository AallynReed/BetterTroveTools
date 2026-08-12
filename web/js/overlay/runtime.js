// In-game overlay runtime — the Vue app inside the transparent window that
// draws over Trove.
//
// This page has no shell. It never loads main.js, has no view router, no
// sidebar and no modals; it is created by main.py only while Trove is running
// and destroyed with it. What it does have is a hard budget: it repaints on top
// of a live game, so the whole surface is a handful of absolutely-positioned
// boxes updated by one 1Hz timer.
//
// Data flow:
//   * `overlay_get_snapshot()` returns every value as an ABSOLUTE unix
//     timestamp. Countdowns then tick locally, so a 60s data refresh still
//     renders a second-accurate clock. Nothing here polls per second.
//   * The backend pushes config/status/notifications in through eel-exposed
//     functions. eel broadcasts to every connected page and the client silently
//     ignores names it hasn't exposed, so only this page reacts to them — the
//     main window sees nothing.
//
// Timers are `setInterval`, never `requestAnimationFrame`: this window is
// created WS_EX_NOACTIVATE and therefore never holds focus, and rAF is the
// first thing a browser throttles for a window that isn't in front.

(function () {
    const hasEel = () => !!window.eel;
    const t = (token, params) => (window.I18nManager && window.I18nManager.t)
        ? window.I18nManager.t(token, params) : token;

    // Module-level inboxes. The eel-exposed names must exist from page load, but
    // the Vue instance doesn't exist until mount, so each exposed function
    // forwards to a handler the app registers (and buffers the last value so a
    // push that lands during boot isn't lost).
    const inbox = {
        config: null,
        onConfig: null,
        onNotification: null,
        onInteractive: null,
        onMuted: null,
        onViewport: null,
        pendingNotifications: [],
    };

    function overlay_apply_config(payload) {
        inbox.config = payload;
        if (inbox.onConfig) inbox.onConfig(payload);
    }
    function overlay_notification(payload) {
        if (inbox.onNotification) inbox.onNotification(payload);
        else inbox.pendingNotifications.push(payload);
    }
    function overlay_set_interactive(value) {
        if (inbox.onInteractive) inbox.onInteractive(value);
    }
    function overlay_set_muted(value) {
        if (inbox.onMuted) inbox.onMuted(value);
    }
    function overlay_set_viewport(payload) {
        if (inbox.onViewport) inbox.onViewport(payload);
    }

    if (window.eel && typeof window.eel.expose === 'function') {
        window.eel.expose(overlay_apply_config, 'overlay_apply_config');
        window.eel.expose(overlay_notification, 'overlay_notification');
        window.eel.expose(overlay_set_interactive, 'overlay_set_interactive');
        window.eel.expose(overlay_set_muted, 'overlay_set_muted');
        window.eel.expose(overlay_set_viewport, 'overlay_set_viewport');
    }

    // --- formatting ------------------------------------------------------

    const pad = (n) => String(n).padStart(2, '0');

    /**
     * Countdown to an absolute timestamp, in the coarsest useful unit.
     *
     * Coarse on purpose: "2d 4h" is what you act on when planning, and seconds
     * only start mattering in the last hour. Showing seconds always would also
     * mean a full-width repaint every second for values nobody reads that
     * closely.
     */
    function formatUntil(target, nowMs) {
        if (!target) return '--';
        let secs = Math.floor((target * 1000 - nowMs) / 1000);
        if (secs <= 0) return t('overlay.now');
        const days = Math.floor(secs / 86400); secs -= days * 86400;
        const hours = Math.floor(secs / 3600); secs -= hours * 3600;
        const mins = Math.floor(secs / 60); secs -= mins * 60;
        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${pad(mins)}m`;
        return `${mins}m ${pad(secs)}s`;
    }

    // A data-driven colour arriving as a bare hex digest ("a14200"). Anything
    // that isn't six hex digits is dropped rather than interpolated into CSS.
    function hexColor(value) {
        const hex = String(value || '').replace('#', '').trim();
        return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (typeof Vue === 'undefined') { console.error('Overlay: Vue failed to load'); return; }
        const { createApp, ref, reactive, computed, onMounted } = Vue;

        createApp({
            setup() {
                const config = reactive({
                    opacity: 0.92, scale: 1, widgets: {},
                    hotkey: 'ctrl+alt+o', mute_hotkey: 'ctrl+alt+h',
                    notification_seconds: 12,
                });
                const snap = ref({});
                const now = ref(Date.now());
                const interactive = ref(false);
                const notes = ref([]);
                const dragId = ref(null);
                // i18n loads asynchronously; bumping this after `languagechange`
                // is what re-runs every t() in the template.
                const localeTick = ref(0);

                // --- config / status ---------------------------------------
                function applyConfig(payload) {
                    const cfg = (payload && payload.config) || payload || {};
                    if (cfg.widgets) config.widgets = cfg.widgets;
                    if (typeof cfg.opacity === 'number') config.opacity = cfg.opacity;
                    if (typeof cfg.scale === 'number') config.scale = cfg.scale;
                    if (cfg.hotkey) config.hotkey = cfg.hotkey;
                    if (cfg.mute_hotkey) config.mute_hotkey = cfg.mute_hotkey;
                    if (typeof cfg.notification_seconds === 'number') {
                        config.notification_seconds = cfg.notification_seconds;
                    }
                    const status = payload && payload.status;
                    if (status && typeof status.interactive === 'boolean') {
                        interactive.value = status.interactive;
                    }
                }
                inbox.onConfig = applyConfig;
                inbox.onInteractive = (value) => { interactive.value = !!value; };
                inbox.onMuted = () => { /* the window is hidden by the tracker; nothing to draw */ };
                inbox.onViewport = () => { /* fractional layout: nothing to recompute */ };

                // --- rendering ---------------------------------------------
                const rootStyle = computed(() => ({
                    '--ov-alpha': String(config.opacity),
                    '--ov-scale': String(config.scale),
                }));

                function placement(widget) {
                    const anchor = widget.anchor || 'top-left';
                    const x = `${(widget.x || 0) * 100}%`;
                    const y = `${(widget.y || 0) * 100}%`;
                    const style = {
                        '--ov-w-scale': String((widget.scale || 1) * (config.scale || 1)),
                    };
                    style[anchor.endsWith('left') ? 'left' : 'right'] = x;
                    style[anchor.startsWith('top') ? 'top' : 'bottom'] = y;
                    return { anchor, style };
                }

                // Everything except the notification stack, which has its own
                // container. Order is stable (catalog order) so a re-render
                // never reshuffles the DOM.
                const placedWidgets = computed(() => Object.entries(config.widgets)
                    .filter(([id, w]) => id !== 'notifications' && w && w.enabled)
                    .map(([id, w]) => Object.assign({ id }, placement(w), { raw: w })));

                const notesEnabled = computed(() => {
                    const w = config.widgets.notifications;
                    return !!(w && w.enabled);
                });
                const notesPlacement = computed(() =>
                    placement(config.widgets.notifications || { anchor: 'bottom-right', x: 0.012, y: 0.02 }));

                const clock = computed(() => {
                    localeTick.value;
                    const offset = (snap.value.server_offset_seconds || 0) * 1000;
                    const d = new Date(now.value + offset);
                    // The offset already shifts the instant, so the UTC getters
                    // read out Trove time regardless of the player's timezone.
                    return {
                        time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
                        date: d.toLocaleDateString(undefined, {
                            weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
                        }),
                    };
                });

                const merchantRows = computed(() => {
                    localeTick.value;
                    const m = snap.value.merchants || {};
                    const fluxState = m.fluxion && m.fluxion.state;
                    const fluxLabel = fluxState === 'voting' ? t('overlay.fluxion_voting')
                        : fluxState === 'selling' ? t('overlay.fluxion_selling')
                        : t('overlay.fluxion');
                    return [
                        { key: 'corruxion', label: t('overlay.corruxion'), active: !!(m.corruxion && m.corruxion.active), until: m.corruxion && m.corruxion.until },
                        { key: 'fluxion', label: fluxLabel, active: !!(m.fluxion && m.fluxion.active), until: m.fluxion && m.fluxion.until },
                        { key: 'invasion', label: t('overlay.luxion_trials'), active: !!(m.invasion && m.invasion.active), until: m.invasion && m.invasion.until },
                    ];
                });

                const gardenRows = computed(() => {
                    localeTick.value;
                    const g = snap.value.gardening || {};
                    return [
                        { key: 'two', label: t('overlay.plants_2day'), active: !!(g.two_day && g.two_day.active), until: g.two_day && (g.two_day.active ? g.two_day.end : g.two_day.start) },
                        { key: 'three', label: t('overlay.plants_3day'), active: !!(g.three_day && g.three_day.active), until: g.three_day && (g.three_day.active ? g.three_day.end : g.three_day.start) },
                    ];
                });

                const stampyUntil = computed(() => {
                    const s = snap.value.rotations && snap.value.rotations.stampy;
                    if (!s) return null;
                    return s.active ? s.end : s.start;
                });

                const hotkeyLabel = computed(() => String(config.hotkey || '')
                    .split('+').map(p => p.length === 1 ? p.toUpperCase() : (p.charAt(0).toUpperCase() + p.slice(1)))
                    .join('+'));

                function until(target) {
                    return formatUntil(target, now.value);
                }
                // Amber inside the last 30 minutes: the point at which "later"
                // becomes "now or you miss it".
                function urgency(target) {
                    if (!target) return '';
                    const left = target * 1000 - now.value;
                    if (left <= 0) return 'is-live';
                    return left <= 30 * 60 * 1000 ? 'is-soon' : '';
                }

                // --- notifications -----------------------------------------
                function pushNote(payload) {
                    if (!payload || !payload.title) return;
                    const seconds = Math.max(3, Number(payload.seconds) || config.notification_seconds);
                    const note = reactive({
                        id: payload.id || `n${Date.now()}`,
                        title: String(payload.title),
                        message: String(payload.message || ''),
                        expires: Date.now() + seconds * 1000,
                        total: seconds * 1000,
                        life: 1,
                    });
                    notes.value = notes.value.concat(note).slice(-4);
                }
                inbox.onNotification = pushNote;
                inbox.pendingNotifications.splice(0).forEach(pushNote);

                function dismiss(id) {
                    notes.value = notes.value.filter(n => n.id !== id);
                }

                // --- interactive mode --------------------------------------
                function lock() {
                    if (hasEel()) window.eel.overlay_set_interactive(false)();
                    interactive.value = false;
                }
                function mute() {
                    if (hasEel()) window.eel.overlay_set_muted(true)();
                }

                // Drag-to-place, in-game. Same write path as the editor's canvas
                // (`overlay_move_widget`), so a widget dragged here is where the
                // editor shows it and vice versa.
                let drag = null;
                function startDrag(event, widget) {
                    if (!interactive.value || event.button !== 0) return;
                    const box = event.currentTarget.getBoundingClientRect();
                    drag = {
                        id: widget.id,
                        anchor: widget.anchor,
                        grabX: event.clientX - box.left,
                        grabY: event.clientY - box.top,
                        width: box.width,
                        height: box.height,
                    };
                    dragId.value = widget.id;
                    // Capture keeps the drag alive if the pointer outruns the
                    // widget; the window-level move/up listeners are what make
                    // it work either way, so a refused capture is not fatal.
                    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) { /* non-fatal */ }
                    event.preventDefault();
                }

                function onMove(event) {
                    if (!drag) return;
                    const vw = window.innerWidth || 1;
                    const vh = window.innerHeight || 1;
                    const left = event.clientX - drag.grabX;
                    const top = event.clientY - drag.grabY;
                    // Re-pick the anchor from which half of the screen the widget
                    // now sits in, so a widget dragged to the right edge stays
                    // pinned to the right when the game window resizes.
                    const anchor = (top + drag.height / 2 < vh / 2 ? 'top' : 'bottom')
                        + '-' + (left + drag.width / 2 < vw / 2 ? 'left' : 'right');
                    const x = anchor.endsWith('left') ? left / vw : (vw - left - drag.width) / vw;
                    const y = anchor.startsWith('top') ? top / vh : (vh - top - drag.height) / vh;

                    const clamp = (v) => Math.min(0.95, Math.max(0, v));
                    const widget = config.widgets[drag.id];
                    if (widget) {
                        widget.anchor = anchor;
                        widget.x = clamp(x);
                        widget.y = clamp(y);
                    }
                    drag.anchor = anchor;
                }

                function endDrag() {
                    if (!drag) return;
                    const widget = config.widgets[drag.id];
                    if (widget && hasEel()) {
                        window.eel.overlay_move_widget(drag.id, widget.anchor, widget.x, widget.y)();
                    }
                    drag = null;
                    dragId.value = null;
                }

                // --- boot ---------------------------------------------------
                async function refreshSnapshot() {
                    if (!hasEel()) return;
                    try {
                        const res = await window.eel.overlay_get_snapshot()();
                        if (res && res.success && res.data) snap.value = res.data;
                    } catch (e) { /* keep the last good snapshot */ }
                }

                async function loadAccent() {
                    if (!hasEel() || !window.applyAccentColor) return;
                    try {
                        // include_games=false: the overlay needs the accent, not a
                        // registry scan for game installs.
                        const res = await window.eel.get_settings(false)();
                        const data = (res && res.data) || {};
                        if (data.accent_color) window.applyAccentColor(data.accent_color);
                    } catch (e) { /* default accent is fine */ }
                }

                onMounted(async () => {
                    if (inbox.config) applyConfig(inbox.config);

                    window.addEventListener('pointermove', onMove);
                    window.addEventListener('pointerup', endDrag);
                    window.addEventListener('pointercancel', endDrag);
                    window.addEventListener('languagechange', () => { localeTick.value++; });

                    await loadAccent();
                    // Announce first: page_ready kicks the backend's network
                    // warm-up, so the snapshot we ask for next is more likely to
                    // already carry the chaos-chest item and the events list.
                    if (hasEel()) {
                        try {
                            const res = await window.eel.overlay_page_ready()();
                            if (res && res.data) applyConfig(res.data);
                        } catch (e) { /* the tracker pushes config on show anyway */ }
                    }
                    await refreshSnapshot();
                    // One early re-read to close the remaining race: if the warm
                    // -up fetch lands a moment after the first snapshot, those two
                    // widgets would otherwise read "needs network" for a full
                    // minute and look broken rather than pending.
                    setTimeout(refreshSnapshot, 4000);

                    // One 1Hz heartbeat drives every countdown, the clock, and
                    // notification expiry. A second timer per widget would be the
                    // easy way to make an overlay expensive.
                    setInterval(() => {
                        const stamp = Date.now();
                        now.value = stamp;
                        if (notes.value.length) {
                            let expired = false;
                            for (const note of notes.value) {
                                note.life = Math.max(0, (note.expires - stamp) / note.total);
                                if (note.expires <= stamp) expired = true;
                            }
                            if (expired) notes.value = notes.value.filter(n => n.expires > stamp);
                        }
                    }, 1000);

                    // Absolute timestamps mean the data only has to be re-read
                    // when a rotation actually rolls over, not to keep a clock
                    // moving. A minute is generous.
                    setInterval(refreshSnapshot, 60 * 1000);
                });

                return {
                    t, snap, config, interactive, notes, dragId,
                    rootStyle, placedWidgets, notesEnabled, notesPlacement,
                    clock, merchantRows, gardenRows, stampyUntil, hotkeyLabel,
                    until, urgency, hexColor, dismiss, lock, mute, startDrag,
                };
            },
        }).mount('#overlay-app');
    });
})();
