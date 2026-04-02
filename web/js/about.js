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
    const sysInfoEl = document.getElementById('app-system-info');

    let appVersion = "...";
    let appAuthor = "Aallyn Reed";
    let sysInfoStr = "";

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

    try {
        if (window.eel && window.eel.get_system_info) {
            const sysInfo = await eel.get_system_info()();
            if (!sysInfo.error) {
                sysInfoStr = `\nOS: ${sysInfo.os} ${sysInfo.os_release} (${sysInfo.architecture})\nProcessor: ${sysInfo.processor}`;
                if (sysInfoEl) sysInfoEl.innerText = `${sysInfo.os} ${sysInfo.os_release} | ${sysInfo.processor}`;
            }
        }
    } catch (e) {
        console.warn("Failed to get extended system info:", e);
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

    const btnCopyDebug = document.getElementById('btn-copy-debug');
    if (btnCopyDebug) {
        btnCopyDebug.addEventListener('click', () => {
            const debugInfo = `App Name: Better Trove Tools\nApp Version: ${appVersion}\nUser Agent: ${navigator.userAgent}\nLanguage: ${navigator.language}${sysInfoStr}`;
            navigator.clipboard.writeText(debugInfo).then(() => {
                const icon = btnCopyDebug.querySelector('i');
                icon.className = 'fa-solid fa-check';
                icon.style.color = '#4ade80';
                setTimeout(() => {
                    icon.className = 'fa-regular fa-clipboard';
                    icon.style.color = '';
                }, 2000);
            });
        });
    }

    const licensesBtn = document.getElementById('btn-licenses');
    const licensesModal = document.getElementById('licenses-modal');
    const closeLicensesBtn = document.getElementById('close-licenses');

    if (licensesBtn && licensesModal && closeLicensesBtn) {
        licensesBtn.addEventListener('click', () => licensesModal.style.display = 'flex');
        closeLicensesBtn.addEventListener('click', () => licensesModal.style.display = 'none');
        licensesModal.addEventListener('click', (e) => {
            if (e.target === licensesModal) licensesModal.style.display = 'none';
        });
    }

    const appLicenseBtn = document.getElementById('btn-app-license');
    const appLicenseModal = document.getElementById('app-license-modal');
    const closeAppLicenseBtn = document.getElementById('close-app-license');
    const appLicenseText = document.getElementById('app-license-text');

    if (appLicenseBtn && appLicenseModal && closeAppLicenseBtn) {
        appLicenseBtn.addEventListener('click', async () => {
            appLicenseModal.style.display = 'flex';
            if (!appLicenseText.innerText || appLicenseText.innerText === "") {
                appLicenseText.innerText = t("Loading license...");
                try {
                    if (window.eel && window.eel.get_app_license) {
                        appLicenseText.innerText = await eel.get_app_license()();
                    }
                } catch (e) {
                    appLicenseText.innerText = t("Failed to load license.");
                    console.warn(e);
                }
            }
        });
        closeAppLicenseBtn.addEventListener('click', () => appLicenseModal.style.display = 'none');
        appLicenseModal.addEventListener('click', (e) => {
            if (e.target === appLicenseModal) appLicenseModal.style.display = 'none';
        });
    }

    async function loadContributors() {
        const container = document.getElementById('contributors-container');
        if (!container) return;
        try {
            const res = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/contributors', { bttLabel: t('Fetching Contributors') });
            const contributors = await res.json();
            if (Array.isArray(contributors)) {
                container.innerHTML = '';
                contributors.forEach(c => {
                    const a = document.createElement('a');
                    a.href = c.html_url;
                    a.target = '_blank';
                    a.title = `${c.login} (${c.contributions} contributions)`;
                    a.className = 'contributor-avatar';
                    
                    const img = document.createElement('img');
                    img.src = c.avatar_url;
                    img.alt = c.login;
                    
                    a.appendChild(img);
                    container.appendChild(a);
                });
            }
        } catch (e) {
            console.error("Failed to load contributors:", e);
            container.innerHTML = '<span class="special-thanks">Failed to load contributors.</span>';
        }
    }
    loadContributors();

    const changelogBtn = document.getElementById('btn-changelog');
    const modal = document.getElementById('changelog-modal');
    const closeBtn = document.getElementById('close-changelog');
    let changelogLoaded = false;

    if (changelogBtn && modal && closeBtn) {
        changelogBtn.addEventListener('click', async () => {
            modal.style.display = 'flex';
            if (!changelogLoaded) {
                await loadChangelog();
                changelogLoaded = true;
            }
        });

        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        });
    }

    async function loadChangelog() {
        const modalBody = document.getElementById('changelog-body');
        try {
            const tagsRes = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/tags', { bttLabel: t('Fetching Changelog Tags') });
            const tags = await tagsRes.json();
            
            const commitsRes = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/commits?per_page=100', { bttLabel: t('Fetching Changelog Commits') });
            const commits = await commitsRes.json();
            
            if (commits.message && commits.message.includes("API rate limit exceeded")) {
                modalBody.innerHTML = `<p style="color: #ff5e5b;">GitHub API rate limit exceeded. Please try again later.</p>`;
                return;
            }

            const tagMap = {};
            if (Array.isArray(tags)) {
                tags.forEach(t => { tagMap[t.commit.sha] = t.name; });
            }

            let currentVersion = t("Unreleased");
            const groups = [];
            let currentGroup = { version: currentVersion, commits: [] };
            groups.push(currentGroup);

            if (Array.isArray(commits)) {
                commits.forEach(c => {
                    if (tagMap[c.sha]) {
                        currentVersion = tagMap[c.sha];
                        currentGroup = { version: currentVersion, commits: [] };
                        groups.push(currentGroup);
                    }
                    currentGroup.commits.push(c);
                });
            }

            const finalGroups = groups.filter(g => g.commits.length > 0);
            modalBody.innerHTML = '';
            
            if (finalGroups.length === 0) {
                modalBody.innerHTML = `<p>${t("No commits found.")}</p>`;
                return;
            }

            finalGroups.forEach(group => {
                const groupEl = document.createElement('div');
                groupEl.className = 'version-group';
                groupEl.innerHTML = `<h3 class="version-title">${group.version}</h3>`;
                
                group.commits.forEach(c => {
                    const commitMsg = c.commit.message.split('\n')[0];
                    let formattedMsg = commitMsg;
                    
                    const prefixMatch = commitMsg.match(/^([a-zA-Z]+)(?:\([^)]+\))?:/);
                    if (prefixMatch) {
                        const fullPrefix = prefixMatch[0];
                        const type = prefixMatch[1].toLowerCase();
                        formattedMsg = `<span class="commit-prefix prefix-${type}">${fullPrefix}</span>` + commitMsg.substring(fullPrefix.length);
                    }

                    groupEl.innerHTML += `
                        <div class="commit-item">
                            <a href="${c.html_url}" class="commit-hash" target="_blank">${c.sha.substring(0, 7)}</a>
                            <div class="commit-message">${formattedMsg}</div>
                        </div>`;
                });
                modalBody.appendChild(groupEl);
            });
        } catch (e) {
            console.error("Failed to load changelog:", e);
            modalBody.innerHTML = `<p style="color: #ff5e5b;">Error loading changelog. Check console for details.</p>`;
        }
    }
});