document.addEventListener('modder_software_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, ref, onMounted } = Vue;

    const app = createApp({
        setup() {
            const { t } = window.ModderTools;

            const softwareCategories = ref({});

            const loadModdingSoftware = async () => {
                try {
                    const response = await fetch('assets/data/modding_software.json');
                    const data = await response.json();
                    const categoryIcons = { 'blueprints': 'fa-cube', 'vfx': 'fa-wand-magic-sparkles', 'ui': 'fa-layer-group', 'sound': 'fa-headphones', 'textures': 'fa-palette' };

                    for (const [cat, catData] of Object.entries(data)) {
                        catData.icon = categoryIcons[cat] || 'fa-laptop-code';
                    }
                    softwareCategories.value = data;
                } catch (e) { console.error("Failed to load software:", e); }
            };

            onMounted(async () => {
                await loadModdingSoftware();
            });

            return {
                t, softwareCategories
            };
        }
    });

    if (window._modderSoftwareApp) window._modderSoftwareApp.unmount();
    window._modderSoftwareApp = app;
    app.mount('#modder-software-vue-app-inner');
});
