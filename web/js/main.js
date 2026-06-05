// Browser shortcuts (devtools, refresh, etc.) are only blocked in the packaged
// build. In dev (running from source) and hosted web mode they stay enabled, so
// there's no need to comment this out by hand while developing. The backend
// reports dev_mode via get_system_info (sys.frozen); until that resolves we
// assume dev and block nothing.
window.BTT_IS_COMPILED = false;
// BTT_DEV_MODE is the POSITIVE dev signal used to gate dev-only conveniences
// like auto-populating missing translation keys. Unlike BTT_IS_COMPILED (which
// defaults to "dev" so we never accidentally block shortcuts), this defaults to
// false and only flips true once the backend confirms we're running from source
// AND we're not in hosted web mode. That way the missing-translation capture is
// strictly off everywhere except the developer's source build.
window.BTT_DEV_MODE = false;
(async () => {
    try {
        if (window.eel && eel.get_system_info) {
            const info = await eel.get_system_info()();
            const devMode = info && (info.dev_mode ?? (info.data && info.data.dev_mode));
            window.BTT_IS_COMPILED = devMode === false;
            window.BTT_DEV_MODE = devMode === true && window.BTT_WEB_MODE !== true;
        }
    } catch (e) {
        // Leave as dev (no blocking) if detection fails. BTT_DEV_MODE stays
        // false so the translation-capture convenience never runs on a guess.
    }
})();

document.addEventListener('keydown', function(e) {
    if (!window.BTT_IS_COMPILED) return;
    const blockedKeys = ['F12', 'F5', 'F11'];
    const blockedCtrlKeys = ['t', 'n', 'w', 'r', 'p', 's', 'o', 'j', 'd', 'u', 'h'];
    const blockedCtrlShiftKeys = ['i', 'j', 'c'];

    if (blockedKeys.includes(e.key)) e.preventDefault();
    if (e.ctrlKey && blockedCtrlKeys.includes(e.key.toLowerCase())) e.preventDefault();
    if (e.ctrlKey && e.shiftKey && blockedCtrlShiftKeys.includes(e.key.toLowerCase())) e.preventDefault();
});

document.addEventListener('contextmenu', (e) => e.preventDefault());

const globalTooltip = document.createElement('div');
globalTooltip.id = 'global-tooltip';
globalTooltip.style.cssText = 'position: fixed; background: var(--bg-panel, #1d232b); border: 1px solid var(--border-color, #444c5e); padding: 8px 12px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.7); pointer-events: none; z-index: 10010; display: none; color: #fff; font-size: 0.9em; line-height: 1.4; max-width: 450px;';
document.body.appendChild(globalTooltip);

const tooltipStyle = document.createElement('style');
tooltipStyle.innerHTML = `
    @keyframes tooltipFadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
    #global-tooltip { animation: tooltipFadeIn 0.15s ease-out; }
    #global-tooltip h3 { margin: 0 0 5px 0; color: var(--accent-blue, #5ec6ff); font-size: 1.1em; }
    #global-tooltip p { margin: 5px 0; color: var(--text-muted, #a3adc2); }
    #global-tooltip ul { margin: 5px 0; padding-left: 20px; }
    #global-tooltip hr { border: 0; border-top: 1px dashed var(--border-color, #444c5e); margin: 8px 0; }
    #global-tooltip .type { font-size: 0.8em; color: var(--text-muted, #a3adc2); text-transform: uppercase; font-weight: bold; }
    .clickable-log-url { transition: color 0.15s ease-in-out; }
    .clickable-log-url:hover { color: var(--text-main, #fff) !important; }
`;
document.head.appendChild(tooltipStyle);

// Feature flags
window.BTT_ENABLE_ONBOARDING_TOURS = false;

// --- Lazy script + stylesheet loader -----------------------------------
// View-specific JS modules are no longer loaded eagerly from index.html.
// `window.loadScript(src)` caches by src and dedupes concurrent requests,
// so each module is fetched/parsed at most once. `BTT_VIEW_SCRIPTS` maps
// the top-level views to the scripts that must be in place before the
// `<view>_loaded` event fires.
(function () {
    const scriptCache = new Map(); // absolute href -> Promise<void>
    const styleCache = new Map();

    const absolutize = (src) => new URL(src, document.baseURI).href;

    window.loadScript = function (src) {
        const href = absolutize(src);
        const cached = scriptCache.get(href);
        if (cached) return cached;

        const existing = document.querySelector(`script[src="${src}"], script[data-lazy-src="${href}"]`);
        if (existing) {
            const p = Promise.resolve();
            scriptCache.set(href, p);
            return p;
        }

        const promise = new Promise((resolve, reject) => {
            const el = document.createElement('script');
            el.src = src;
            el.async = false; // preserve evaluation order when several are queued together
            el.dataset.lazySrc = href;
            el.onload = () => resolve();
            el.onerror = () => {
                scriptCache.delete(href);
                reject(new Error(`Failed to load script: ${src}`));
            };
            document.head.appendChild(el);
        });
        scriptCache.set(href, promise);
        return promise;
    };

    window.loadScripts = function (srcs) {
        return Promise.all((srcs || []).map((s) => window.loadScript(s)));
    };

    window.loadStyle = function (href) {
        const abs = absolutize(href);
        const cached = styleCache.get(abs);
        if (cached) return cached;

        const promise = new Promise((resolve, reject) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            link.onload = () => resolve();
            link.onerror = () => {
                styleCache.delete(abs);
                reject(new Error(`Failed to load stylesheet: ${href}`));
            };
            document.head.appendChild(link);
        });
        styleCache.set(abs, promise);
        return promise;
    };
})();

// Map top-level views to the scripts they need. Anything that listens for a
// `<view>_loaded` event must be in here, otherwise the listener won't have
// attached by the time the event fires.
window.BTT_VIEW_SCRIPTS = {
    home: ['js/home.js'],
    mod_manager: ['js/mod_manager/index.js'],
    modder_tools: [
        'js/modder_tools/shared.js',
        'js/modder_tools/index.js',
        'js/modder_tools/build.js',
        'js/modder_tools/extract.js',
        'js/modder_tools/edit_tmod.js',
        'js/modder_tools/projects.js',
        'js/modder_tools/qb_editor.js',
        'js/modder_tools/software.js',
    ],
    gems_and_builds: [
        'js/gems_and_builds/index.js',
        'js/gems_and_builds/gem_builds.js',
        'js/gems_and_builds/star_chart.js',
        'js/gems_and_builds/gem_evaluator.js',
        'js/gems_and_builds/gem_simulator.js',
    ],
    calculators: ['js/calculators.js'],
    codexes: ['js/codexes/index.js'],
    settings: ['js/settings.js'],
    about: ['js/about.js'],
};

// Codex sub-tabs are loaded lazily by codexes.js's loadSubview.
window.BTT_CODEX_SUBVIEW_SCRIPTS = {
    allies: 'js/codexes/allies.js',
    mounts: 'js/codexes/mounts.js',
    dragons: 'js/codexes/dragons.js',
    mementos: 'js/codexes/mementos.js',
    recipes: 'js/codexes/recipes.js',
    items: 'js/codexes/items.js',
    fish: 'js/codexes/fish.js',
    badges: 'js/codexes/badges.js',
};

window.AppSettings = {
    _cache: null,
    _saveTimer: null,
    _loadPromise: null,

    _unwrap(raw) {
        if (raw && typeof raw === 'object' && raw.success !== undefined && raw.data && typeof raw.data === 'object') {
            return { ...raw.data };
        }
        return raw && typeof raw === 'object' ? { ...raw } : {};
    },

    async load(force = false) {
        if (!force && this._cache) return this._cache;
        if (!force && this._loadPromise) return this._loadPromise;

        this._loadPromise = (async () => {
            try {
                const raw = await eel.get_settings()();
                const settings = this._unwrap(raw);
                if (!settings.ui_preferences || typeof settings.ui_preferences !== 'object') {
                    settings.ui_preferences = {};
                }
                this._cache = settings;
            } catch {
                this._cache = { custom_directories: [], ui_preferences: {} };
            }
            return this._cache;
        })();

        return this._loadPromise;
    },

    get(key, fallback = undefined) {
        if (!this._cache || this._cache[key] === undefined) return fallback;
        return this._cache[key];
    },

    getPref(key, fallback = undefined) {
        const prefs = (this._cache && this._cache.ui_preferences) ? this._cache.ui_preferences : {};
        return Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : fallback;
    },

    async set(key, value) {
        await this.load();
        this._cache[key] = value;
        return this.save();
    },

    setPrefSync(key, value) {
        if (!this._cache) this._cache = { custom_directories: [], ui_preferences: {} };
        if (!this._cache.ui_preferences || typeof this._cache.ui_preferences !== 'object') {
            this._cache.ui_preferences = {};
        }
        this._cache.ui_preferences[key] = value;
        this.scheduleSave();
    },

    removePrefSync(key) {
        if (!this._cache || !this._cache.ui_preferences) return;
        delete this._cache.ui_preferences[key];
        this.scheduleSave();
    },

    scheduleSave(delayMs = 120) {
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            this.save();
        }, delayMs);
    },

    async save() {
        await this.load();
        if (!this._cache.ui_preferences || typeof this._cache.ui_preferences !== 'object') {
            this._cache.ui_preferences = {};
        }
        try {
            const latestRaw = await eel.get_settings()();
            const latest = this._unwrap(latestRaw);
            const merged = {
                ...latest,
                ...this._cache,
                ui_preferences: {
                    ...(latest.ui_preferences || {}),
                    ...(this._cache.ui_preferences || {})
                }
            };
            this._cache = merged;
            await eel.save_settings(merged)();
        } catch {}
        return this._cache;
    }
};

// Tooltip listeners are document-wide and fire constantly. The mousemove handler
// in particular used to do width/height reads + style writes on every mouse pixel
// while the tooltip was visible. Now:
//   - mouseover does the (cheap) `closest()` match and shows the tooltip
//   - mousemove bails immediately when no tooltip is showing, and otherwise
//     defers position updates to the next animation frame so we paint at most
//     once per frame instead of once per mouse event.
let tooltipVisible = false;
let pendingTooltipX = 0;
let pendingTooltipY = 0;
let tooltipRafId = 0;

const positionTooltip = (clientX, clientY) => {
    let x = clientX + 15;
    let y = clientY + 15;
    const w = globalTooltip.offsetWidth;
    const h = globalTooltip.offsetHeight;
    if (x + w > window.innerWidth) x = clientX - w - 15;
    if (y + h > window.innerHeight) y = clientY - h - 15;
    globalTooltip.style.left = x + 'px';
    globalTooltip.style.top = y + 'px';
};

const hideTooltip = () => {
    if (!tooltipVisible) return;
    tooltipVisible = false;
    globalTooltip.style.display = 'none';
};

document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[title], [data-tooltip], [data-tooltip-text]');
    if (!target) return;

    const rawTitle = target.getAttribute('title');
    if (rawTitle && rawTitle.trim() !== "") {
        target.setAttribute('data-tooltip-text', rawTitle.replace(/\n/g, '<br>'));
        target.removeAttribute('title');
    }

    const content = target.getAttribute('data-tooltip') || target.getAttribute('data-tooltip-text');
    if (!content) return;

    globalTooltip.innerHTML = content;
    globalTooltip.style.display = 'block';
    tooltipVisible = true;
    positionTooltip(e.clientX, e.clientY);
});

document.addEventListener('mousemove', (e) => {
    if (!tooltipVisible) return;
    if (e.buttons > 0) { hideTooltip(); return; }
    pendingTooltipX = e.clientX;
    pendingTooltipY = e.clientY;
    if (tooltipRafId) return;
    tooltipRafId = requestAnimationFrame(() => {
        tooltipRafId = 0;
        if (tooltipVisible) positionTooltip(pendingTooltipX, pendingTooltipY);
    });
}, { passive: true });

document.addEventListener('mouseout', (e) => {
    if (!tooltipVisible) return;
    if (e.target.closest('[data-tooltip], [data-tooltip-text]')) hideTooltip();
});

document.addEventListener('click', hideTooltip);

const networkState = Vue.reactive({
    activeRequests: [],
    fullLog: [],
    isModalOpen: false
});

