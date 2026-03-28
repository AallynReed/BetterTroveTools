document.addEventListener('about_loaded', async () => {
    console.log("About view initialized!");
    
    if (window.I18nManager && typeof window.I18nManager.translatePage === 'function') {
        window.I18nManager.translatePage(document.querySelector('.about-view-container'));
    } else {
        const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
        
        document.querySelectorAll('.about-view-container [data-i18n]').forEach(el => {
            if (el.childNodes.length > 0) {
                el.innerHTML = t(el.innerHTML.trim());
            }
        });

        document.querySelectorAll('.about-view-container [data-i18n-title]').forEach(el => {
            el.title = t(el.getAttribute('data-i18n-title'));
        });
    }

    try {
        if (window.eel && window.eel.get_app_info) {
            const info = await eel.get_app_info()();
            if (info && info.success) {
                const versionEl = document.getElementById('app-version');
                const descEl = document.getElementById('app-description');
                const authorEl = document.getElementById('app-author');

                if (versionEl && info.version) versionEl.innerText = info.version;
                if (descEl && info.description) descEl.innerText = t(info.description);
                if (authorEl && info.author) authorEl.innerText = info.author;
            }
        }
    } catch (e) {
        console.warn("Could not load app info from backend:", e);
    }
});