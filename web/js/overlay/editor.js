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
        fullscreen_risk: false, hotkeys: {},
    });
    const config = reactive({
        enabled: false,
        hotkey: 'ctrl+alt+o',
        mute_hotkey: 'ctrl+alt+h',
        opacity: 0.92,
        scale: 1,
        hide_when_unfocused: true,
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

    async function setMuted(value) {
        if (!hasEel()) return;
        try {
            await window.eel.overlay_set_muted(!!value)();
            status.muted = !!value;
        } catch (e) { /* status poll will correct it */ }
    }

    // --- hotkey capture ---------------------------------------------------

    const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

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

        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
        parts.push(key);
        const spec = parts.join('+');

        const field = capturing.value;
        const other = field === 'hotkey' ? config.mute_hotkey : config.hotkey;
        if (spec === other) {
            if (window.showToast) window.showToast(t('overlay.hotkey_in_use'), true);
            return;
        }
        config[field] = spec;
        capturing.value = '';
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
        const frame = canvas.value.getBoundingClientRect();
        const left = event.clientX - frame.left - drag.grabX;
        const top = event.clientY - frame.top - drag.grabY;

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
        overlayStatusLine: statusLine,
        overlayHotkeyFailed: hotkeyFailed,
        overlayPretty: prettyHotkey,
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