const networkTrackerApp = Vue.createApp({
    setup() {
        const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;

        const hasActive = Vue.computed(() => networkState.activeRequests.some(r => r.status === 'active'));

        const tooltipContent = Vue.computed(() => {
            if (networkState.activeRequests.length > 0) {
                let content = `<h3>${t('app.recent_requests')}</h3><ul style="margin-bottom: 0;">`;
                const reversedList = [...networkState.activeRequests].reverse();
                const displayList = reversedList.slice(0, 10);
                
                displayList.forEach(req => {
                    let labelStr = req.label || req.url;
                    if (labelStr.length > 40) labelStr = labelStr.substring(0, 37) + '...';
                    const safeLabel = labelStr.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                    
                    let statusHtml = '';
                    if (req.status === 'active') statusHtml = `<span style="color: var(--accent-blue);" title="${t('common.active')}"><i class="fa-solid fa-circle-notch fa-spin"></i></span> `;
                    else if (req.status === 'error') statusHtml = `<span style="color: #ff5555;" title="${t('app.failed')}"><i class="fa-solid fa-xmark"></i></span> `;
                    else statusHtml = `<span style="color: #4ade80;" title="${t('common.done')}"><i class="fa-solid fa-check"></i></span> `;
                    
                    content += `<li>${statusHtml}${safeLabel}</li>`;
                });
                
                if (networkState.activeRequests.length > 10) {
                    content += `<li><i>...${t('app.and_count_more').replace('{count}', networkState.activeRequests.length - 10)}</i></li>`;
                }
                content += `</ul><hr style="margin: 8px 0; border: 0; border-top: 1px dashed var(--border-color, #444c5e);"><div style="font-size: 0.85em; color: var(--text-muted, #a3adc2);">${t('app.total_requests_made')} ${networkState.fullLog.length}</div>`;
                return content;
            } else {
                return networkState.fullLog.length > 0 
                    ? `${t('app.no_active_requests')}<hr style="margin: 8px 0; border: 0; border-top: 1px dashed var(--border-color, #444c5e);"><div style="font-size: 0.85em; color: var(--text-muted, #a3adc2);">${t('app.total_requests_made')} ${networkState.fullLog.length}</div>` 
                    : t('app.no_external_requests_made_yet');
            }
        });

        Vue.watch(tooltipContent, (newContent) => {
            const indicator = document.getElementById('external-request-indicator');
            const globalTooltip = document.getElementById('global-tooltip');
            if (indicator && globalTooltip && globalTooltip.style.display === 'block' && indicator.matches(':hover')) {
                globalTooltip.innerHTML = newContent;
            }
        });

        const reversedLog = Vue.computed(() => [...networkState.fullLog].reverse());

        const copyLog = () => {
            if (networkState.fullLog.length === 0) {
                window.showToast(t('app.no_requests_to_copy'), true);
                return;
            }
            let logText = `--- ${t('app.external_request_log')} ---\n\n`;
            reversedLog.value.forEach(req => {
                const timeStr = req.time ? req.time.toLocaleTimeString() : 'Unknown Time';
                const statusStr = req.status.toUpperCase();
                logText += `[${timeStr}] [${statusStr}] ${req.label || req.url}\n`;
                if (req.label && req.label !== req.url) {
                    logText += `  -> URL: ${req.url}\n`;
                }
            });
            navigator.clipboard.writeText(logText).then(() => {
                window.showToast(t('app.entire_request_log_copied_to_clipboard'));
            });
        };

        const copyUrl = (url) => {
            navigator.clipboard.writeText(url).then(() => {
                window.showToast(t('app.url_copied_to_clipboard'));
            });
        };

        const formatTime = (time) => time ? time.toLocaleTimeString() : '';

        return {
            t, networkState, hasActive, tooltipContent, reversedLog, copyLog, copyUrl, formatTime
        };
    }
});

document.addEventListener('DOMContentLoaded', () => {
    networkTrackerApp.mount('#network-tracker-vue-app');
    if (window.initJobQueueUi) window.initJobQueueUi();
});

eel.expose(add_external_request, 'add_external_request');
function add_external_request(label = "Python Backend Request", url = "") {
    const id = Math.random().toString(36).substring(2, 11);
    if (!url) url = label;
    const reqObj = { id, url, label, status: 'active', time: new Date() };
    networkState.activeRequests.push(reqObj);
    networkState.fullLog.push(reqObj);
    return id;
}

eel.expose(remove_external_request, 'remove_external_request');
function remove_external_request(id, success = true) {
    let reqObj = null;
    if (id) {
        reqObj = networkState.activeRequests.find(r => r.id === id);
    } else {
        reqObj = networkState.activeRequests.find(r => r.status === 'active');
    }
    
    if (reqObj) {
        reqObj.status = success ? 'completed' : 'error';
        setTimeout(() => {
            networkState.activeRequests = networkState.activeRequests.filter(r => r !== reqObj);
        }, 60000);
    }
}

const originalFetch = window.fetch;
window.fetch = async function(...args) {
    let reqObj = null;
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
    if (url.startsWith('http://') || url.startsWith('https://')) {
        const options = args[1] || {};
        let label = options.bttLabel;
        if (!label) {
            label = url;
            try { label = `Fetching data from ${new URL(url).hostname}`; } catch(e) {}
        }
        reqObj = { url: url, label: label, status: 'active', time: new Date() };
        networkState.activeRequests.push(reqObj);
        networkState.fullLog.push(reqObj);
    }
    try {
        const response = await originalFetch.apply(this, args);
        if (reqObj) reqObj.status = response.ok ? 'completed' : 'error';
        return response;
    } catch (e) {
        if (reqObj) reqObj.status = 'error';
        throw e;
    } finally {
        if (reqObj) {
            setTimeout(() => {
                networkState.activeRequests = networkState.activeRequests.filter(r => r !== reqObj);
            }, 60000);
        }
    }
};

const originalXhrOpen = XMLHttpRequest.prototype.open;
const originalXhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._requestUrl = url;
    this._isExternal = typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
    return originalXhrOpen.apply(this, [method, url, ...rest]);
};
XMLHttpRequest.prototype.send = function(...args) {
    if (this._isExternal) {
        let label = this.bttLabel;
        if (!label) {
            label = this._requestUrl;
            try { label = `Contacting ${new URL(this._requestUrl).hostname}`; } catch(e) {}
        }
        const reqObj = { url: this._requestUrl, label: label, status: 'active', time: new Date() };
        networkState.activeRequests.push(reqObj);
        networkState.fullLog.push(reqObj);
        const onComplete = (e) => {
            reqObj.status = (e.type === 'error' || e.type === 'abort' || this.status >= 400) ? 'error' : 'completed';
            setTimeout(() => {
                networkState.activeRequests = networkState.activeRequests.filter(r => r !== reqObj);
            }, 60000);
            this.removeEventListener('loadend', onComplete);
            this.removeEventListener('error', onComplete);
            this.removeEventListener('abort', onComplete);
        };
        this.addEventListener('loadend', onComplete);
        this.addEventListener('error', onComplete);
        this.addEventListener('abort', onComplete);
    }
    return originalXhrSend.apply(this, args);
};

document.addEventListener('DOMContentLoaded', async () => {
    const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;

    // Google Fonts families used to be loaded eagerly from index.html for every
    // launch, but most users keep the default 'system' font and never need
    // Inter / Noto Sans / Roboto. Now we fetch a Google Fonts stylesheet only
    // for the family the user actually picked, and only once per session.
    const GOOGLE_FONT_URLS = {
        'inter': 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
        'noto-sans': 'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&display=swap',
        'roboto': 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap',
    };
    const loadedGoogleFonts = new Set();
    const ensureGoogleFont = (key) => {
        const url = GOOGLE_FONT_URLS[key];
        if (!url || loadedGoogleFonts.has(key)) return;
        loadedGoogleFonts.add(key);
        if (window.loadStyle) window.loadStyle(url).catch(() => loadedGoogleFonts.delete(key));
    };

    const applyFont = async () => {
        try {
            // Drop force=true: this runs once at startup before any other AppSettings
            // user, so the cache is empty and the regular load() spawns the fresh
            // backend call. Forcing was creating a second in-flight load that raced
            // with handler 3's first call, causing duplicate get_settings traffic.
            const settings = window.AppSettings
                ? await window.AppSettings.load()
                : await eel.get_settings()();
            const appFont = settings?.app_font || 'system';

            const fontMap = {
                'system': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                'product-sans': '"Product Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                'noto-sans': '"Noto Sans", sans-serif',
                'inter': 'Inter, sans-serif',
                'roboto': 'Roboto, sans-serif',
                'segoe-ui': '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif',
                'arial': 'Arial, Helvetica, sans-serif'
            };
            ensureGoogleFont(appFont);
            document.documentElement.style.setProperty('--app-font', fontMap[appFont] || fontMap['system']);
        } catch (e) {
            console.error('Failed to load font preference:', e);
        }
    };

    // Expose so the settings screen can pre-load the new family before swapping.
    window.ensureGoogleFont = ensureGoogleFont;

    await applyFont();

    const metaResponse = await eel.get_app_metadata()();
    let currentVersion = metaResponse?.APP_VERSION || "Unknown";
    
    if (metaResponse && metaResponse.APP_VERSION) {
        const appName = metaResponse.APP_NAME || "Better Trove Tools";
        document.title = `${appName} v${currentVersion}`;
        const titleEl = document.getElementById('app-title');
        if (titleEl) {
            const isBetaVersion = /b$/i.test(currentVersion);
            const cleanVersion = isBetaVersion ? currentVersion.replace(/b$/i, '') : currentVersion;
            titleEl.innerHTML = `
                <div class="app-name-text">${appName}</div>
                <div class="app-version-text">v${cleanVersion}${isBetaVersion ? ' <span class="app-beta-pill">BETA</span>' : ''}</div>
            `;
        }
    }

    const normalizeVersionTag = (tag) => String(tag || '').trim().replace(/^v/i, '');

    const parseVersion = (tag) => {
        const normalized = normalizeVersionTag(tag);
        const match = normalized.match(/^(\d+(?:\.\d+)*)(b)?$/i);
        if (!match) return null;
        const parts = match[1].split('.').map(n => parseInt(n, 10));
        const isBeta = !!match[2];
        return { normalized, parts, isBeta };
    };

    const compareVersionTags = (aTag, bTag) => {
        const a = parseVersion(aTag);
        const b = parseVersion(bTag);
        if (!a || !b) return 0;

        const maxLen = Math.max(a.parts.length, b.parts.length);
        for (let i = 0; i < maxLen; i++) {
            const av = a.parts[i] || 0;
            const bv = b.parts[i] || 0;
            if (av !== bv) return av - bv;
        }

        if (a.isBeta === b.isBeta) return 0;
        return a.isBeta ? -1 : 1;
    };

    let isAppUpdateStarting = false;
    const updateOverlayEl = document.getElementById('app-update-overlay');
    const updateOverlayTitleEl = document.getElementById('app-update-overlay-title');
    const updateOverlayMessageEl = document.getElementById('app-update-overlay-message');
    const setAppUpdateOverlay = (visible, message = '', title = '') => {
        if (!updateOverlayEl) return;
        if (title && updateOverlayTitleEl) updateOverlayTitleEl.textContent = title;
        if (message && updateOverlayMessageEl) updateOverlayMessageEl.textContent = message;
        updateOverlayEl.style.display = visible ? 'flex' : 'none';
        document.body.classList.toggle('app-update-active', !!visible);
    };

    const addWebDownloadButton = () => {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        const existingDownload = sidebar.querySelector('.app-download-container');
        if (existingDownload) existingDownload.remove();

        const downloadContainer = document.createElement('div');
        downloadContainer.className = 'app-download-container app-update-container';
        const downloadButton = document.createElement('button');
        downloadButton.className = 'nav-btn download-app-btn update-app-btn';
        // data-i18n* so the i18n engine re-translates these if the button was
        // built before the dictionary finished loading (web mode renders it at
        // first paint, which can beat i18n's async load -> raw token otherwise).
        downloadButton.setAttribute('data-i18n-title', 'app.download_the_desktop_app');
        downloadButton.title = t('app.download_the_desktop_app');
        downloadButton.innerHTML = `
            <i class="fa-solid fa-download nav-icon"></i>
            <span class="nav-text" data-i18n="app.download_app">${t('app.download_app')}</span>
        `;
        downloadButton.addEventListener('click', () => {
            window.location.href = 'https://trove.aallyn.net';
        });
        downloadContainer.appendChild(downloadButton);
        sidebar.appendChild(downloadContainer);
    };

    if (window.BTT_WEB_MODE === true) {
        addWebDownloadButton();
        return;
    }

    try {
        const ghResponse = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/releases?per_page=5', { bttLabel: t('app.looking_for_updates') });
        if (ghResponse.ok) {
            const releases = await ghResponse.json();
            const hasMsiAsset = (release) => Array.isArray(release?.assets)
                && release.assets.some(asset => typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith('.msi'));

            const validReleases = Array.isArray(releases)
                ? releases.filter(r => r && !r.draft && parseVersion(r.tag_name) && hasMsiAsset(r))
                : [];

            let latestStable = null;
            let latestPrerelease = null;

            validReleases.forEach(release => {
                if (release.prerelease) {
                    if (!latestPrerelease || compareVersionTags(release.tag_name, latestPrerelease.tag_name) > 0) {
                        latestPrerelease = release;
                    }
                } else {
                    if (!latestStable || compareVersionTags(release.tag_name, latestStable.tag_name) > 0) {
                        latestStable = release;
                    }
                }
            });

            const currentParsed = parseVersion(currentVersion);
            const currentIsBeta = !!(currentParsed && currentParsed.isBeta);

            let updateTarget = null;

            if (currentParsed) {
                if (currentIsBeta) {
                    const prereleaseNewer = latestPrerelease && compareVersionTags(latestPrerelease.tag_name, currentVersion) > 0;
                    const stableNewer = latestStable && compareVersionTags(latestStable.tag_name, currentVersion) > 0;

                    if (prereleaseNewer && stableNewer) {
                        updateTarget = compareVersionTags(latestPrerelease.tag_name, latestStable.tag_name) >= 0
                            ? latestPrerelease
                            : latestStable;
                    } else if (prereleaseNewer) {
                        updateTarget = latestPrerelease;
                    } else if (stableNewer) {
                        updateTarget = latestStable;
                    }
                } else {
                    if (latestStable && compareVersionTags(latestStable.tag_name, currentVersion) > 0) {
                        updateTarget = latestStable;
                    }
                }
            }

            if (updateTarget) {
                const latestVersion = normalizeVersionTag(updateTarget.tag_name);
                const updateAsset = Array.isArray(updateTarget.assets)
                    ? updateTarget.assets.find(asset => typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith('.msi') && typeof asset?.browser_download_url === 'string' && asset.browser_download_url)
                    : null;
                const sidebar = document.getElementById('sidebar');
                if (sidebar && updateAsset) {
                    const existingUpdate = sidebar.querySelector('.app-update-container');
                    if (existingUpdate) existingUpdate.remove();
                    const updateContainer = document.createElement('div');
                    updateContainer.className = 'app-update-container';
                    const updateButton = document.createElement('button');
                    updateButton.className = 'nav-btn update-app-btn';
                    updateButton.title = t("app.a_new_version_is_available_click_to_upda_1d6574");
                    updateButton.innerHTML = `
                        <i class="fa-solid fa-cloud-arrow-down nav-icon"></i>
                        <span class="nav-text">${t("app.update_v_version").replace("{version}", latestVersion)}</span>
                    `;
                    updateButton.addEventListener('click', async () => {
                        if (isAppUpdateStarting) return;

                        let confirmed = true;
                        if (typeof window.showConfirmModal === 'function') {
                            confirmed = await window.showConfirmModal({
                                title: t('app.install_update'),
                                message: t('app.download_and_install_v_version_now_the_a_2231eb').replace('{version}', latestVersion),
                                confirmLabel: t('app.update_now'),
                                cancelLabel: t('common.cancel'),
                                danger: false
                            });
                        }
                        if (!confirmed) return;

                        isAppUpdateStarting = true;
                        updateButton.disabled = true;
                        setAppUpdateOverlay(
                            true,
                            t('app.downloading_the_installer_and_preparing_6c20a2'),
                            t('app.updating_better_trove_tools')
                        );

                        try {
                            const response = await window.callBackend(
                                eel.start_self_update(updateAsset.browser_download_url, updateTarget.tag_name, updateAsset.name)(),
                                t('app.failed_to_start_self_update')
                            );

                            if (!response.success) {
                                throw new Error(response.error || t('app.failed_to_start_self_update'));
                            }

                            setAppUpdateOverlay(
                                true,
                                t('app.closing_the_app_window_and_starting_the_e43133'),
                                t('app.installing_update')
                            );

                            try {
                                await window.callBackend(
                                    eel.finalize_self_update_exit(2.2)(),
                                    t('app.failed_to_close_app_for_update')
                                );
                            } catch {}

                            setTimeout(() => {
                                try { window.close(); } catch {}
                            }, 100);
                            setTimeout(() => {
                                try {
                                    window.location.replace('about:blank');
                                } catch {}
                            }, 350);
                        } catch (err) {
                            isAppUpdateStarting = false;
                            updateButton.disabled = false;
                            setAppUpdateOverlay(false);
                            window.showToast(String(err?.message || err || t('app.failed_to_start_self_update')), true, {
                                actionLabel: t('app.open_release'),
                                onAction: async () => eel.open_url_in_browser(updateTarget.html_url)()
                            });
                        }
                    });
                    updateContainer.appendChild(updateButton);
                    sidebar.appendChild(updateContainer);
                }
            }
        }
    } catch (err) {
        console.error("Failed to check for app updates:", err);
    }
});

