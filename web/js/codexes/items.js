function initItemsView() {
    window.CodexView.boot('items', 'Item', function setup() {
        const { ref, computed } = Vue;

        const itemsData = ref([]);
        const categoryOptions = ref([]);

        const prettyNameFromPath = (value) => {
            const normalized = String(value || '').replace(/\\/g, '/').replace(/\.binfab$/i, '').trim();
            const tail = normalized.split('/').filter(Boolean).pop() || normalized;
            return tail
                .replace(/^collections\//i, '')
                .replace(/^(?:item|placeable|block|collections)\//i, '')
                .replace(/[_-]+/g, ' ')
                .trim()
                .replace(/\b\w/g, (ch) => ch.toUpperCase());
        };

        const normalizeUnlockEntry = (unlock) => {
            if (unlock && typeof unlock === 'object' && !Array.isArray(unlock)) {
                const path = String(unlock.path || unlock.filename || unlock.id || '').trim();
                const name = String(unlock.name || '').trim();
                return {
                    path,
                    name: name || prettyNameFromPath(path),
                };
            }
            const path = String(unlock || '').trim();
            return {
                path,
                name: prettyNameFromPath(path),
            };
        };

        const kit = window.CodexView.create({
            key: 'items',
            singular: 'item',
            plural: 'items',
            pageSize: 36,
            clampPage: false,
            cacheAgeSuffix: true,
            filters: { selectedCategory: 'All' },
            sourceText: {
                'game-cache': 'items.loaded_item_data_from_cached_game_file_s_3ebc82',
                'game-cache-stale': 'items.loaded_item_data_from_cache_refreshing_i_cd0a43',
                'game-live': 'items.loaded_item_data_from_live_game_files',
            },
            ingest: (data) => {
                const uniqueCategories = new Set();
                itemsData.value = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.category) uniqueCategories.add(row.category);
                    return {
                        id: key,
                        ...row,
                        imagePath: kit.catalogImage(row.blueprint || row.filename || key),
                        unlocks: Array.isArray(row.unlocks) ? row.unlocks.map(normalizeUnlockEntry).filter(unlock => unlock.path) : [],
                    };
                });

                const catOpts = [['All Categories', 'All']];
                Array.from(uniqueCategories).sort().forEach(c => catOpts.push([c, c]));
                categoryOptions.value = catOpts;
            },
        });
        const { searchQuery, t } = kit;
        const { selectedCategory } = kit.filters;

        const filteredItems = computed(() => {
            let result = itemsData.value.slice();

            const sq = searchQuery.value.toLowerCase().trim();
            if (sq.length >= 3) {
                let generalSearch = sq;
                const filters = { name: null, category: null, unlock: null, path: null };
                const regex = /(name|category|unlock|path):("([^"]+)"|([^\s]+))/g;
                let match;
                while ((match = regex.exec(sq)) !== null) {
                    filters[match[1]] = (match[3] || match[4] || '').toLowerCase();
                    generalSearch = generalSearch.replace(match[0], '');
                }
                generalSearch = generalSearch.trim();

                result = result.filter(item => {
                    const name = String(item.name || '').toLowerCase();
                    const category = String(item.category || '').toLowerCase();
                    const path = String(item.filename || '').toLowerCase();
                    const desc = String(item.desc || '').toLowerCase();
                    const unlocks = (item.unlocks || []).map(unlock => {
                        if (unlock && typeof unlock === 'object') {
                            return `${unlock.name || ''} ${unlock.path || ''}`;
                        }
                        return String(unlock || '');
                    }).join(' ').toLowerCase();

                    if (filters.name && !name.includes(filters.name)) return false;
                    if (filters.category && !category.includes(filters.category)) return false;
                    if (filters.unlock && !unlocks.includes(filters.unlock)) return false;
                    if (filters.path && !path.includes(filters.path)) return false;

                    if (generalSearch.length > 0) {
                        const haystack = `${name} ${category} ${path} ${desc} ${unlocks}`;
                        if (!haystack.includes(generalSearch)) return false;
                    }
                    return true;
                });
            }

            if (selectedCategory.value && selectedCategory.value !== 'All') {
                result = result.filter(item => item.category === selectedCategory.value);
            }

            return [...result].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        });
        kit.paginate(filteredItems);

        const exportCsv = () => {
            if (!window.CodexExport) return;
            const { joinList, yesNo } = window.CodexExport;
            window.CodexExport.run({
                rows: filteredItems.value,
                basename: 'items',
                t,
                columns: [
                    { label: 'Name', value: (row) => t(row.name) },
                    { label: 'Category', value: (row) => t(row.category || 'Item') },
                    { label: 'Description', value: (row) => t(row.desc || '') },
                    { label: 'Tradability', value: (row) => t(row.tradability || '') },
                    { label: 'Lootbox', value: (row) => yesNo(row.lootbox, t) },
                    { label: 'Decay', value: (row) => yesNo(row.decay, t) },
                    { label: 'Unlock Count', value: (row) => (row.unlocks || []).length },
                    { label: 'Unlocks', value: (row) => joinList((row.unlocks || []).map(u => u.name || u.path)) },
                    { label: 'Designer', value: (row) => row.designer || '' },
                    { label: 'Path', value: (row) => row.filename || '' },
                    { label: 'Blueprint', value: (row) => row.blueprint || '' },
                    { label: 'ID', value: (row) => row.id || '' },
                ],
            });
        };

        return {
            ...kit.expose(),
            itemsData, filteredItems,
            paginatedItems: kit.paginatedItems,
            categoryOptions,
            resetFilters: kit.resetFilters, exportCsv,
        };
    });
}

// Driven solely by the `items_loaded` event dispatched after lazy-load; the
// old readyState self-call double-initialized (mount + remount + duplicate
// fetch) once these scripts became lazy-loaded. Removed.
document.addEventListener('items_loaded', initItemsView);
