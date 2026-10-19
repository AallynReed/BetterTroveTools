//! models/trove/gem_constants.py and gem_bases.py: the gem enums and lookup tables.

use super::py::{Float, Int, Num};

macro_rules! gem_enum {
    ($name:ident, $($variant:ident = $value:literal, $member:literal, $display:literal;)+) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant = $value),+
        }

        #[allow(dead_code)]
        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
            pub const VALUES: &'static [i64] = &[$($value),+];
            /// The Python class name, for `"5 is not a valid GemTier"`.
            pub const PY_NAME: &'static str = stringify!($name);

            pub fn value(self) -> i64 {
                self as i64
            }

            pub fn from_value(v: i64) -> Option<Self> {
                Self::ALL.iter().copied().find(|e| e.value() == v)
            }

            pub fn display_name(self) -> &'static str {
                match self {
                    $($name::$variant => $display),+
                }
            }

            /// The member name (`MAX_HEALTH_BONUS`).
            pub fn member(self) -> &'static str {
                match self {
                    $($name::$variant => $member),+
                }
            }
        }
    };
}

gem_enum!(GemTier,
    Radiant = 1, "RADIANT", "Radiant";
    Stellar = 2, "STELLAR", "Stellar";
    Crystal = 3, "CRYSTAL", "Crystal";
    Mystic = 4, "MYSTIC", "Mystic";
);

gem_enum!(GemType,
    Lesser = 1, "LESSER", "Lesser";
    Empowered = 2, "EMPOWERED", "Empowered";
);

gem_enum!(GemElement,
    Water = 1, "WATER", "Water";
    Fire = 2, "FIRE", "Fire";
    Air = 3, "AIR", "Air";
    Cosmic = 4, "COSMIC", "Cosmic";
);

gem_enum!(GemStatType,
    PhysicalDamage = 1, "PHYSICAL_DAMAGE", "Physical Damage";
    MagicDamage = 2, "MAGIC_DAMAGE", "Magic Damage";
    CriticalDamage = 3, "CRITICAL_DAMAGE", "Critical Damage";
    CriticalHit = 4, "CRITICAL_HIT", "Critical Hit";
    MaxHealth = 5, "MAX_HEALTH", "Max Health";
    MaxHealthBonus = 6, "MAX_HEALTH_BONUS", "Max Health %";
    Light = 7, "LIGHT", "Light";
    MovementSpeed = 8, "MOVEMENT_SPEED", "Movement Speed";
    Jump = 9, "JUMP", "Jump";
);

gem_enum!(GemRestriction,
    Fierce = 1, "FIERCE", "Fierce";
    Arcane = 2, "ARCANE", "Arcane";
);

gem_enum!(GemAbility,
    StingingCurse = 1, "STINGING_CURSE", "Stinging Curse";
    VolatileVelocity = 2, "VOLATILE_VELOCITY", "Volatile Velocity";
    SpiritSurge = 3, "SPIRIT_SURGE", "Spirit Surge";
    MiredMojo = 4, "MIRED_MOJO", "Mired Mojo";
    Stunburst = 5, "STUNBURST", "Stunburst";
    Pyrodisc = 6, "PYRODISC", "Pyrodisc";
    ExplosiveEpilogue = 7, "EXPLOSIVE_EPILOGUE", "Explosive Epilogue";
    CubicCurtain = 8, "CUBIC_CURTAIN", "Cubic Curtain";
    BerserkBattler = 9, "BERSERK_BATTLER", "Berserk Battler";
    EmpyreanBarrier = 10, "EMPYREAN_BARRIER", "Empyrean Barrier";
    FlowerPower = 11, "FLOWER_POWER", "Flower Power";
    VampirianVanquisher = 12, "VAMPIRIAN_VANQUISHER", "Vampirian Vanquisher";
);

gem_enum!(AugmentType,
    Rough = 1, "ROUGH", "Rough Focus";
    Precise = 2, "PRECISE", "Precise Focus";
    Superior = 3, "SUPERIOR", "Superior Focus";
);

use GemStatType as S;

