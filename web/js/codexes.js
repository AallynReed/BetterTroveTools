document.addEventListener('codexes_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const root = document.getElementById('codexes-vue-app');
    if (!root || root.dataset.codexesInitializing === '1') return;
    root.dataset.codexesInitializing = '1';

    const { createApp, ref, onMounted } = Vue;

    const app = createApp({
        setup() {
            const t = (str) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str) : str;
            const PREF_STATE_KEY = 'state_codexes';
            const activeTab = ref('allies');

            const setActiveTab = (tabName) => {
                activeTab.value = tabName;
                if (window.AppSettings) {
                    window.AppSettings.setPrefSync(PREF_STATE_KEY, {
                        activeTab: activeTab.value
                    });
                }
            };

            const restoreState = async () => {
                if (!window.AppSettings) return;
                await window.AppSettings.load();
                const saved = window.AppSettings.getPref(PREF_STATE_KEY, null);
                if (saved && typeof saved === 'object' && typeof saved.activeTab === 'string') {
                    activeTab.value = saved.activeTab;
                }
            };

            const loadSubview = async (targetId, viewPath, rootSelector, eventName) => {
                const host = document.getElementById(targetId);
                if (!host || host.childElementCount > 0) return;
                const response = await fetch(viewPath);
                if (!response.ok) throw new Error(`Failed to load ${viewPath}`);
                const html = await response.text();
                const parsed = new DOMParser().parseFromString(html, 'text/html');
                const rootNode = parsed.querySelector(rootSelector);
                if (!rootNode) throw new Error(`Failed to find ${rootSelector} in ${viewPath}`);
                host.innerHTML = '';
                host.appendChild(rootNode);
                document.dispatchEvent(new CustomEvent(eventName));
            };

            onMounted(async () => {
                await restoreState();
                if (window.pendingCodexTab) {
                    activeTab.value = window.pendingCodexTab;
                    window.pendingCodexTab = null;
                    if (window.AppSettings) {
                        window.AppSettings.setPrefSync(PREF_STATE_KEY, { activeTab: activeTab.value });
                    }
                }

                await loadSubview('codexes-allies-host', 'views/allies.html', '#allies-vue-app', 'allies_loaded');
                await loadSubview('codexes-mounts-host', 'views/mounts.html', '#mounts-vue-app', 'mounts_loaded');
                await loadSubview('codexes-dragons-host', 'views/dragons.html', '#dragons-vue-app', 'dragons_loaded');
                await loadSubview('codexes-mementos-host', 'views/mementos.html', '#mementos-vue-app', 'mementos_loaded');
                await loadSubview('codexes-recipes-host', 'views/recipes.html', '#recipes-vue-app', 'recipes_loaded');
            });

            return {
                activeTab,
                setActiveTab,
                t
            };
        }
    });

    try {
        if (window._codexesApp) window._codexesApp.unmount();
        window._codexesApp = app;
        app.mount('#codexes-vue-app');
    } finally {
        delete root.dataset.codexesInitializing;
    }
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        document.dispatchEvent(new CustomEvent('codexes_loaded'));
    });
} else {
    document.dispatchEvent(new CustomEvent('codexes_loaded'));
}
