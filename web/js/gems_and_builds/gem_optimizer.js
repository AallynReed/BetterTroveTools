/*
 * Gem Build Optimizer — JS port of utils/gem_engine.py (GemOptimizerEngine).
 *
 * Mirrors `calculate_builds` bit-for-bit so the Gem Builds tab can compute on the
 * web / Android build with no desktop Python backend. `computeBuilds(config, data)`
 * is PURE (no I/O) so it can be verified in Node against the Python engine;
 * `calculateBuilds(config)` is the async wrapper that fetches the static data files.
 */
(function () {
    'use strict';

    // ---- StatName / Class enum *values* (what the JSON + config carry) --------
    const SN = {
        MAGIC: 'Magic Damage', PHYSICAL: 'Physical Damage',
        MAXHP: 'Maximum Health', MAXHP_PCT: 'Maximum Health %',
        CRIT: 'Critical Damage', LIGHT: 'Light',
    };
    const CL = {
        BARD: 'Bard', BOOMERANGER: 'Boomeranger', CANDY_BARBARIAN: 'Candy Barbarian',
        CHLOROMANCER: 'Chloromancer', GUNSLINGER: 'Gunslinger', ICE_SAGE: 'Ice Sage',
        LUNAR_LANCER: 'Lunar Lancer', SHADOW_HUNTER: 'Shadow Hunter', SOLARION: 'Solarion',
    };
    const ROOT_TO_ABBREV = { combat: 'c', gathering: 'g', pve: 'p' };
    const ABBREV_TO_ROOT = { c: 'combat', g: 'gathering', p: 'pve' };
    const COMPACT_CODE_PREFIX = 'SC:';

    // Match Python 3 round(). For integer rounding (no ndigits) use half-to-even
    // (banker's). For decimal rounding, defer to toFixed: it is spec'd to be
    // correctly rounded, and exact ties at 1–2 decimals are not representable as
    // doubles, so its half-away tie rule never diverges from Python's half-even
    // here. The naive `x * 10^n` scale loses precision and mis-rounds near .x5,
    // which is what we must avoid.
    function pyRound(x, ndigits) {
        if (ndigits === undefined || ndigits === null) {
            const floor = Math.floor(x);
            const diff = x - floor;
            if (diff < 0.5) return floor;
            if (diff > 0.5) return floor + 1;
            return (floor % 2 === 0) ? floor : floor + 1;
        }
        return Number(x.toFixed(ndigits));
    }

    const BUILD_DEFAULTS = {
        build_type: 'Light', character: 'Bard', subclass: 'Boomeranger',
        food: 'zephyr_rune', ally: 'boot_clown', ally_buff: true, berserker_battler: false,
        critical_damage_count: 3, no_face: false, light: 0,
        subclass_active: false, litany: false, star_chart: null, high_precision: false,
    };

    // Blessing of the Lilypad - the ally buff, on top of the level-30 ally stats
    // the data files already hold. Per stat class, not per ally: damage, crit
    // damage share one 31% class, light is its own 15.5%, power rank takes
    // nothing. Stability and Movement Speed have no measured multiplier yet.
    const LILYPAD_MULTIPLIERS = {
        [SN.LIGHT]: 1.155,
        [SN.PHYSICAL]: 1.31,
        [SN.MAGIC]: 1.31,
        [SN.CRIT]: 1.31,
    };
    const applyLilypad = (name, value, active) =>
        (active ? value * (LILYPAD_MULTIPLIERS[name] || 1) : value);

    // ---- Star Chart parser (port of StarChartParser) --------------------------
    function b64urlToBytes(payload) {
        let s = String(payload).replace(/-/g, '+').replace(/_/g, '/');
        s += '='.repeat((4 - (s.length % 4)) % 4);
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    class StarChartParser {
        constructor(raw) {
            this.nodeMap = {};
            this.parentMap = {};
            if (raw) Object.values(raw).forEach((c) => this._flatten(c, null));
            this.selectablePaths = Object.keys(this.nodeMap)
                .filter((p) => this.nodeMap[p].Type !== 'Root')
                .sort();
            this.pathToId = {};
            this.selectablePaths.forEach((p, i) => { this.pathToId[p] = i; });
        }

        _flatten(node, parentPath) {
            if (node && Object.prototype.hasOwnProperty.call(node, 'Path')) {
                this.nodeMap[node.Path] = node;
                this.parentMap[node.Path] = parentPath;
            }
            const children = (node && node.Stars) || [];
            children.forEach((child) => this._flatten(child, node && node.Path));
        }

        _expandTerminalPath(path) {
            const expanded = new Set();
            let current = path;
            while (current && this.nodeMap[current]) {
                const node = this.nodeMap[current];
                if (node.Type === 'Root') break;
                if (expanded.has(current)) break;
                expanded.add(current);
                const parent = this.parentMap[current];
                if (!parent || (this.nodeMap[parent] || {}).Type === 'Root') break;
                current = parent;
            }
            return expanded;
        }

        _decodeCompactPath(token) {
            const t = String(token || '').trim().toLowerCase();
            if (!t) return null;
            const root = ABBREV_TO_ROOT[t[0]];
            if (!root) return null;
            const segments = t.slice(1).match(/[a-z]+|\d+/g) || [];
            const path = [root, ...segments].join('.');
            const node = this.nodeMap[path];
            if (!node || node.Type === 'Root') return null;
            return path;
        }

        _decodeBuildCode(buildCode) {
            const code = String(buildCode || '').trim();
            if (!code) return new Set();

            if (code.startsWith(COMPACT_CODE_PREFIX) || code.startsWith('v2:')) {
                const selected = new Set();
                const payload = code.slice(code.indexOf(':') + 1);

                if (payload.indexOf('|') !== -1) {
                    payload.split('|').forEach((token) => {
                        const path = this._decodeCompactPath(token);
                        if (path) this._expandTerminalPath(path).forEach((p) => selected.add(p));
                    });
                    return selected;
                }

                const bytes = b64urlToBytes(payload);
                bytes.forEach((nodeId) => {
                    if (nodeId >= 0 && nodeId < this.selectablePaths.length) {
                        this._expandTerminalPath(this.selectablePaths[nodeId]).forEach((p) => selected.add(p));
                    }
                });
                return selected;
            }

            const decoded = atob(code);
            const out = new Set();
            decoded.split('$').forEach((p) => { if (this.nodeMap[p]) out.add(p); });
            return out;
        }

        parseBuildCode(buildCode) {
            const result = { stats: {}, abilities: new Set(), ability_values: {}, paths_count: 0 };
            if (!buildCode || !Object.keys(this.nodeMap).length) {
                result.abilities = [];
                return result;
            }

            let selectedPaths;
            try {
                selectedPaths = this._decodeBuildCode(buildCode);
            } catch (e) {
                result.abilities = [];
                return result;
            }

            result.paths_count = selectedPaths.size;

            const overwrites = new Set();
            selectedPaths.forEach((path) => {
                const node = this.nodeMap[path];
                if (node && node.Overwrites) node.Overwrites.forEach((o) => overwrites.add(o));
            });

            const activePaths = [...selectedPaths].filter((p) => !overwrites.has(p));
            activePaths.forEach((path) => {
                const node = this.nodeMap[path];
                if (!node) return;
                const passiveStats = node.Stats || [];
                passiveStats.forEach((stat) => {
                    const name = stat.name;
                    if (!name) return;
                    let val;
                    const raw = stat.value !== undefined ? stat.value : 0;
                    val = (raw === null || raw === undefined) ? 0 : Number(raw);
                    if (!isFinite(val)) val = 0;
                    const isPct = stat.percentage || false;
                    if (!result.stats[name]) result.stats[name] = { flat: 0, pct: 0 };
                    if (isPct) result.stats[name].pct += val;
                    else result.stats[name].flat += val;
                });
                if (node.Abilities) node.Abilities.forEach((a) => result.abilities.add(a));
            });

            result.abilities = [...result.abilities];
            return result;
        }
    }

    // ---- combinations (port of generate_combinations) -------------------------
    function generateCombinations(farm) {
        const firstSet = [];
        for (let i = 0; i < 10; i++) firstSet.push([i, 9 - i]);
        const secondSet = [];
        for (let i = 0; i < 19; i++) secondSet.push([i, 18 - i]);
        const thirdSet = [];
        for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++)
            if (x + y + z === 3 && (farm ? true : z === 3)) thirdSet.push([x, y, z]);
        const fourthSet = [];
        for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) for (let z = 0; z < 7; z++)
            if (x + y + z === 6 && (farm ? true : z === 6)) fourthSet.push([x, y, z]);
        // itertools.product order: rightmost varies fastest.
        const out = [];
        for (const a of firstSet) for (const b of secondSet) for (const c of thirdSet) for (const d of fourthSet)
            out.push([a, b, c, d]);
        return out;
    }

    // ---- gem stat contribution (port of calculate_gem_stats) ------------------
    function calculateGemStats(config, build, gemStats) {
        if (!gemStats || !Object.keys(gemStats).length) return [0, 0, 0];

        let first = 0, second = 0, third = 0, cosmicFirst = 0, cosmicSecond = 0;
        let firstLesser, firstEmpowered, secondLesser, secondEmpowered;

        if (config.build_type === 'Health') {
            firstLesser = gemStats.Lesser[SN.MAXHP];
            firstEmpowered = gemStats.Empowered[SN.MAXHP];
            secondLesser = gemStats.Lesser[SN.MAXHP_PCT];
            secondEmpowered = gemStats.Empowered[SN.MAXHP_PCT];
        } else {
            firstLesser = gemStats.Lesser.Damage;
            firstEmpowered = gemStats.Empowered.Damage;
            secondLesser = gemStats.Lesser['Critical Damage'];
            secondEmpowered = gemStats.Empowered['Critical Damage'];
        }
        const thirdLesser = gemStats.Lesser.Light;
        const thirdEmpowered = gemStats.Empowered.Light;

        first += 3 * firstEmpowered[0] + 6 * firstLesser[0];
        second += 3 * secondEmpowered[0] + 6 * secondLesser[0];
        third += 1 * thirdEmpowered[0] + 2 * thirdLesser[0];
        cosmicFirst += 1 * firstEmpowered[0] + 2 * firstLesser[0];
        cosmicSecond += 1 * secondEmpowered[0] + 2 * secondLesser[0];

        first += firstEmpowered[1] * build[0][0];
        second += secondEmpowered[1] * build[0][1];
        first += firstLesser[1] * build[1][0];
        second += secondLesser[1] * build[1][1];

        cosmicFirst += firstEmpowered[1] * build[2][0];
        cosmicSecond += secondEmpowered[1] * build[2][1];
        third += thirdEmpowered[1] * build[2][2];

        cosmicFirst += firstLesser[1] * build[3][0];
        cosmicSecond += secondLesser[1] * build[3][1];
        third += thirdLesser[1] * build[3][2];

        first = (first + cosmicFirst) * 1.1;
        second = (second + cosmicSecond) * 1.1;
        third = third * 1.1;

        return [first, second, third];
    }

    function findStatValue(stats, name) {
        const s = (stats || []).find((st) => st.name === name);
        return s ? s.value : 0;
    }

    // ---- main build calculation (port of calculate_builds) --------------------
    function computeBuilds(rawConfig, data) {
        const config = Object.assign({}, BUILD_DEFAULTS, rawConfig || {});
        config.light = Number(config.light) || 0;
        config.critical_damage_count = Number(config.critical_damage_count);
        if (!isFinite(config.critical_damage_count)) config.critical_damage_count = 3;

        if (!data || !data.classes || !Object.keys(data.classes).length) {
            throw new Error('Class data not loaded. Please ensure classes.json exists.');
        }

        const selectedClass = data.classes[config.character];
        const selectedSubclass = data.classes[config.subclass];
        if (!selectedClass) throw new Error(`Unknown class: ${config.character}`);

        let damageType = selectedClass.damage_type === 'Magic' ? SN.MAGIC : SN.PHYSICAL;
        const damageTypeName = selectedClass.damage_type === 'Magic' ? 'magic_damage' : 'physical_damage';
        const sums = data.sums || {};

        // Auto-Ally Fallback
        if (config.ally === 'boot_clown') {
            config.ally = damageType === SN.MAGIC ? 'phoenix_stars' : 'spidermonkey_stars';
        }

        let first, second, third, fourth, fifth, sixth;

        if (config.build_type === 'Health') {
            first = (sums.health || 0) + findStatValue(selectedClass.stats, SN.MAXHP);
            second = (sums.health_per || 0) + findStatValue(selectedClass.stats, SN.MAXHP_PCT);
            // NOTE: selected_class.subclass is a dict in the source model, so this
            // comparison is always false there too — replicated faithfully.
            if (selectedClass.subclass === CL.CHLOROMANCER) second += 60;
            third = 0; fourth = 0; fifth = 100; sixth = 100;
            damageType = SN.MAXHP;
        } else {
            first = sums.damage || 0;
            second = sums.critical_damage || 0;
            third = sums.light || 0;
            fourth = sums.bonus_damage || 0;
            fifth = 100; sixth = 100;

            first += findStatValue(selectedClass.stats, damageType);
            second += findStatValue(selectedClass.stats, SN.CRIT);

            if (!config.no_face) first += data.faceDamage || 0;

            first += (sums[`${damageTypeName}/dragons_damage`] || 0) + (sums.dragons_damage || 0);
            second += sums.dragons_critical_damage || 0;

            if (config.food && data.foods && data.foods[config.food]) {
                const foodData = data.foods[config.food];
                (foodData.stats || []).forEach((stat) => {
                    if (stat.name === damageType) { if (stat.percentage) fourth += stat.value; else first += stat.value; }
                    if (stat.name === SN.CRIT) second += stat.value;
                    if (stat.name === SN.LIGHT) third += stat.value;
                });
            }

            if (config.ally && data.allies && data.allies[config.ally]) {
                const allyData = data.allies[config.ally];
                (allyData.stats || []).forEach((stat) => {
                    const value = applyLilypad(stat.name, stat.value, config.ally_buff);
                    if (stat.name === damageType) { if (stat.percentage) fourth += value; else first += value; }
                    if (stat.name === SN.CRIT) { if (stat.percentage) fifth += value; else second += value; }
                    if (stat.name === SN.LIGHT) third += value;
                });
            }

            second -= 48.1 * (3 - config.critical_damage_count);

            if (config.character === CL.SOLARION || config.subclass === CL.SOLARION) third += 140;
            if (damageType === SN.PHYSICAL && config.subclass === CL.LUNAR_LANCER) first += 750;
            if (damageType === SN.MAGIC && (config.subclass === CL.ICE_SAGE || config.subclass === CL.SHADOW_HUNTER)) first += 750;
            if (config.subclass === CL.BARD || config.subclass === CL.BOOMERANGER) second += 20;

            if (config.subclass_active) {
                if (config.subclass === CL.BARD) { fourth += 45; second += 45; }
                if (config.subclass === CL.GUNSLINGER) fourth += 5.5;
                if (config.subclass === CL.LUNAR_LANCER || config.subclass === CL.CANDY_BARBARIAN) fourth += 30;
            }

            if (config.berserker_battler) third += 750;
            if (config.litany) sixth += 1;

            if (config.star_chart) {
                if (!data._starParser) data._starParser = new StarChartParser(data.starChart);
                const parsed = data._starParser.parseBuildCode(config.star_chart);
                const chartStats = parsed.stats;
                const dmgStat = chartStats[damageType] || {};
                const critStat = chartStats[SN.CRIT] || {};
                const lightStat = chartStats[SN.LIGHT] || {};
                first += dmgStat.flat || 0;
                second += critStat.flat || 0;
                third += lightStat.flat || 0;
                fourth += dmgStat.pct || 0;
                fifth += critStat.pct || 0;
                sixth += lightStat.pct || 0;
            }
        }

        const classBonusStat = (selectedClass.bonuses || []).find((b) => b.name === damageType);
        const classBonus = classBonusStat ? classBonusStat.value : null;

        // Rankings are decided several decimals below the display rounding, so
        // high precision widens every result field to 8 places instead of 1-2.
        const precise = !!config.high_precision;
        const rd = (value, digits) => pyRound(value, precise ? 8 : digits);

        const rawBuilds = [];
        const builder = generateCombinations(config.build_type === 'Farm');

        for (const build of builder) {
            const [gemFirst, gemSecond, gemThird] = calculateGemStats(config, build, data.gemStats);

            const cfirst = first + gemFirst;
            const csecond = second + gemSecond;
            const cthird = third + gemThird;

            let final = cfirst * (1 + fourth / 100);
            if (classBonus !== null) final *= 1 + (classBonus / 100);

            const coefficient = rd(final * (1 + (csecond * (fifth / 100)) / 100), 2);
            const lightValue = precise ? pyRound(cthird * (sixth / 100), 8) : Math.trunc(cthird * (sixth / 100));

            rawBuilds.push([
                build, cfirst, csecond, lightValue, fourth, fifth, final, classBonus, coefficient,
            ]);
        }

        // sort: by closeness to light target then coefficient desc; else coefficient desc.
        rawBuilds.sort((a, b) => {
            if (config.light) {
                const da = Math.abs(a[3] - config.light);
                const db = Math.abs(b[3] - config.light);
                if (da !== db) return da - db;
                return b[8] - a[8];
            }
            return b[8] - a[8];
        });

        const formattedResults = [];
        const top = rawBuilds.slice(0, 200);
        for (let i = 0; i < top.length; i++) {
            const buildData = top[i];
            const buildArrays = buildData[0];

            let boosts = [];
            for (const arr of buildArrays) boosts.push(...arr);

            if (!config.light || (config.light && config.build_type === 'Health')) {
                boosts.splice(9, 1);
                boosts.splice(6, 1);
            }
            if (!config.light && config.build_type !== 'Health') {
                boosts = boosts.slice(0, 4);
            }

            let buildText = boosts.slice(0, 4).map(String).join('/');
            if (boosts.length > 4) buildText += ' + ' + boosts.slice(4).map(String).join('/');

            formattedResults.push({
                rank: i + 1,
                layout: buildText,
                base_dmg: rd(buildData[1], 2),
                crit_dmg: rd(buildData[2], 1),
                light: buildData[3],
                bonus_dmg: rd(buildData[4], 8),
                total_dmg: rd(buildData[6], 2),
                class_bonus: buildData[7],
                coefficient: buildData[8],
            });
        }

        return formattedResults;
    }

    // ---- async data loading + public wrapper ----------------------------------
    const SUM_PATHS = [
        'health', 'health_per', 'damage', 'critical_damage', 'light', 'bonus_damage',
        'dragons_damage', 'dragons_critical_damage',
        'magic_damage/dragons_damage', 'physical_damage/dragons_damage',
    ];

    function sumValues(obj) {
        return Object.values(obj || {}).reduce((acc, v) => acc + (Number(v) || 0), 0);
    }

    let _dataPromise = null;

    async function loadData() {
        const base = 'assets/data/';
        const getJson = async (rel) => {
            try {
                const r = await fetch(base + rel);
                return r.ok ? await r.json() : {};
            } catch (e) { return {}; }
        };
        const [classesArr, foods, allies, faceDmg, gemStats, starChart] = await Promise.all([
            getJson('classes.json'), getJson('builds/food.json'), getJson('builds/ally.json'),
            getJson('builds/face_damage.json'), getJson('mystic.json'), getJson('star_chart.json'),
        ]);
        const sumData = await Promise.all(SUM_PATHS.map((p) => getJson(`builds/${p}.json`)));

        const classes = {};
        (classesArr || []).forEach((c) => { classes[c.name] = c; });
        const sums = {};
        SUM_PATHS.forEach((p, i) => { sums[p] = sumValues(sumData[i]); });

        return {
            classes, foods, allies,
            faceDamage: (faceDmg && faceDmg.Face) || 0,
            gemStats, starChart, sums,
        };
    }

    async function calculateBuilds(config) {
        if (!_dataPromise) _dataPromise = loadData();
        const data = await _dataPromise;
        return computeBuilds(config, data);
    }

    async function parseStarChart(code) {
        if (!_dataPromise) _dataPromise = loadData();
        const data = await _dataPromise;
        if (!data._starParser) data._starParser = new StarChartParser(data.starChart);
        return data._starParser.parseBuildCode(code);
    }

    const api = { computeBuilds, calculateBuilds, parseStarChart, loadData, StarChartParser, pyRound, generateCombinations };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.GemBuildOptimizer = api;
})();