const BASE_POOL: [GemStatType; 6] = [S::PhysicalDamage, S::MagicDamage, S::CriticalDamage, S::CriticalHit, S::MaxHealth, S::MaxHealthBonus];
const COSMIC_POOL: [GemStatType; 7] =
    [S::PhysicalDamage, S::MagicDamage, S::CriticalDamage, S::CriticalHit, S::MaxHealth, S::MaxHealthBonus, S::Light];
const PHYSICAL_POOL: [GemStatType; 5] = [S::PhysicalDamage, S::CriticalDamage, S::CriticalHit, S::MaxHealth, S::MaxHealthBonus];
const MAGIC_POOL: [GemStatType; 5] = [S::MagicDamage, S::CriticalDamage, S::CriticalHit, S::MaxHealth, S::MaxHealthBonus];

/// `GEM_STAT_RESTRICTIONS[element]`.
pub fn stat_restrictions(element: GemElement) -> &'static [GemStatType] {
    if element == GemElement::Cosmic { &COSMIC_POOL } else { &BASE_POOL }
}

/// `PHYSICAL_GEM_STAT_POOL` / `MAGIC_GEM_STAT_POOL` (the same for every element).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StatPool {
    Physical,
    Magic,
}

impl StatPool {
    pub fn stats(self, _element: GemElement) -> &'static [GemStatType] {
        match self {
            StatPool::Physical => &PHYSICAL_POOL,
            StatPool::Magic => &MAGIC_POOL,
        }
    }
}

/// `GEM_ABILITIES[element]`.
pub fn abilities(element: GemElement) -> &'static [GemAbility] {
    use GemAbility as A;
    const ELEMENTAL: [GemAbility; 8] = [
        A::StingingCurse,
        A::VolatileVelocity,
        A::SpiritSurge,
        A::MiredMojo,
        A::Stunburst,
        A::Pyrodisc,
        A::ExplosiveEpilogue,
        A::CubicCurtain,
    ];
    const COSMIC: [GemAbility; 4] = [A::BerserkBattler, A::EmpyreanBarrier, A::FlowerPower, A::VampirianVanquisher];
    if element == GemElement::Cosmic { &COSMIC } else { &ELEMENTAL }
}

pub fn get_gem_max_level(tier: GemTier) -> i64 {
    match tier {
        GemTier::Radiant => 23,
        GemTier::Stellar => 25,
        GemTier::Crystal => 30,
        GemTier::Mystic => 35,
    }
}

/// `get_level_pr_increment`: `None` below level 1.
pub fn get_level_pr_increment(level: i64, base: i64) -> Option<i64> {
    match level {
        1 | 5 | 10 | 15 => Some(0),
        l if l > 15 && l % 5 == 0 => Some(base * 5),
        l if 1 < l && l < 15 => Some(base),
        l if l > 15 => Some(base * 2),
        _ => None,
    }
}

/// `get_increment_power_rank_lesser` and `_empowered` (the two are identical).
pub fn get_increment_power_rank(tier: GemTier, level: i64) -> Option<i64> {
    let base = match tier {
        GemTier::Radiant => 3,
        GemTier::Stellar => 5,
        GemTier::Crystal => 7,
        GemTier::Mystic => 9,
    };
    get_level_pr_increment(level, base)
}

/// Sum of the per-level Power Rank increments up to `level`.
pub fn pr_increment_total(tier: GemTier, level: i64) -> i64 {
    (1..=level).filter_map(|l| get_increment_power_rank(tier, l)).sum()
}