window.showToast = function(message, isError = false, options = {}) {
    let toastHost = document.getElementById('global-toast-host');
    if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.id = 'global-toast-host';
        toastHost.style.position = 'fixed';
        toastHost.style.left = '50%';
        toastHost.style.bottom = '20px';
        toastHost.style.transform = 'translateX(-50%)';
        toastHost.style.display = 'flex';
        toastHost.style.flexDirection = 'column-reverse';
        toastHost.style.alignItems = 'center';
        toastHost.style.gap = '10px';
        toastHost.style.maxWidth = 'min(92vw, 640px)';
        toastHost.style.width = 'max-content';
        const toastZ = getComputedStyle(document.documentElement).getPropertyValue('--z-toast').trim();
        toastHost.style.zIndex = toastZ || '210000';
        toastHost.style.pointerEvents = 'none';
        document.body.appendChild(toastHost);
    }

    const toast = document.createElement('div');
    toast.style.backgroundColor = isError ? '#ff5555' : '#28a745';
    toast.style.color = 'white';
    toast.style.padding = '12px 16px';
    toast.style.borderRadius = '8px';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    toast.style.fontSize = '14px';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    toast.style.whiteSpace = 'pre-wrap';
    toast.style.textAlign = 'left';
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    toast.style.gap = '12px';
    toast.style.pointerEvents = 'auto';
    toast.style.maxWidth = '100%';
    toast.style.width = 'fit-content';
    toast.style.margin = '0 auto';

    const messageEl = document.createElement('div');
    messageEl.innerText = message;
    toast.appendChild(messageEl);

    if (options.closeable) {
        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '&times;';
        closeBtn.setAttribute('aria-label', 'Dismiss');
        closeBtn.style.background = 'transparent';
        closeBtn.style.color = '#fff';
        closeBtn.style.border = 'none';
        closeBtn.style.fontSize = '18px';
        closeBtn.style.lineHeight = '1';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.padding = '0 0 0 4px';
        closeBtn.onclick = () => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        };
        toast.appendChild(closeBtn);
    }

    if (options.actionLabel && typeof options.onAction === 'function') {
        const actionBtn = document.createElement('button');
        actionBtn.innerText = options.actionLabel;
        actionBtn.style.background = 'rgba(0,0,0,0.2)';
        actionBtn.style.color = '#fff';
        actionBtn.style.border = '1px solid rgba(255,255,255,0.4)';
        actionBtn.style.padding = '4px 10px';
        actionBtn.style.borderRadius = '6px';
        actionBtn.style.cursor = 'pointer';
        actionBtn.onclick = async () => {
            try {
                await options.onAction();
            } finally {
                toast.style.opacity = '0';
                setTimeout(() => toast.remove(), 300);
            }
        };
        toast.appendChild(actionBtn);
    }

        toastHost.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '1'; }, 10);

    const timeoutMs = typeof options.durationMs === 'number' ? options.durationMs : 3000;
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, timeoutMs);
};

window.showUndoToast = function(message, seconds, onUndo) {
    window.showToast(message, false, {
        actionLabel: 'Undo',
        onAction: onUndo,
        durationMs: Math.max(1000, Number(seconds || 8) * 1000)
    });
};

window.showConfirmModal = function({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', extraActionLabel = '', danger = true }) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('global-confirm-overlay');
        const titleEl = document.getElementById('global-confirm-title');
        const messageEl = document.getElementById('global-confirm-message');
        const cancelBtn = document.getElementById('global-confirm-cancel');
        const extraBtn = document.getElementById('global-confirm-extra');
        const okBtn = document.getElementById('global-confirm-ok');
        if (!overlay || !titleEl || !messageEl || !cancelBtn || !okBtn) return resolve(false);

        titleEl.textContent = title || 'Confirm';
        messageEl.textContent = message || '';
        cancelBtn.textContent = cancelLabel;
        if (extraBtn) {
            extraBtn.textContent = extraActionLabel || '';
            extraBtn.style.display = extraActionLabel ? '' : 'none';
        }
        okBtn.textContent = confirmLabel;
        okBtn.className = danger ? 'danger-btn' : 'primary-btn';
        overlay.style.display = 'flex';

        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                cleanup();
                resolve(false);
                return;
            }
            if (e.key === 'Enter') {
                const targetTag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
                if (targetTag === 'textarea') return;
                e.preventDefault();
                cleanup();
                resolve(true);
            }
        };
        document.addEventListener('keydown', onKeyDown, true);

        const cleanup = () => {
            overlay.style.display = 'none';
            cancelBtn.onclick = null;
            if (extraBtn) {
                extraBtn.onclick = null;
                extraBtn.style.display = 'none';
            }
            okBtn.onclick = null;
            overlay.onclick = null;
            document.removeEventListener('keydown', onKeyDown, true);
        };

        cancelBtn.onclick = () => {
            cleanup();
            resolve(false);
        };
        if (extraBtn && extraActionLabel) {
            extraBtn.onclick = () => {
                cleanup();
                resolve('extra');
            };
        }
        okBtn.onclick = () => {
            cleanup();
            resolve(true);
        };
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                cleanup();
                resolve(false);
            }
        };
    });
};

window.normalizeApiResponse = function(resp) {
    if (!resp || typeof resp !== 'object') return { success: false, code: 'INVALID_RESPONSE', data: {}, error: 'Invalid response', meta: {} };
    return {
        success: !!resp.success,
        code: resp.code || (resp.success ? 'OK' : 'ERROR'),
        data: resp.data || {},
        error: resp.error || null,
        meta: resp.meta || {},
        raw: resp
    };
};

window.callBackend = async function(eelCallPromise, fallbackError = 'Operation failed') {
    try {
        const raw = await eelCallPromise;
        const normalized = window.normalizeApiResponse(raw);

        // Legacy compatibility bridge for endpoints not migrated yet.
        if (!('data' in (raw || {}))) {
            normalized.data = {
                ...(raw || {}),
                ...(normalized.data || {})
            };
        }
        return normalized;
    } catch (err) {
        return { success: false, code: 'EXCEPTION', data: {}, error: String(err || fallbackError), meta: {}, raw: null };
    }
};

window.createRequestGuard = function() {
    let activeToken = 0;
    return {
        next() {
            activeToken += 1;
            return activeToken;
        },
        isCurrent(token) {
            return token === activeToken;
        }
    };
};

window.fuzzyMatchScore = function(haystack, needle) {
    const h = String(haystack || '').toLowerCase();
    const n = String(needle || '').toLowerCase().trim();
    if (!n) return 1;
    if (h.includes(n)) return 100 + n.length;

    let hi = 0;
    let score = 0;
    let streak = 0;
    for (let ni = 0; ni < n.length; ni++) {
        const ch = n[ni];
        let found = false;
        while (hi < h.length) {
            if (h[hi] === ch) {
                found = true;
                streak += 1;
                score += 1 + streak;
                hi += 1;
                break;
            }
            streak = 0;
            hi += 1;
        }
        if (!found) return 0;
    }
    return score;
};

window.fuzzyIncludes = function(haystack, needle, minScore = 3) {
    return window.fuzzyMatchScore(haystack, needle) >= minScore;
};

