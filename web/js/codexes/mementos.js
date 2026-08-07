function initMementosView() {
    window.CodexView.boot('mementos', 'Memento', function setup() {
        const { ref, computed } = Vue;

        const mementosData = ref([]);
        const categoryOptions = ref([]);

        const stripMementoPrefix = (value) => String(value || '').replace(/^\s*Memento:\s*/i, '').trim();

        const kit = window.CodexView.create({
            key: 'mementos',
            singular: 'memento',
            plural: 'mementos',
            pageSize: 36,
            clampPage: false,
            cacheAgeSuffix: true,
            filters: { selectedCategory: 'All' },
            sourceText: {
                'game-cache': 'mementos.loaded_memento_data_from_cached_game_fil_232003',
                'game-cache-stale': 'mementos.loaded_memento_data_from_cache_refreshin_0ef26a',
                'game-live': 'mementos.loaded_memento_data_from_live_game_files',
            },
            ingest: (data) => {
                const uniqueCategories = new Set();
                mementosData.value = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.category) uniqueCategories.add(row.category);
                    const fallbackName = key.split('/').slice(-1)[0].replaceAll('_', ' ');
                    const hasSourceContext = !!(row.source_label && row.source_name);
                    return {
                        id: key,
                        ...row,
                        fallbackName,
                        imagePath: kit.catalogImage(row.blueprint || ''),
                        displayName: hasSourceContext
                            ? (row.name || fallbackName)
                            : (stripMementoPrefix(row.name || '') || fallbackName),
                    };
                });

                const catOpts = [['All Categories', 'All']];
                Array.from(uniqueCategories).sort().forEach(c => catOpts.push([c, c]));
                categoryOptions.value = catOpts;
            },
        });
        const { searchQuery, t } = kit;
        const { selectedCategory } = kit.filters;

        const filteredMementos = computed(() => {
            let result = mementosData.value.filter(m => {
                const category = m.category || 'Unknown';
                return category !== 'Unknown'
                    && category !== 'InProgress'
                    && category !== 'ReadyForGame'
                    && category !== 'Hidden'
                    && !!String(m.source_name || '').trim();
            });

            const sq = searchQuery.value.toLowerCase().trim();
            if (sq.length >= 3) {
                let generalSearch = sq;
                const filters = { author: null, name: null, category: null, source: null };
                const regex = /(author|designer|name|category|source):("([^"]+)"|([^\s]+))/g;
                let match;
                while ((match = regex.exec(sq)) !== null) {
                    const key = match[1] === 'designer' ? 'author' : match[1];
                    filters[key] = match[3] || match[4];
                    generalSearch = generalSearch.replace(match[0], '');
                }
                generalSearch = generalSearch.trim();

                result = result.filter(m => {
                    const name = (m.name || m.fallbackName || '').toLowerCase();
                    const source = (m.source_name || '').toLowerCase();
                    const category = (m.category || '').toLowerCase();
                    const designer = (m.designer || '').toLowerCase();

                    if (filters.author && !designer.includes(filters.author)) return false;
                    if (filters.name && !name.includes(filters.name)) return false;
                    if (filters.category && !category.includes(filters.category)) return false;
                    if (filters.source && !source.includes(filters.source)) return false;
                    if (generalSearch.length > 0 && !(name.includes(generalSearch) || source.includes(generalSearch) || category.includes(generalSearch) || designer.includes(generalSearch))) return false;
                    return true;
                });
            }

            if (selectedCategory.value && selectedCategory.value !== 'All') {
                result = result.filter(m => m.category === selectedCategory.value);
            }

            return [...result].sort((a, b) => (a.name || a.fallbackName || '').localeCompare(b.name || b.fallbackName || ''));
        });
        kit.paginate(filteredMementos);

        const sourceRowClass = (label) => {
            switch (String(label || '').toLowerCase()) {
                case 'biome':
                    return 'memento-meta-row-biome';
                case 'boss':
                    return 'memento-meta-row-boss';
                case 'creature':
                    return 'memento-meta-row-creature';
                default:
                    return '';
            }
        };

        const exportCsv = () => {
            if (!window.CodexExport) return;
            window.CodexExport.run({
                rows: filteredMementos.value,
                basename: 'mementos',
                t,
                columns: [
                    { label: 'Name', value: (row) => t(row.displayName || row.name || row.fallbackName) },
                    { label: 'Category', value: (row) => t(row.category || '') },
                    { label: 'Description', value: (row) => t(row.desc || '') },
                    { label: 'Mastery', value: (row) => row.mastery || '0' },
                    { label: 'Source Type', value: (row) => t(row.source_label || '') },
                    { label: 'Source', value: (row) => t(row.source_name || '') },
                    { label: 'Biome', value: (row) => t(row.biome_name || '') },
                    { label: 'Designer', value: (row) => row.designer || '' },
                    { label: 'Path', value: (row) => row.filename || '' },
                    { label: 'Blueprint', value: (row) => row.blueprint || '' },
                    { label: 'ID', value: (row) => row.id || '' },
                ],
            });
        };

        return {
            ...kit.expose(),
            mementosData, filteredMementos,
            paginatedMementos: kit.paginatedItems,
            categoryOptions,
            resetFilters: kit.resetFilters, exportCsv, sourceRowClass,
        };
    });
}

document.addEventListener('mementos_loaded', initMementosView);
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initMementosView, 0);
});
