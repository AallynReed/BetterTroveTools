function initStylesView() {
    window.CodexView.boot('styles', 'Style', function setup() {
        const { ref, computed } = Vue;

        const stylesData = ref([]);
        const familyOptions = ref([['All Families', 'All']]);
        const masteryOptions = ref([
            ['All Mastery', 'All'],
            ['Has mastery', 'has'],
            ['Review-only', 'review'],
        ]);

        const kit = window.CodexView.create({
            key: 'styles',
            singular: 'style',
            plural: 'styles',
            filters: { selectedFamily: 'All', selectedMastery: 'All' },
            sourceText: {
                'game-cache': 'styles.loaded_style_data_from_cached_game_files',
                'game-live': 'styles.loaded_style_data_from_live_game_files',
            },
            ingest: (data) => {
                const families = new Set();
                stylesData.value = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.family) families.add(row.family);
                    return {
                        id: key, ...row,
                        imagePath: kit.catalogImage(row.blueprint || row.equipment_ref || row.filename || key),
                    };
                });
                familyOptions.value = [['All Families', 'All'], ...Array.from(families).sort().map(f => [f, f]), ['(no family)', '(none)']];
            },
        });
        const { searchQuery, t } = kit;
        const { selectedFamily, selectedMastery } = kit.filters;

        const filteredStyles = computed(() => {
            let result = stylesData.value.slice();
            const sq = searchQuery.value.toLowerCase().trim();
            if (sq.length >= 3) {
                let general = sq;
                const filters = { name: null, family: null, equipment: null };
                const regex = /(name|family|equipment):("([^"]+)"|([^\s]+))/g;
                let m;
                while ((m = regex.exec(sq)) !== null) {
                    filters[m[1]] = (m[3] || m[4] || '').toLowerCase();
                    general = general.replace(m[0], '');
                }
                general = general.trim();
                result = result.filter(s => {
                    const name = String(s.name || '').toLowerCase();
                    const family = String(s.family || '').toLowerCase();
                    const equipment = String(s.equipment_ref || '').toLowerCase();
                    const path = String(s.filename || '').toLowerCase();
                    if (filters.name && !name.includes(filters.name)) return false;
                    if (filters.family && !family.includes(filters.family)) return false;
                    if (filters.equipment && !equipment.includes(filters.equipment)) return false;
                    if (general.length > 0 && !`${name} ${family} ${equipment} ${path}`.includes(general)) return false;
                    return true;
                });
            }
            if (selectedFamily.value !== 'All') {
                result = (selectedFamily.value === '(none)')
                    ? result.filter(s => !s.family)
                    : result.filter(s => s.family === selectedFamily.value);
            }
            if (selectedMastery.value === 'has') {
                result = result.filter(s => s.mastery != null);
            } else if (selectedMastery.value === 'review') {
                result = result.filter(s => s.mastery == null);
            }
            return [...result].sort((a, b) => {
                const fa = String(a.family || '~').localeCompare(String(b.family || '~'));
                if (fa !== 0) return fa;
                return String(a.name || '').localeCompare(String(b.name || ''));
            });
        });

        // Group the filtered styles by family (Hat / Face / Weapon / Banner).
        const groupedStyles = computed(() => {
            const groups = new Map();
            for (const s of filteredStyles.value) {
                const label = s.family || 'Other';
                if (!groups.has(label)) groups.set(label, []);
                groups.get(label).push(s);
            }
            const arr = Array.from(groups.entries()).map(([label, list]) => {
                list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
                return {
                    label,
                    styles: list,
                    count: list.length,
                    totalMastery: list.reduce((s, x) => s + (x.mastery || 0), 0),
                };
            });
            arr.sort((a, b) => a.label.localeCompare(b.label));
            return arr;
        });
        kit.paginate(groupedStyles);

        const totalMastery = computed(() => filteredStyles.value.reduce((s, x) => s + (x.mastery || 0), 0));

        const exportCsv = () => {
            if (!window.CodexExport) return;
            window.CodexExport.run({
                rows: filteredStyles.value,
                basename: 'styles',
                t,
                columns: [
                    { label: 'Name', value: (row) => t(row.name) },
                    { label: 'Family', value: (row) => t(row.family || '') },
                    { label: 'Category', value: (row) => t(row.category || '') },
                    { label: 'Description', value: (row) => t(row.desc || '') },
                    { label: 'Mastery', value: (row) => row.mastery || 0 },
                    { label: 'Geode Mastery', value: (row) => row.mastery_geode || 0 },
                    { label: 'Equipment Ref', value: (row) => row.equipment_ref || '' },
                    { label: 'Path', value: (row) => row.filename || '' },
                    { label: 'Blueprint', value: (row) => row.blueprint || '' },
                    { label: 'ID', value: (row) => row.id || '' },
                ],
            });
        };

        return {
            ...kit.expose(),
            stylesData, filteredStyles, groupedStyles,
            paginatedGroups: kit.paginatedItems,
            familyOptions, masteryOptions,
            totalMastery, exportCsv,
        };
    });
}

document.addEventListener('styles_loaded', initStylesView);
