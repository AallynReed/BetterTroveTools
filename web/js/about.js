document.addEventListener('about_loaded', async () => {
    console.log("About Vue initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, reactive, onMounted } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;

            const appVersion = ref("...");
            const appAuthor = ref("Aallyn Reed");
            const appDescription = ref("");
            const sysInfoStrShort = ref("");
            const sysInfoStrFull = ref("");

            const debugCopied = ref(false);
            
            const contributors = ref([]);
            const contributorsLoaded = ref(false);
            const supporters = ref([]);
            const supportersLoaded = ref(false);

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
                    if (window.showToast) window.showToast(t("about.copied_debug_info_to_clipboard"));
                });
            };

            const loadAppLicense = async () => {
                if (!appLicenseText.value) {
                    try {
                        const licenseResp = await eel.get_app_license()();
                        appLicenseText.value = licenseResp?.text ?? licenseResp?.data?.text ?? licenseResp?.value ?? licenseResp;
                    } 
                    catch (e) { appLicenseText.value = t("about.failed_to_load_license"); }
                }
            };

            const loadChangelog = async () => {
                if (changelogLoaded.value) return;
                try {
                    // Kiwi API does the heavy lifting server-side: pulls /tags +
                    // /commits, groups by tag (with "Unreleased" as the head group),
                    // parses the conventional-commit prefix, and caches the result
                    // for 30 min so users don't trip GitHub's 60/hr unauth limit.
                    // One call replaces the previous two.
                    //
                    // Transport: BTT_Kiwi.get when present (Android / web mode →
                    // CapacitorHttp on native bypasses CORS for the WebView's
                    // https://localhost origin), else plain fetch — fine on the
                    // hosted web (*.aallyn.net) and on desktop eel (http://localhost
                    // origins, both allowlisted by the API).
                    const path = 'btt/changelog';
                    let data;
                    if (window.BTT_Kiwi && typeof window.BTT_Kiwi.get === 'function') {
                        data = await window.BTT_Kiwi.get(path);
                    } else {
                        const resp = await fetch(`https://api.aallyn.net/v1/${path}`, { bttLabel: t('about.fetching_changelog_commits') });
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        data = await resp.json();
                    }

                    if (data && data.rate_limited) {
                        changelogError.value = t('about.changelog_rate_limited');
                        changelogLoaded.value = true;
                        return;
                    }

                    const unreleasedLabel = t('about.unreleased');
                    const groups = Array.isArray(data && data.groups) ? data.groups : [];

                    // Map the API shape onto what the about.html template reads:
                    //   { version, commits: [{ shortSha, url, formattedMsg }] }
                    // The API gives us `type` already (lowercased prefix), but we
                    // still re-detect the *exact* prefix substring on the first line
                    // so the wrapped span shows e.g. "feat(scope):" verbatim.
                    changelogGroups.value = groups
                        .map((g) => ({
                            version: g.version === 'Unreleased' ? unreleasedLabel : g.version,
                            commits: (Array.isArray(g.commits) ? g.commits : []).map((c) => {
                                const firstLine = (c.message || '').split('\n')[0];
                                let formattedMsg = firstLine;
                                const prefixMatch = firstLine.match(/^([a-zA-Z]+)(?:\([^)]+\))?:/);
                                if (prefixMatch) {
                                    const fullPrefix = prefixMatch[0];
                                    const type = (c.type || prefixMatch[1]).toLowerCase();
                                    formattedMsg = `<span class="commit-prefix prefix-${type}">${fullPrefix}</span>` + firstLine.substring(fullPrefix.length);
                                }
                                return { sha: c.sha, shortSha: c.short_sha || (c.sha || '').substring(0, 7), url: c.url, formattedMsg };
                            })
                        }))
                        .filter((g) => g.commits.length > 0);
                } catch (e) {
                    changelogError.value = t('about.changelog_load_failed');
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
                    const res = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/contributors', { bttLabel: t('about.fetching_contributors') });
                    const data = await res.json();
                    if (Array.isArray(data)) contributors.value = data;
                } catch (e) {}
                contributorsLoaded.value = true;

                try {
                    const res = await fetch('/assets/data/supporters.json?t=' + Date.now(), { bttLabel: t('about.fetching_supporters') });
                    if (res.ok) {
                        const data = await res.json();
                        if (Array.isArray(data)) {
                            supporters.value = data
                                .map((name) => typeof name === 'string' ? name.trim() : '')
                                .filter((name) => name.length > 0);
                        }
                    }
                } catch (e) {}
                supportersLoaded.value = true;

                // If the user arrived here via a sidebar entry that requested
                // a scroll target (currently: the "Support the Project" donate
                // button → "donate-hero"), honor it after the view has rendered.
                const pending = window.pendingViewScroll;
                if (pending && pending.view === 'about' && pending.elementId) {
                    window.pendingViewScroll = null;
                    requestAnimationFrame(() => {
                        const el = document.getElementById(pending.elementId);
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    });
                }
            });

            return {
                t, appVersion, appAuthor, appDescription, sysInfoStrShort, debugCopied,
                contributors, contributorsLoaded, supporters, supportersLoaded,
                modals, appLicenseText, changelogLoaded, changelogGroups, changelogError,
                copyDebug, loadAppLicense, loadChangelog, openUrl
            };
        }
    });

    if (window._aboutApp) window._aboutApp.unmount();
    window._aboutApp = app;
    app.mount('#about-vue-app');
});