/**
 * Live feed — one place every view learns that something changed.
 *
 * Desktop: the Python backend (backend/live_feed.py) holds a single SSE
 * connection to the API and pushes each frame in through `receive_live_event`.
 * Web build: the browser opens the same stream itself with EventSource.
 *
 * Views fetch once when they mount and then subscribe, instead of re-polling on
 * a timer. `LiveFeed.on(type, handler)` returns an unsubscribe function, `'*'`
 * subscribes to every type, and `LiveFeed.last(type)` is the most recent payload
 * — the server opens each connection with a snapshot of current state, so a view
 * that mounts late still has something to read without waiting for a push.
 */
(function () {
    const STREAM_URL = 'https://api.aallyn.net/v1/events/stream';

    // Every type the stream emits. Named explicitly because EventSource
    // dispatches by event name — an unlisted type would arrive nowhere.
    const EVENT_TYPES = [
        'challenge', 'chaos', 'corruxion', 'fluxion', 'longshade', 'wild_mana',
        'stampy', 'daily_bonuses', 'activity', 'server_status', 'trove_news',
        'giveaways', 'game_update'
    ];

    const handlers = new Map();     // type -> Set<handler>
    const lastByType = new Map();

    const state = { connected: false };

    const emit = (type, data) => {
        for (const key of [type, '*']) {
            const set = handlers.get(key);
            if (!set) continue;
            for (const handler of Array.from(set)) {
                try {
                    handler(data, type);
                } catch (err) {
                    console.error(`[LiveFeed] handler for "${type}" failed`, err);
                }
            }
        }
    };

    const setConnected = (connected) => {
        if (state.connected === connected) return;
        state.connected = connected;
        document.dispatchEvent(new CustomEvent('live_feed_status', { detail: { connected } }));
    };

    const ingest = (type, data) => {
        if (type === '_status') {
            setConnected(!!(data && data.connected));
            return;
        }
        if (!data || typeof data !== 'object') return;
        lastByType.set(type, data);
        emit(type, data);
    };

    window.LiveFeed = {
        get connected() { return state.connected; },
        last(type) { return type ? lastByType.get(type) || null : Object.fromEntries(lastByType); },
        on(type, handler) {
            if (typeof handler !== 'function') return () => {};
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type).add(handler);
            return () => {
                const set = handlers.get(type);
                if (set) set.delete(handler);
            };
        }
    };

    // --- desktop: frames arrive from the Python backend ---------------------
    const hasEelBridge = !!window.eel && typeof window.eel.expose === 'function' && !window.BTT_WEB_MODE;
    if (hasEelBridge) {
        window.receive_live_event = (type, data) => ingest(type, data);
        eel.expose(window.receive_live_event, 'receive_live_event');

        // A page reload drops everything this module knew while the backend's
        // connection kept running, so seed from its snapshot rather than waiting
        // for the next push (chaos moves weekly — that could be days).
        document.addEventListener('DOMContentLoaded', async () => {
            try {
                const response = await eel.get_live_feed_status()();
                const data = (response && (response.data || response)) || {};
                setConnected(!!data.connected);
                Object.entries(data.events || {}).forEach(([type, payload]) => ingest(type, payload));
            } catch (err) {
                /* backend not up yet — the first real push seeds us instead */
            }
        });
        return;
    }

    // --- web build: connect straight to the stream --------------------------
    // EventSource reconnects on its own; nothing to schedule here.
    if (typeof EventSource !== 'function') return;
    let source = null;
    const connect = () => {
        source = new EventSource(STREAM_URL);
        source.onopen = () => setConnected(true);
        source.onerror = () => setConnected(false);
        EVENT_TYPES.forEach((type) => {
            source.addEventListener(type, (event) => {
                try {
                    const payload = JSON.parse(event.data);
                    ingest(type, payload && payload.data);
                } catch (err) {
                    /* malformed frame — skip it */
                }
            });
        });
    };
    document.addEventListener('DOMContentLoaded', connect);
})();
