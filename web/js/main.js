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

    async function loadView(target) {
        try {
            const response = await fetch(`views/${target}.html`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const html = await response.text();
            viewContainer.innerHTML = html;

            navButtons.forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-target') === target);
            });

            const event = new CustomEvent(`${target}_loaded`);
            document.dispatchEvent(event);
            
            console.log(`Successfully loaded and initialized view: ${target}`);
        } catch (err) {
            console.error("View loading error:", err);
            viewContainer.innerHTML = `<div class="placeholder-box" style="color: #ff5555;">Failed to load view: ${err.message}</div>`;
        }
    }

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-target');
            loadView(target);
        });
    });

    loadView('trovesaurus');
});