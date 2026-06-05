/* =========================================================================
   Better Trove Tools - client-side gem engine
   -------------------------------------------------------------------------
   A faithful JS port of the Python gem model (models/trove/gems.py +
   gem_bases.py + gem_constants.py) so the Gem Simulator works with no Python
   backend - i.e. in hosted web mode AND in the Android (Capacitor) build.

   web_mode.js routes the gem eel-shim functions here. The output matches the
   Python `model_dump(mode='json')` shape exactly, including the computed
   fields the UI reads (value / real_value / increase / augmentation_progress /
   quality / power_rank / stat_values / gem_name / ...). Gem creation is
   inherently random, so Math.random() is used; the DETERMINISTIC computations
   (quality, power rank, stat values) match the Python engine.
   ========================================================================= */
(function () {
    // ---- enum values (must match gem_constants.py) ----
    const Tier = { RADIANT: 1, STELLAR: 2, CRYSTAL: 3, MYSTIC: 4 };
    const Type = { LESSER: 1, EMPOWERED: 2 };
    const Element = { WATER: 1, FIRE: 2, AIR: 3, COSMIC: 4 };
    const Stat = {
        PHYSICAL_DAMAGE: 1, MAGIC_DAMAGE: 2, CRITICAL_DAMAGE: 3, CRITICAL_HIT: 4,
        MAX_HEALTH: 5, MAX_HEALTH_BONUS: 6, LIGHT: 7, MOVEMENT_SPEED: 8, JUMP: 9
    };
    const Restriction = { FIERCE: 1, ARCANE: 2 };
    const Augment = { ROUGH: 1, PRECISE: 2, SUPERIOR: 3 };

    // ---- display names (GEM_*_NAMES) ----
    const TIER_NAMES = { 1: "Radiant", 2: "Stellar", 3: "Crystal", 4: "Mystic" };
    const TYPE_NAMES = { 1: "Lesser", 2: "Empowered" };
    const ELEMENT_NAMES = { 1: "Water", 2: "Fire", 3: "Air", 4: "Cosmic" };
    const STAT_NAMES = {
        1: "Physical Damage", 2: "Magic Damage", 3: "Critical Damage", 4: "Critical Hit",
        5: "Max Health", 6: "Max Health %", 7: "Light", 8: "Movement Speed", 9: "Jump"
    };
    const RESTRICTION_NAMES = { 1: "Fierce", 2: "Arcane" };
    const ABILITY_NAMES = {
        1: "Stinging Curse", 2: "Volatile Velocity", 3: "Spirit Surge", 4: "Mired Mojo",
        5: "Stunburst", 6: "Pyrodisc", 7: "Explosive Epilogue", 8: "Cubic Curtain",
        9: "Berserk Battler", 10: "Empyrean Barrier", 11: "Flower Power", 12: "Vampirian Vanquisher"
    };

    // ---- stat pools / restrictions / abilities (keyed by element value) ----
    const GEM_STAT_RESTRICTIONS = {
        [Element.AIR]: [1, 2, 3, 4, 5, 6],
        [Element.FIRE]: [1, 2, 3, 4, 5, 6],
        [Element.WATER]: [1, 2, 3, 4, 5, 6],
        [Element.COSMIC]: [1, 2, 3, 4, 5, 6, 7]
    };
    const PHYSICAL_GEM_STAT_POOL = {
        [Element.AIR]: [1, 3, 4, 5, 6],
        [Element.FIRE]: [1, 3, 4, 5, 6],
        [Element.WATER]: [1, 3, 4, 5, 6],
        [Element.COSMIC]: [1, 3, 4, 5, 6]
    };
    const MAGIC_GEM_STAT_POOL = {
        [Element.AIR]: [2, 3, 4, 5, 6],
        [Element.FIRE]: [2, 3, 4, 5, 6],
        [Element.WATER]: [2, 3, 4, 5, 6],
        [Element.COSMIC]: [2, 3, 4, 5, 6]
    };
    const GEM_ABILITIES = {
        [Element.WATER]: [1, 2, 3, 4, 5, 6, 7, 8],
        [Element.FIRE]: [1, 2, 3, 4, 5, 6, 7, 8],
        [Element.AIR]: [1, 2, 3, 4, 5, 6, 7, 8],
        [Element.COSMIC]: [9, 10, 11, 12]
    };

    // ---- bases (gem_bases.py) ----
    function getGemMaxLevel(tier) {
        switch (tier) {
            case Tier.RADIANT: return 23;
            case Tier.STELLAR: return 25;
            case Tier.CRYSTAL: return 30;
            case Tier.MYSTIC: return 35;
        }
        return null;
    }
    function getLevelPrIncrement(level, base) {
        if (level === 1 || level === 5 || level === 10 || level === 15) return 0;
        if (level > 15 && level % 5 === 0) return base * 5;
        if (level > 1 && level < 15) return base;
        if (level > 15) return base * 2;
        return null;
    }
    function getIncrementPowerRank(tier, level) {
        // lesser and empowered use the same table in gem_bases.py
        switch (tier) {
            case Tier.RADIANT: return getLevelPrIncrement(level, 3);
            case Tier.STELLAR: return getLevelPrIncrement(level, 5);
            case Tier.CRYSTAL: return getLevelPrIncrement(level, 7);
            case Tier.MYSTIC: return getLevelPrIncrement(level, 9);
        }
        return null;
    }
    function getStatBaseLesser(tier, statType) {
        const D = (statType === Stat.PHYSICAL_DAMAGE || statType === Stat.MAGIC_DAMAGE);
        switch (tier) {
            case Tier.RADIANT: case Tier.STELLAR:
                if (D) return 14;
                if (statType === Stat.CRITICAL_DAMAGE) return 0.2;
                if (statType === Stat.CRITICAL_HIT) return 0.02;
                if (statType === Stat.MAX_HEALTH_BONUS) return 0.5;
                if (statType === Stat.MAX_HEALTH) return 50;
                if (statType === Stat.LIGHT) return 1;
                break;
            case Tier.CRYSTAL:
                if (D) return 16;
                if (statType === Stat.CRITICAL_DAMAGE) return 3 / 14;
                if (statType === Stat.CRITICAL_HIT) return 0.3 / 14;
                if (statType === Stat.MAX_HEALTH_BONUS) return 0.5;
                if (statType === Stat.MAX_HEALTH) return 50;
                if (statType === Stat.LIGHT) return 5 / 7;
                break;
            case Tier.MYSTIC:
                if (D) return 168 / 9;
                if (statType === Stat.CRITICAL_DAMAGE) return 2.5 / 9;
                if (statType === Stat.CRITICAL_HIT) return 0.25 / 9;
                if (statType === Stat.MAX_HEALTH_BONUS) return 5.25 / 9;
                if (statType === Stat.MAX_HEALTH) return 525 / 9;
                if (statType === Stat.LIGHT) return 5 / 9;
                break;
        }
        return null;
    }
    function getStatBaseEmpowered(tier, statType) {
        const D = (statType === Stat.PHYSICAL_DAMAGE || statType === Stat.MAGIC_DAMAGE);
        // identical to lesser EXCEPT Mystic damage base (28 vs 168/9)
        if (tier === Tier.MYSTIC && D) return 28;
        return getStatBaseLesser(tier, statType);
    }
    function getStatThresholdLesser(tier, statType) {
        const D = (statType === Stat.PHYSICAL_DAMAGE || statType === Stat.MAGIC_DAMAGE);
        switch (tier) {
            case Tier.RADIANT: return [85, 113];
            case Tier.STELLAR: return [150, 200];
            case Tier.CRYSTAL:
                if (D) return [210, 280];
                if (statType === Stat.CRITICAL_DAMAGE || statType === Stat.CRITICAL_HIT) return [560 / 3, 770 / 3];
                if (statType === Stat.MAX_HEALTH_BONUS || statType === Stat.MAX_HEALTH) return [245, 315];
                if (statType === Stat.LIGHT) return [280, 385];
                break;
            case Tier.MYSTIC:
                if (D) return [270, 360];
                if (statType === Stat.CRITICAL_DAMAGE || statType === Stat.CRITICAL_HIT) return [187.2, 297];
                if (statType === Stat.MAX_HEALTH_BONUS || statType === Stat.MAX_HEALTH) return [315, 405];
                if (statType === Stat.LIGHT) return [495, 585];
                break;
        }
        return null;
    }
    function getStatThresholdEmpowered(tier, statType) {
        const D = (statType === Stat.PHYSICAL_DAMAGE || statType === Stat.MAGIC_DAMAGE);
        switch (tier) {
            case Tier.RADIANT: return [113, 150];
            case Tier.STELLAR: return [200, 266];
            case Tier.CRYSTAL:
                if (D) return [245, 350];
                if (statType === Stat.CRITICAL_DAMAGE || statType === Stat.CRITICAL_HIT) return [700 / 3, 910 / 3];
                if (statType === Stat.MAX_HEALTH_BONUS || statType === Stat.MAX_HEALTH) return [315, 385];
                if (statType === Stat.LIGHT) return [350, 420];
                break;
            case Tier.MYSTIC:
                if (D) return [210, 300];
                if (statType === Stat.CRITICAL_DAMAGE || statType === Stat.CRITICAL_HIT) return [252, 342];
                if (statType === Stat.MAX_HEALTH_BONUS || statType === Stat.MAX_HEALTH) return [405, 495];
                if (statType === Stat.LIGHT) return [495, 630];
                break;
        }
        return null;
    }
    function getLesserGemPrThreshold(tier) {
        switch (tier) {
            case Tier.RADIANT: return [85, 113];
            case Tier.STELLAR: return [150, 200];
            case Tier.CRYSTAL: return [175, 250];
            case Tier.MYSTIC: return [200, 260];
        }
        return null;
    }
    function getEmpoweredGemPrThreshold(tier) {
        switch (tier) {
            case Tier.RADIANT: return [113, 150];
            case Tier.STELLAR: return [200, 266];
            case Tier.CRYSTAL: return [220, 280];
            case Tier.MYSTIC: return [240, 300];
        }
        return null;
    }
    function getAugmentBase(augment) {
        switch (augment) {
            case Augment.ROUGH: return 2.5;
            case Augment.PRECISE: return 5;
            case Augment.SUPERIOR: return 12.5;
        }
        return null;
    }

    // ---- helpers ----
    // Python round(): round-half-to-even (banker's rounding).
    function pyRound(x, ndigits) {
        if (ndigits === undefined || ndigits === null) {
            const floor = Math.floor(x);
            const diff = x - floor;
            if (diff < 0.5) return floor;
            if (diff > 0.5) return floor + 1;
            return (floor % 2 === 0) ? floor : floor + 1;
        }
        const m = Math.pow(10, ndigits);
        return pyRound(x * m) / m;
    }
    const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const randint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
    function sample(arr, k) {
        const pool = arr.slice();
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
        }
        return pool.slice(0, k);
    }
    let _idCounter = 0;
    const genId = () => Date.now() * 1000 + (_idCounter++ % 1000);

    // ---- raw structure builders (mirror StatContainer / Stat defaults) ----
    function makeContainer(base) {
        return {
            base: (base === undefined || base === null) ? Math.random() : base,
            augments: [
                { type: Augment.ROUGH, count: 0 },
                { type: Augment.PRECISE, count: 0 },
                { type: Augment.SUPERIOR, count: 0 }
            ]
        };
    }
    const makeStat = (type) => ({ type, containers: [], locked: false });

    // ---- derived values (StatContainer / Stat computed fields) ----
    function containerIncrease(c) {
        let inc = 0;
        for (const aug of (c.augments || [])) inc += (getAugmentBase(aug.type) / 100) * aug.count;
        return inc;
    }
    const containerRealValue = (c) => c.base + containerIncrease(c);
    const containerValue = (c) => Math.min(c.base + containerIncrease(c), 1);
    function statAugmentationProgress(stat) {
        let v = 0;
        for (const c of stat.containers) v += containerRealValue(c);
        return Math.min(v / stat.containers.length, 1);
    }

    // ---- serialization (model_dump(mode='json') with computed fields) ----
    function serializeContainer(c) {
        const increase = containerIncrease(c);
        return {
            base: c.base,
            augments: c.augments.map(a => ({ type: a.type, count: a.count })),
            increase: increase,
            value: Math.min(c.base + increase, 1),
            real_value: c.base + increase
        };
    }
    function serializeStat(stat) {
        return {
            type: stat.type,
            containers: stat.containers.map(serializeContainer),
            locked: !!stat.locked,
            augmentation_progress: statAugmentationProgress(stat)
        };
    }
    function gemQuality(gem) {
        let total = 0, count = 0;
        for (const stat of gem.stats) for (const c of stat.containers) { total += containerValue(c); count++; }
        if (count === 0) return 0.0;
        return pyRound((total / count) * 100, 1) / 100;
    }
    function gemPowerRank(gem) {
        let pr = (gem.type === Type.LESSER) ? 0 : 100;
        const thresholds = (gem.type === Type.LESSER)
            ? getLesserGemPrThreshold(gem.tier) : getEmpoweredGemPrThreshold(gem.tier);
        for (const stat of gem.stats) {
            const progress = thresholds[0] + (thresholds[1] - thresholds[0]) * statAugmentationProgress(stat);
            pr += progress * stat.containers.length;
        }
        for (let s = 0; s < gem.stats.length; s++) {
            for (let level = 1; level <= gem.level; level++) pr += getIncrementPowerRank(gem.tier, level);
        }
        return pyRound(pr);
    }
    function gemStatValues(gem) {
        let prIncrements = 0;
        for (let level = 1; level <= gem.level; level++) prIncrements += getIncrementPowerRank(gem.tier, level);
        const out = [];
        for (const stat of gem.stats) {
            const statBase = (gem.type === Type.LESSER)
                ? getStatBaseLesser(gem.tier, stat.type) : getStatBaseEmpowered(gem.tier, stat.type);
            const thresholds = (gem.type === Type.LESSER)
                ? getStatThresholdLesser(gem.tier, stat.type) : getStatThresholdEmpowered(gem.tier, stat.type);
            const progress = thresholds[0] + (thresholds[1] - thresholds[0]) * statAugmentationProgress(stat);
            let statValue = statBase * progress * stat.containers.length;
            statValue += statBase * prIncrements;
            out.push({ [STAT_NAMES[stat.type]]: statValue });
        }
        return out;
    }
    function gemName(gem) {
        if (gem.type === Type.LESSER) {
            return `${RESTRICTION_NAMES[gem.restriction]} ${TIER_NAMES[gem.tier]} Gem`;
        }
        return gem.ability ? ABILITY_NAMES[gem.ability] : null;
    }
    function serializeGem(gem) {
        const maxLevel = getGemMaxLevel(gem.tier);
        return {
            id: gem.id,
            tier: gem.tier,
            type: gem.type,
            element: gem.element,
            restriction: (gem.restriction === undefined ? null : gem.restriction),
            ability: (gem.ability === undefined ? null : gem.ability),
            level: gem.level,
            stats: gem.stats.map(serializeStat),
            augmentation: (gem.augmentation === undefined ? null : gem.augmentation),
            ability_name: gem.ability ? ABILITY_NAMES[gem.ability] : null,
            gem_name: gemName(gem),
            is_max_level: gem.level === maxLevel,
            quality: gemQuality(gem),
            power_rank: gemPowerRank(gem),
            stat_values: gemStatValues(gem)
        };
    }

    // ---- normalize an incoming (possibly serialized) gem to raw structure ----
    function normalize(g) {
        return {
            id: (g.id !== undefined ? g.id : genId()),
            tier: g.tier, type: g.type, element: g.element,
            restriction: (g.restriction === undefined ? null : g.restriction),
            ability: (g.ability === undefined ? null : g.ability),
            level: g.level,
            augmentation: (g.augmentation === undefined ? null : g.augmentation),
            stats: (g.stats || []).map(s => ({
                type: s.type,
                locked: !!s.locked,
                containers: (s.containers || []).map(c => ({
                    base: c.base,
                    augments: (c.augments && c.augments.length)
                        ? c.augments.map(a => ({ type: a.type, count: a.count || 0 }))
                        : [{ type: 1, count: 0 }, { type: 2, count: 0 }, { type: 3, count: 0 }]
                }))
            }))
        };
    }

    // ---- operations (mirror gem_simulator.py) ----
    function create(data) {
        data = data || {};
        const augLevel = (data.augmentation === undefined || data.augmentation === null) ? undefined : data.augmentation;
        let tier = data.tier || choice([1, 2, 3, 4]);
        let type = data.type || choice([1, 2]);
        let element = data.element ? data.element : choice([1, 2, 3, 4]);
        let level = data.level || 1;
        let restriction;
        if (type === Type.LESSER) {
            restriction = (data.restriction === undefined || data.restriction === null)
                ? choice([Restriction.FIERCE, Restriction.ARCANE]) : data.restriction;
        } else {
            restriction = null;
        }
        const extraContainers = Math.floor(Math.min(level, 15) / 5);

        let stats;
        const pool = (restriction === null || restriction === undefined)
            ? choice([PHYSICAL_GEM_STAT_POOL, MAGIC_GEM_STAT_POOL])
            : (restriction === Restriction.FIERCE ? PHYSICAL_GEM_STAT_POOL : MAGIC_GEM_STAT_POOL);
        const statTypes = sample(pool[element], 3);
        stats = statTypes.map(makeStat);
        if (element === Element.COSMIC) {
            const index = randint(0, 2);
            stats[index].type = Stat.LIGHT;
            stats[index].locked = true;
        }
        for (const stat of stats) stat.containers.push(makeContainer(augLevel));
        for (let i = 0; i < extraContainers; i++) {
            const index = randint(0, 2);
            stats[index].containers.push(makeContainer(augLevel));
        }
        const maxLevel = getGemMaxLevel(tier);
        level = Math.min(level, maxLevel);
        const ability = (type === Type.EMPOWERED) ? choice(GEM_ABILITIES[element]) : null;
        return {
            id: genId(), tier, type, element, restriction, ability, level,
            augmentation: (augLevel === undefined ? null : augLevel), stats
        };
    }

    const augLevelOf = (gem) => (gem.augmentation === undefined || gem.augmentation === null) ? undefined : gem.augmentation;
    const hasStat = (gem, statType) => gem.stats.some(s => s.type === statType);

    function levelUp(gem) {
        const maxLevel = getGemMaxLevel(gem.tier);
        if (gem.level < maxLevel) gem.level += 1;
        else return false;
        if (gem.level === 5 || gem.level === 10 || gem.level === 15) {
            const index = randint(0, 2);
            gem.stats[index].containers.push(makeContainer(augLevelOf(gem)));
        }
        return true;
    }
    function addAugmentToStat(stat, augmentType) {
        if (statAugmentationProgress(stat) === 1) return false;
        for (const c of stat.containers) {
            if (containerRealValue(c) >= 1) continue;
            const a = c.augments.find(x => x.type === augmentType);
            if (a) a.count += 1;
            return true;
        }
        return false;
    }
    function rerollStatType(gem, statType) {
        const inUse = gem.stats.map(s => s.type);
        if (!hasStat(gem, statType)) return false;
        for (const stat of gem.stats) {
            if (stat.type === statType && !stat.locked) {
                const pool = gem.restriction
                    ? (gem.restriction === Restriction.FIERCE ? PHYSICAL_GEM_STAT_POOL : MAGIC_GEM_STAT_POOL)
                    : GEM_STAT_RESTRICTIONS;
                const statTypes = pool[gem.element];
                let unused = statTypes.filter(s => !inUse.includes(s));
                if (inUse.includes(Stat.PHYSICAL_DAMAGE)) unused = unused.filter(s => s !== Stat.MAGIC_DAMAGE);
                if (inUse.includes(Stat.MAGIC_DAMAGE)) unused = unused.filter(s => s !== Stat.PHYSICAL_DAMAGE);
                if (!unused.length) return false;
                stat.type = choice(unused);
                return true;
            }
        }
        return false;
    }
    function moveProc(gem, statType) {
        if (!hasStat(gem, statType)) return false;
        for (const stat of gem.stats) {
            if (stat.type === statType) {
                if (stat.containers.length === 1) return false;
                const last = stat.containers.pop();
                const others = gem.stats.filter(s => s.type !== statType);
                choice(others).containers.push(last);
                return true;
            }
        }
        return false;
    }

    // ---- public API: returns the same resp-shape as the Python eel functions ----
    const ok = (gem) => ({ success: true, data: { gem }, gem });
    const err = (error, code) => ({ success: false, error, code });

    function getLookups() {
        // name-based titles, sorted by value (matches get_gem_lookups)
        return {
            success: true,
            data: {
                types: { "Lesser": 1, "Empowered": 2 },
                elements: { "Water": 1, "Fire": 2, "Air": 3, "Cosmic": 4 },
                tiers: { "Radiant": 1, "Stellar": 2, "Crystal": 3, "Mystic": 4 },
                restrictions: { "Fierce": 1, "Arcane": 2 },
                stat_types: {
                    "Physical Damage": 1, "Magic Damage": 2, "Critical Damage": 3, "Critical Hit": 4,
                    "Max Health": 5, "Max Health Bonus": 6, "Light": 7, "Movement Speed": 8, "Jump": 9
                },
                augment_types: { "Rough": 1, "Precise": 2, "Superior": 3 }
            }
        };
    }

    window.GemEngine = {
        getLookups,
        createGem(data) {
            const gem = create(data || {});
            return ok(serializeGem(gem));
        },
        levelUpGem(gemData) {
            const gem = normalize(gemData);
            if (!levelUp(gem)) return err("Gem is already at max level.", "GEM_MAX_LEVEL");
            return ok(serializeGem(gem));
        },
        augmentGem(gemData, statId, augmentId) {
            const gem = normalize(gemData);
            if (!hasStat(gem, statId)) return err("Stat type not found in gem", "GEM_STAT_NOT_FOUND");
            for (const stat of gem.stats) {
                if (stat.type === statId) {
                    if (!addAugmentToStat(stat, augmentId)) return err("Stat is already fully augmented", "GEM_STAT_MAX_AUGMENT");
                    return ok(serializeGem(gem));
                }
            }
            return err("Failed to augment", "GEM_AUGMENT_FAILED");
        },
        sparkGem(gemData, statId) {
            const gem = normalize(gemData);
            if (!hasStat(gem, statId)) return err("Stat type not found in gem", "GEM_STAT_NOT_FOUND");
            if (!rerollStatType(gem, statId)) return err("Failed to reroll stat. It might be locked.", "GEM_REROLL_FAILED");
            return ok(serializeGem(gem));
        },
        flareGem(gemData, statId) {
            const gem = normalize(gemData);
            if (!hasStat(gem, statId)) return err("Stat type not found in gem", "GEM_STAT_NOT_FOUND");
            if (!moveProc(gem, statId)) return err("Cannot move boost from a stat with only one proc.", "GEM_MOVE_PROC_FAILED");
            return ok(serializeGem(gem));
        },
        massUpdate(gems) {
            const out = (gems || []).map(g => (g === null || g === undefined) ? null : serializeGem(normalize(g)));
            return { success: true, data: { gems: out }, gems: out };
        }
    };
})();
