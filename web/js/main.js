// ==========================================
// App Security & Hotkey Blocking
// ==========================================
document.addEventListener('keydown', function(e) {
    const blockedKeys = ['F12', 'F5', 'F11'];
    const blockedCtrlKeys = ['t', 'n', 'w', 'r', 'p', 's', 'o', 'j', 'd', 'u', 'h'];
    const blockedCtrlShiftKeys = ['i', 'j', 'c'];
    
    if (blockedKeys.includes(e.key)) e.preventDefault();
    if (e.ctrlKey && blockedCtrlKeys.includes(e.key.toLowerCase())) e.preventDefault();
    if (e.ctrlKey && e.shiftKey && blockedCtrlShiftKeys.includes(e.key.toLowerCase())) e.preventDefault();
});

document.addEventListener('contextmenu', (e) => e.preventDefault());

// ==========================================
// Toast Notification System
// ==========================================
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

// ==========================================
// App Protocol / Deep Link Handling
// ==========================================
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
                        // Already on the Trovesaurus tab, execute immediately
                        window.executePendingSearch();
                    } else {
                        // Navigate to Trovesaurus tab, the event listener will pick up the search
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
            window.pendingSearch = null; // Clear it out so it doesn't loop
        }
    }
}

// Attach the search execution to the trovesaurus loaded event
document.addEventListener('trovesaurus_loaded', () => {
    window.executePendingSearch();
});

// ==========================================
// Core Application Logic
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    const navButtons = document.querySelectorAll('.nav-btn');
    const viewContainer = document.getElementById('view-container');

    // Sidebar toggle logic
    const burgerBtn = document.getElementById('burger-btn');
    const sidebar = document.getElementById('sidebar');
    if (burgerBtn && sidebar) {
        burgerBtn.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
        });
    }

    // View Routing (Made global so the deep link handler can trigger it)
    window.loadView = async function(target) {
        try {
            const response = await fetch(`views/${target}.html`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const html = await response.text();
            viewContainer.innerHTML = html;

            navButtons.forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-target') === target);
            });

            // Dispatch event so individual scripts know their HTML just loaded
            const event = new CustomEvent(`${target}_loaded`);
            document.dispatchEvent(event);
            
            console.log(`Successfully loaded view: ${target}`);
        } catch (err) {
            console.error("View loading error:", err);
            viewContainer.innerHTML = `<div style="color: #ff5555; padding: 40px; text-align: center;">Failed to load view: ${err.message}</div>`;
        }
    };

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-target');
            if (target) window.loadView(target);
        });
    });

    // ==========================================
    // ABOUT VIEW LOGIC
    // ==========================================
    document.addEventListener('about_loaded', async () => {
        const versionSpan = document.getElementById('app-version');
        const authorSpan = document.getElementById('app-author');
        const descP = document.getElementById('app-description');
        
        if (!versionSpan) return;

        try {
            const metadata = await eel.get_app_metadata()();
            console.log("Metadata received:", metadata);
            
            if (metadata) {
                if (versionSpan) versionSpan.textContent = metadata.APP_VERSION || "Unknown";
                if (authorSpan) authorSpan.textContent = metadata.APP_AUTHOR || "Aallyn Reed";
                if (descP) descP.textContent = metadata.APP_DESCRIPTION || "";
            }
        } catch (err) {
            console.error("Metadata fetch error:", err);
            versionSpan.textContent = "Error";
        }
    });

    // ==========================================
    // Live Server Clock (Trove Time: UTC - 11)
    // ==========================================
    const dateEl = document.getElementById('server-time-date');
    const clockEl = document.getElementById('server-time-clock');

    function updateServerTime() {
        if (!dateEl || !clockEl) return;
        const now = new Date();
        const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
        const troveMs = utcMs - (11 * 3600000);
        const troveTime = new Date(troveMs);

        dateEl.textContent = troveTime.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        clockEl.textContent = troveTime.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    updateServerTime();
    setInterval(updateServerTime, 1000);

    // ==========================================
    // Initial Load Protocol Checks
    // ==========================================
    const startupUrl = await eel.get_startup_url()();
    if (startupUrl) {
        window.handle_deep_link(startupUrl);
    } else {
        window.loadView('home');
    }
});