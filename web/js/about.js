document.addEventListener('about_loaded', async () => {
    console.log("About view initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    
    if (window.I18nManager && typeof window.I18nManager.translatePage === 'function') {
        window.I18nManager.translatePage(document.querySelector('.about-view-container'));
    } else {
        document.querySelectorAll('.about-view-container [data-i18n]').forEach(el => {
            if (el.childNodes.length > 0) {
                el.innerHTML = t(el.innerHTML.trim());
            }
        });

        document.querySelectorAll('.about-view-container [data-i18n-title]').forEach(el => {
            el.title = t(el.getAttribute('data-i18n-title'));
        });
    }

    const versionDisplay = document.getElementById('app-version-display') || document.getElementById('app-version');
    const authorDisplay = document.getElementById('app-author-display') || document.getElementById('app-author');
    const descEl = document.getElementById('app-description');

    let appVersion = "...";
    let appAuthor = "Aallyn Reed";

    try {
        if (window.eel && window.eel.get_app_metadata) {
            const metadata = await eel.get_app_metadata()();
            if (metadata) {
                appVersion = metadata.APP_VERSION || appVersion;
                if (metadata.APP_AUTHOR) appAuthor = metadata.APP_AUTHOR;
                
                if (descEl && metadata.APP_DESCRIPTION) {
                    descEl.innerText = t(metadata.APP_DESCRIPTION);
                }
            }
        }
    } catch (e) {
        console.warn("Could not load app metadata from backend:", e);
    }

    if (versionDisplay) {
        if (versionDisplay.id === 'app-version') {
            versionDisplay.innerText = appVersion; 
        } else {
            versionDisplay.innerText = t("Version {version}").replace("{version}", appVersion); 
        }
    }

    if (authorDisplay) {
        if (authorDisplay.id === 'app-author') {
            authorDisplay.innerText = appAuthor; 
        } else {
            authorDisplay.innerHTML = t("Created by {name}").replace("{name}", `<strong>${appAuthor}</strong>`);
        }
    }
});