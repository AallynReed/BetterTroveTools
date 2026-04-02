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

    // Changelog Modal Logic
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
            const tagsRes = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/tags');
            const tags = await tagsRes.json();
            
            const commitsRes = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/commits?per_page=100');
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
                    
                    // Parse conventional commit prefixes (e.g., "feat:", "fix(ui):")
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