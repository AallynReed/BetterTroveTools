// Global Tooltip System
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

document.addEventListener('mouseover', (e) => {
    let target = e.target.closest('[title], [data-tooltip], [data-tooltip-text]');
    if (!target) return;

    // Suppress default browser tooltip & support line breaks
    if (target.hasAttribute('title') && target.getAttribute('title').trim() !== "") {
        target.setAttribute('data-tooltip-text', target.getAttribute('title').replace(/\n/g, '<br>'));
        target.removeAttribute('title');
    }

    const content = target.getAttribute('data-tooltip') || target.getAttribute('data-tooltip-text');
    if (content) {
        globalTooltip.innerHTML = content;
        globalTooltip.style.display = 'block';
        
        let x = e.clientX + 15;
        let y = e.clientY + 15;
        if (x + globalTooltip.offsetWidth > window.innerWidth) x = e.clientX - globalTooltip.offsetWidth - 15;
        if (y + globalTooltip.offsetHeight > window.innerHeight) y = e.clientY - globalTooltip.offsetHeight - 15;
        globalTooltip.style.left = x + 'px';
        globalTooltip.style.top = y + 'px';
    }
});

document.addEventListener('mousemove', (e) => {
    if (globalTooltip.style.display === 'block') {
        if (e.buttons > 0) { globalTooltip.style.display = 'none'; return; } // Hide while dragging
        let x = e.clientX + 15;
        let y = e.clientY + 15;
        if (x + globalTooltip.offsetWidth > window.innerWidth) x = e.clientX - globalTooltip.offsetWidth - 15;
        if (y + globalTooltip.offsetHeight > window.innerHeight) y = e.clientY - globalTooltip.offsetHeight - 15;
        globalTooltip.style.left = x + 'px';
        globalTooltip.style.top = y + 'px';
    }
});

document.addEventListener('mouseout', (e) => {
    let target = e.target.closest('[data-tooltip], [data-tooltip-text]');
    if (target) globalTooltip.style.display = 'none';
});

document.addEventListener('click', () => globalTooltip.style.display = 'none');

// External Request Indicator
let activeRequestList = [];
let fullRequestLog = [];

function updateIndicator() {
    const requestIndicator = document.getElementById('external-request-indicator');
    if (!requestIndicator) return;
    
    requestIndicator.style.display = 'block';
    
    // Toggle the fading animation depending on if there are active requests
    const icon = requestIndicator.querySelector('i');
    if (icon) {
        if (activeRequestList.some(r => r.status === 'active')) icon.classList.add('fa-fade');
        else icon.classList.remove('fa-fade');
    }

    if (activeRequestList.length > 0) {

        let tooltipContent = '<h3>Recent Requests</h3><ul style="margin-bottom: 0;">';
        
        // Reverse list to show the most recent requests at the top
        const reversedList = [...activeRequestList].reverse();
        const displayList = reversedList.slice(0, 10);
        
        displayList.forEach(req => {
            let labelStr = req.label || req.url;
            if (labelStr.length > 40) labelStr = labelStr.substring(0, 37) + '...';
            const safeLabel = labelStr.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            
            let statusHtml = '';
            if (req.status === 'active') statusHtml = '<span style="color: #5ec6ff;" title="Active"><i class="fa-solid fa-circle-notch fa-spin"></i></span> ';
            else if (req.status === 'error') statusHtml = '<span style="color: #ff5555;" title="Failed"><i class="fa-solid fa-xmark"></i></span> ';
            else statusHtml = '<span style="color: #4ade80;" title="Done"><i class="fa-solid fa-check"></i></span> ';
            
            tooltipContent += `<li>${statusHtml}${safeLabel}</li>`;
        });
        
        if (activeRequestList.length > 10) {
            tooltipContent += `<li><i>...and ${activeRequestList.length - 10} more</i></li>`;
        }
        tooltipContent += `</ul><hr style="margin: 8px 0; border: 0; border-top: 1px dashed var(--border-color, #444c5e);"><div style="font-size: 0.85em; color: var(--text-muted, #a3adc2);">Total requests made: ${fullRequestLog.length}</div>`;
        
        requestIndicator.setAttribute('data-tooltip', tooltipContent);
        
        // Dynamically update the tooltip if the user is actively hovering over it
        const globalTooltip = document.getElementById('global-tooltip');
        if (globalTooltip && globalTooltip.style.display === 'block' && requestIndicator.matches(':hover')) {
            globalTooltip.innerHTML = tooltipContent;
        }
    } else {
        const emptyText = fullRequestLog.length > 0 
            ? `No active requests.<hr style="margin: 8px 0; border: 0; border-top: 1px dashed var(--border-color, #444c5e);"><div style="font-size: 0.85em; color: var(--text-muted, #a3adc2);">Total requests made: ${fullRequestLog.length}</div>` 
            : 'No external requests made yet.';
        requestIndicator.setAttribute('data-tooltip', emptyText);
        
        const globalTooltip = document.getElementById('global-tooltip');
        if (globalTooltip && globalTooltip.style.display === 'block' && requestIndicator.matches(':hover')) {
            globalTooltip.innerHTML = emptyText;
        }
    }
}

