document.addEventListener('modder_extract_loaded', () => {
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load!");
        return;
    }

    const { createApp, reactive } = Vue;

    const app = createApp({
        setup() {
            const { store, t } = window.ModderTools;

            const extract = reactive({
                source: '', dest: ''
            });

            const validationState = reactive({
                extract: false
            });

            const isExtractFieldInvalid = (field) => {
                if (!validationState.extract) return false;
                switch (field) {
                    case 'source': return !extract.source;
                    case 'dest': return !extract.dest;
                    default: return false;
                }
            };

            const browseExtractSource = async () => {
                const fileResp = await eel.ask_tmod_file()();
                const file = fileResp?.value ?? fileResp?.data?.value ?? fileResp;
                if (file) extract.source = file;
            };
            const browseExtractDest = async () => {
                const dirResp = await eel.ask_extract_destination()();
                const dir = dirResp?.value ?? dirResp?.data?.value ?? dirResp;
                if (dir) extract.dest = dir;
            };
            const extractTMod = async () => {
                validationState.extract = true;
                if (!extract.source) return window.showToast(t("modder_tools.please_select_a_source_tmod_file"), true);
                if (!extract.dest) return window.showToast(t("modder_tools.please_select_a_destination_folder"), true);

                store.isWorking.extracting = true;
                try {
                    const result = await window.ModderTools.runQueuedModderOperation({
                        label: t('modder_tools.extract_tmod_archive'),
                        operation: 'extract_tmod',
                        task: () => eel.extract_tmod(extract.source, extract.dest)()
                    });
                    if (result.cancelled) {
                        window.showToast(t('common.extraction_cancelled'));
                        store.isWorking.extracting = false;
                        return;
                    }
                    if (result.success) window.showToast(t("modder_tools.successfully_extracted_count_files_to_pa_a5ca3e").replace("{count}", result.count).replace("{path}", extract.dest));
                    else window.showToast(t("modder_tools.failed_to_extract_tmod_error").replace("{error}", result.error), true);
                } catch (e) {
                    window.showToast(t("modder_tools.an_unexpected_error_occurred_during_extr_0d9416"), true);
                }
                store.isWorking.extracting = false;
            };

            return {
                t, store, extract,
                isExtractFieldInvalid,
                browseExtractSource, browseExtractDest, extractTMod
            };
        }
    });

    if (window._modderExtractApp) window._modderExtractApp.unmount();
    window._modderExtractApp = app;
    app.mount('#modder-extract-vue-app-inner');
});
