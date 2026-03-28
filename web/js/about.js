document.addEventListener('about_loaded', async () => {
    console.log("About view initialized!");
    const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
    
    // 1. Run translations on the static view elements
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

    // 2. Grab elements (Supports both your old HTML IDs and the new ones)
    const versionDisplay = document.getElementById('app-version-display') || document.getElementById('app-version');
    const authorDisplay = document.getElementById('app-author-display') || document.getElementById('app-author');
    const descEl = document.getElementById('app-description');

    // 3. Set safe fallbacks so the UI is never blank
    let appVersion = "...";
    let appAuthor = "Aallyn Reed";

    // 4. Fetch live info using the CORRECT Python endpoint
    try {
        if (window.eel && window.eel.get_app_metadata) {
            const metadata = await eel.get_app_metadata()();
            if (metadata) {
                // Grab the uppercase keys your Python backend actually sends
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

    // 5. Apply to UI safely based on which HTML structure you have
    if (versionDisplay) {
        if (versionDisplay.id === 'app-version') {
            versionDisplay.innerText = appVersion; // Old split HTML
        } else {
            versionDisplay.innerText = t("Version {version}").replace("{version}", appVersion); // New unified HTML
        }
    }

    if (authorDisplay) {
        if (authorDisplay.id === 'app-author') {
            authorDisplay.innerText = appAuthor; // Old split HTML
        } else {
            authorDisplay.innerHTML = t("Created by {name}").replace("{name}", `<strong>${appAuthor}</strong>`); // New unified HTML
        }
    }
});