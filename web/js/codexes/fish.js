function initFishView() {
    window.CodexView.boot('fish', 'Fish', function setup() {
        const { ref, computed } = Vue;

        const fishData = ref([]);
        const sourceOptions = ref([['All Sources', 'All']]);
        const rarityOptions = ref([['All Rarities', 'All']]);

        const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Relic'];
        const RARITY_COLORS = {
            Common: '#b0bec5', Uncommon: '#7ed957', Rare: '#5ec6ff',
            Epic: '#b066ff', Legendary: '#ffd54f', Relic: '#ff8a65'
        };

        const kit = window.CodexView.create({
            key: 'fish',
            singular: 'fish',
            plural: 'fish',
            filters: { selectedSource: 'All', selectedRarity: 'All' },
            sourceText: {
                'game-cache': 'fish.loaded_fish_data_from_cached_game_file_s_1562da',
                'game-cache-stale': 'fish.loaded_fish_data_from_cache_refreshing_i_e9df1d',
                'game-live': 'fish.loaded_fish_data_from_live_game_files',
            },
            ingest: (data) => {
                const sources = new Set(), rarities = new Set();
                fishData.value = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.source) sources.add(row.source);
                    if (row.rarity) rarities.add(row.rarity);
                    return {
                        id: key, ...row,
                        imagePath: kit.catalogImage(row.blueprint || row.filename || key),
                    };
                });
                sourceOptions.value = [['All Sources', 'All'], ...Array.from(sources).sort().map(s => [s, s])];
                rarityOptions.value = [['All Rarities', 'All'], ...Array.from(rarities)
                    .sort((a, b) => (RARITY_ORDER.indexOf(a) + 1 || 99) - (RARITY_ORDER.indexOf(b) + 1 || 99))
                    .map(r => [r, r])];
            },
        });
        const { searchQuery, t } = kit;
        const { selectedSource, selectedRarity } = kit.filters;

        const rarityColor = (r) => RARITY_COLORS[r] || 'var(--text-muted)';
        const trophyCount = (fish) => fish.trophies ? Object.keys(fish.trophies).length : 0;
        const weightText = (fish) => (fish.weight_min != null && fish.weight_max != null)
            ? `${fish.weight_min} - ${fish.weight_max}` : '';

        const filteredFish = computed(() => {
            let result = fishData.value.slice();
            const sq = searchQuery.value.toLowerCase().trim();
            if (sq.length >= 3) {
                let general = sq;
                const filters = { name: null, source: null, rarity: null, path: null };
                const regex = /(name|source|rarity|path):("([^"]+)"|([^\s]+))/g;
                let m;
                while ((m = regex.exec(sq)) !== null) {
                    filters[m[1]] = (m[3] || m[4] || '').toLowerCase();
                    general = general.replace(m[0], '');
                }
                general = general.trim();
                result = result.filter(f => {
                    const name = String(f.name || '').toLowerCase();
                    const source = String(f.source || '').toLowerCase();
                    const rarity = String(f.rarity || '').toLowerCase();
                    const path = String(f.filename || '').toLowerCase();
                    const desc = String(f.desc || '').toLowerCase();
                    if (filters.name && !name.includes(filters.name)) return false;
                    if (filters.source && !source.includes(filters.source)) return false;
                    if (filters.rarity && !rarity.includes(filters.rarity)) return false;
                    if (filters.path && !path.includes(filters.path)) return false;
                    if (general.length > 0 && !`${name} ${source} ${rarity} ${path} ${desc}`.includes(general)) return false;
                    return true;
                });
            }
            if (selectedSource.value !== 'All') result = result.filter(f => f.source === selectedSource.value);
            if (selectedRarity.value !== 'All') result = result.filter(f => f.rarity === selectedRarity.value);
            return [...result].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        });

        // Group the filtered fish by liquid (source). Inside each group, sort by
        // rarity Common -> Rare so the section reads naturally.
        const groupedFish = computed(() => {
            const groups = new Map();
            for (const f of filteredFish.value) {
                const label = f.source || 'Other';
                if (!groups.has(label)) groups.set(label, []);
                groups.get(label).push(f);
            }
            const arr = Array.from(groups.entries()).map(([label, list]) => {
                list.sort((a, b) => {
                    const ra = (RARITY_ORDER.indexOf(String(a.rarity || '').toLowerCase()) + 1) || 99;
                    const rb = (RARITY_ORDER.indexOf(String(b.rarity || '').toLowerCase()) + 1) || 99;
                    if (ra !== rb) return ra - rb;
                    return String(a.name || '').localeCompare(String(b.name || ''));
                });
                return { label, fish: list, count: list.length };
            });
            arr.sort((a, b) => a.label.localeCompare(b.label));
            return arr;
        });
        kit.paginate(groupedFish);

        const exportCsv = () => {
            if (!window.CodexExport) return;
            const { joinList } = window.CodexExport;
            window.CodexExport.run({
                rows: filteredFish.value,
                basename: 'fish',
                t,
                columns: [
                    { label: 'Name', value: (row) => t(row.name) },
                    { label: 'Source', value: (row) => t(row.source || '') },
                    { label: 'Rarity', value: (row) => t(row.rarity || '') },
                    { label: 'Description', value: (row) => t(row.desc || '') },
                    { label: 'Weight Min', value: (row) => (row.weight_min === null || row.weight_min === undefined ? '' : row.weight_min) },
                    { label: 'Weight Max', value: (row) => (row.weight_max === null || row.weight_max === undefined ? '' : row.weight_max) },
                    { label: 'Trophy Count', value: (row) => trophyCount(row) },
                    // trophies is {basic|silver|gold: deco path}; the slots are what the card shows.
                    { label: 'Trophy Variants', value: (row) => joinList(Object.keys(row.trophies || {})) },
                    { label: 'Tradable', value: (row) => (row.tradable === null || row.tradable === undefined ? '' : t(row.tradable ? 'Tradable' : 'Untradable')) },
                    { label: 'Path', value: (row) => row.filename || '' },
                    { label: 'Blueprint', value: (row) => row.blueprint || '' },
                    { label: 'ID', value: (row) => row.id || '' },
                ],
            });
        };

        return {
            ...kit.expose(),
            fishData, filteredFish, groupedFish,
            paginatedGroups: kit.paginatedItems,
            sourceOptions, rarityOptions,
            rarityColor, trophyCount, weightText, exportCsv,
        };
    });
}

// Init is driven solely by the `fish_loaded` event, which codexes.js dispatches
// right after lazy-loading this script (the listener above is already attached
// by then). The old `if (document.readyState !== 'loading') initFishView()`
// self-call fired an extra time on load, causing a full mount + immediate
// unmount/remount and a duplicate data fetch on first open. Removed.
document.addEventListener('fish_loaded', initFishView);
