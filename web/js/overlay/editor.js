// Overlay editor — the "Overlay" tab inside the Trove view.
//
// Exposed as a factory rather than its own Vue app because it shares the Trove
// view's single root: `trove.js` calls `window.BTTOverlayEditor(Vue)` and
// spreads the result into its own setup() return. Keeping it in its own file
// keeps the launcher's state and the overlay's from growing into one 900-line
// setup block.
//
// The editor writes the same config the overlay window reads, through the same
// two endpoints the in-game drag uses (`overlay_save_config` for settings,
// `overlay_move_widget` for a position). There is no second source of truth: a
// widget dragged in-game moves on this canvas and vice versa.

window.BTTOverlayEditor = function (Vue) {
    const { ref, reactive, computed, onUnmounted } = Vue;
    const hasEel = () => !!window.eel;
    const t = (token, params) => (window.I18nManager && window.I18nManager.t)
        ? window.I18nManager.t(token, params) : token;

    // Windows-only, desktop-only. `supported` stays false in web/Android mode
    // (no eel at all) and on Linux (the backend reports it), and the tab is
    // hidden outright in both cases rather than shown disabled — an option you
    // can see but never use is worse than one that isn't offered.
    const supported = ref(false);
    const loaded = ref(false);
    const saving = ref(false);
    const status = reactive({
        running: false, visible: false, muted: false, interactive: false,
        fullscreen_risk: false, in_menu: false, hotkeys: {},
    });
    const config = reactive({
        enabled: false,
        hotkey: 'ctrl+alt+o',
        mute_hotkey: 'ctrl+alt+h',
        opacity: 0.92,
        scale: 1,
        hide_when_unfocused: true,
        hide_inactive: false,
        prevent_overlap: true,
        hide_from_capture: false,
        text_color: '',
        panel_color: '',
        notifications_in_overlay: true,
        notification_seconds: 12,
        widgets: {},
    });
    // Catalog order is the backend's, so the editor list and the overlay's
    // render order never disagree.
    const catalog = ref([]);
    const capturing = ref('');   // which hotkey field is listening, '' when idle
    const dragId = ref(null);
    const canvas = ref(null);

    let statusTimer = null;
    let saveTimer = null;

    function applyPayload(data) {
        if (!data) return;
        if (typeof data.supported === 'boolean') supported.value = data.supported;
        if (Array.isArray(data.catalog)) catalog.value = data.catalog;
        if (data.config) Object.assign(config, data.config);
        if (data.status) Object.assign(status, data.status);
    }

    async function load() {
        if (!hasEel()) { supported.value = false; loaded.value = true; return; }
        try {
            const res = await window.callBackend(window.eel.overlay_get_config()(), 'overlay');
            if (res.success) applyPayload(res.data);
        } catch (e) { supported.value = false; }
        loaded.value = true;
    }

    async function refreshStatus() {
        if (!hasEel() || !supported.value) return;
        try {
            const res = await window.eel.overlay_status()();
            if (res && res.success) applyPayload(res.data);
        } catch (e) { /* transient */ }
    }

    // The tracker's state changes on its own (game launched, alt-tabbed, hotkey
    // pressed), so the tab polls while it is on screen. 2s is fast enough to
    // feel live and slow enough to be free.
    function startStatusPolling() {
        stopStatusPolling();
        if (!supported.value) return;
        refreshStatus();
        statusTimer = setInterval(refreshStatus, 2000);
    }
    function stopStatusPolling() {
        if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    }

    async function saveNow() {
        if (!hasEel() || !supported.value) return;
        saving.value = true;
        try {
            const res = await window.callBackend(
                window.eel.overlay_save_config(JSON.parse(JSON.stringify(config)))(), 'overlay');
            if (res.success) applyPayload(res.data);
            else if (window.showToast) window.showToast(res.error || t('overlay.save_failed'), true);
        } catch (e) {
            if (window.showToast) window.showToast(t('overlay.save_failed'), true);
        }
        saving.value = false;
    }

    // Sliders fire continuously; coalesce so dragging opacity doesn't rewrite
    // the config file (and rebind both global hotkeys) sixty times.
    function save() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(saveNow, 250);
    }

    async function setEnabled(value) {
        config.enabled = !!value;
        await saveNow();
        startStatusPolling();
    }

    function toggleWidget(id) {
        const widget = config.widgets[id];
        if (!widget) return;
        widget.enabled = !widget.enabled;
        save();
    }

    // Short form for widgets that offer one (only the bonuses panel today).
    const widgetCollapsed = (id) => !!(config.widgets[id] || {}).collapsed;

    function toggleWidgetCollapsed(id) {
        const widget = config.widgets[id];
        if (!widget) return;
        widget.collapsed = !widget.collapsed;
        saveNow();
    }

    // Colours. "" in the config means "use the app's own", but <input
    // type=color> has no empty state, so the picker shows the default it would
    // otherwise draw with while the config stays blank until you pick one.
    const COLOR_FALLBACK = { text_color: '#e0e0e0', panel_color: '#1e1e1e' };
    const overlayColor = (key) => config[key] || COLOR_FALLBACK[key];

    function setOverlayColor(key, value) {
        config[key] = value;
        save();
    }

    function resetOverlayColors() {
        config.text_color = '';
        config.panel_color = '';
        saveNow();
    }

    // Sections inside one widget (the biome panel's three rotations).
    const widgetSection = (id, name) => {
        const sections = (config.widgets[id] || {}).sections || {};
        return sections[name] !== false;
    };

    function toggleSection(id, name) {
        const widget = config.widgets[id];
        if (!widget || !widget.sections) return;
        widget.sections[name] = !widgetSection(id, name);
        saveNow();
    }

    async function setMuted(value) {
        if (!hasEel()) return;
        try {
            await window.eel.overlay_set_muted(!!value)();
            status.muted = !!value;
        } catch (e) { /* status poll will correct it */ }
    }

    // --- hotkey capture ---------------------------------------------------

    const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

    // Every binding currently in use, so a capture can reject a duplicate
    // before it reaches the backend (which would silently drop it).
    function boundSpecs(exceptField) {
        const out = [];
        if (exceptField !== 'hotkey' && config.hotkey) out.push(config.hotkey);
        if (exceptField !== 'mute_hotkey' && config.mute_hotkey) out.push(config.mute_hotkey);
        for (const [id, widget] of Object.entries(config.widgets || {})) {
            if (exceptField === `widget:${id}`) continue;
            if (widget && widget.hotkey) out.push(widget.hotkey);
        }
        return out.map(s => String(s).toLowerCase().replace(/\s+/g, ''));
    }

    function onCaptureKey(event) {
        if (!capturing.value) return;
        event.preventDefault();
        event.stopPropagation();

        if (event.key === 'Escape') { capturing.value = ''; return; }
        if (MODIFIER_KEYS.has(event.key)) return;  // wait for the real key

        const parts = [];
        if (event.ctrlKey) parts.push('ctrl');
        if (event.altKey) parts.push('alt');
        if (event.shiftKey) parts.push('shift');
        if (event.metaKey) parts.push('win');
        // A bare key would be registered globally and swallowed everywhere in
        // Windows, including Trove's own chat box.
        if (!parts.length) {
            if (window.showToast) window.showToast(t('overlay.hotkey_needs_modifier'), true);
            return;
        }

        parts.push(event.key.toLowerCase());
        const spec = parts.join('+');

        const field = capturing.value;
        if (boundSpecs(field).includes(spec.toLowerCase())) {
            if (window.showToast) window.showToast(t('overlay.hotkey_in_use'), true);
            return;
        }

        if (field.startsWith('widget:')) {
            const widget = config.widgets[field.slice(7)];
            if (widget) widget.hotkey = spec;
        } else {
            config[field] = spec;
        }
        capturing.value = '';
        saveNow();
    }

    const widgetHotkey = (id) => (config.widgets[id] || {}).hotkey || '';

    function clearWidgetHotkey(id) {
        const widget = config.widgets[id];
        if (!widget || !widget.hotkey) return;
        widget.hotkey = '';
        if (capturing.value === `widget:${id}`) capturing.value = '';
        saveNow();
    }

    function startCapture(field) {
        capturing.value = capturing.value === field ? '' : field;
    }

    function prettyHotkey(spec) {
        return String(spec || '').split('+')
            .map(p => (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
            .join(' + ');
    }

    // A binding the OS refused (another app owns that combination). Reported
    // per-key so one clash doesn't cast doubt on the other.
    const hotkeyFailed = (action) => status.hotkeys && status.hotkeys[action] === false;

    // --- layout canvas ----------------------------------------------------

    // Chips carry the widget's name, not its live data: at canvas scale the
    // real widget would be unreadable, and what is being edited here is
    // position, not content.
    const placedChips = computed(() => catalog.value
        .map(entry => ({ id: entry.id, widget: config.widgets[entry.id] }))
        .filter(item => item.widget && item.widget.enabled)
        .map(item => {
            const w = item.widget;
            const style = {};
            style[w.anchor.endsWith('left') ? 'left' : 'right'] = `${w.x * 100}%`;
            style[w.anchor.startsWith('top') ? 'top' : 'bottom'] = `${w.y * 100}%`;
            return { id: item.id, anchor: w.anchor, style };
        }));

    let drag = null;

    // --- snapping on the layout canvas -------------------------------------
    //
    // Mirrors the in-game drag (utils/overlay_window.py): same candidates, same
    // ranking, same Ctrl escape hatch, so a layout arranged here behaves like
    // one arranged over the game.
    const SNAP_PX = 6;
    const snapGuides = ref({ x: [], y: [] });

    // Returns [position, guideCoordinate|null]. Each candidate carries the
    // offset from the leading edge to whichever edge did the aligning, so the
    // guide is drawn on the edge that actually matched.
    function snapAxis(value, size, others, extent) {
        const candidates = [
            [0, 0, 0],
            [0, extent - size, size],
            [1, (extent - size) / 2, size / 2],
        ];
        for (const [pos, otherSize] of others) {
            candidates.push([0, pos, 0]);                               // leading edges
            candidates.push([0, pos + otherSize - size, size]);         // trailing edges
            candidates.push([0, pos + otherSize, 0]);                   // sits after
            candidates.push([0, pos - size, size]);                     // sits before
            candidates.push([1, pos + (otherSize - size) / 2, size / 2]); // centres
        }
        let best = null;
        for (const [rank, pos, offset] of candidates) {
            const gap = Math.abs(pos - value);
            if (gap > SNAP_PX) continue;
            if (!best || rank < best[0] || (rank === best[0] && gap < best[1])) {
                best = [rank, gap, pos, offset];
            }
        }
        return best ? [best[2], best[2] + best[3]] : [value, null];
    }

    // The canvas measured as chips actually see it. getBoundingClientRect gives
    // the BORDER box, but absolutely-positioned children resolve against the
    // PADDING box, so mixing the two drifts a widget by the border width and
    // leaves a guide sitting next to the chip instead of on it.
    function canvasFrame() {
        const el = canvas.value;
        const box = el.getBoundingClientRect();
        return {
            left: box.left + el.clientLeft,
            top: box.top + el.clientTop,
            width: el.clientWidth,
            height: el.clientHeight,
        };
    }

    // Every other chip's box, in canvas-relative pixels.
    function neighbourRects(frame, exceptId) {
        if (!canvas.value) return [];
        return [...canvas.value.querySelectorAll('.ov-ed-chip')]
            .filter(el => el.dataset.id !== exceptId)
            .map(el => {
                const b = el.getBoundingClientRect();
                return { x: b.left - frame.left, y: b.top - frame.top,
                         w: b.width, h: b.height };
            });
    }

    function startChipDrag(event, chip) {
        if (event.button !== 0) return;
        const box = event.currentTarget.getBoundingClientRect();
        drag = {
            id: chip.id,
            grabX: event.clientX - box.left,
            grabY: event.clientY - box.top,
            width: box.width,
            height: box.height,
        };
        dragId.value = chip.id;
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch (e) { /* non-fatal */ }
        event.preventDefault();
    }

    function onChipMove(event) {
        if (!drag || !canvas.value) return;
        const frame = canvasFrame();
        let left = event.clientX - frame.left - drag.grabX;
        let top = event.clientY - frame.top - drag.grabY;

        // Snap live against the other chips and the canvas edges, showing the
        // line it locked onto. Ctrl drops it exactly where the cursor is.
        if (event.ctrlKey) {
            snapGuides.value = { x: [], y: [] };
        } else {
            const others = neighbourRects(frame, drag.id);
            const [sx, gx] = snapAxis(left, drag.width,
                others.map(r => [r.x, r.w]), frame.width);
            const [sy, gy] = snapAxis(top, drag.height,
                others.map(r => [r.y, r.h]), frame.height);
            left = sx;
            top = sy;
            snapGuides.value = { x: gx === null ? [] : [gx], y: gy === null ? [] : [gy] };
        }

        // Same anchor rule as the in-game drag: whichever quadrant the chip's
        // centre lands in decides which two edges it measures from, so a widget
        // parked at the right edge stays there when the game window resizes.
        const anchor = (top + drag.height / 2 < frame.height / 2 ? 'top' : 'bottom')
            + '-' + (left + drag.width / 2 < frame.width / 2 ? 'left' : 'right');
        const x = anchor.endsWith('left') ? left / frame.width : (frame.width - left - drag.width) / frame.width;
        const y = anchor.startsWith('top') ? top / frame.height : (frame.height - top - drag.height) / frame.height;

        const clamp = (v) => Math.min(0.95, Math.max(0, v));
        const widget = config.widgets[drag.id];
        if (!widget) return;
        widget.anchor = anchor;
        widget.x = clamp(x);
        widget.y = clamp(y);
    }

    function endChipDrag() {
        if (!drag) return;
        const widget = config.widgets[drag.id];
        const id = drag.id;
        drag = null;
        dragId.value = null;
        snapGuides.value = { x: [], y: [] };
        if (widget && hasEel()) {
            window.eel.overlay_move_widget(id, widget.anchor, widget.x, widget.y)();
        }
    }

    async function resetLayout() {
        if (!hasEel()) return;
        const confirmed = window.showConfirmModal
            ? await window.showConfirmModal({
                title: t('overlay.reset_layout'),
                message: t('overlay.reset_layout_confirm'),
                confirmLabel: t('overlay.reset_layout'),
                danger: false,
            })
            : true;
        if (!confirmed) return;
        // Dropping the widget map makes the backend re-seed every widget from
        // its shipped default, which is exactly what "reset layout" means.
        const payload = JSON.parse(JSON.stringify(config));
        payload.widgets = {};
        try {
            const res = await window.callBackend(window.eel.overlay_save_config(payload)(), 'overlay');
            if (res.success) applyPayload(res.data);
        } catch (e) { /* toast handled by callBackend */ }
    }

    window.addEventListener('keydown', onCaptureKey, true);
    window.addEventListener('pointermove', onChipMove);
    window.addEventListener('pointerup', endChipDrag);
    window.addEventListener('pointercancel', endChipDrag);

    onUnmounted(() => {
        stopStatusPolling();
        if (saveTimer) clearTimeout(saveTimer);
        window.removeEventListener('keydown', onCaptureKey, true);
        window.removeEventListener('pointermove', onChipMove);
        window.removeEventListener('pointerup', endChipDrag);
        window.removeEventListener('pointercancel', endChipDrag);
    });

    // A one-line summary of what the overlay is doing right now, so the user
    // never has to guess why they can't see it.
    const statusLine = computed(() => {
        if (!config.enabled) return t('overlay.status_off');
        if (status.muted) return t('overlay.status_muted');
        if (!status.running) return t('overlay.status_waiting');
        if (status.visible) return t('overlay.status_visible');
        // Distinguish the two reasons it can be hidden while the game runs,
        // otherwise "hidden" looks like a bug rather than the setting working.
        if (status.in_menu) return t('overlay.status_in_menu');
        return t('overlay.status_hidden');
    });

    return {
        overlaySupported: supported,
        overlayLoaded: loaded,
        overlaySaving: saving,
        overlayStatus: status,
        overlayConfig: config,
        overlayCatalog: catalog,
        overlayCapturing: capturing,
        overlayDragId: dragId,
        overlayCanvas: canvas,
        overlayChips: placedChips,
        overlaySnapGuides: snapGuides,
        overlayStatusLine: statusLine,
        overlayHotkeyFailed: hotkeyFailed,
        overlayPretty: prettyHotkey,
        widgetHotkey,
        widgetCollapsed,
        overlayColor,
        setOverlayColor,
        resetOverlayColors,
        widgetSection,
        toggleOverlaySection: toggleSection,
        toggleOverlayWidgetCollapsed: toggleWidgetCollapsed,
        clearOverlayWidgetHotkey: clearWidgetHotkey,
        loadOverlay: load,
        saveOverlay: save,
        saveOverlayNow: saveNow,
        setOverlayEnabled: setEnabled,
        toggleOverlayWidget: toggleWidget,
        setOverlayMuted: setMuted,
        startOverlayCapture: startCapture,
        startOverlayChipDrag: startChipDrag,
        resetOverlayLayout: resetLayout,
        startOverlayPolling: startStatusPolling,
        stopOverlayPolling: stopStatusPolling,
    };
};
