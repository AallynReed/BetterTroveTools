document.addEventListener('about_loaded', async () => {
    console.log("About Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, onMounted } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;

            const appVersion = ref("...");
            const appAuthor = ref("Aallyn Reed");
            const appDescription = ref("");
            const sysInfoStrShort = ref("");
            const sysInfoStrFull = ref("");

            const debugCopied = ref(false);
            
            const contributors = ref([]);
            const contributorsLoaded = ref(false);

            const modals = reactive({
                changelog: false,
                licenses: false,
                appLicense: false
            });

            const appLicenseText = ref("");
            
            const changelogLoaded = ref(false);
            const changelogGroups = ref([]);
            const changelogError = ref("");

            const copyDebug = () => {
                const debugInfo = `App Name: Better Trove Tools\nApp Version: ${appVersion.value}\nUser Agent: ${navigator.userAgent}\nLanguage: ${navigator.language}${sysInfoStrFull.value}`;
                navigator.clipboard.writeText(debugInfo).then(() => {
                    debugCopied.value = true;
                    setTimeout(() => debugCopied.value = false, 2000);
                    if (window.showToast) window.showToast(t("Copied Debug Info to clipboard!"));
                });
            };

            const loadAppLicense = async () => {
                if (!appLicenseText.value) {
                    try { appLicenseText.value = await eel.get_app_license()(); } 
                    catch (e) { appLicenseText.value = t("Failed to load license."); }
                }
            };

            const loadChangelog = async () => {
                if (changelogLoaded.value) return;
                try {
                    const tagsRes = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/tags', { bttLabel: t('Fetching Changelog Tags') });
                    const tags = await tagsRes.json();
                    
                    const commitsRes = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/commits?per_page=100', { bttLabel: t('Fetching Changelog Commits') });
                    const commits = await commitsRes.json();
                    
                    if (commits.message && commits.message.includes("API rate limit exceeded")) {
                        changelogError.value = "GitHub API rate limit exceeded. Please try again later.";
                        changelogLoaded.value = true;
                        return;
                    }

                    const tagMap = {};
                    if (Array.isArray(tags)) tags.forEach(tag => tagMap[tag.commit.sha] = tag.name);

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
                            
                            const commitMsg = c.commit.message.split('\n')[0];
                            let formattedMsg = commitMsg;
                            const prefixMatch = commitMsg.match(/^([a-zA-Z]+)(?:\([^)]+\))?:/);
                            if (prefixMatch) {
                                const fullPrefix = prefixMatch[0];
                                const type = prefixMatch[1].toLowerCase();
                                formattedMsg = `<span class="commit-prefix prefix-${type}">${fullPrefix}</span>` + commitMsg.substring(fullPrefix.length);
                            }

                            currentGroup.commits.push({ sha: c.sha, shortSha: c.sha.substring(0, 7), url: c.html_url, formattedMsg });
                        });
                    }
                    
                    changelogGroups.value = groups.filter(g => g.commits.length > 0);
                } catch (e) {
                    changelogError.value = "Error loading changelog. Check console for details.";
                } finally {
                    changelogLoaded.value = true;
                }
            };

            const openUrl = (url) => {
                if (window.eel && eel.open_url_in_browser) {
                    eel.open_url_in_browser(url)();
                }
            };

            onMounted(async () => {
                try {
                    const metadata = await eel.get_app_metadata()();
                    if (metadata) {
                        appVersion.value = metadata.APP_VERSION || appVersion.value;
                        appAuthor.value = metadata.APP_AUTHOR || appAuthor.value;
                        appDescription.value = metadata.APP_DESCRIPTION || "";
                    }
                } catch (e) {}

                try {
                    const sysInfo = await eel.get_system_info()();
                    if (!sysInfo.error) {
                        sysInfoStrFull.value = `\nOS: ${sysInfo.os} ${sysInfo.os_release} (${sysInfo.architecture})\nProcessor: ${sysInfo.processor}`;
                        sysInfoStrShort.value = `${sysInfo.os} ${sysInfo.os_release} | ${sysInfo.processor}`;
                    }
                } catch (e) {}

                try {
                    const res = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/contributors', { bttLabel: t('Fetching Contributors') });
                    const data = await res.json();
                    if (Array.isArray(data)) contributors.value = data;
                } catch (e) {}
                contributorsLoaded.value = true;
            });

            return {
                t, appVersion, appAuthor, appDescription, sysInfoStrShort, debugCopied,
                contributors, contributorsLoaded, modals, appLicenseText, changelogLoaded, changelogGroups, changelogError,
                copyDebug, loadAppLicense, loadChangelog, openUrl
            };
        }
    });

    if (window._aboutApp) window._aboutApp.unmount();
    window._aboutApp = app;
    app.mount('#about-vue-app');
});