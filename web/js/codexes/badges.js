function initBadgesView() {
    window.CodexView.boot('badges', 'Badge', function setup() {
        const { ref, computed } = Vue;

        const badgesData = ref([]);
        const tierOptions = ref([['All Tiers', 'All']]);
        const categoryOptions = ref([['All Categories', 'All']]);

        const TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Obsidian', 'Trovium'];
        const TIER_COLORS = {
            Bronze: '#cd7f32', Silver: '#c0c0c0', Gold: '#ffd54f',
            Platinum: '#e5e4e2', Diamond: '#b9f2ff', Obsidian: '#7a4dff', Trovium: '#ff8a65'
        };

        const kit = window.CodexView.create({
            key: 'badges',
            singular: 'badge',
            plural: 'badges',
            filters: { selectedTier: 'All', selectedCategory: 'All' },
            sourceText: {
                'game-cache': 'badges.loaded_badge_data_from_cached_game_file_a0e7e4',
                'game-live': 'badges.loaded_badge_data_from_live_game_files',
            },
            ingest: (data) => {
                const tiers = new Set(), cats = new Set();
                badgesData.value = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.tier) tiers.add(row.tier);
                    if (row.in_game_category) cats.add(row.in_game_category);
                    return {
                        id: key, ...row,
                        imagePath: kit.catalogImage(row.blueprint || row.filename || key),
                    };
                });
                tierOptions.value = [['All Tiers', 'All'], ...Array.from(tiers)
                    .sort((a, b) => (TIER_ORDER.indexOf(a) + 1 || 99) - (TIER_ORDER.indexOf(b) + 1 || 99))
                    .map(t => [t, t]), ['(no tier)', '(none)']];
                categoryOptions.value = [['All Categories', 'All'], ...Array.from(cats).sort().map(c => [c, c]), ['(uncategorized)', '(uncategorized)']];
            },
        });
        const { searchQuery, t } = kit;
        const { selectedTier, selectedCategory } = kit.filters;

        const tierColor = (tier) => TIER_COLORS[tier] || 'var(--text-muted)';
        const masteryText = (b) => (b.base && b.multiplier > 1)
            ? `${b.mastery} (${b.base} × ${b.multiplier})` : `${b.mastery}`;

        const filteredBadges = computed(() => {
            let result = badgesData.value.slice();
            const sq = searchQuery.value.toLowerCase().trim();
            if (sq.length >= 3) {
                let general = sq;
                const filters = { name: null, group: null, tier: null, category: null };
                const regex = /(name|group|tier|category):("([^"]+)"|([^\s]+))/g;
                let m;
                while ((m = regex.exec(sq)) !== null) {
                    filters[m[1]] = (m[3] || m[4] || '').toLowerCase();
                    general = general.replace(m[0], '');
                }
                general = general.trim();
                result = result.filter(b => {
                    const name = String(b.name || '').toLowerCase();
                    const group = String(b.group || '').toLowerCase();
                    const tier = String(b.tier || '').toLowerCase();
                    const category = String(b.in_game_category || '').toLowerCase();
                    const path = String(b.filename || '').toLowerCase();
                    if (filters.name && !name.includes(filters.name)) return false;
                    if (filters.group && !group.includes(filters.group)) return false;
                    if (filters.tier && !tier.includes(filters.tier)) return false;
                    if (filters.category && !category.includes(filters.category)) return false;
                    if (general.length > 0 && !`${name} ${group} ${tier} ${category} ${path}`.includes(general)) return false;
                    return true;
                });
            }
            if (selectedTier.value !== 'All') {
                result = (selectedTier.value === '(none)')
                    ? result.filter(b => !b.tier)
                    : result.filter(b => b.tier === selectedTier.value);
            }
            if (selectedCategory.value !== 'All') {
                result = (selectedCategory.value === '(uncategorized)')
                    ? result.filter(b => !b.in_game_category)
                    : result.filter(b => b.in_game_category === selectedCategory.value);
            }
            return [...result].sort((a, b) => {
                // sort by category, then group, then tier order
                const ca = String(a.in_game_category || '~').localeCompare(String(b.in_game_category || '~'));
                if (ca !== 0) return ca;
                const ga = String(a.group || '').localeCompare(String(b.group || ''));
                if (ga !== 0) return ga;
                const ta = TIER_ORDER.indexOf(a.tier) + 1 || 99;
                const tb = TIER_ORDER.indexOf(b.tier) + 1 || 99;
                return ta - tb;
            });
        });

        // Pretty-print a snake_case group id ("dragon_beard" -> "Dragon Beard")
        const prettifyGroup = (s) => String(s || '').split('_')
            .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '').join(' ').trim();

        // Group the filtered badges by family (prefer the in-game category from
        // collection_badge.binfab, fall back to the group id). Inside each group,
        // sort by tier order so Bronze..Trovium reads naturally.
        const groupedBadges = computed(() => {
            const groups = new Map();
            for (const b of filteredBadges.value) {
                const label = b.in_game_category || prettifyGroup(b.group) || 'Other';
                if (!groups.has(label)) groups.set(label, []);
                groups.get(label).push(b);
            }
            const arr = Array.from(groups.entries()).map(([label, list]) => {
                list.sort((a, b) => {
                    const ta = (TIER_ORDER.indexOf(a.tier) + 1) || 99;
                    const tb = (TIER_ORDER.indexOf(b.tier) + 1) || 99;
                    if (ta !== tb) return ta - tb;
                    return String(a.name || '').localeCompare(String(b.name || ''));
                });
                return {
                    label,
                    badges: list,
                    count: list.length,
                    totalMastery: list.reduce((s, x) => s + (x.mastery || 0), 0),
                };
            });
            arr.sort((a, b) => a.label.localeCompare(b.label));
            return arr;
        });
        kit.paginate(groupedBadges);

        const totalMastery = computed(() => filteredBadges.value.reduce((s, b) => s + (b.mastery || 0), 0));

        const exportCsv = () => {
            if (!window.CodexExport) return;
            window.CodexExport.run({
                rows: filteredBadges.value,
                basename: 'badges',
                t,
                columns: [
                    { label: 'Name', value: (row) => t(row.name) },
                    { label: 'Group', value: (row) => t(row.group || '') },
                    { label: 'Tier', value: (row) => t(row.tier || '') },
                    { label: 'Category', value: (row) => t(row.in_game_category || '') },
                    { label: 'Description', value: (row) => t(row.desc || '') },
                    { label: 'Mastery', value: (row) => row.mastery || 0 },
                    { label: 'Path', value: (row) => row.filename || '' },
                    { label: 'Blueprint', value: (row) => row.blueprint || '' },
                    { label: 'ID', value: (row) => row.id || '' },
                ],
            });
        };

        return {
            ...kit.expose(),
            badgesData, filteredBadges, groupedBadges,
            paginatedGroups: kit.paginatedItems,
            tierOptions, categoryOptions,
            tierColor, masteryText, totalMastery, exportCsv,
        };
    });
}

// Driven solely by the `badges_loaded` event dispatched after lazy-load; the
// old readyState self-call double-initialized (mount + remount + duplicate
// fetch) once these scripts became lazy-loaded. Removed.
document.addEventListener('badges_loaded', initBadgesView);
