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
        if (e.buttons > 0) { globalTooltip.style.display = 'none'; return; }
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

let activeRequestList = [];
let fullRequestLog = [];

function updateIndicator() {
    const requestIndicator = document.getElementById('external-request-indicator');
    if (!requestIndicator) return;
    
    requestIndicator.style.display = 'block';
    
    const icon = requestIndicator.querySelector('i');
    if (icon) {
        if (activeRequestList.some(r => r.status === 'active')) icon.classList.add('fa-fade');
        else icon.classList.remove('fa-fade');
    }

    if (activeRequestList.length > 0) {

        let tooltipContent = '<h3>Recent Requests</h3><ul style="margin-bottom: 0;">';
        
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
    if (!url) url = label;
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

window.applyCustomDropdowns = function() {
    // Target ALL standard dropdowns (ignores multi-selects and Select2)
    document.querySelectorAll('select:not([multiple]):not(.select2-hidden-accessible):not(.flatpickr-monthDropdown-months)').forEach(select => {
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

            triggerText.innerHTML = select.options[select.selectedIndex]?.innerHTML || '';
            
            // Try to selectively update to preserve scroll focus during fast mutation updates
            if (optionsContainer.children.length === select.options.length) {
                Array.from(select.options).forEach((opt, index) => {
                    const optDiv = optionsContainer.children[index];
                    if (optDiv.innerHTML !== opt.innerHTML) optDiv.innerHTML = opt.innerHTML;
                    if (opt.selected) optDiv.classList.add('selected');
                    else optDiv.classList.remove('selected');
                });
                return;
            }

            // Fallback full rebuild
            optionsContainer.innerHTML = '';
            Array.from(select.options).forEach((opt, index) => {
                const optDiv = document.createElement('div');
                optDiv.className = 'custom-select-option' + (opt.selected ? ' selected' : '');
                optDiv.innerHTML = opt.innerHTML;
                optDiv.dataset.value = opt.value;
                optDiv.dataset.index = index;

                optDiv.addEventListener('click', (e) => {
                    e.stopPropagation();
                    select.selectedIndex = index;
                    select.dispatchEvent(new Event('change'));
                    wrapper.classList.remove('open');
                });
                optionsContainer.appendChild(optDiv);
            });
        }

        updateOptions();

        const observer = new MutationObserver(() => updateOptions());
        observer.observe(select, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
        
        select.addEventListener('change', () => updateOptions());

        // Intercept background JS property changes so the custom UI syncs instantly
        if (!select._customDropdownPatched) {
            const originalValueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
            if (originalValueSetter) {
                Object.defineProperty(select, 'value', {
                    set: function(val) {
                        originalValueSetter.call(this, val);
                        updateOptions();
                    },
                    get: function() { return Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').get.call(this); }
                });
            }
            
            const originalIndexSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex')?.set;
            if (originalIndexSetter) {
                Object.defineProperty(select, 'selectedIndex', {
                    set: function(val) {
                        originalIndexSetter.call(this, val);
                        updateOptions();
                    },
                    get: function() { return Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').get.call(this); }
                });
            }
            select._customDropdownPatched = true;
        }

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
                    select.dispatchEvent(new Event('change'));
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
            document.querySelectorAll('.custom-select-wrapper').forEach(w => w.classList.remove('open'));
            if (!isOpen) {
                const rect = trigger.getBoundingClientRect();
                const spaceBelow = window.innerHeight - rect.bottom;
                const spaceAbove = rect.top;
                
                if (spaceBelow < 250 && spaceAbove > spaceBelow) {
                    wrapper.classList.add('drop-up');
                    optionsContainer.style.maxHeight = Math.max(100, Math.min(spaceAbove - 20, 250)) + 'px';
                } else {
                    wrapper.classList.remove('drop-up');
                    optionsContainer.style.maxHeight = Math.max(100, Math.min(spaceBelow - 20, 250)) + 'px';
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
            document.querySelectorAll('.custom-select-wrapper').forEach(w => w.classList.remove('open'));
        });
        window._customDropdownListenerAttached = true;
    }
};

// Watch the document globally to instantly transform any dynamically injected dropdowns!
if (!window._globalDropdownObserverAttached) {
    const globalDropdownObserver = new MutationObserver((mutations) => {
        let shouldApply = false;
        for (let mut of mutations) {
            if (mut.addedNodes.length) {
                for (let node of mut.addedNodes) {
                    if (node.nodeType === 1) {
                        if (node.tagName === 'SELECT' && !node.multiple && !node.classList.contains('select2-hidden-accessible') && !node.classList.contains('flatpickr-monthDropdown-months')) {
                            shouldApply = true; break;
                        }
                        if (node.querySelector && node.querySelector('select:not([multiple]):not(.select2-hidden-accessible):not(.flatpickr-monthDropdown-months)')) {
                            shouldApply = true; break;
                        }
                    }
                }
            }
            if (shouldApply) break;
        }
        if (shouldApply) window.applyCustomDropdowns();
    });
    globalDropdownObserver.observe(document.body, { childList: true, subtree: true });
    window._globalDropdownObserverAttached = true;
};

window.ContextMenu = {
    show: function(e, items) {
        e.preventDefault();
        const contextMenuEl = document.getElementById('custom-context-menu');
        if (!contextMenuEl) return;
        
        contextMenuEl.innerHTML = '';
        const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
        
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
            el.onclick = () => {
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
    // Allow native right-click in text fields or when text is highlighted for copying
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (window.getSelection().toString().length > 0) return; 
    
    // Prevent the default browser context menu globally
    e.preventDefault();
    
    if (window.ContextMenu) window.ContextMenu.hide();
});

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
    
    eel.get_settings()().then(settings => {
        if (settings && settings.accent_color) {
            document.documentElement.style.setProperty('--accent-blue', settings.accent_color);
        }
    });

    // Command Palette Logic
    const cmdOverlay = document.getElementById('command-palette-overlay');
    const cmdInput = document.getElementById('cmd-input');
    const cmdResults = document.getElementById('cmd-results');
    
    const commands = [
        { id: 'home', title: 'Home', icon: 'fa-house' },
        { id: 'trovesaurus', title: 'Trovesaurus', imgIcon: 'https://trovesaurus.com/images/logos/Sage_64.png' },
        { id: 'mod_manager', title: 'Mod Manager', icon: 'fa-cubes' },
        { id: 'file_manager', title: 'Game File Manager', icon: 'fa-folder-tree' },
        { id: 'modder_tools', title: 'Modder Tools', icon: 'fa-toolbox' },
        { id: 'star_chart', title: 'Star Chart', icon: 'fa-star' },
        { id: 'gem_builds', title: 'Gem Builds', icon: 'fa-dice-five' },
        { id: 'gem_simulator', title: 'Gem Simulator', icon: 'fa-gem' },
        { id: 'calculators', title: 'Calculators', icon: 'fa-calculator' },
        { id: 'allies', title: 'Ally Codex', icon: 'fa-paw' },
        { id: 'settings', title: 'Settings', icon: 'fa-gear' },
        { id: 'about', title: 'About', icon: 'fa-circle-info' }
    ];

    let activeCmdIndex = 0;

    function renderCmdResults(filter = "") {
        const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
        const filtered = commands.filter(c => t(c.title).toLowerCase().includes(filter.toLowerCase()) || c.id.toLowerCase().includes(filter.toLowerCase()));
        
        if (filtered.length === 0) {
            cmdResults.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">No results found.</div>`;
            return;
        }
        
        if (activeCmdIndex >= filtered.length) activeCmdIndex = 0;
        
        cmdResults.innerHTML = filtered.map((c, i) => `
            <div class="cmd-result-item ${i === activeCmdIndex ? 'active' : ''}" data-target="${c.id}">
                <div class="cmd-result-icon">${c.imgIcon ? `<img src="${c.imgIcon}" style="width: 20px; height: 20px; object-fit: contain; vertical-align: middle;">` : `<i class="fa-solid ${c.icon}"></i>`}</div>
                <div>${t(c.title)}</div>
            </div>
        `).join('');

        const activeEl = cmdResults.querySelector('.cmd-result-item.active');
        if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    }

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            if (cmdOverlay.style.display === 'flex') { cmdOverlay.style.display = 'none'; } 
            else { cmdOverlay.style.display = 'flex'; cmdInput.value = ''; activeCmdIndex = 0; renderCmdResults(); cmdInput.focus(); }
        } else if (e.key === 'Escape' && cmdOverlay.style.display === 'flex') { cmdOverlay.style.display = 'none'; } 
        else if (cmdOverlay.style.display === 'flex') {
            if (e.key === 'ArrowDown') { e.preventDefault(); activeCmdIndex++; renderCmdResults(cmdInput.value); } 
            else if (e.key === 'ArrowUp') { e.preventDefault(); activeCmdIndex = Math.max(0, activeCmdIndex - 1); renderCmdResults(cmdInput.value); } 
            else if (e.key === 'Enter') {
                e.preventDefault();
                const activeEl = cmdResults.querySelector('.cmd-result-item.active');
                if (activeEl) { window.loadView(activeEl.getAttribute('data-target')); cmdOverlay.style.display = 'none'; }
            }
        }
    });

    cmdInput.addEventListener('input', (e) => { activeCmdIndex = 0; renderCmdResults(e.target.value); });
    cmdResults.addEventListener('click', (e) => { const item = e.target.closest('.cmd-result-item'); if (item) { window.loadView(item.getAttribute('data-target')); cmdOverlay.style.display = 'none'; } });
    cmdOverlay.addEventListener('click', (e) => { if (e.target === cmdOverlay) cmdOverlay.style.display = 'none'; });

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
            
            window.applyCustomDropdowns();

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

    const langSelect = document.getElementById('global-language-select');
    if (langSelect && window.I18nManager) {
        langSelect.addEventListener('change', async (e) => {
            await window.I18nManager.setLocale(e.target.value);
            await window.I18nManager.translatePage(); // Translates static shell (sidebar, etc)
            const currentView = document.querySelector('.nav-btn.active')?.getAttribute('data-target');
            if (currentView) window.loadView(currentView); // Reloads active view to translate dynamic JS content
        });
    }

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

        const modalList = document.getElementById('st-timezones-list');
        const modal = document.getElementById('server-time-modal');
        
        if (modal && modal.style.display === 'flex' && modalList) {

            let html = '';
            window.globalTimezones.forEach(tz => {
                let timeStr, dateStr;
                try {
                    if (tz.id === 'trove') {
                        timeStr = troveTime.toLocaleTimeString(locale, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        dateStr = troveTime.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
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
            modalList.innerHTML = html;
        }
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
    const btnCopyDiscord = document.getElementById('st-btn-copy-discord');
    let currentUnixSeconds = 0;

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
        
        if (window.flatpickr) {
            flatpickr(convInput, {
                enableTime: true,
                dateFormat: "Y-m-d\\TH:i",
                time_24hr: true,
                onChange: doTimeConversion
            });
        }
    }

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

                    if (val === 't') opt.textContent = t("Short Time") + ` (${preview})`;
                    else if (val === 'T') opt.textContent = t("Long Time") + ` (${preview})`;
                    else if (val === 'd') opt.textContent = t("Short Date") + ` (${preview})`;
                    else if (val === 'D') opt.textContent = t("Long Date") + ` (${preview})`;
                    else if (val === 'f') opt.textContent = t("Short D/T") + ` (${preview})`;
                    else if (val === 'F') opt.textContent = t("Long D/T") + ` (${preview})`;
                    else if (val === 'R') opt.textContent = t("Relative") + ` (${preview})`;
                });
            } catch(e) {}
        }
    }

    if (convInput) convInput.addEventListener('input', doTimeConversion);
    if (convTz) convTz.addEventListener('change', doTimeConversion);
    if (btnCopyDiscord) btnCopyDiscord.addEventListener('click', () => {
        navigator.clipboard.writeText(`<t:${currentUnixSeconds}:${discordFormat.value}>`).then(() => { if(window.showToast) window.showToast(t("Discord timestamp copied!")); });
    });
    setTimeout(doTimeConversion, 500);

    const timeWrapper = document.getElementById('server-time-wrapper');
    const timeModal = document.getElementById('server-time-modal');
    const closeTimeBtn = document.getElementById('close-server-time-btn');
    if (timeWrapper && timeModal) {
        timeWrapper.addEventListener('click', () => { timeModal.style.display = 'flex'; updateServerTime(); });
        if (closeTimeBtn) closeTimeBtn.addEventListener('click', () => timeModal.style.display = 'none');
        timeModal.addEventListener('click', (e) => { if (e.target === timeModal) timeModal.style.display = 'none'; });
    }

    const startupUrl = await eel.get_startup_url()();
    if (startupUrl) {
        window.handle_deep_link(startupUrl);
    } else {
        window.loadView('home');
    }
    
    window.applyCustomDropdowns();
});