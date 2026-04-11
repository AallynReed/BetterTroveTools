document.addEventListener('gems_and_builds_loaded', () => {
    console.log("Gems and Builds Manager initialized!");
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, watch, onMounted } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
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
                try {
                    // Load Gem Builds view
                    const gemBuildsResponse = await fetch('views/gems_and_builds/gem_builds.html');
                    if (gemBuildsResponse.ok) {
                        const gemBuildsHtml = await gemBuildsResponse.text();
                        const gemBuildsContainer = document.getElementById('gem-builds-vue-app-inner');
                        if (gemBuildsContainer) {
                            gemBuildsContainer.innerHTML = gemBuildsHtml;
                        }
                    }

                    // Load Star Chart view
                    const starChartResponse = await fetch('views/gems_and_builds/star_chart.html');
                    if (starChartResponse.ok) {
                        const starChartHtml = await starChartResponse.text();
                        const starChartContainer = document.getElementById('star-chart-vue-app-inner');
                        if (starChartContainer) {
                            starChartContainer.innerHTML = starChartHtml;
                        }
                    }

                    // Load Gem Evaluator view
                    const gemEvaluatorResponse = await fetch('views/gems_and_builds/gem_evaluator.html');
                    if (gemEvaluatorResponse.ok) {
                        const gemEvaluatorHtml = await gemEvaluatorResponse.text();
                        const gemEvaluatorContainer = document.getElementById('gem-evaluator-vue-app-inner');
                        if (gemEvaluatorContainer) {
                            gemEvaluatorContainer.innerHTML = gemEvaluatorHtml;
                        }
                    }

                    // Load Gem Simulator view
                    const gemSimulatorResponse = await fetch('views/gems_and_builds/gem_simulator.html');
                    if (gemSimulatorResponse.ok) {
                        const gemSimulatorHtml = await gemSimulatorResponse.text();
                        const gemSimulatorContainer = document.getElementById('gem-simulator-vue-app-inner');
                        if (gemSimulatorContainer) {
                            gemSimulatorContainer.innerHTML = gemSimulatorHtml;
                        }
                    }
                } catch (error) {
                    console.error('Error loading subview content:', error);
                }
            };

            onMounted(async () => {
                await restoreState();
                
                // Check if a specific tab was requested via command palette
                if (window.pendingGemsTab) {
                    activeTab.value = window.pendingGemsTab;
                    window.pendingGemsTab = null;
                    persistState();
                }
                
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

// Ensure the event is fired when the script loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        document.dispatchEvent(new CustomEvent('gems_and_builds_loaded'));
    });
} else {
    document.dispatchEvent(new CustomEvent('gems_and_builds_loaded'));
}
