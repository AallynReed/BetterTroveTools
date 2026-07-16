// Shared state + helpers for the Modder Tools split.
// MUST load before index.js and every per-tab file. Idempotent so re-loads
// (e.g. a view re-entry) never clobber the live reactive store.
(function () {
    if (window.ModderTools) return;
    if (typeof Vue === 'undefined') {
        console.error("Vue.js failed to load before ModderTools shared!");
        return;
    }

    const { reactive } = Vue;

    const t = (str, p) => window.I18nManager && window.I18nManager.t ? window.I18nManager.t(str, p) : str;

    // A module-level Vue.reactive is shared across every createApp instance and
    // stays reactive in each. RULE: mutate `store.x`, never reassign `store`.
    const store = reactive({
        selectedGamePath: '',
        installs: [],
        isWorking: {
            detectingOverrides: false,
            autoStructuringBuild: false,
            buildingTMod: false,
            extracting: false,
            loadingEditTmod: false,
            savingEditTmod: false,
            refreshProjectFiles: false,
            autoStructuringProject: false,
            compilingProject: false,
            placingOverrides: false,
            removingOverrides: false,
            savingQb: false
        },
        tagOptions: [
            {id: 'Allies', text: 'Allies'}, {id: 'Banners', text: 'Banners'}, {id: 'Boats and Sails', text: 'Boats and Sails'},
            {id: 'Cosmetics', text: 'Cosmetics'}, {id: 'Costumes', text: 'Costumes'}, {id: 'Dragons', text: 'Dragons'},
            {id: 'Fishing', text: 'Fishing'}, {id: 'GUI', text: 'GUI'}, {id: 'Helmets', text: 'Helmets'},
            {id: 'Language', text: 'Language'}, {id: 'Mag Riders', text: 'Mag Riders'}, {id: 'Mounts', text: 'Mounts'},
            {id: 'NPCs', text: 'NPCs'}, {id: 'Utility', text: 'Utility'}, {id: 'Waypoint', text: 'Waypoint'},
            {id: 'Wings', text: 'Wings'}
        ],
        subtypeOptions: [
            [t('modder_tools.no_subtype'), ''],
            ['Bard', 'Bard'], ['Boomeranger', 'Boomeranger'],
            ['Candy Barbarian', 'Candy Barbarian'], ['Chloromancer', 'Chloromancer'],
            ['Dino Tamer', 'Dino Tamer'], ['Dracolyte', 'Dracolyte'],
            ['Fae Trickster', 'Fae Trickster'], ['Gunslinger', 'Gunslinger'],
            ['Ice Sage', 'Ice Sage'], ['Knight', 'Knight'],
            ['Lunar Lancer', 'Lunar Lancer'], ['Neon Ninja', 'Neon Ninja'],
            ['Pirate Captain', 'Pirate Captain'], ['Revenant', 'Revenant'],
            ['Shadow Hunter', 'Shadow Hunter'], ['Solarion', 'Solarion'],
            ['Tomb Raiser', 'Tomb Raiser'], ['Vanguardian', 'Vanguardian']
        ]
    });

    const normalizeInternalPath = (value) => String(value || '').replaceAll('\\', '/').trim().toLowerCase();
    const defaultConfigInternalPath = 'ui/default.cfg';
    const previewInternalPath = (name) => `ui/${String(name || '').replace(/[\\/*?:"<>|]/g, '').trim()}`;

    // Returns an i18n id (callers pass it through t() before showing it) or null.
    const validateSpecialFileSelections = ({ files, previewName, hasPreview, hasConfig }) => {
        const seen = new Set();
        for (const file of files || []) {
            const internalPath = normalizeInternalPath(file.internal_path);
            if (!internalPath) continue;
            if (seen.has(internalPath)) return 'modder_tools.same_file_path_added_more_than_once';
            seen.add(internalPath);
        }

        if (hasConfig && seen.has(defaultConfigInternalPath)) {
            return 'modder_tools.default_cfg_must_use_config_option';
        }

        if (hasPreview) {
            const previewPath = normalizeInternalPath(previewInternalPath(previewName || 'preview.png'));
            if (seen.has(previewPath)) return 'modder_tools.preview_image_path_cannot_also_be_includ_01ba5d';
        }

        const cfgPaths = [...seen].filter(path => path.endsWith('.cfg'));
        if (hasConfig) cfgPaths.push(defaultConfigInternalPath);
        if (cfgPaths.length > 1) return 'modder_tools.only_one_config_file_per_mod';
        if (cfgPaths.length === 1) {
            if (cfgPaths[0] !== defaultConfigInternalPath) return 'modder_tools.default_cfg_must_use_config_option';
        }

        return null;
    };

    const hasIllegalTitleChars = (value) => /[<>:"/\\|?*]/.test(String(value || '').trim());

    const runQueuedModderOperation = async ({ label, operation, task }) => {
        return window.JobQueue.run({
            label,
            task,
            retryTask: task,
            cancel: () => eel.cancel_modder_tools_operation(operation)()
        });
    };

    const unwrapResponse = (resp, key = null, fallback = null) => {
        if (key) {
            if (resp && Object.prototype.hasOwnProperty.call(resp, key)) return resp[key];
            if (resp && resp.data && Object.prototype.hasOwnProperty.call(resp.data, key)) return resp.data[key];
        }
        if (resp && resp.data !== undefined && resp.success !== undefined) return resp.data;
        return resp ?? fallback;
    };

    const readSettings = async () => {
        const settingsResp = await eel.get_settings()();
        return unwrapResponse(settingsResp, null, {}) || {};
    };

    const openPathInExplorer = async (path) => {
        if (!path) {
            window.showToast(t('common.no_path_selected'), true);
            return;
        }
        const result = await eel.open_path_in_explorer(path)();
        if (!result || !result.success) {
            window.showToast(t('common.failed_to_open_folder_error').replace('{error}', result?.error || t('common.unknown_error_occurred')), true);
        }
    };

    // Returns the game-path picker options derived from the live install scan.
    const buildGameOptions = () => {
        if (store.installs.length === 0) return [[t('common.searching'), '']];
        return store.installs.map(g => [
            t('common.name_path')
                .replace('{name}', t(g.name))
                .replace('{path}', g.path),
            g.path
        ]);
    };

    window.ModderTools = {
        store,
        t,
        validateSpecialFileSelections,
        hasIllegalTitleChars,
        normalizeInternalPath,
        previewInternalPath,
        runQueuedModderOperation,
        unwrapResponse,
        readSettings,
        openPathInExplorer,
        buildGameOptions
    };
})();