function renderRequestLog() {
    const logContent = document.getElementById('request-log-content');
    if (!logContent) return;

    if (fullRequestLog.length === 0) {
        logContent.innerHTML = '<div style="text-align: center; padding: 20px;">No requests made yet.</div>';
        return;
    }

    let html = '<ul style="list-style: none; padding: 0; margin: 0;">';
    [...fullRequestLog].reverse().forEach(req => {
        let statusHtml = '';
        if (req.status === 'active') statusHtml = '<span style="color: #5ec6ff;" title="Active"><i class="fa-solid fa-circle-notch fa-spin"></i></span> ';
        else if (req.status === 'error') statusHtml = '<span style="color: #ff5555;" title="Failed"><i class="fa-solid fa-xmark"></i></span> ';
        else statusHtml = '<span style="color: #4ade80;" title="Done"><i class="fa-solid fa-check"></i></span> ';
        
        const timeStr = req.time ? req.time.toLocaleTimeString() : '';
        const safeLabel = (req.label || req.url).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        const safeUrl = (req.url || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        
        let labelHtml = `<span style="color: var(--text-main, #fff); word-break: break-word;">${safeLabel}</span>`;
        if (req.label === req.url) {
            labelHtml = `<span class="clickable-log-url" data-url="${safeUrl}" style="color: var(--text-muted, rgba(255,255,255,0.6)); word-break: break-word; cursor: pointer;" onclick="navigator.clipboard.writeText(this.getAttribute('data-url')); window.showToast('URL copied to clipboard!');" title="Click to copy URL">${safeLabel}</span>`;
        }
        
        let urlHtml = '';
        if (req.label && req.label !== req.url) {
            urlHtml = `<br><span class="clickable-log-url" data-url="${safeUrl}" style="font-size: 0.85em; color: var(--text-muted, rgba(255,255,255,0.6)); margin-left: 20px; display: inline-block; word-break: break-all; cursor: pointer;" onclick="navigator.clipboard.writeText(this.getAttribute('data-url')); window.showToast('URL copied to clipboard!');" title="Click to copy URL">↳ ${safeUrl}</span>`;
        }
        
        html += `<li style="margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05);"><span style="color: #666;">[${timeStr}]</span> ${statusHtml} ${labelHtml}${urlHtml}</li>`;
    });
    html += '</ul>';
    logContent.innerHTML = html;
}

eel.expose(add_external_request, 'add_external_request');
function add_external_request(label = "Python Backend Request", url = "") {
    const id = Math.random().toString(36).substring(2, 11);
    if (!url) url = label; // Fallback if only one argument is provided
    const reqObj = { id, url, label, status: 'active', time: new Date() };
    activeRequestList.push(reqObj);
    fullRequestLog.push(reqObj);
    updateIndicator();
    if (document.getElementById('request-log-modal')?.style.display === 'flex') renderRequestLog();
    return id;
}

eel.expose(remove_external_request, 'remove_external_request');
function remove_external_request(id, success = true) {
    let reqObj = null;
    if (id) {
        reqObj = activeRequestList.find(r => r.id === id);
    } else {
        // Fallback for Python scripts not passing back the ID
        reqObj = activeRequestList.find(r => r.status === 'active');
    }
    
    if (reqObj) {
        reqObj.status = success ? 'completed' : 'error';
        updateIndicator();
        setTimeout(() => {
            activeRequestList = activeRequestList.filter(r => r !== reqObj);
            updateIndicator();
        }, 60000);
        if (document.getElementById('request-log-modal')?.style.display === 'flex') renderRequestLog();
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
        activeRequestList.push(reqObj);
        fullRequestLog.push(reqObj);
        updateIndicator();
        if (document.getElementById('request-log-modal')?.style.display === 'flex') renderRequestLog();
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
            updateIndicator();
            setTimeout(() => {
                activeRequestList = activeRequestList.filter(r => r !== reqObj);
                updateIndicator();
            }, 60000);
            if (document.getElementById('request-log-modal')?.style.display === 'flex') renderRequestLog();
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
        activeRequestList.push(reqObj);
        fullRequestLog.push(reqObj);
        updateIndicator();
        if (document.getElementById('request-log-modal')?.style.display === 'flex') renderRequestLog();
        const onComplete = (e) => {
            reqObj.status = (e.type === 'error' || e.type === 'abort' || this.status >= 400) ? 'error' : 'completed';
            updateIndicator();
            setTimeout(() => {
                activeRequestList = activeRequestList.filter(r => r !== reqObj);
                updateIndicator();
            }, 60000);
            if (document.getElementById('request-log-modal')?.style.display === 'flex') renderRequestLog();
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
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    
    const requestIndicator = document.getElementById('external-request-indicator');
    const logModal = document.getElementById('request-log-modal');
    const closeLogBtn = document.getElementById('close-request-log-btn');
    const copyLogBtn = document.getElementById('copy-request-log-btn');

    if (requestIndicator && logModal) {
        requestIndicator.addEventListener('click', () => {
            logModal.style.display = 'flex';
            renderRequestLog();
        });
        if (closeLogBtn) closeLogBtn.addEventListener('click', () => logModal.style.display = 'none');
        logModal.addEventListener('click', (e) => {
            if (e.target === logModal) logModal.style.display = 'none';
        });
    }

    if (copyLogBtn) {
        copyLogBtn.addEventListener('click', () => {
            if (fullRequestLog.length === 0) {
                window.showToast('No requests to copy!', true);
                return;
            }
            let logText = '--- External Request Log ---\n\n';
            [...fullRequestLog].reverse().forEach(req => {
                const timeStr = req.time ? req.time.toLocaleTimeString() : 'Unknown Time';
                const statusStr = req.status.toUpperCase();
                logText += `[${timeStr}] [${statusStr}] ${req.label || req.url}\n`;
                if (req.label && req.label !== req.url) {
                    logText += `  -> URL: ${req.url}\n`;
                }
            });
            navigator.clipboard.writeText(logText).then(() => {
                window.showToast('Entire request log copied to clipboard!');
            });
        });
    }

    const metaResponse = await eel.get_app_metadata()();
    let currentVersion = metaResponse?.APP_VERSION || "Unknown";
    
    if (metaResponse && metaResponse.APP_VERSION) {
        const appName = metaResponse.APP_NAME || "Better Trove Tools";
        document.title = `${appName} v${currentVersion}`;
        const titleEl = document.getElementById('app-title');
        if (titleEl) {
            titleEl.innerHTML = `
                <div class="app-name-text">${appName}</div>
                <div class="app-version-text">v${currentVersion}</div>
            `;
        }
    }

    try {
        const ghResponse = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/releases/latest', { bttLabel: t('Looking for updates') });
        if (ghResponse.ok) {
            const ghData = await ghResponse.json();
            let latestVersion = ghData.tag_name;
            
            if (latestVersion && latestVersion.startsWith('v')) {
                latestVersion = latestVersion.substring(1);
            }
            
            if (latestVersion && currentVersion !== latestVersion) {
                const sidebar = document.getElementById('sidebar');
                if (sidebar) {
                    const updateContainer = document.createElement('div');
                    updateContainer.className = 'app-update-container';
                    updateContainer.innerHTML = `
                        <button class="nav-btn update-app-btn" title="${t("A new version is available! Click to download.")}" onclick="eel.open_url_in_browser('${ghData.html_url}')()">
                            <i class="fa-solid fa-cloud-arrow-down nav-icon"></i>
                            <span class="nav-text">${t("Update v{version}").replace("{version}", latestVersion)}</span>
                        </button>
                    `;
                    sidebar.appendChild(updateContainer);
                }
            }
        }
    } catch (err) {
        console.error("Failed to check for app updates:", err);
    }
});

document.addEventListener('keydown', function(e) {
    const blockedKeys = ['F12', 'F5', 'F11'];
    const blockedCtrlKeys = ['t', 'n', 'w', 'r', 'p', 's', 'o', 'j', 'd', 'u', 'h'];
    const blockedCtrlShiftKeys = ['i', 'j', 'c'];
    
    if (blockedKeys.includes(e.key)) e.preventDefault();
    if (e.ctrlKey && blockedCtrlKeys.includes(e.key.toLowerCase())) e.preventDefault();
    if (e.ctrlKey && e.shiftKey && blockedCtrlShiftKeys.includes(e.key.toLowerCase())) e.preventDefault();
});

document.addEventListener('contextmenu', (e) => e.preventDefault());

window.showToast = function(message, isError = false) {
    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.backgroundColor = isError ? '#ff5555' : '#28a745';
    toast.style.color = 'white';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '6px';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    toast.style.zIndex = '10020';
    toast.style.fontSize = '14px';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    toast.style.whiteSpace = 'pre-wrap';
    toast.style.textAlign = 'center';
    
    toast.innerText = message;
    
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '1';
    }, 10);

    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
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
                    
                    const searchInput = document.getElementById('ts-search-input');
                    if (searchInput) {
                        window.executePendingSearch();
                    } else {
                        window.loadView('trovesaurus');
                    }
                }
            }
        } catch (e) {
            console.error("Failed to parse deep link:", e);
        }
    }
}

