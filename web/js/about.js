// --- Client info helpers ----------------------------------------------------
// Used by the About page's sysInfoStrShort/Full when we're NOT on desktop. The
// goal is browser/device facts (what's actually running the app), not the host
// the page was served from. We blend three sources:
//   - User-Agent parsing for the broad OS+browser+engine ID (works everywhere)
//   - navigator.userAgentData high-entropy hints for accurate Windows version,
//     architecture/bitness, and on mobile the device model (Chromium-only)
//   - Capacitor.getPlatform() to pin OS = "Android" inside the packaged app
//     (the WebView's UA still says Android, but this is the source of truth)
const _parseBrowser = (ua) => {
    let m;
    if ((m = ua.match(/Edg\/([\d.]+)/)))     return { name: 'Edge',    version: m[1] };
    if ((m = ua.match(/OPR\/([\d.]+)/)))     return { name: 'Opera',   version: m[1] };
    if ((m = ua.match(/Firefox\/([\d.]+)/))) return { name: 'Firefox', version: m[1] };
    if ((m = ua.match(/Chrome\/([\d.]+)/)))  return { name: 'Chrome',  version: m[1] };
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua) && (m = ua.match(/Version\/([\d.]+)/))) {
        return { name: 'Safari', version: m[1] };
    }
    return { name: 'Browser', version: '' };
};
const _parseEngine = (ua) => {
    let m;
    if ((m = ua.match(/Gecko\/[\d.]+/)))              return { name: 'Gecko',   version: '' };
    if ((m = ua.match(/AppleWebKit\/([\d.]+)/)))      return { name: 'WebKit',  version: m[1] };
    return { name: '', version: '' };
};
const _parseOS = (ua) => {
    // Trove targets Windows + Linux (via Steam/Proton) for the playable game and
    // Android for the companion app. macOS / iOS aren't supported targets — no
    // Trove client there, and Apple Silicon isn't supported by the game engine
    // anyway — so we don't bother parsing those UAs. Web users on other OSes
    // just fall through to '' which surfaces as a blank OS field in the line.
    let m;
    if ((m = ua.match(/Android\s([\d.]+)/)))    return { name: 'Android', version: m[1] };
    if ((m = ua.match(/Windows NT\s([\d.]+)/))) {
        // NT 10.0 covers Windows 10 AND 11; the high-entropy `platformVersion`
        // resolves it for Chromium UAs (≥13.0.0 = Win 11), so leave it generic
        // here and let the caller overwrite when better data is available.
        const map = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7', '6.0': 'Vista', '5.1': 'XP' };
        return { name: 'Windows', version: map[m[1]] || m[1] };
    }
    if (/Linux/.test(ua)) return { name: 'Linux', version: '' };
    return { name: '', version: '' };
};
// Promise<{ os, os_release, architecture, browser, engine, model, screen,
//           cores, memory_gb, platform }> — everything either a string or ''.
const collectClientInfo = async () => {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const browser = _parseBrowser(ua);
    const engine = _parseEngine(ua);
    let os = _parseOS(ua);

    // Client Hints (Chromium ≥90): more accurate than UA parsing on Windows 11
    // and the only way to read the mobile device model in modern Chrome.
    let uad = null;
    try {
        if (navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function') {
            uad = await navigator.userAgentData.getHighEntropyValues(['platform','platformVersion','architecture','bitness','model']);
        }
    } catch (_) { /* user denied / unsupported */ }
    if (uad && uad.platform) {
        os.name = uad.platform;
        if (uad.platformVersion) {
            // Chromium's Win 11 marker is platformVersion ≥ 13.0.0.
            if (uad.platform === 'Windows') {
                const major = parseInt((uad.platformVersion.split('.')[0] || '0'), 10);
                os = { name: 'Windows', version: major >= 13 ? '11' : (major > 0 ? '10' : os.version) };
            } else {
                os.version = uad.platformVersion;
            }
        }
    }

    // Packaged Android app: Capacitor is the source of truth for OS name even
    // when the WebView UA is unusual (custom shells, vendor forks, etc.). Only
    // Android is shipped — there's no Trove iOS client to warrant a build.
    const capPlatform = (window.Capacitor && typeof window.Capacitor.getPlatform === 'function')
        ? window.Capacitor.getPlatform() : '';
    if (capPlatform === 'android') os.name = 'Android';

    const arch = uad && uad.architecture
        ? `${uad.architecture}${uad.bitness ? '/' + uad.bitness : ''}`
        : '';

    const sw = (window.screen && window.screen.width) || 0;
    const sh = (window.screen && window.screen.height) || 0;
    const dpr = window.devicePixelRatio || 1;
    const screenStr = sw && sh ? `${sw}×${sh}@${dpr}x` : '';

    return {
        os: os.name || '',
        os_release: os.version || '',
        architecture: arch,
        browser: browser.name ? `${browser.name}${browser.version ? ' ' + browser.version : ''}` : '',
        engine: engine.name ? `${engine.name}${engine.version ? ' ' + engine.version : ''}` : '',
        model: (uad && uad.model) || '',
        screen: screenStr,
        cores: navigator.hardwareConcurrency || '',
        memory_gb: navigator.deviceMemory || '',
        platform: capPlatform ? `Capacitor ${capPlatform}` : (window.BTT_WEB_MODE ? 'Web' : ''),
    };
};

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
                    // Desktop (eel-backed) reports the user's real OS/CPU from
                    // Python's `platform` module. On web/Android that call would
                    // either fail outright (Android: no eel) or — worse — hit
                    // the hosted web's /api/eel/ shim and report the SERVER's
                    // host info, not the user's. Branch on BTT_WEB_MODE so we
                    // gather from `navigator` + Capacitor in those cases.
                    if (!window.BTT_WEB_MODE && window.eel && typeof window.eel.get_system_info === 'function') {
                        const sysInfo = await eel.get_system_info()();
                        if (sysInfo && !sysInfo.error) {
                            sysInfoStrFull.value = `\nOS: ${sysInfo.os} ${sysInfo.os_release} (${sysInfo.architecture})\nProcessor: ${sysInfo.processor}`;
                            sysInfoStrShort.value = `${sysInfo.os} ${sysInfo.os_release} | ${sysInfo.processor}`;
                        }
                    } else {
                        const ci = await collectClientInfo();
                        const osLine = [ci.os, ci.os_release].filter(Boolean).join(' ');
                        sysInfoStrShort.value = [osLine, ci.browser].filter(Boolean).join(' | ');

                        const lines = [];
                        if (osLine) lines.push(`OS: ${osLine}${ci.architecture ? ' (' + ci.architecture + ')' : ''}`);
                        if (ci.model)      lines.push(`Device: ${ci.model}`);
                        if (ci.browser)    lines.push(`Browser: ${ci.browser}`);
                        if (ci.engine)     lines.push(`Engine: ${ci.engine}`);
                        if (ci.screen)     lines.push(`Screen: ${ci.screen}`);
                        if (ci.cores)      lines.push(`CPU cores: ${ci.cores}`);
                        if (ci.memory_gb)  lines.push(`Memory: ~${ci.memory_gb} GB`);
                        if (ci.platform)   lines.push(`Platform: ${ci.platform}`);
                        sysInfoStrFull.value = lines.length ? '\n' + lines.join('\n') : '';
                    }
                } catch (e) {}

                try {
                    const res = await fetch('https://api.github.com/repos/AallynReed/BetterTroveTools/contributors', { bttLabel: t('about.fetching_contributors') });
                    const data = await res.json();
                    if (Array.isArray(data)) contributors.value = data;
                } catch (e) {}
                contributorsLoaded.value = true;

                // Supporters list: Kiwi /v1/misc/supporters is the sole source
                // of truth; admin-controlled display order ({supporters: [...]}).
                // Empty list (or fetch failure) renders the "no supporters listed
                // yet" state — no bundled copy to go stale.
                try {
                    const path = 'misc/supporters';
                    let data;
                    if (window.BTT_Kiwi && typeof window.BTT_Kiwi.get === 'function') {
                        data = await window.BTT_Kiwi.get(path);
                    } else {
                        const resp = await fetch(`https://api.aallyn.net/v1/${path}`, { bttLabel: t('about.fetching_supporters') });
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        data = await resp.json();
                    }
                    if (data && Array.isArray(data.supporters)) {
                        supporters.value = data.supporters
                            .map((name) => typeof name === 'string' ? name.trim() : '')
                            .filter((name) => name.length > 0);
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