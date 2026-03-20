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
// Core Application Logic
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
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

    // View Routing
    async function loadView(target) {
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
    }

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-target');
            if (target) loadView(target);
        });
    });

    // ==========================================
    // ABOUT VIEW LOGIC (Updated for your Metadata keys)
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
                // Map your specific uppercase keys to the UI
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

    // Initial load
    loadView('home');
});