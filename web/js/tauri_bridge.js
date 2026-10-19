/* Desktop bridge: the `eel` object eel.js used to provide, carried over Tauri IPC.
   `eel.<name>(...args)()` runs a btt_core endpoint; functions registered with
   `eel.expose(fn, name)` are what the backend calls back into. Does nothing outside
   the desktop app (Android and plain web builds fall through to js/web_mode.js). */
(function () {
    'use strict';
    const tauri = window.__TAURI__;
    if (!tauri || !tauri.core || !tauri.event) return;
    const { invoke, convertFileSrc } = tauri.core;

    const exposed = {};
    const kept = new Map();

    const eel = {
        expose(fn, name) {
            if (name === undefined) name = fn.name;
            exposed[name] = fn;
        },
        _exposed_functions: exposed,
    };

    (window.__BTT_COMMANDS__ || []).forEach((name) => {
        eel[name] = function () {
            const args = Array.prototype.map.call(arguments, (v) => (v === undefined ? null : v));
            const promise = invoke('eel_call', { name, args });
            return function (callback = null) {
                if (callback != null) {
                    promise.then(callback, (err) => console.error(`[eel] ${name} failed:`, err));
                    return undefined;
                }
                return promise;
            };
        };
    });
    window.eel = eel;

    // An argument {"$rid": id} stands for the value an earlier call was told to keep.
    const resolveKept = (value) => {
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && '$rid' in value) {
            const kept_value = kept.get(value.$rid);
            kept.delete(value.$rid);
            return kept_value;
        }
        return value;
    };

    tauri.event.listen('btt:js-call', (event) => {
        const { name, args, keep } = event.payload || {};
        const fn = exposed[name];
        if (typeof fn !== 'function') return;
        try {
            const value = fn(...(args || []).map(resolveKept));
            if (keep) kept.set(keep, value);
        } catch (err) {
            console.error(`[eel] page function ${name} failed:`, err);
        }
    }).then(() => invoke('eel_ready'));

    // The Kiwi API's CORS allowlist doesn't include this page's origin, so the page's
    // BTT_Kiwi calls (update checks, About, feedback) go through the backend instead.
    const KIWI_BASE = 'https://api.aallyn.net/v1';
    const kiwiResult = (res) => {
        let data = null;
        try { data = res.body ? JSON.parse(res.body) : null; } catch { data = res.body; }
        if (res.status < 200 || res.status >= 300) {
            const err = new Error(`HTTP ${res.status}`);
            err.status = res.status;
            err.data = data;
            throw err;
        }
        return data;
    };
    const fileToBase64 = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
    window.BTT_Kiwi = {
        base: KIWI_BASE,
        get: async (path) => kiwiResult(await invoke('eel_call', { name: 'kiwi_request', args: ['GET', path, null, null] })),
        post: async (path, body) => {
            let payload = { json: body };
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                const form = [];
                for (const [name, value] of body.entries()) {
                    if (typeof Blob !== 'undefined' && value instanceof Blob) {
                        form.push({ name, filename: value.name || 'file', content_type: value.type || '', data_b64: await fileToBase64(value) });
                    } else {
                        form.push({ name, value: String(value) });
                    }
                }
                payload = { form };
            }
            return kiwiResult(await invoke('eel_call', { name: 'kiwi_request', args: ['POST', path, payload, null] }));
        },
    };

    // bottle served /api/* and /proxy/* on the page's own origin; they now live on a
    // custom scheme, so same-origin fetches to those paths are pointed there.
    const origin = convertFileSrc('', window.__BTT_BACKEND_SCHEME__ || 'bttapi').replace(/\/+$/, '');
    window.BTT_BACKEND_ORIGIN = origin;
    const isBackendPath = (path) => /^\/(api|proxy)\//.test(path);
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        if (typeof input === 'string' && isBackendPath(input)) {
            input = origin + input;
        } else if (input instanceof URL && input.origin === location.origin && isBackendPath(input.pathname)) {
            input = origin + input.pathname + input.search;
        } else if (typeof Request !== 'undefined' && input instanceof Request) {
            const url = new URL(input.url);
            if (url.origin === location.origin && isBackendPath(url.pathname)) {
                input = new Request(origin + url.pathname + url.search, input);
            }
        }
        return nativeFetch(input, init);
    };
})();
