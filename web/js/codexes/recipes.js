function initRecipesView() {
    window.CodexView.boot('recipes', 'Recipe', function setup() {
        const { ref, computed } = Vue;

        const recipesData = ref([]);
        const categoryOptions = ref([]);

        const prettyPath = (value) => String(value || '')
            .replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .trim();

        const kit = window.CodexView.create({
            key: 'recipes',
            singular: 'recipe',
            plural: 'recipes',
            pageSize: 36,
            clampPage: false,
            cacheAgeSuffix: true,
            filters: { selectedCategory: 'All' },
            sourceText: {
                'game-cache': 'recipes.loaded_recipe_data_from_cached_game_file_b84260',
                'game-cache-stale': 'recipes.loaded_recipe_data_from_cache_refreshing_b7261a',
                'game-live': 'recipes.loaded_recipe_data_from_live_game_files',
            },
            ingest: (data) => {
                const uniqueCategories = new Set();
                recipesData.value = Object.keys(data).map(key => {
                    const row = data[key];
                    if (row.category) uniqueCategories.add(row.category);
                    const outputPath = prettyPath(row.output_path || '');
                    return {
                        id: key,
                        ...row,
                        outputPath,
                        outputAmount: Number(row.output_amount || 1),
                        unlockCount: Number(row.unlock_count || 0),
                        outputLabel: outputPath || prettyPath(row.filename || key),
                        imagePath: kit.catalogImage(row.blueprint || outputPath),
                        ingredients: Array.isArray(row.ingredients) ? row.ingredients : [],
                        requirements: Array.isArray(row.requirements) ? row.requirements : []
                    };
                });

                const catOpts = [['All Categories', 'All']];
                Array.from(uniqueCategories).sort().forEach(c => catOpts.push([c, c]));
                categoryOptions.value = catOpts;
            },
        });
        const { searchQuery, t } = kit;
        const { selectedCategory } = kit.filters;

        const filteredRecipes = computed(() => {
            let result = recipesData.value.slice();

            const sq = searchQuery.value.toLowerCase().trim();
            if (sq.length >= 3) {
                let generalSearch = sq;
                const filters = { name: null, category: null, ingredient: null, output: null };
                const regex = /(name|category|ingredient|output):("([^"]+)"|([^\s]+))/g;
                let match;
                while ((match = regex.exec(sq)) !== null) {
                    filters[match[1]] = (match[3] || match[4] || '').toLowerCase();
                    generalSearch = generalSearch.replace(match[0], '');
                }
                generalSearch = generalSearch.trim();

                result = result.filter(recipe => {
                    const name = String(recipe.name || '').toLowerCase();
                    const category = String(recipe.category || '').toLowerCase();
                    const output = String(recipe.outputLabel || '').toLowerCase();
                    const ingredients = (recipe.ingredients || []).map(row => `${row.name} ${row.path}`.toLowerCase()).join(' ');
                    const requirements = (recipe.requirements || []).join(' ').toLowerCase();

                    if (filters.name && !name.includes(filters.name)) return false;
                    if (filters.category && !category.includes(filters.category)) return false;
                    if (filters.ingredient && !ingredients.includes(filters.ingredient)) return false;
                    if (filters.output && !output.includes(filters.output)) return false;

                    if (generalSearch.length > 0) {
                        const haystack = `${name} ${category} ${output} ${ingredients} ${requirements}`;
                        if (!haystack.includes(generalSearch)) return false;
                    }
                    return true;
                });
            }

            if (selectedCategory.value && selectedCategory.value !== 'All') {
                result = result.filter(recipe => recipe.category === selectedCategory.value);
            }

            return [...result].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        });
        kit.paginate(filteredRecipes);

        const exportCsv = () => {
            if (!window.CodexExport) return;
            const { joinList, yesNo } = window.CodexExport;
            window.CodexExport.run({
                rows: filteredRecipes.value,
                basename: 'recipes',
                t,
                columns: [
                    { label: 'Name', value: (row) => t(row.name) },
                    { label: 'Category', value: (row) => t(row.category || '') },
                    { label: 'Description', value: (row) => t(row.desc || '') },
                    { label: 'Output', value: (row) => row.outputLabel || row.outputPath || '' },
                    { label: 'Output Amount', value: (row) => row.outputAmount },
                    {
                        label: 'Ingredients',
                        value: (row) => joinList((row.ingredients || []).map(i => `${i.amount || 1}x ${t(i.name || i.path || '')}`)),
                    },
                    { label: 'Requirements', value: (row) => joinList((row.requirements || []).map(r => t(r))) },
                    { label: 'Mastery', value: (row) => row.mastery || '0' },
                    { label: 'Lootbox', value: (row) => yesNo(row.lootbox, t) },
                    { label: 'Decay', value: (row) => yesNo(row.decay, t) },
                    { label: 'Unlock Count', value: (row) => row.unlockCount },
                    { label: 'Designer', value: (row) => row.designer || '' },
                    { label: 'Path', value: (row) => row.filename || '' },
                    { label: 'Blueprint', value: (row) => row.blueprint || '' },
                    { label: 'ID', value: (row) => row.id || '' },
                ],
            });
        };

        return {
            ...kit.expose(),
            recipesData, filteredRecipes,
            paginatedRecipes: kit.paginatedItems,
            categoryOptions,
            resetFilters: kit.resetFilters, exportCsv,
        };
    });
}

// Driven solely by the `recipes_loaded` event dispatched after lazy-load; the
// old readyState self-call double-initialized (mount + remount + duplicate
// fetch) once these scripts became lazy-loaded. Removed.
document.addEventListener('recipes_loaded', initRecipesView);
