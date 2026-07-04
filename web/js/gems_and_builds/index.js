document.addEventListener('gems_and_builds_loaded', () => {
    console.log("Gems and Builds Manager initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, watch, onMounted } = Vue;

    const app = createApp({
        setup() {
            const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;
            const PREF_STATE_KEY = 'state_gems_and_builds';
            
            const activeTab = ref('gem-builds');
            
            const setActiveTab = (tabName) => {
                activeTab.value = tabName;
                persistState();
            };

            const persistState = () => {
                if (!window.AppSettings) return;
                window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                    activeTab: activeTab.value
                });
            };

            const restoreState = async () => {
                if (!window.AppSettings) return;
                await window.AppSettings.load();
                const saved = window.AppSettings.getPref(PREF_STATE_KEY, null);
                if (saved && typeof saved === 'object' && typeof saved.activeTab === 'string') {
                    activeTab.value = saved.activeTab;
                }
            };

            const loadSubviewContent = async () => {
                // Fetch all four sub-view HTMLs in parallel — they're independent and the
                // sequential fetch was costing several round-trips before the user could
                // interact with the gems tab.
                const subviews = [
                    { url: 'views/gems_and_builds/gem_builds.html', host: 'gem-builds-vue-app-inner' },
                    { url: 'views/gems_and_builds/star_chart.html', host: 'star-chart-vue-app-inner' },
                    { url: 'views/gems_and_builds/gem_evaluator.html', host: 'gem-evaluator-vue-app-inner' },
                    { url: 'views/gems_and_builds/gem_simulator.html', host: 'gem-simulator-vue-app-inner' },
                ];
                const fetched = await Promise.all(subviews.map(async ({ url, host }) => {
                    try {
                        const response = await fetch(url);
                        if (!response.ok) return null;
                        return { host, html: await response.text() };
                    } catch (e) {
                        console.error(`Failed to fetch ${url}:`, e);
                        return null;
                    }
                }));
                fetched.forEach((entry) => {
                    if (!entry) return;
                    const el = document.getElementById(entry.host);
                    if (el) el.innerHTML = entry.html;
                });
            };

            onMounted(async () => {
                await restoreState();
                
                // Check if a specific tab was requested via command palette
                const applyPendingGemsTab = () => {
                    if (window.pendingGemsTab) {
                        activeTab.value = window.pendingGemsTab;
                        window.pendingGemsTab = null;
                        persistState();
                    }
                };
                applyPendingGemsTab();
                // A deep-link into a sub-tab of the already-cached view arrives via
                // gems_and_builds_shown (no rebuild); honor it in place. Drop any
                // prior handler first so a rebuild can't leave two racing.
                if (window._gemsShownHandler) {
                    document.removeEventListener('gems_and_builds_shown', window._gemsShownHandler);
                }
                window._gemsShownHandler = applyPendingGemsTab;
                document.addEventListener('gems_and_builds_shown', applyPendingGemsTab);
                
                await loadSubviewContent();
                
                // Dispatch custom events to initialize the individual apps
                // These will be caught by gem_builds.js, star_chart.js, and gem_simulator.js
                document.dispatchEvent(new CustomEvent('gem_builds_loaded'));
                document.dispatchEvent(new CustomEvent('star_chart_loaded'));
                document.dispatchEvent(new CustomEvent('gem_evaluator_loaded'));
                document.dispatchEvent(new CustomEvent('gem_simulator_loaded'));
            });

            // Watch for tab changes and trigger appropriate events
            watch(() => activeTab.value, (newTab) => {
                if (newTab === 'gem-builds') {
                    document.dispatchEvent(new CustomEvent('gem_builds_shown'));
                } else if (newTab === 'star-chart') {
                    document.dispatchEvent(new CustomEvent('star_chart_shown'));
                } else if (newTab === 'gem-evaluator') {
                    document.dispatchEvent(new CustomEvent('gem_evaluator_shown'));
                } else if (newTab === 'gem-simulator') {
                    document.dispatchEvent(new CustomEvent('gem_simulator_shown'));
                }
            });

            return {
                activeTab,
                setActiveTab,
                t
            };
        }
    });

    app.mount('#gems-and-builds-vue-app');
});

// Auto-dispatch removed: window.loadView() now dispatches `gems_and_builds_loaded`
// after this script finishes loading.