window.executePendingSearch = function() {
    if (window.pendingSearch) {
        const searchInput = document.getElementById('ts-search-input');
        const searchBtn = document.getElementById('btn-ts-search');
        if (searchInput && searchBtn) {
            searchInput.value = window.pendingSearch;
            searchBtn.click();
            window.pendingSearch = null;
        }
    }
}

document.addEventListener('trovesaurus_loaded', () => {
    window.executePendingSearch();
});

document.addEventListener('DOMContentLoaded', async () => {
    const navButtons = document.querySelectorAll('.nav-btn');
    const viewContainer = document.getElementById('view-container');
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

    const burgerBtn = document.getElementById('burger-btn');
    const sidebar = document.getElementById('sidebar');
    if (burgerBtn && sidebar) {
        burgerBtn.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
        });
    }

    window.loadView = async function(target) {
        try {
            const response = await fetch(`views/${target}.html`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const html = await response.text();
            viewContainer.innerHTML = html;

            navButtons.forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-target') === target);
            });

            if (window.I18nManager) {
                await window.I18nManager.translatePage();
            }

            const event = new CustomEvent(`${target}_loaded`);
            document.dispatchEvent(event);
            
            console.log(`Successfully loaded view: ${target}`);
        } catch (err) {
            console.error("View loading error:", err);
            const errorMsg = t("Failed to load view: {error}").replace("{error}", err.message);
            viewContainer.innerHTML = `<div style="color: #ff5555; padding: 40px; text-align: center;">${errorMsg}</div>`;
        }
    };

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-target');
            if (target) window.loadView(target);
        });
    });

    const dateEl = document.getElementById('server-time-date');
    const clockEl = document.getElementById('server-time-clock');

    function updateServerTime() {
        if (!dateEl || !clockEl) return;
        const now = new Date();
        const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
        const troveMs = utcMs - (11 * 3600000);
        const troveTime = new Date(troveMs);

        const locale = window.I18nManager ? window.I18nManager.currentLocale.replace("_", "-") : 'en-US';
        dateEl.textContent = troveTime.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
        clockEl.textContent = troveTime.toLocaleTimeString(locale, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    updateServerTime();
    setInterval(updateServerTime, 1000);

    const startupUrl = await eel.get_startup_url()();
    if (startupUrl) {
        window.handle_deep_link(startupUrl);
    } else {
        window.loadView('home');
    }
});