/// `get_stat_base_lesser` / `get_stat_base_empowered`.
pub fn get_stat_base(kind: GemType, tier: GemTier, stat: GemStatType) -> Option<Num> {
    use GemTier::*;
    let early = matches!(tier, Radiant | Stellar);
    Some(match (tier, stat) {
        (_, S::PhysicalDamage | S::MagicDamage) if early => Int(14),
        (_, S::CriticalDamage) if early => Float(0.2),
        (_, S::CriticalHit) if early => Float(0.02),
        (_, S::MaxHealthBonus) if early => Float(0.5),
        (_, S::MaxHealth) if early => Int(50),
        (_, S::Light) if early => Int(1),
        (Crystal, S::PhysicalDamage | S::MagicDamage) => Int(16),
        (Crystal, S::CriticalDamage) => Float(3.0 / 14.0),
        (Crystal, S::CriticalHit) => Float(0.3 / 14.0),
        (Crystal, S::MaxHealthBonus) => Float(0.5),
        (Crystal, S::MaxHealth) => Int(50),
        (Crystal, S::Light) => Float(5.0 / 7.0),
        (Mystic, S::PhysicalDamage | S::MagicDamage) => {
            if kind == GemType::Lesser {
                Float(168.0 / 9.0)
            } else {
                Int(28)
            }
        }
        (Mystic, S::CriticalDamage) => Float(2.5 / 9.0),
        (Mystic, S::CriticalHit) => Float(0.25 / 9.0),
        (Mystic, S::MaxHealthBonus) => Float(5.25 / 9.0),
        (Mystic, S::MaxHealth) => Float(525.0 / 9.0),
        (Mystic, S::Light) => Float(5.0 / 9.0),
        _ => return None,
    })
}

/// `get_stat_threshold_lesser` / `get_stat_threshold_empowered`.
pub fn get_stat_threshold(kind: GemType, tier: GemTier, stat: GemStatType) -> Option<[Num; 2]> {
    use GemTier::*;
    if matches!(stat, S::MovementSpeed | S::Jump) {
        return None;
    }
    let damage = matches!(stat, S::PhysicalDamage | S::MagicDamage);
    let crit = matches!(stat, S::CriticalDamage | S::CriticalHit);
    let health = matches!(stat, S::MaxHealth | S::MaxHealthBonus);
    let ints = |a: i64, b: i64| [Int(a), Int(b)];
    Some(match (kind, tier) {
        (GemType::Lesser, Radiant) => ints(85, 113),
        (GemType::Lesser, Stellar) => ints(150, 200),
        (GemType::Lesser, Crystal) if damage => ints(210, 280),
        (GemType::Lesser, Crystal) if crit => [Float(560.0 / 3.0), Float(770.0 / 3.0)],
        (GemType::Lesser, Crystal) if health => ints(245, 315),
        (GemType::Lesser, Crystal) => ints(280, 385),
        (GemType::Lesser, Mystic) if damage => ints(270, 360),
        (GemType::Lesser, Mystic) if crit => [Float(187.2), Int(297)],
        (GemType::Lesser, Mystic) if health => ints(315, 405),
        (GemType::Lesser, Mystic) => ints(495, 585),
        (GemType::Empowered, Radiant) => ints(113, 150),
        (GemType::Empowered, Stellar) => ints(200, 266),
        (GemType::Empowered, Crystal) if damage => ints(245, 350),
        (GemType::Empowered, Crystal) if crit => [Float(700.0 / 3.0), Float(910.0 / 3.0)],
        (GemType::Empowered, Crystal) if health => ints(315, 385),
        (GemType::Empowered, Crystal) => ints(350, 420),
        (GemType::Empowered, Mystic) if damage => ints(210, 300),
        (GemType::Empowered, Mystic) if crit => ints(252, 342),
        (GemType::Empowered, Mystic) if health => ints(405, 495),
        (GemType::Empowered, Mystic) => ints(495, 630),
    })
}

/// `get_lesser_gem_pr_threshold` / `get_empowered_gem_pr_threshold`.
pub fn get_gem_pr_threshold(kind: GemType, tier: GemTier) -> [i64; 2] {
    match (kind, tier) {
        (GemType::Lesser, GemTier::Radiant) => [85, 113],
        (GemType::Lesser, GemTier::Stellar) => [150, 200],
        (GemType::Lesser, GemTier::Crystal) => [175, 250],
        (GemType::Lesser, GemTier::Mystic) => [200, 260],
        (GemType::Empowered, GemTier::Radiant) => [113, 150],
        (GemType::Empowered, GemTier::Stellar) => [200, 266],
        (GemType::Empowered, GemTier::Crystal) => [220, 280],
        (GemType::Empowered, GemTier::Mystic) => [240, 300],
    }
}

/// `get_augment_base`: the percent one focus adds.
pub fn get_augment_base(augment: AugmentType) -> Num {
    match augment {
        AugmentType::Rough => Float(2.5),
        AugmentType::Precise => Int(5),
        AugmentType::Superior => Float(12.5),
    }
}