window.JobQueue = (() => {
    const PREF_KEY = 'job_queue_history_v1';
    const PATCH_EMIT_INTERVAL_MS = 120;
    let jobs = [];
    const listeners = [];
    const runtimeHandlers = {};
    let patchEmitTimer = null;

    const loadHistory = () => {
        if (window.AppSettings) {
            const parsed = window.AppSettings.getPref(PREF_KEY, []);
            jobs = Array.isArray(parsed) ? parsed : [];
            return;
        }
        jobs = [];
    };
    const saveHistory = () => {
        if (!window.AppSettings) return;
        window.AppSettings.setPrefSync(PREF_KEY, jobs.slice(0, 200));
    };
    const emit = () => listeners.forEach(fn => fn([...jobs]));

    const update = (id, patch, options = {}) => {
        const { persist = true, emitNow = true } = options;
        const idx = jobs.findIndex(j => j.id === id);
        if (idx < 0) return;
        jobs[idx] = { ...jobs[idx], ...patch, updatedAt: Date.now() };
        if (persist) saveHistory();
        if (emitNow) emit();
    };

    const queuePatchEmit = () => {
        if (patchEmitTimer) return;
        patchEmitTimer = setTimeout(() => {
            patchEmitTimer = null;
            emit();
        }, PATCH_EMIT_INTERVAL_MS);
    };

    const add = (job) => {
        jobs.unshift(job);
        saveHistory();
        emit();
    };

    const run = async ({ label, task, retryTask, cancel, onStart, meta }) => {
        const id = Math.random().toString(36).slice(2, 11);
        const job = {
            id,
            label,
            status: 'running',
            error: null,
            meta: meta || {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
            canRetry: typeof retryTask === 'function',
            canCancel: typeof cancel === 'function'
        };
        add(job);
        runtimeHandlers[id] = { retryTask, cancel };
        if (typeof onStart === 'function') {
            try { onStart(id); } catch {}
        }

        try {
            const result = await task();
            const current = jobs.find(j => j.id === id);
            if (current && current.status === 'cancelling') {
                update(id, { status: 'cancelled' });
            } else if (current && current.status !== 'cancelled') {
                update(id, { status: 'completed' });
            }
            return result;
        } catch (e) {
            const current = jobs.find(j => j.id === id);
            if (current && current.status === 'cancelling') {
                update(id, { status: 'cancelled', error: null });
            } else if (current && current.status !== 'cancelled') {
                update(id, { status: 'error', error: String(e) });
            }
            throw e;
        }
    };

    const retry = async (id, task) => {
        update(id, { status: 'running', error: null });
        try {
            const result = await task();
            const current = jobs.find(j => j.id === id);
            if (current && current.status !== 'cancelled') {
                update(id, { status: 'completed' });
            }
            return result;
        } catch (e) {
            const current = jobs.find(j => j.id === id);
            if (current && current.status !== 'cancelled') {
                update(id, { status: 'error', error: String(e) });
            }
            throw e;
        }
    };

    const cancelJob = (id, cancel) => {
        update(id, { status: 'cancelling', error: null });
        if (typeof cancel === 'function') {
            try {
                const maybePromise = cancel();
                if (maybePromise && typeof maybePromise.then === 'function') {
                    maybePromise.catch((err) => {
                        const current = jobs.find(j => j.id === id);
                        if (current && current.status === 'cancelling') {
                            update(id, { status: 'running', error: null });
                        }
                        if (window.showToast) {
                            window.showToast(String(err || 'Failed to cancel operation.'), true);
                        }
                    });
                }
            } catch (err) {
                const current = jobs.find(j => j.id === id);
                if (current && current.status === 'cancelling') {
                    update(id, { status: 'running', error: null });
                }
                if (window.showToast) {
                    window.showToast(String(err || 'Failed to cancel operation.'), true);
                }
            }
        }
    };

    const retryById = async (id) => {
        const handlers = runtimeHandlers[id];
        if (!handlers || typeof handlers.retryTask !== 'function') return;
        return retry(id, handlers.retryTask);
    };

    const cancelById = (id) => {
        const handlers = runtimeHandlers[id];
        if (!handlers || typeof handlers.cancel !== 'function') {
            update(id, { status: 'cancelled', error: null });
            return;
        }
        cancelJob(id, handlers.cancel);
    };

    const subscribe = (listener) => {
        listeners.push(listener);
        listener([...jobs]);
        return () => {
            const idx = listeners.indexOf(listener);
            if (idx >= 0) listeners.splice(idx, 1);
        };
    };

    const patch = (id, patchData) => {
        const patchObj = { ...(patchData || {}) };
        if (patchObj.meta && typeof patchObj.meta === 'object') {
            const current = jobs.find(j => j.id === id);
            patchObj.meta = { ...(current?.meta || {}), ...patchObj.meta };
        }
        update(id, patchObj, { persist: false, emitNow: false });
        queuePatchEmit();
    };

    loadHistory();
    const syncFromSettings = () => {
        loadHistory();
        emit();
    };

    return { run, retry, cancelJob, retryById, cancelById, subscribe, patch, syncFromSettings, getJobs: () => [...jobs] };
})();

window.initJobQueueUi = function() {
    const toggle = document.getElementById('job-queue-toggle');
    const close = document.getElementById('job-queue-close');
    const panel = document.getElementById('job-queue-panel');
    const list = document.getElementById('job-queue-list');
    const badge = document.getElementById('job-queue-badge');
    if (!toggle || !close || !panel || !list || !badge) return;

    toggle.onclick = () => {
        panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    };
    close.onclick = () => { panel.style.display = 'none'; };

    window.JobQueue.subscribe((jobs) => {
        const runningCount = jobs.filter(j => j.status === 'running' || j.status === 'cancelling').length;
        if (runningCount > 0) {
            badge.style.display = 'inline-block';
            badge.textContent = String(runningCount);
        } else {
            badge.style.display = 'none';
        }

        if (jobs.length === 0) {
            list.innerHTML = '<div class="job-item"><div class="job-label">No jobs yet.</div></div>';
            return;
        }

        list.innerHTML = jobs.map(j => {
            const err = j.error ? `<div class="job-error">${j.error}</div>` : '';
            const statusText = j.status === 'cancelling' ? 'cancelling...' : j.status;
            const hasProgress = Number.isFinite(Number(j.meta?.progressPercent));
            const clampedProgress = hasProgress ? Math.max(0, Math.min(100, Number(j.meta.progressPercent))) : 0;
            const progressBar = hasProgress
                ? `
                    <div class="job-progress-track" role="progressbar" aria-valuenow="${clampedProgress}" aria-valuemin="0" aria-valuemax="100" aria-label="Job progress">
                        <div class="job-progress-fill" style="width:${clampedProgress}%;"></div>
                        <span class="job-progress-percent">${clampedProgress}%</span>
                    </div>
                `
                : '';
            const details = j.meta && (j.meta.current || j.meta.elapsed || j.meta.eta || j.meta.status)
                ? `
                    <details class="job-details" data-id="${j.id}" ${j.meta.detailsOpen ? 'open' : ''}>
                        <summary>Details</summary>
                        <div class="job-details-content">
                            ${j.meta.status ? `<div>Status: ${j.meta.status}</div>` : ''}
                            ${j.meta.current ? `<div>Current: ${j.meta.current}</div>` : ''}
                            ${j.meta.elapsed ? `<div>Elapsed: ${j.meta.elapsed}</div>` : ''}
                            ${j.meta.eta ? `<div>ETA: ${j.meta.eta}</div>` : ''}
                        </div>
                    </details>
                `
                : '';
            const actions = `
                <div class="job-actions">
                    ${j.status === 'running' ? `<button data-action="cancel" data-id="${j.id}">Cancel</button>` : ''}
                    ${j.status === 'error' && j.canRetry ? `<button data-action="retry" data-id="${j.id}">Retry</button>` : ''}
                </div>
            `;
            return `
                <div class="job-item">
                    <div class="job-top">
                        <div class="job-label">${j.label}</div>
                        <div class="job-status">${statusText}</div>
                    </div>
                    ${progressBar}
                    ${err}
                    ${details}
                    ${actions}
                </div>
            `;
        }).join('');

        list.querySelectorAll('button[data-action="retry"]').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.getAttribute('data-id');
                try {
                    await window.JobQueue.retryById(id);
                } catch (e) {
                    window.showToast(String(e), true);
                }
            };
        });

        list.querySelectorAll('button[data-action="cancel"]').forEach(btn => {
            btn.onclick = () => {
                const id = btn.getAttribute('data-id');
                window.JobQueue.cancelById(id);
            };
        });

        list.querySelectorAll('details.job-details[data-id]').forEach(detailsEl => {
            detailsEl.addEventListener('toggle', () => {
                const id = detailsEl.getAttribute('data-id');
                if (!id || !window.JobQueue || !window.JobQueue.patch) return;
                window.JobQueue.patch(id, { meta: { detailsOpen: detailsEl.open } });
            });
        });
    });
};

window.pendingSearch = null;

eel.expose(handle_deep_link);
function handle_deep_link(url) {
    console.log("Deep link received:", url);
    if (url.startsWith('btt://trovesaurus')) {
        try {
            const queryString = url.split('?')[1];
            if (queryString) {
                const params = new URLSearchParams(queryString);
                const modId = params.get('mod_id');
                
                if (modId) {
                    window.pendingSearch = modId;
                    window.pendingModManagerSection = 'trovesaurus';
                    
                    const searchInput = document.getElementById('ts-search-input');
                    if (searchInput) {
                        if (typeof window.setModManagerSection === 'function') {
                            window.setModManagerSection('trovesaurus');
                        }
                        window.executePendingSearch();
                    } else {
                        window.loadView('mod_manager');
                    }
                }
            }
        } catch (e) {
            console.error("Failed to parse deep link:", e);
        }
    }
}

window.applyCustomDropdowns = function() {
    if (!window.closeAllDropdowns) {
        window.closeAllDropdowns = function(exceptEl = null) {
            document.querySelectorAll('.custom-select-wrapper.open').forEach((wrapper) => {
                if (!exceptEl || wrapper !== exceptEl) wrapper.classList.remove('open');
            });
            document.dispatchEvent(new CustomEvent('btt-close-vue-selects', { detail: { exceptEl } }));
        };
    }

    const escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const renderSelectOptionHtml = (opt) => {
        if (!opt) return '';
        const label = escapeHtml(opt.textContent || '');
        const iconClass = (opt.dataset && opt.dataset.icon) ? String(opt.dataset.icon).trim() : '';
        if (!iconClass) return `<span class="custom-select-option-label">${label}</span>`;
        const safeIconClass = iconClass.replace(/[^a-zA-Z0-9\-\s]/g, '').trim();
        const iconHtml = safeIconClass ? `<i class="${safeIconClass} custom-select-option-icon" aria-hidden="true"></i>` : '';
        return `${iconHtml}<span class="custom-select-option-label">${label}</span>`;
    };

    const getDropdownMaxHeight = (optionCount, availableSpace, optionHeight = 40) => {
        const desiredHeight = Math.max(100, Math.min(7, Math.max(1, optionCount || 0)) * optionHeight);
        return Math.max(100, Math.min(availableSpace - 20, desiredHeight));
    };

    document.querySelectorAll('select:not([multiple]):not(.select2-hidden-accessible):not(.flatpickr-monthDropdown-months):not([data-native-select="true"])').forEach(select => {
        if (select.closest('[v-cloak]')) return;
        if (select.parentElement.classList.contains('custom-select-wrapper')) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'custom-select-wrapper';
        if (select.disabled) wrapper.classList.add('disabled');
        
        if (select.style.width) wrapper.style.width = select.style.width;
        if (select.style.maxWidth) wrapper.style.maxWidth = select.style.maxWidth;
        if (select.style.flex) wrapper.style.flex = select.style.flex;
        
        select.parentNode.insertBefore(wrapper, select);
        wrapper.appendChild(select);
        select.style.display = 'none';

        const trigger = document.createElement('div');
        trigger.className = 'custom-select-trigger';
        
        const triggerText = document.createElement('span');
        triggerText.className = 'custom-select-trigger-text';
        trigger.appendChild(triggerText);
        
        const triggerIcon = document.createElement('i');
        triggerIcon.className = 'fa-solid fa-chevron-down';
        trigger.appendChild(triggerIcon);

        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'custom-select-options';

        function updateOptions() {
            if (select.disabled) {
                wrapper.classList.add('disabled');
                trigger.tabIndex = -1;
            } else {
                wrapper.classList.remove('disabled');
                trigger.tabIndex = 0;
            }

            triggerText.innerHTML = renderSelectOptionHtml(select.options[select.selectedIndex]);
            
            if (optionsContainer.children.length === select.options.length) {
                Array.from(select.options).forEach((opt, index) => {
                    const optDiv = optionsContainer.children[index];
                    const rendered = renderSelectOptionHtml(opt);
                    if (optDiv.innerHTML !== rendered) optDiv.innerHTML = rendered;
                    if (opt.selected) optDiv.classList.add('selected');
                    else optDiv.classList.remove('selected');
                });
                return;
            }

            optionsContainer.innerHTML = '';
            Array.from(select.options).forEach((opt, index) => {
                const optDiv = document.createElement('div');
                optDiv.className = 'custom-select-option' + (opt.selected ? ' selected' : '');
                optDiv.innerHTML = renderSelectOptionHtml(opt);
                optDiv.dataset.value = opt.value;
                optDiv.dataset.index = index;

                optDiv.addEventListener('click', (e) => {
                    e.stopPropagation();
                    select.selectedIndex = index;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    wrapper.classList.remove('open');
                });
                optionsContainer.appendChild(optDiv);
            });
        }

        updateOptions();

        const observer = new MutationObserver(() => updateOptions());
        observer.observe(select, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
        
        select.addEventListener('change', () => updateOptions());

        trigger.addEventListener('keydown', (e) => {
            if (select.disabled) return;
            const isOpen = wrapper.classList.contains('open');
            
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                trigger.click();
            } else if (e.key === 'Escape') {
                wrapper.classList.remove('open');
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                let newIndex = select.selectedIndex;
                if (e.key === 'ArrowDown' && newIndex < select.options.length - 1) newIndex++;
                if (e.key === 'ArrowUp' && newIndex > 0) newIndex--;
                if (newIndex !== select.selectedIndex) {
                    select.selectedIndex = newIndex;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    if (isOpen) {
                        const selectedOpt = optionsContainer.children[newIndex];
                        if(selectedOpt) optionsContainer.scrollTop = selectedOpt.offsetTop - (optionsContainer.offsetHeight / 2) + (selectedOpt.offsetHeight / 2);
                    }
                }
            }
        });

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            if (select.disabled) return;
            const isOpen = wrapper.classList.contains('open');
            if (window.closeAllDropdowns) window.closeAllDropdowns(wrapper);
            else document.querySelectorAll('.custom-select-wrapper').forEach(w => w.classList.remove('open'));
            if (!isOpen) {
                const rect = trigger.getBoundingClientRect();
                const spaceBelow = window.innerHeight - rect.bottom;
                const spaceAbove = rect.top;
                const optionCount = select.options.length;
                
                if (spaceBelow < 250 && spaceAbove > spaceBelow) {
                    wrapper.classList.add('drop-up');
                    optionsContainer.style.maxHeight = getDropdownMaxHeight(optionCount, spaceAbove) + 'px';
                } else {
                    wrapper.classList.remove('drop-up');
                    optionsContainer.style.maxHeight = getDropdownMaxHeight(optionCount, spaceBelow) + 'px';
                }

                wrapper.classList.add('open');
                const selectedOpt = optionsContainer.querySelector('.selected');
                if(selectedOpt) optionsContainer.scrollTop = selectedOpt.offsetTop - (optionsContainer.offsetHeight / 2) + (selectedOpt.offsetHeight / 2);
            }
        });

        wrapper.appendChild(trigger);
        wrapper.appendChild(optionsContainer);
    });

    if (!window._customDropdownListenerAttached) {
        document.addEventListener('click', () => {
            if (window.closeAllDropdowns) window.closeAllDropdowns(null);
            else document.querySelectorAll('.custom-select-wrapper').forEach(w => w.classList.remove('open'));
        });
        window._customDropdownListenerAttached = true;
    }
};

