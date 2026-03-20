// ==========================================
// App Security & Hotkey Blocking
// ==========================================
document.addEventListener('keydown', function(e) {
    const blockedKeys = ['F12', 'F5', 'F11'];
    const blockedCtrlKeys = ['t', 'n', 'w', 'r', 'p', 's', 'o', 'j', 'd', 'u', 'h'];
    const blockedCtrlShiftKeys = ['i', 'j', 'c'];
    
    if (blockedKeys.includes(e.key)) {
        e.preventDefault();
    }
    if (e.ctrlKey && blockedCtrlKeys.includes(e.key.toLowerCase())) {
        e.preventDefault();
    }
    if (e.ctrlKey && e.shiftKey && blockedCtrlShiftKeys.includes(e.key.toLowerCase())) {
        e.preventDefault();
    }
});

document.addEventListener('contextmenu', function(e) {
    e.preventDefault(); // Disables right-click to prevent "Inspect Element"
});

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
            
            console.log(`Successfully loaded and initialized view: ${target}`);
        } catch (err) {
            console.error("View loading error:", err);
            viewContainer.innerHTML = `<div class="placeholder-box" style="color: #ff5555; padding: 40px; text-align: center;">Failed to load view: ${err.message}</div>`;
        }
    }

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-target');
            if (target) {
                loadView(target);
            }
        });
    });

    // ==========================================
    // Live Server Clock (Trove Time: UTC - 11)
    // ==========================================
    const dateEl = document.getElementById('server-time-date');
    const clockEl = document.getElementById('server-time-clock');

    function updateServerTime() {
        if (!dateEl || !clockEl) return;

        const now = new Date();
        
        // Get current UTC time in milliseconds
        const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
        
        // Trove server time is strictly UTC - 11 hours
        const troveMs = utcMs - (11 * 3600000);
        const troveTime = new Date(troveMs);

        // Format Date: e.g. "Fri, Mar 20"
        const dateStr = troveTime.toLocaleDateString('en-US', { 
            weekday: 'short', 
            month: 'short', 
            day: 'numeric' 
        });

        // Format Time: e.g. "15:25:31" (24-hour clock formatting)
        const timeStr = troveTime.toLocaleTimeString('en-US', { 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        });

        dateEl.textContent = dateStr;
        clockEl.textContent = timeStr;
    }

    // Run the clock immediately, then tick every 1 second
    updateServerTime();
    setInterval(updateServerTime, 1000);

    // Load initial view
    loadView('home');
});