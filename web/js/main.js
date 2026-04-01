// Global Tooltip System
const globalTooltip = document.createElement('div');
globalTooltip.id = 'global-tooltip';
globalTooltip.style.cssText = 'position: fixed; background: var(--bg-panel, #1d232b); border: 1px solid var(--border-color, #444c5e); padding: 8px 12px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.7); pointer-events: none; z-index: 10000; display: none; color: #fff; font-size: 0.9em; line-height: 1.4; max-width: 300px;';
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

document.addEventListener('DOMContentLoaded', async () => {
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    
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
        const ghResponse = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/releases/latest');
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
    toast.style.zIndex = '10000';
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