window.CustomVueSelect = {
    props: ['modelValue', 'options', 'disabled', 'translateOptions'],
    setup(props, { emit }) {
        const isOpen = Vue.ref(false);
        const isDropUp = Vue.ref(false);
        const maxH = Vue.ref(250);
        const wrapperRef = Vue.ref(null);
        const optionsRef = Vue.ref(null);
        const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
        const shouldTranslateOptions = Vue.computed(() => props.translateOptions !== false);
        const formatLabel = (label) => shouldTranslateOptions.value ? t(label) : label;
        const currentLabel = Vue.computed(() => {
            const found = props.options ? props.options.find(opt => String(opt[1]) === String(props.modelValue)) : null;
            return found ? formatLabel(found[0]) : '';
        });

        const getDropdownMaxHeight = (optionCount, availableSpace, optionHeight = 40) => {
            const desiredHeight = Math.max(100, Math.min(7, Math.max(1, optionCount || 0)) * optionHeight);
            return Math.max(100, Math.min(availableSpace - 20, desiredHeight));
        };

        const scrollSelectedIntoView = () => {
            if (!optionsRef.value) return;
            const selected = optionsRef.value.querySelector('.custom-select-option.selected');
            if (!selected) return;
            optionsRef.value.scrollTop = selected.offsetTop - (optionsRef.value.clientHeight / 2) + (selected.offsetHeight / 2);
        };

        const onGlobalClose = (evt) => {
            const exceptEl = evt && evt.detail ? evt.detail.exceptEl : null;
            if (!wrapperRef.value || exceptEl === wrapperRef.value) return;
            isOpen.value = false;
        };

        const toggle = () => {
            if (props.disabled) return;
            const nextOpen = !isOpen.value;
            if (nextOpen && window.closeAllDropdowns) {
                window.closeAllDropdowns(wrapperRef.value);
            }
            isOpen.value = nextOpen;
            if (isOpen.value && wrapperRef.value) {
                const rect = wrapperRef.value.getBoundingClientRect();
                const spaceBelow = window.innerHeight - rect.bottom;
                const spaceAbove = rect.top;
                const optionCount = Array.isArray(props.options) ? props.options.length : 0;
                if (spaceBelow < 250 && spaceAbove > spaceBelow) {
                    isDropUp.value = true;
                    maxH.value = getDropdownMaxHeight(optionCount, spaceAbove);
                } else {
                    isDropUp.value = false;
                    maxH.value = getDropdownMaxHeight(optionCount, spaceBelow);
                }
                Vue.nextTick(scrollSelectedIntoView);
            }
        };
        const selectOpt = (val) => { emit('update:modelValue', val); isOpen.value = false; };
        const handleKey = (e) => {
            if (props.disabled) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
            else if (e.key === 'Escape') isOpen.value = false;
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!props.options || props.options.length === 0) return;
                let currentIdx = props.options.findIndex(opt => String(opt[1]) === String(props.modelValue));
                if (e.key === 'ArrowDown' && currentIdx < props.options.length - 1) currentIdx++;
                if (e.key === 'ArrowUp' && currentIdx > 0) currentIdx--;
                if (currentIdx > -1) {
                    emit('update:modelValue', props.options[currentIdx][1]);
                    if (!isOpen.value) {
                        isOpen.value = true;
                        Vue.nextTick(scrollSelectedIntoView);
                    } else {
                        Vue.nextTick(scrollSelectedIntoView);
                    }
                }
            }
        };
        const onDocClick = (e) => {
            if (wrapperRef.value && !wrapperRef.value.contains(e.target)) isOpen.value = false;
        };
        Vue.onMounted(() => {
            document.addEventListener('click', onDocClick);
            document.addEventListener('btt-close-vue-selects', onGlobalClose);
        });
        Vue.onUnmounted(() => {
            document.removeEventListener('click', onDocClick);
            document.removeEventListener('btt-close-vue-selects', onGlobalClose);
        });
        return { isOpen, isDropUp, maxH, wrapperRef, optionsRef, formatLabel, currentLabel, toggle, selectOpt, handleKey };
    },
    template: `
        <div ref="wrapperRef" class="custom-select-wrapper" :class="{ disabled: disabled, open: isOpen, 'drop-up': isDropUp }" tabindex="0" @keydown="handleKey">
            <div class="custom-select-trigger" @click.stop="toggle">
                <span class="custom-select-trigger-text">{{ currentLabel }}</span>
                <i class="fa-solid fa-chevron-down"></i>
            </div>
            <div ref="optionsRef" class="custom-select-options" :style="{ maxHeight: maxH + 'px' }" @click.stop>
                <div v-for="opt in options" :key="opt[1]" class="custom-select-option" :class="{ selected: String(modelValue) === String(opt[1]) }" @click.stop="selectOpt(opt[1])">
                    {{ formatLabel(opt[0]) }}
                </div>
            </div>
        </div>
    `
};

// jQuery + Select2 are loaded lazily the first time a Select2Component mounts.
// They were the heaviest non-Vue dependencies in the eager bundle and the
// multi-select wrapper below is their only consumer.
window.ensureSelect2Loaded = function () {
    if (window.BTT_SELECT2_READY) return Promise.resolve();
    if (!window.BTT_SELECT2_PROMISE) {
        window.BTT_SELECT2_PROMISE = (async () => {
            await window.loadScript('https://code.jquery.com/jquery-3.7.0.min.js');
            await Promise.all([
                window.loadScript('https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/js/select2.min.js'),
                window.loadStyle('https://cdn.jsdelivr.net/npm/select2@4.1.0-rc.0/dist/css/select2.min.css'),
            ]);
            window.BTT_SELECT2_READY = true;
        })();
    }
    return window.BTT_SELECT2_PROMISE;
};

window.Select2Component = {
    props: ['options', 'modelValue', 'placeholder', 'maxSelectionLength', 'limitReachedMessage'],
    template: '<select multiple style="width: 100%;"></select>',
    methods: {
        getMaxSelectionLength() {
            const parsed = Number(this.maxSelectionLength);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        },
        async setupSelect2() {
            await window.ensureSelect2Loaded();
            if (this._isUnmounted || !this.$el) return;
            const vm = this;
            const maxSelectionLength = this.getMaxSelectionLength();
            const $el = $(this.$el);
            if ($el.hasClass('select2-hidden-accessible')) {
                $el.off('.bttSelect2');
                $el.select2('destroy');
            }
            $el.select2({
                data: this.options,
                placeholder: this.placeholder,
                allowClear: true,
                theme: "btt-dark",
                maxSelectionLength
            })
            .val(this.modelValue).trigger('change')
            .on('change.bttSelect2', function() {
                vm.$emit('update:modelValue', $(this).val() || []);
            })
            .on('select2:selecting.bttSelect2', function(e) {
                if (!maxSelectionLength) return;
                const selectedCount = ($(this).val() || []).length;
                if (selectedCount >= maxSelectionLength) {
                    if (vm.limitReachedMessage && window.showToast) {
                        window.showToast(vm.limitReachedMessage, true);
                    }
                    e.preventDefault();
                }
            });
        }
    },
    mounted() {
        this._isUnmounted = false;
        this.setupSelect2();
    },
    watch: {
        modelValue(value) {
            if (!window.BTT_SELECT2_READY || !this.$el) return;
            if ([...$(this.$el).val() || []].join(',') !== [...value || []].join(',')) $(this.$el).val(value).trigger('change');
        },
        options() { this.setupSelect2(); },
        maxSelectionLength() { this.setupSelect2(); },
        placeholder() { this.setupSelect2(); },
        limitReachedMessage() { this.setupSelect2(); }
    },
    unmounted() {
        this._isUnmounted = true;
        if (!window.BTT_SELECT2_READY || !this.$el) return;
        const $el = $(this.$el);
        if ($el.hasClass('select2-hidden-accessible')) {
            $el.off('.bttSelect2');
            $el.select2('destroy');
        }
    }
};

window.ContextMenu = {
    show: function(e, items) {
        e.preventDefault();
        const contextMenuEl = document.getElementById('custom-context-menu');
        if (!contextMenuEl) return;
        
        contextMenuEl.innerHTML = '';
        const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
        
        items.forEach(item => {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                contextMenuEl.appendChild(sep);
                return;
            }
            const el = document.createElement('div');
            el.className = 'context-menu-item' + (item.danger ? ' danger' : '');
            el.innerHTML = `${item.icon ? `<i class="fa-solid ${item.icon}" style="width: 16px; text-align: center;"></i>` : ''} <span>${t(item.label)}</span>`;
            el.onclick = (ev) => {
                if (ev) ev.stopPropagation();
                window.ContextMenu.hide();
                if (item.action) item.action();
            };
            contextMenuEl.appendChild(el);
        });

        contextMenuEl.style.display = 'flex';
        let x = e.clientX;
        let y = e.clientY;
        if (x + contextMenuEl.offsetWidth > window.innerWidth) x -= contextMenuEl.offsetWidth;
        if (y + contextMenuEl.offsetHeight > window.innerHeight) y -= contextMenuEl.offsetHeight;
        contextMenuEl.style.left = x + 'px';
        contextMenuEl.style.top = y + 'px';
    },
    hide: function() {
        const contextMenuEl = document.getElementById('custom-context-menu');
        if (contextMenuEl) contextMenuEl.style.display = 'none';
    }
};

document.addEventListener('click', (e) => {
    if (!e.target.closest('#custom-context-menu')) {
        if (window.ContextMenu) window.ContextMenu.hide();
    }
});

document.addEventListener('contextmenu', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (window.getSelection().toString().length > 0) return; 
    
    e.preventDefault();
    
    if (window.ContextMenu) window.ContextMenu.hide();
});

window.executePendingSearch = function() {
    if (!window.pendingSearch) return;

    let handled = false;

    const tsInput = document.getElementById('ts-search-input');
    if (tsInput) {
        tsInput.value = window.pendingSearch;
        tsInput.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-ts-search')?.click();
        handled = true;
    }

    const modInput = document.getElementById('mod-search-input');
    if (modInput) {
        modInput.value = window.pendingSearch;
        modInput.dispatchEvent(new Event('input', { bubbles: true }));
        handled = true;
    }

    const codexSearchInputIds = [
        'ally-search-input',
        'mount-search-input',
        'dragon-search-input',
        'memento-search-input',
        'recipe-search-input',
        'item-search-input',
        'fish-search-input',
        'badges-search-input'
    ];
    for (const id of codexSearchInputIds) {
        const input = document.getElementById(id);
        if (!input || input.offsetParent === null) continue;
        input.value = window.pendingSearch;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        handled = true;
    }

    if (handled) window.pendingSearch = null;
};

document.addEventListener('trovesaurus_loaded', () => setTimeout(() => window.executePendingSearch(), 0));
document.addEventListener('mod_manager_loaded', () => setTimeout(() => window.executePendingSearch(), 0));
['allies', 'mounts', 'dragons', 'mementos', 'recipes', 'items', 'fish', 'badges'].forEach((name) => {
    document.addEventListener(`${name}_loaded`, () => setTimeout(() => window.executePendingSearch(), 100));
});

document.addEventListener('DOMContentLoaded', async () => {
    await window.AppSettings.load();
    // Kick off the startup-URL check (deep-link routing) in parallel with the
    // sidebar/command-palette/server-time setup that follows. By the time we
    // actually need the value to decide between loadView('home') and
    // handle_deep_link, it's almost always already resolved.
    const startupUrlPromise = (window.eel && eel.get_startup_url)
        ? eel.get_startup_url()().catch(() => null)
        : Promise.resolve(null);
    if (window.JobQueue && typeof window.JobQueue.syncFromSettings === 'function') {
        window.JobQueue.syncFromSettings();
    }

    const accentColor = window.AppSettings.get('accent_color');
    if (accentColor) {
        document.documentElement.style.setProperty('--accent-blue', accentColor);
        const hex = String(accentColor).replace('#', '');
        if (hex.length === 6) {
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
        }
    }

    const cmdOverlay = document.getElementById('command-palette-overlay');
    const cmdInput = document.getElementById('cmd-input');
    const cmdResults = document.getElementById('cmd-results');
    const quickOpenCard = document.getElementById('quick-open-card');
    const quickOpenCardDismiss = document.getElementById('quick-open-card-dismiss');
    
    const commands = [
        { id: 'home', title: 'Home', icon: 'fa-house' },
        { id: 'mod_manager', title: 'My Mods', icon: 'fa-cubes', mmSection: 'mod_manager' },
        { id: 'mod_manager', title: 'Trovesaurus', imgIcon: 'https://trovesaurus.com/images/logos/Sage_64.png', mmSection: 'trovesaurus' },
        { id: 'modder_tools', title: 'File Explorer', icon: 'fa-folder-tree', modderTab: 'file_explorer' },
        { id: 'modder_tools', title: 'Update Tracker', icon: 'fa-satellite-dish', modderTab: 'update_tracker' },
        { id: 'modder_tools', title: 'Build TMod', icon: 'fa-hammer', modderTab: 'build' },
        { id: 'modder_tools', title: 'Extract TMod', icon: 'fa-box-open', modderTab: 'extract' },
        { id: 'modder_tools', title: 'Edit TMod', icon: 'fa-pen-to-square', modderTab: 'edit_tmod' },
        { id: 'modder_tools', title: 'Projects', icon: 'fa-diagram-project', modderTab: 'projects' },
        { id: 'modder_tools', title: 'Blueprint Editor', icon: 'fa-code', modderTab: 'qb_editor' },
        { id: 'modder_tools', title: 'Third Party Software', icon: 'fa-computer', modderTab: 'software' },
        { id: 'gems_and_builds', title: 'Gem Builds', icon: 'fa-dice-five', gemsTab: 'gem-builds' },
        { id: 'gems_and_builds', title: 'Star Chart', icon: 'fa-star', gemsTab: 'star-chart' },
        { id: 'gems_and_builds', title: 'Gem Evaluator', icon: 'fa-magnifying-glass-chart', gemsTab: 'gem-evaluator' },
        { id: 'gems_and_builds', title: 'Gem Simulator', icon: 'fa-gem', gemsTab: 'gem-simulator' },
        { id: 'calculators', title: 'Calculators', icon: 'fa-calculator' },
        { id: 'codexes', title: 'Ally Codex', icon: 'fa-paw', codexTab: 'allies', beta: true },
        { id: 'codexes', title: 'Mount Codex', icon: 'fa-horse', codexTab: 'mounts', beta: true },
        { id: 'codexes', title: 'Dragon Codex', icon: 'fa-dragon', codexTab: 'dragons', beta: true },
        { id: 'codexes', title: 'Memento Codex', icon: 'fa-scroll', codexTab: 'mementos', beta: true },
        { id: 'codexes', title: 'Recipe Codex', icon: 'fa-book', codexTab: 'recipes', beta: true },
        { id: 'codexes', title: 'Item Codex', icon: 'fa-box', codexTab: 'items', beta: true },
        { id: 'codexes', title: 'Fish Codex', icon: 'fa-fish', codexTab: 'fish', beta: true },
        { id: 'codexes', title: 'Badge Codex', icon: 'fa-shield-halved', codexTab: 'badges', beta: true },
        { id: 'settings', title: 'Settings', icon: 'fa-gear' },
        { id: 'about', title: 'About', icon: 'fa-circle-info' },
        { id: 'documentation', title: 'Documentation', icon: 'fa-book', url: 'https://trove.aallyn.net/documentation' }
    ];

    let activeCmdIndex = 0;

    function openCommandPalette() {
        if (!cmdOverlay || !cmdInput) return;
        cmdOverlay.style.display = 'flex';
        cmdInput.value = '';
        activeCmdIndex = 0;
        renderCmdResults();
        cmdInput.focus();
    }

    const quickOpenCardPrefKey = 'hint_command_palette_card_v1';
    const hideQuickOpenCard = () => {
        if (!quickOpenCard) return;
        quickOpenCard.style.display = 'none';
        if (window.AppSettings) {
            window.AppSettings.setPrefSync(quickOpenCardPrefKey, 'dismissed');
        }
    };

    const showQuickOpenCard = () => {
        if (!quickOpenCard) return;
        quickOpenCard.style.display = '';
    };

    function renderCmdResults(filter = "") {
        const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
        const query = filter.trim();
        let displayCommands = [];

        const codexSearchTargets = [
            { codexTab: 'allies', label: 'Allies', icon: 'fa-paw' },
            { codexTab: 'mounts', label: 'Mounts', icon: 'fa-horse' },
            { codexTab: 'dragons', label: 'Dragons', icon: 'fa-dragon' },
            { codexTab: 'mementos', label: 'Mementos', icon: 'fa-scroll' },
            { codexTab: 'recipes', label: 'Recipes', icon: 'fa-book' },
            { codexTab: 'items', label: 'Items', icon: 'fa-box' },
            { codexTab: 'fish', label: 'Fish', icon: 'fa-fish' },
            { codexTab: 'badges', label: 'Badges', icon: 'fa-shield-halved' }
        ];
        const buildCodexSearchCommands = (sq) => {
            if (areBetaFeaturesHidden() || isWebUnavailableView('codexes')) return [];
            return codexSearchTargets.map(target => ({
                id: 'codexes',
                title: `Search ${target.label}: "${sq}"`,
                icon: target.icon,
                codexTab: target.codexTab,
                query: sq,
                beta: true
            }));
        };

        if (query.startsWith('@')) {
            const sq = query.substring(1).trim();
            if (sq && !isWebUnavailableView('mod_manager')) {
                displayCommands.push({ id: 'mod_manager', title: `Search Trovesaurus: "${sq}"`, imgIcon: 'https://trovesaurus.com/images/logos/Sage_64.png', mmSection: 'trovesaurus', query: sq });
            }
        } else if (query.startsWith('#')) {
            const sq = query.substring(1).trim();
            if (sq) displayCommands.push(...buildCodexSearchCommands(sq));
        } else {
            const sq = query.startsWith('>') ? query.substring(1).trim() : query;
            displayCommands = commands
                .filter(isCommandVisible)
                .map(c => ({
                    ...c,
                    _score: Math.max(
                        window.fuzzyMatchScore(t(c.title), sq),
                        window.fuzzyMatchScore(c.id, sq)
                    )
                }))
                .filter(c => !sq || c._score > 0)
                .sort((a, b) => b._score - a._score);

            if (sq.length >= 3 && displayCommands.length === 0) {
                if (!isWebUnavailableView('mod_manager')) {
                    displayCommands.push({ id: 'mod_manager', title: `Search Trovesaurus: "${sq}"`, imgIcon: 'https://trovesaurus.com/images/logos/Sage_64.png', mmSection: 'trovesaurus', query: sq });
                }
                displayCommands.push(...buildCodexSearchCommands(sq));
            }
        }

        if (displayCommands.length === 0) {
            cmdResults.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">${t("app.no_results_found")}</div>`;
            return;
        }
        
        if (activeCmdIndex >= displayCommands.length) activeCmdIndex = 0;
        
        cmdResults.innerHTML = displayCommands.map((c, i) => `
            <div class="cmd-result-item ${i === activeCmdIndex ? 'active' : ''}" data-target="${c.id}" data-url="${c.url || ''}" data-modder-tab="${c.modderTab || ''}" data-mm-section="${c.mmSection || ''}" data-gems-tab="${c.gemsTab || ''}" data-codex-tab="${c.codexTab || ''}" data-query="${c.query || ''}">
                <div class="cmd-result-icon">${c.imgIcon ? `<img src="${c.imgIcon}" style="width: 20px; height: 20px; object-fit: contain; vertical-align: middle;">` : `<i class="fa-solid ${c.icon}"></i>`}</div>
                <div>${t(c.title)}</div>
            </div>
        `).join('');

        const activeEl = cmdResults.querySelector('.cmd-result-item.active');
        if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    }

    function openCommandResult(itemEl) {
        const target = itemEl.getAttribute('data-target');
        const url = itemEl.getAttribute('data-url');
        if (url) {
            try {
                if (window.eel && eel.open_url_in_browser) eel.open_url_in_browser(url)();
                else window.open(url, '_blank', 'noopener');
            } catch (e) {
                window.open(url, '_blank', 'noopener');
            }
            return;
        }
        if (isWebUnavailableView(target)) return;
        const modderTab = itemEl.getAttribute('data-modder-tab');
        const mmSection = itemEl.getAttribute('data-mm-section');
        const gemsTab = itemEl.getAttribute('data-gems-tab');
        const codexTab = itemEl.getAttribute('data-codex-tab');
        if (modderTab) {
            window.pendingModderToolsTab = modderTab;
        }
        if (mmSection) {
            window.pendingModManagerSection = mmSection;
        }
        if (gemsTab) {
            window.pendingGemsTab = gemsTab;
        }
        if (codexTab) {
            window.pendingCodexTab = codexTab;
        }
        window.loadView(target);
    }

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            if (cmdOverlay.style.display === 'flex') { cmdOverlay.style.display = 'none'; } 
            else { openCommandPalette(); }
        } else if (e.key === 'Escape' && cmdOverlay.style.display === 'flex') { cmdOverlay.style.display = 'none'; } 
        else if (cmdOverlay.style.display === 'flex') {
            if (e.key === 'ArrowDown') { e.preventDefault(); activeCmdIndex++; renderCmdResults(cmdInput.value); } 
            else if (e.key === 'ArrowUp') { e.preventDefault(); activeCmdIndex = Math.max(0, activeCmdIndex - 1); renderCmdResults(cmdInput.value); } 
            else if (e.key === 'Enter') {
                e.preventDefault();
                const activeEl = cmdResults.querySelector('.cmd-result-item.active');
                if (activeEl) { 
                    const q = activeEl.getAttribute('data-query');
                    if (q) window.pendingSearch = q;
                    openCommandResult(activeEl);
                    cmdOverlay.style.display = 'none'; 
                }
            }
        } else if ((e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) && !e.target.matches('input, textarea')) {
            e.preventDefault();
            const searchInputs = [
                'ts-search-input',
                'mod-search-input',
                'ally-search-input',
                'mount-search-input',
                'dragon-search-input',
                'memento-search-input',
                'recipe-search-input',
                'item-search-input',
                'fish-search-input',
                'badges-search-input',
                'tree-search'
            ];
            for (let id of searchInputs) {
                const input = document.getElementById(id);
                if (input && input.offsetParent !== null) {
                    input.focus();
                    input.select();
                    
                    const originalBoxShadow = input.style.boxShadow;
                    input.style.boxShadow = '0 0 15px var(--accent-blue, #5ec6ff)';
                    setTimeout(() => input.style.boxShadow = originalBoxShadow, 400);
                    break;
                }
            }
        }
    });

    cmdInput.addEventListener('input', (e) => { activeCmdIndex = 0; renderCmdResults(e.target.value); });
    cmdResults.addEventListener('click', (e) => { 
        const item = e.target.closest('.cmd-result-item'); 
        if (item) { 
            const q = item.getAttribute('data-query');
            if (q) window.pendingSearch = q;
            openCommandResult(item);
            cmdOverlay.style.display = 'none'; 
        } 
    });
    cmdOverlay.addEventListener('click', (e) => { if (e.target === cmdOverlay) cmdOverlay.style.display = 'none'; });
    if (quickOpenCard) {
        quickOpenCard.addEventListener('click', openCommandPalette);
        quickOpenCard.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openCommandPalette();
            }
        });
    }
    if (quickOpenCardDismiss) {
        const dismissQuickOpen = (e) => {
            e.preventDefault();
            e.stopPropagation();
            hideQuickOpenCard();
        };
        quickOpenCardDismiss.addEventListener('click', dismissQuickOpen);
        quickOpenCardDismiss.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') dismissQuickOpen(e);
        });
    }

    const navButtons = document.querySelectorAll('.nav-btn');
    const viewContainer = document.getElementById('view-container');
    const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
    let lastNavBlockToastAt = 0;

    const burgerBtn = document.getElementById('burger-btn');
    const sidebar = document.getElementById('sidebar');
    let activeViewLoadToken = 0;
    let activeViewLoadController = null;
    const loadedViewStyles = new Map();

    const webUnavailableViews = new Set(window.BTT_UNAVAILABLE_WEB_VIEWS || []);
    const isWebUnavailableView = (target) => window.BTT_WEB_MODE === true && webUnavailableViews.has(target);
    const areBetaFeaturesHidden = () => window.AppSettings && window.AppSettings.get('hide_beta_features', false) === true;

    const isCommandVisible = (command) => {
        if (!command) return false;
        if (isWebUnavailableView(command.id)) return false;
        return !(command.beta === true && areBetaFeaturesHidden());
    };

    const getDirectiveAttributes = (element) => {
        if (!element) return [];
        return element.getAttributeNames()
            .filter((name) => name.startsWith(':') || name.startsWith('@') || name.startsWith('v-'))
            .map((name) => String(element.getAttribute(name) || ''));
    };

    const inferTabKeyFromButton = (button) => {
        if (!button) return '';
        const sources = [
            ...getDirectiveAttributes(button),
            String(button.getAttribute('onclick') || '')
        ];
        const patterns = [
            /activeTab\s*===\s*['"]([^'"]+)['"]/,
            /activeTab\s*=\s*['"]([^'"]+)['"]/,
            /setActiveTab\(\s*['"]([^'"]+)['"]\s*\)/
        ];
        for (const source of sources) {
            for (const pattern of patterns) {
                const match = source.match(pattern);
                if (match && match[1]) return match[1];
            }
        }
        return '';
    };

    const findTabContentsForKey = (container, tabKey) => {
        if (!container || !tabKey) return [];
        return [...container.querySelectorAll('.tab-content')].filter((content) => {
            if (content.dataset.bttTabKey === tabKey) return true;
            return content.getAttributeNames().some((name) => {
                const value = content.getAttribute(name);
                return typeof value === 'string' && value.includes(tabKey);
            });
        });
    };

    const setBetaElementHidden = (element, hidden) => {
        if (!element) return;
        element.dataset.bttBetaHidden = hidden ? 'true' : 'false';
        element.style.display = hidden ? 'none' : '';
        element.hidden = hidden;
    };

    const applyBetaVisibilityToContainer = (container) => {
        if (!container) return;
        const hideBetaFeatures = areBetaFeaturesHidden();

        container.querySelectorAll('.tab-btn').forEach((button) => {
            const hasBetaLabel = !!button.querySelector('.beta-label');
            const tabKey = inferTabKeyFromButton(button);
            if (tabKey) button.dataset.bttTabKey = tabKey;
            if (!hasBetaLabel) return;

            setBetaElementHidden(button, hideBetaFeatures);
            findTabContentsForKey(container, tabKey).forEach((content) => {
                if (tabKey) content.dataset.bttTabKey = tabKey;
                setBetaElementHidden(content, hideBetaFeatures);
            });
        });
    };

    const enforceVisibleBetaTabFallback = (container) => {
        if (!container || !areBetaFeaturesHidden()) return;

        const hiddenActiveButton = container.querySelector('.tab-btn.active[data-btt-beta-hidden="true"]');
        const hiddenActiveContent = container.querySelector('.tab-content.active[data-btt-beta-hidden="true"]');
        if (!hiddenActiveButton && !hiddenActiveContent) return;

        const fallbackButton = [...container.querySelectorAll('.tab-btn')]
            .find((button) => button.dataset.bttBetaHidden !== 'true' && button.offsetParent !== null && !button.disabled);
        if (fallbackButton) {
            fallbackButton.click();
        }
    };

    const isViewVisible = (target) => {
        if (isWebUnavailableView(target)) return false;
        const navBtn = document.querySelector(`.nav-btn[data-target="${target}"]`);
        if (!navBtn) return true;
        return navBtn.style.display !== 'none' && !navBtn.hidden;
    };

    const applyBetaFeatureVisibility = async () => {
        if (window.AppSettings) {
            await window.AppSettings.load();
        }

        const hideBetaFeatures = areBetaFeaturesHidden();
        document.querySelectorAll('#sidebar .nav-btn').forEach((btn) => {
            const target = btn.getAttribute('data-target');
            const shouldHideForWeb = isWebUnavailableView(target);
            if (shouldHideForWeb) {
                btn.classList.add('web-desktop-only-btn');
                btn.setAttribute('data-tooltip-text', t('app.only_available_in_the_desktop_app'));
                let desktopLabel = btn.querySelector('.desktop-app-label');
                if (!desktopLabel) {
                    desktopLabel = document.createElement('span');
                    desktopLabel.className = 'desktop-app-label';
                    btn.appendChild(desktopLabel);
                }
                // Always (re)set the text so a re-run after i18n loads replaces a
                // raw token stamped before the dictionary was ready.
                desktopLabel.textContent = t('app.desktop_app');
                const menuItem = btn.closest('li');
                if (menuItem) {
                    menuItem.style.display = '';
                    menuItem.hidden = false;
                } else {
                    btn.style.display = '';
                    btn.hidden = false;
                }
                return;
            }
            btn.classList.remove('web-desktop-only-btn');
            btn.querySelector('.desktop-app-label')?.remove();
            if (!btn.querySelector('.beta-label')) return;
            const menuItem = btn.closest('li');
            if (menuItem) {
                menuItem.style.display = hideBetaFeatures ? 'none' : '';
                menuItem.hidden = hideBetaFeatures;
            } else {
                btn.style.display = hideBetaFeatures ? 'none' : '';
                btn.hidden = hideBetaFeatures;
            }
        });

        const currentTarget = document.querySelector('.nav-btn.active')?.getAttribute('data-target');
        if (currentTarget && !isViewVisible(currentTarget) && typeof window.loadView === 'function') {
            await window.loadView('home');
        }

        if (cmdOverlay && cmdOverlay.style.display === 'flex') {
            activeCmdIndex = 0;
            renderCmdResults(cmdInput ? cmdInput.value : '');
        }
    };

    // i18n loads its dictionary asynchronously (it fetches _ui_ids.json + the
    // locale file). The web-mode "Desktop App" sidebar markers above are stamped
    // imperatively via t(), which at startup can run before that finishes -> they
    // would show the raw token (e.g. "app.desktop_app"). Re-apply them whenever
    // i18n (re)resolves a language so they pick up the translated text. Registered
    // here, before the startup await below, so it can't miss the first event.
    window.addEventListener('languagechange', () => {
        void applyBetaFeatureVisibility();
    });

    function extractViewContentAndStyles(html) {
        const parser = new DOMParser();
        const parsed = parser.parseFromString(html, 'text/html');

        const stylesheetHrefs = [...parsed.querySelectorAll('link[rel="stylesheet"][href]')]
            .map(link => link.getAttribute('href'))
            .filter(Boolean);

        let contentHtml = parsed.body ? parsed.body.innerHTML.trim() : '';
        if (!contentHtml) {
            // Fallback for malformed partials: strip any head block and keep the rest.
            contentHtml = html.replace(/<head[\s\S]*?<\/head>/i, '').trim();
        }

        return { contentHtml, stylesheetHrefs };
    }

    async function ensureViewStylesLoaded(stylesheetHrefs, abortSignal) {
        const absoluteHrefs = stylesheetHrefs.map(href => new URL(href, window.location.href).href);
        const pendingLoads = stylesheetHrefs.map((href, index) => {
            const absoluteHref = absoluteHrefs[index];
            if (loadedViewStyles.has(absoluteHref)) return loadedViewStyles.get(absoluteHref).promise;

            const existingLink = [...document.querySelectorAll('link[rel="stylesheet"][href]')]
                .find(link => new URL(link.href, window.location.href).href === absoluteHref);

            const linkEl = existingLink || (() => {
                const newLink = document.createElement('link');
                newLink.rel = 'stylesheet';
                newLink.href = href;
                document.head.appendChild(newLink);
                return newLink;
            })();
            linkEl.setAttribute('data-view-style-managed', 'true');

            const loadPromise = new Promise((resolve, reject) => {
                if (abortSignal?.aborted) {
                    reject(new DOMException('View style load aborted', 'AbortError'));
                    return;
                }

                const done = () => {
                    cleanup();
                    resolve();
                };

                const fail = () => {
                    cleanup();
                    reject(new Error(`Failed to load stylesheet: ${href}`));
                };

                const onAbort = () => {
                    cleanup();
                    reject(new DOMException('View style load aborted', 'AbortError'));
                };

                const cleanup = () => {
                    linkEl.removeEventListener('load', done);
                    linkEl.removeEventListener('error', fail);
                    abortSignal?.removeEventListener('abort', onAbort);
                };

                if (linkEl.sheet) {
                    resolve();
                    return;
                }

                linkEl.addEventListener('load', done, { once: true });
                linkEl.addEventListener('error', fail, { once: true });
                abortSignal?.addEventListener('abort', onAbort, { once: true });
            });

            loadedViewStyles.set(absoluteHref, { promise: loadPromise, linkEl });
            return loadPromise;
        });

        await Promise.all(pendingLoads);
        return absoluteHrefs;
    }

    function activateViewStyles(activeAbsoluteHrefs) {
        const activeSet = new Set(activeAbsoluteHrefs);
        document.querySelectorAll('link[data-view-style-managed="true"]').forEach((link) => {
            const absoluteHref = new URL(link.href, window.location.href).href;
            link.disabled = !activeSet.has(absoluteHref);
        });
    }

    if (sidebar && window.AppSettings) {
        try {
            await window.AppSettings.load();
            await applyBetaFeatureVisibility();
            if (window.AppSettings.getPref('sidebar_collapsed', false)) {
                sidebar.classList.add('collapsed');
            }
            if (window.AppSettings.getPref(quickOpenCardPrefKey, '') === 'dismissed') {
                hideQuickOpenCard();
            } else {
                showQuickOpenCard();
            }
        } catch {}
    }

    document.addEventListener('app_settings_updated', () => {
        void applyBetaFeatureVisibility();
    });

    if (burgerBtn && sidebar) {
        burgerBtn.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
            if (window.AppSettings) {
                window.AppSettings.setPrefSync('sidebar_collapsed', sidebar.classList.contains('collapsed'));
            }
        });
    }

    // --- Mobile off-canvas nav drawer -------------------------------------
    // On phones/tablets (<=900px, see style.css) the sidebar is a fixed drawer.
    // This toggle/backdrop/Esc wiring opens & closes it; closeMobileNav() is also
    // called after navigating so tapping a tool dismisses the drawer.
    const mobileNavToggle = document.getElementById('mobile-nav-toggle');
    const mobileNavBackdrop = document.getElementById('mobile-nav-backdrop');
    const closeMobileNav = () => {
        document.body.classList.remove('mobile-nav-open');
        if (mobileNavToggle) mobileNavToggle.setAttribute('aria-expanded', 'false');
    };
    const toggleMobileNav = () => {
        const isOpen = document.body.classList.toggle('mobile-nav-open');
        if (mobileNavToggle) mobileNavToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };
    if (mobileNavToggle) mobileNavToggle.addEventListener('click', toggleMobileNav);
    if (mobileNavBackdrop) mobileNavBackdrop.addEventListener('click', closeMobileNav);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('mobile-nav-open')) closeMobileNav();
    });
    window.closeMobileNav = closeMobileNav;

    // --- Mobile collapsible tabs ------------------------------------------
    // On small screens (<=900px, see style.css) a view's .tab-buttons row shows
    // as icon-only squares. We inject a toggle that expands it to a labelled
    // column; choosing a tab auto-collapses it again. Works across all views via
    // a MutationObserver on #view-container, so lazy-loaded views are covered too.
    (function setupCollapsibleTabs() {
        const vc = viewContainer;
        if (!vc) return;

        const setToggleIcon = (tog, expanded) => {
            tog.classList.toggle('is-expanded', expanded);
            tog.innerHTML = expanded ? '<i class="fa-solid fa-xmark"></i>' : '<i class="fa-solid fa-ellipsis"></i>';
            tog.setAttribute('aria-label', expanded ? 'Hide tab labels' : 'Show tab labels');
        };

        const collapse = (row) => {
            row.classList.remove('tabs-expanded');
            const tog = row.querySelector(':scope > .tabs-mobile-toggle');
            if (tog) setToggleIcon(tog, false);
        };

        // Inject the toggle element only (NO per-element handler — clicks are
        // handled by delegation below, so re-renders that drop the element are
        // harmless: the re-injected one keeps working).
        const injectToggle = (row) => {
            if (!row || row.querySelector(':scope > .tabs-mobile-toggle')) return;
            if (row.querySelectorAll(':scope > .tab-btn').length < 2) return;  // nothing to collapse
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tabs-mobile-toggle';
            btn.setAttribute('aria-label', 'Show tab labels');
            btn.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
            row.appendChild(btn);
        };

        const scanAll = () => vc.querySelectorAll('.tab-buttons').forEach(injectToggle);

        scanAll();
        new MutationObserver(scanAll).observe(vc, { childList: true, subtree: true });

        // One delegated click handler for both the toggle and tab selection.
        vc.addEventListener('click', (e) => {
            const tog = e.target.closest('.tabs-mobile-toggle');
            if (tog) {
                e.preventDefault();
                e.stopPropagation();
                const row = tog.closest('.tab-buttons');
                if (row) setToggleIcon(tog, row.classList.toggle('tabs-expanded'));
                return;
            }
            const tab = e.target.closest('.tab-btn');
            if (tab) {
                const row = tab.closest('.tab-buttons');
                if (row && row.classList.contains('tabs-expanded')) collapse(row);
            }
        });
    })();

    window.loadView = async function(target) {
        const loadToken = ++activeViewLoadToken;
        if (activeViewLoadController) {
            try { activeViewLoadController.abort(); } catch {}
        }
        activeViewLoadController = new AbortController();

        try {
            const currentTarget = document.querySelector('.nav-btn.active')?.getAttribute('data-target') || null;
            const isSwitchingTabs = !!currentTarget && !!target && currentTarget !== target;
            const hasBlockingJobs = (() => {
                if (!window.JobQueue || typeof window.JobQueue.getJobs !== 'function') return false;
                const jobs = window.JobQueue.getJobs() || [];
                return jobs.some(j => j && (j.status === 'running' || j.status === 'cancelling'));
            })();

            if (!isViewVisible(target)) {
                return false;
            }

            if (isSwitchingTabs && hasBlockingJobs) {
                const now = Date.now();
                if (now - lastNavBlockToastAt > 1200) {
                    window.showToast(t('app.cannot_switch_tabs_while_a_job_is_runnin_b3bddf'), true);
                    lastNavBlockToastAt = now;
                }
                return false;
            }

            if (isSwitchingTabs && currentTarget === 'home' && target !== 'home') {
                document.dispatchEvent(new CustomEvent('home_unloading', { detail: { from: currentTarget, to: target } }));
                if (window._homeApp && typeof window._homeApp.unmount === 'function') {
                    try { window._homeApp.unmount(); } catch {}
                    window._homeApp = null;
                }
            }

            if (isSwitchingTabs && currentTarget === 'codexes' && target !== 'codexes') {
                if (window._codexesApp && typeof window._codexesApp.unmount === 'function') {
                    try { window._codexesApp.unmount(); } catch {}
                    window._codexesApp = null;
                }
                window.CodexGamePathApi = null;
                window.getSelectedCodexGamePath = null;
            }

            const response = await fetch(`views/${target}.html`, { signal: activeViewLoadController.signal, cache: 'no-store' });
            if (loadToken !== activeViewLoadToken) return false;
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const html = await response.text();
            if (loadToken !== activeViewLoadToken) return false;

            const { contentHtml, stylesheetHrefs } = extractViewContentAndStyles(html);
            const activeStyleHrefs = await ensureViewStylesLoaded(stylesheetHrefs, activeViewLoadController.signal);
            if (loadToken !== activeViewLoadToken) return false;
            activateViewStyles(activeStyleHrefs);

            viewContainer.innerHTML = contentHtml;
            if (loadToken !== activeViewLoadToken) return false;
            applyBetaVisibilityToContainer(viewContainer);

            navButtons.forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-target') === target);
            });

            if (window.I18nManager) {
                await window.I18nManager.translatePage();
                if (loadToken !== activeViewLoadToken) return false;
            }

            window.applyCustomDropdowns();
            if (loadToken !== activeViewLoadToken) return false;

            const viewScripts = (window.BTT_VIEW_SCRIPTS && window.BTT_VIEW_SCRIPTS[target]) || [];
            if (viewScripts.length) {
                try { await window.loadScripts(viewScripts); } catch (e) { console.error(`Failed to lazy-load scripts for ${target}:`, e); }
                if (loadToken !== activeViewLoadToken) return false;
            }

            const event = new CustomEvent(`${target}_loaded`);
            document.dispatchEvent(event);
            setTimeout(() => {
                if (loadToken === activeViewLoadToken) {
                    applyBetaVisibilityToContainer(viewContainer);
                    enforceVisibleBetaTabFallback(viewContainer);
                }
            }, 0);
            
            console.log(`Successfully loaded view: ${target}`);
            return true;
        } catch (err) {
            if (loadToken !== activeViewLoadToken || (err && err.name === 'AbortError')) {
                return false;
            }
            console.error("View loading error:", err);
            const errorMsg = t("app.failed_to_load_view_error").replace("{error}", err.message);
            viewContainer.innerHTML = `<div style="color: #ff5555; padding: 40px; text-align: center;">${errorMsg}</div>`;
            return false;
        } finally {
            if (loadToken === activeViewLoadToken) {
                activeViewLoadController = null;
            }
        }
    };

    const showDesktopOnlyPrompt = async () => {
        let confirmed = true;
        if (typeof window.showConfirmModal === 'function') {
            confirmed = await window.showConfirmModal({
                title: t('app.desktop_app_required'),
                message: t('app.this_tool_is_only_available_in_the_deskt_47d907'),
                confirmLabel: t('app.install_now'),
                cancelLabel: t('common.cancel'),
                danger: false
            });
        }
        if (confirmed) {
            window.location.href = 'https://trove.aallyn.net';
        }
    };

    const NAV_VISITS_PREF_KEY = 'home_nav_visits';
    const trackNavVisit = (target) => {
        if (!target || target === 'home' || !window.AppSettings) return;
        const visits = { ...(window.AppSettings.getPref(NAV_VISITS_PREF_KEY, {}) || {}) };
        visits[target] = (Number(visits[target]) || 0) + 1;
        window.AppSettings.setPrefSync(NAV_VISITS_PREF_KEY, visits);
    };

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-target');
            if (isWebUnavailableView(target)) {
                showDesktopOnlyPrompt();
                return;
            }
            if (target) {
                trackNavVisit(target);
                window.loadView(target);
            }
            closeMobileNav();  // dismiss the mobile drawer after picking a tool
        });
    });

    // Documentation shortcut — opens the hosted user manual in the browser
    // (works in both the desktop app via eel and in hosted web mode).
    const docsLinkBtn = document.getElementById('docs-link-btn');
    if (docsLinkBtn) {
        const DOCS_URL = 'https://trove.aallyn.net/documentation';
        docsLinkBtn.addEventListener('click', () => {
            try {
                if (window.eel && eel.open_url_in_browser) eel.open_url_in_browser(DOCS_URL)();
                else window.open(DOCS_URL, '_blank', 'noopener');
            } catch (e) {
                window.open(DOCS_URL, '_blank', 'noopener');
            }
        });
    }

    document.addEventListener('btt_navigate', (e) => {
        const target = e?.detail?.target;
        if (!target) return;
        if (isWebUnavailableView(target)) {
            showDesktopOnlyPrompt();
            return;
        }
        if (e.detail.modderTab) window.pendingModderToolsTab = e.detail.modderTab;
        if (e.detail.mmSection) window.pendingModManagerSection = e.detail.mmSection;
        if (e.detail.gemsTab) window.pendingGemsTab = e.detail.gemsTab;
        if (e.detail.codexTab) window.pendingCodexTab = e.detail.codexTab;
        trackNavVisit(target);
        window.loadView(target);
    });

    const langSelect = document.getElementById('global-language-select');
    if (langSelect && window.I18nManager) {
        langSelect.addEventListener('change', async (e) => {
            await window.I18nManager.setLocale(e.target.value);
            await window.I18nManager.translatePage();
            const currentView = document.querySelector('.nav-btn.active')?.getAttribute('data-target');
            if (currentView) window.loadView(currentView);
        });
    }

    const dateEl = document.getElementById('server-time-date');
    const clockEl = document.getElementById('server-time-clock');
    // Cache hero + modal refs once. They live in index.html so they're always
    // present; we don't need to re-query them every second.
    const heroDateEl = document.getElementById('st-hero-date');
    const heroClockEl = document.getElementById('st-hero-clock');
    const timeModalEl = document.getElementById('server-time-modal');
    const modalListEl = document.getElementById('st-timezones-list');

    // Track last-rendered values so we skip textContent writes (which dirty the
    // layout) when the displayed string hasn't actually changed.
    let lastSidebarDate = '';
    let lastSidebarClock = '';
    let lastHeroDate = '';
    let lastHeroClock = '';

    function updateServerTime() {
        if (!dateEl || !clockEl) return;
        const now = new Date();
        const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
        const troveMs = utcMs - (11 * 3600000);
        const troveTime = new Date(troveMs);

        const locale = window.I18nManager ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US';
        const sidebarDate = troveTime.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
        const sidebarClock = troveTime.toLocaleTimeString(locale, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

        if (sidebarDate !== lastSidebarDate) { dateEl.textContent = sidebarDate; lastSidebarDate = sidebarDate; }
        if (sidebarClock !== lastSidebarClock) { clockEl.textContent = sidebarClock; lastSidebarClock = sidebarClock; }

        // Only touch hero + modal DOM when the modal is actually open.
        const modalOpen = timeModalEl && timeModalEl.style.display === 'flex';
        if (!modalOpen) return;

        if (heroDateEl && sidebarDate !== lastHeroDate) { heroDateEl.textContent = sidebarDate; lastHeroDate = sidebarDate; }
        if (heroClockEl && sidebarClock !== lastHeroClock) { heroClockEl.textContent = sidebarClock; lastHeroClock = sidebarClock; }

        if (!modalListEl) return;
        let html = '';
        window.globalTimezones.forEach(tz => {
            let timeStr, dateStr;
            try {
                if (tz.id === 'trove') {
                    timeStr = sidebarClock;
                    dateStr = sidebarDate;
                } else if (tz.id === 'local') {
                    timeStr = now.toLocaleTimeString(locale, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    dateStr = now.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
                } else {
                    timeStr = now.toLocaleTimeString(locale, { timeZone: tz.id, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    dateStr = now.toLocaleDateString(locale, { timeZone: tz.id, weekday: 'short', month: 'short', day: 'numeric' });
                }
            } catch(e) {
                timeStr = "--:--:--";
                dateStr = "---";
            }

            const isMain = tz.id === 'trove';
            html += `
                <div class="tz-row ${isMain ? 'highlight' : ''}">
                    <div class="tz-name">${t(tz.name)}</div>
                    <div style="text-align: right;">
                        <div class="tz-time">${timeStr}</div>
                        <div class="tz-date">${dateStr}</div>
                    </div>
                </div>
            `;
        });
        modalListEl.innerHTML = html;
    }
    
    window.globalTimezones = [
        { id: 'trove', name: 'Trove Server (Reset)' },
        { id: 'local', name: 'Local Time' },
        { id: 'UTC', name: 'UTC' },
        { id: 'America/Sao_Paulo', name: 'Brazil (Brasília)' },
        { id: 'America/New_York', name: 'US Eastern' },
        { id: 'America/Los_Angeles', name: 'US Pacific' },
        { id: 'Europe/Lisbon', name: 'Portugal / UK' },
        { id: 'Europe/Paris', name: 'Central Europe (FR, DE, ES)' },
        { id: 'Europe/Moscow', name: 'Russia (Moscow)' },
        { id: 'Asia/Shanghai', name: 'China (Beijing)' },
        { id: 'Asia/Tokyo', name: 'Japan & South Korea' },
        { id: 'Australia/Sydney', name: 'Australia (Sydney)' }
    ];

    updateServerTime();
    setInterval(updateServerTime, 1000);
    
    const convInput = document.getElementById('st-converter-input');
    const convTz = document.getElementById('st-converter-tz');
    const convResult = document.getElementById('st-converter-result');
    const discordFormat = document.getElementById('st-discord-format');
    const btnCopyNormal = document.getElementById('st-btn-copy-normal');
    const btnCopyDiscord = document.getElementById('st-btn-copy-discord');
    let currentUnixSeconds = 0;

    const formatUtcTimestamp = (unixSec) => {
        const d = new Date(unixSec * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
    };

    if (convTz) {
        window.globalTimezones.forEach(tz => {
            const opt = document.createElement('option');
            opt.value = tz.id;
            opt.textContent = t(tz.name);
            convTz.appendChild(opt);
        });
        convTz.value = 'local';
    }

    if (convInput) {
        const nowLocal = new Date();
        nowLocal.setMinutes(nowLocal.getMinutes() - nowLocal.getTimezoneOffset());
        convInput.value = nowLocal.toISOString().slice(0, 16);
    }

    // Flatpickr is only used by the server-time converter input. Load it
    // lazily the first time the user opens the modal — saves ~50KB JS + CSS
    // for everyone who never opens it.
    window.ensureFlatpickrLoaded = function () {
        if (window.BTT_FLATPICKR_READY) return Promise.resolve();
        if (!window.BTT_FLATPICKR_PROMISE) {
            window.BTT_FLATPICKR_PROMISE = (async () => {
                await Promise.all([
                    window.loadScript('https://cdn.jsdelivr.net/npm/flatpickr'),
                    window.loadStyle('https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css'),
                    window.loadStyle('https://cdn.jsdelivr.net/npm/flatpickr/dist/themes/dark.css'),
                ]);
                window.BTT_FLATPICKR_READY = true;
                if (convInput && window.flatpickr) {
                    flatpickr(convInput, {
                        enableTime: true,
                        dateFormat: "Y-m-d\\TH:i",
                        time_24hr: true,
                        onChange: doTimeConversion
                    });
                }
            })();
        }
        return window.BTT_FLATPICKR_PROMISE;
    };

    function doTimeConversion() {
        if (!convInput || !convInput.value) return;
        const d = new Date(convInput.value);
        if (isNaN(d)) return;
        
        const zone = convTz.value;
        let unixSec = 0;
        
        if (zone === 'local') unixSec = Math.floor(d.getTime() / 1000);
        else if (zone === 'trove') unixSec = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) / 1000) + 11 * 3600;
        else if (zone === 'UTC') unixSec = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) / 1000);
        else {
            const utcDate = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()));
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(utcDate);
            const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value;
            let offsetMs = 0;
            if (offsetPart && offsetPart.startsWith('GMT')) {
                if (offsetPart === 'GMT') offsetMs = 0;
                else {
                    const match = offsetPart.match(/GMT([+-]\d+)(?::(\d+))?/);
                    if (match) offsetMs = (parseInt(match[1]) * 3600 + (parseInt(match[1]) < 0 ? -parseInt(match[2]||0) : parseInt(match[2]||0)) * 60) * 1000;
                }
            }
            unixSec = Math.floor((utcDate.getTime() - offsetMs) / 1000);
        }
        currentUnixSeconds = unixSec;
        const locale = window.I18nManager ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US';
        try { convResult.textContent = new Intl.DateTimeFormat(locale, { timeZone: 'Pacific/Midway', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(unixSec * 1000)); } catch(e) { convResult.textContent = "Error"; }

        if (discordFormat) {
            try {
                const targetDate = new Date(unixSec * 1000);
                const diffMin = (targetDate.getTime() - Date.now()) / 60000;
                
                let fmt_R = "";
                try {
                    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
                    if (Math.abs(diffMin) < 60) fmt_R = rtf.format(Math.round(diffMin), 'minute');
                    else if (Math.abs(diffMin) < 1440) fmt_R = rtf.format(Math.round(diffMin / 60), 'hour');
                    else if (Math.abs(diffMin) < 43200) fmt_R = rtf.format(Math.round(diffMin / 1440), 'day');
                    else fmt_R = rtf.format(Math.round(diffMin / 43200), 'month');
                } catch(e) { fmt_R = "relative"; }

                Array.from(discordFormat.options).forEach(opt => {
                    const val = opt.value;
                    let preview = "";
                    if (val === 't') preview = targetDate.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
                    else if (val === 'T') preview = targetDate.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    else if (val === 'd') preview = targetDate.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
                    else if (val === 'D') preview = targetDate.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
                    else if (val === 'f') preview = targetDate.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                    else if (val === 'F') preview = targetDate.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                    else if (val === 'R') preview = fmt_R;

                    if (val === 't') opt.textContent = t("app.short_time") + ` (${preview})`;
                    else if (val === 'T') opt.textContent = t("app.long_time") + ` (${preview})`;
                    else if (val === 'd') opt.textContent = t("app.short_date") + ` (${preview})`;
                    else if (val === 'D') opt.textContent = t("app.long_date") + ` (${preview})`;
                    else if (val === 'f') opt.textContent = t("app.short_d_t") + ` (${preview})`;
                    else if (val === 'F') opt.textContent = t("app.long_d_t") + ` (${preview})`;
                    else if (val === 'R') opt.textContent = t("app.relative") + ` (${preview})`;
                });
            } catch(e) {}
        }
    }

    if (convInput) convInput.addEventListener('input', doTimeConversion);
    if (convTz) convTz.addEventListener('change', doTimeConversion);
    if (btnCopyNormal) btnCopyNormal.addEventListener('click', () => {
        if (!currentUnixSeconds) return;
        navigator.clipboard.writeText(formatUtcTimestamp(currentUnixSeconds)).then(() => {
            if(window.showToast) window.showToast(t("app.timestamp_copied"));
        });
    });
    if (btnCopyDiscord) btnCopyDiscord.addEventListener('click', () => {
        navigator.clipboard.writeText(`<t:${currentUnixSeconds}:${discordFormat.value}>`).then(() => { if(window.showToast) window.showToast(t("app.discord_timestamp_copied")); });
    });
    setTimeout(doTimeConversion, 500);

    const timeWrapper = document.getElementById('server-time-wrapper');
    const timeModal = document.getElementById('server-time-modal');
    const closeTimeBtn = document.getElementById('close-server-time-btn');
    const copyTimeBtn = document.getElementById('copy-server-time-btn');

    const copyCurrentServerTime = () => {
        const payload = [dateEl?.textContent, clockEl?.textContent].filter(Boolean).join(' ');
        if (!payload) return;
        navigator.clipboard.writeText(payload).then(() => {
            if (window.showToast) window.showToast(t('app.server_time_copied_to_clipboard'));
        });
    };

    if (timeWrapper && timeModal) {
        const openServerTimeModal = () => {
            timeModal.style.display = 'flex';
            updateServerTime();
            if (window.ensureFlatpickrLoaded) {
                window.ensureFlatpickrLoaded().catch((e) => console.error('Failed to lazy-load flatpickr:', e));
            }
        };

        const closeServerTimeModal = () => {
            timeModal.style.display = 'none';
        };

        timeWrapper.addEventListener('click', openServerTimeModal);
        timeWrapper.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openServerTimeModal();
            }
        });
        if (closeTimeBtn) closeTimeBtn.addEventListener('click', closeServerTimeModal);
        if (copyTimeBtn) copyTimeBtn.addEventListener('click', copyCurrentServerTime);
        timeModal.addEventListener('click', (e) => { if (e.target === timeModal) closeServerTimeModal(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && timeModal.style.display === 'flex') {
                closeServerTimeModal();
            }
        });
    }

    const startupUrl = await startupUrlPromise;
    if (startupUrl) {
        window.handle_deep_link(startupUrl);
    } else {
        window.loadView('home');
    }

    const maybeShowDiscoverabilityHints = () => {
        const commandHintKey = 'hint_command_palette_v1';
        const requestHintKey = 'hint_request_log_v1';

        if (window.AppSettings.getPref(commandHintKey, '') !== 'dismissed') {
            window.AppSettings.setPrefSync(commandHintKey, 'dismissed');
            window.showToast(t('app.quick_open_is_available_from_the_sidebar_1dc9fd'), false, {
                actionLabel: t('common.open'),
                onAction: async () => openCommandPalette(),
                durationMs: 7000,
                closeable: true
            });
            return;
        }

        if (window.AppSettings.getPref(requestHintKey, '') !== 'dismissed') {
            window.AppSettings.setPrefSync(requestHintKey, 'dismissed');
            window.showToast(t('app.the_requests_button_shows_every_external_035e62'), false, {
                actionLabel: t('app.view'),
                onAction: async () => { networkState.isModalOpen = true; },
                durationMs: 7000
            });
        }
    };

    setTimeout(maybeShowDiscoverabilityHints, 900);
    
    window.applyCustomDropdowns();
});
