//! models/trove/gems.py: the simulator's `Gem` and `PartialGem`.

use rand::seq::SliceRandom;
use rand::Rng;
use serde_json::{json, Map, Value};

use super::constants::*;
use crate::py::{self, Float, Int, Num};
use super::pyd::{self, Errors, Fail};

#[derive(Clone, Debug)]
pub struct Augment {
    pub kind: AugmentType,
    pub count: i64,
}

#[derive(Clone, Debug)]
pub struct StatContainer {
    pub base: f64,
    pub augments: Vec<Augment>,
}

#[derive(Clone, Debug)]
pub struct Stat {
    pub kind: GemStatType,
    pub containers: Vec<StatContainer>,
    pub locked: bool,
}

#[derive(Clone, Debug)]
pub struct Gem {
    pub id: i64,
    pub tier: GemTier,
    pub kind: GemType,
    pub element: GemElement,
    pub restriction: Option<GemRestriction>,
    pub ability: Option<GemAbility>,
    pub level: i64,
    pub stats: Vec<Stat>,
    pub augmentation: Option<f64>,
}

const EMPTY_SEQUENCE: &str = "Cannot choose from an empty sequence";
const INDEX_ERROR: &str = "list index out of range";

fn default_augments() -> Vec<Augment> {
    AugmentType::ALL.iter().map(|&kind| Augment { kind, count: 0 }).collect()
}

/// `int(datetime.now(UTC).timestamp() * 100)`.
fn default_id() -> i64 {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    (secs * 100.0) as i64
}

impl StatContainer {
    pub fn new(base: Option<f64>) -> Self {
        StatContainer { base: base.unwrap_or_else(|| rand::thread_rng().gen()), augments: default_augments() }
    }

    pub fn increase(&self) -> f64 {
        self.augments.iter().fold(0.0, |acc, a| acc + get_augment_base(a.kind).f() / 100.0 * a.count as f64)
    }

    /// `min(base + increase, 1)`: the int 1 once over-focused.
    pub fn value(&self) -> Num {
        let v = self.real_value();
        if 1.0 < v { Int(1) } else { Float(v) }
    }

    pub fn real_value(&self) -> f64 {
        self.base + self.increase()
    }

    fn add_augment(&mut self, kind: AugmentType) {
        for aug in self.augments.iter_mut().filter(|a| a.kind == kind) {
            aug.count += 1;
        }
    }

    fn dump(&self) -> Value {
        json!({
            "base": py::json_float(self.base),
            "augments": self.augments.iter().map(|a| json!({"type": a.kind.value(), "count": a.count})).collect::<Vec<_>>(),
            "increase": py::json_float(self.increase()),
            "value": py::json_float(self.value().f()),
            "real_value": py::json_float(self.real_value()),
        })
    }
}

impl Stat {
    pub fn new(kind: GemStatType) -> Self {
        Stat { kind, containers: Vec::new(), locked: false }
    }

    /// `min(sum(real_value) / len(containers), 1)`.
    pub fn augmentation_progress(&self) -> Result<Num, String> {
        if self.containers.is_empty() {
            return Err("division by zero".into());
        }
        let total = self.containers.iter().fold(0.0, |acc, c| acc + c.real_value());
        let avg = total / self.containers.len() as f64;
        Ok(if 1.0 < avg { Int(1) } else { Float(avg) })
    }

    /// `Stat.add_augment`: `None` (falsy) when every container is already full.
    pub fn add_augment(&mut self, kind: AugmentType) -> Result<Option<bool>, String> {
        if self.augmentation_progress()?.f() == 1.0 {
            return Ok(Some(false));
        }
        // NaN counts as not full, as Python's `>= 1` check does.
        let full = |c: &&mut StatContainer| matches!(c.real_value().partial_cmp(&1.0), Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal));
        match self.containers.iter_mut().find(|c| !full(c)) {
            Some(c) => {
                c.add_augment(kind);
                Ok(Some(true))
            }
            None => Ok(None),
        }
    }

    fn dump(&self) -> Result<Value, String> {
        Ok(json!({
            "type": self.kind.value(),
            "containers": self.containers.iter().map(StatContainer::dump).collect::<Vec<_>>(),
            "locked": self.locked,
            "augmentation_progress": py::json_float(self.augmentation_progress()?.f()),
        }))
    }
}

// --- validation ------------------------------------------------------------------------

fn enum_field<T: Copy>(errs: &mut Errors, obj: &Map<String, Value>, prefix: &str, key: &str, values: &[i64], from: fn(i64) -> Option<T>) -> Option<T> {
    errs.field(obj, prefix, key, None, |_, _, v| pyd::int_enum(v, values)).and_then(from)
}

fn opt_enum_field<T: Copy>(errs: &mut Errors, obj: &Map<String, Value>, key: &str, values: &[i64], from: fn(i64) -> Option<T>) -> Option<Option<T>> {
    errs.field(obj, "", key, Some(|| None), |_, _, v| if v.is_null() { Ok(None) } else { pyd::int_enum(v, values).map(Some) })
        .map(|o| o.and_then(from))
}

fn validate_augment(errs: &mut Errors, loc: &str, v: &Value) -> Result<Option<Augment>, Fail> {
    let obj = pyd::model(v, "Augment")?;
    let kind = enum_field(errs, obj, loc, "type", AugmentType::VALUES, AugmentType::from_value);
    let count = errs.field(obj, loc, "count", Some(|| 0), |_, _, v| pyd::int(v));
    Ok(kind.zip(count).map(|(kind, count)| Augment { kind, count }))
}

fn validate_container(errs: &mut Errors, loc: &str, v: &Value) -> Result<Option<StatContainer>, Fail> {
    let obj = pyd::model(v, "StatContainer")?;
    let base = errs.field(obj, loc, "base", Some(|| rand::thread_rng().gen::<f64>()), |_, _, v| pyd::float(v));
    let augments = errs.field(obj, loc, "augments", Some(|| Some(default_augments())), |errs, loc, v| {
        Ok(collect(errs, loc, pyd::list(v)?, validate_augment))
    });
    Ok(base.zip(augments.flatten()).map(|(base, augments)| StatContainer { base, augments }))
}

fn validate_stat(errs: &mut Errors, loc: &str, v: &Value) -> Result<Option<Stat>, Fail> {
    let obj = pyd::model(v, "Stat")?;
    let kind = enum_field(errs, obj, loc, "type", GemStatType::VALUES, GemStatType::from_value);
    let containers = errs.field(obj, loc, "containers", Some(|| Some(Vec::new())), |errs, loc, v| {
        Ok(collect(errs, loc, pyd::list(v)?, validate_container))
    });
    let locked = errs.field(obj, loc, "locked", Some(|| false), |_, _, v| pyd::boolean(v));
    Ok(match (kind, containers.flatten(), locked) {
        (Some(kind), Some(containers), Some(locked)) => Some(Stat { kind, containers, locked }),
        _ => None,
    })
}

/// Validates every item of a list field; `None` when any item failed.
fn collect<T>(errs: &mut Errors, loc: &str, items: &[Value], check: fn(&mut Errors, &str, &Value) -> Result<Option<T>, Fail>) -> Option<Vec<T>> {
    let mut out = Vec::new();
    let mut ok = true;
    for (i, item) in items.iter().enumerate() {
        let item_loc = format!("{loc}.{i}");
        match check(errs, &item_loc, item) {
            Ok(Some(t)) => out.push(t),
            Ok(None) => ok = false,
            Err(f) => {
                errs.push(&item_loc, f, item);
                ok = false;
            }
        }
    }
    ok.then_some(out)
}

/// Pre-built pieces `Gem.create` hands to `cls(...)`.
struct Parts {
    tier: Value,
    kind: Value,
    element: GemElement,
    restriction: Option<GemRestriction>,
    ability: Option<GemAbility>,
    level: Value,
    stats: Vec<Stat>,
    augmentation: Value,
}

impl Gem {
    /// `Gem(**v)`.
    pub fn validate(v: &Value) -> Result<Gem, String> {
        let obj = v.as_object().ok_or_else(|| pyd::not_a_mapping("models.trove.gems.Gem", v))?;
        let mut errs = Errors::new("Gem");
        let id = errs.field(obj, "", "id", Some(default_id), |_, _, v| pyd::int(v));
        let tier = enum_field(&mut errs, obj, "", "tier", GemTier::VALUES, GemTier::from_value);
        let kind = enum_field(&mut errs, obj, "", "type", GemType::VALUES, GemType::from_value);
        let element = enum_field(&mut errs, obj, "", "element", GemElement::VALUES, GemElement::from_value);
        let restriction = opt_enum_field(&mut errs, obj, "restriction", GemRestriction::VALUES, GemRestriction::from_value);
        let ability = opt_enum_field(&mut errs, obj, "ability", GemAbility::VALUES, GemAbility::from_value);
        let level = errs.field(obj, "", "level", None, |_, _, v| pyd::int(v));
        let stats = errs.field(obj, "", "stats", None, |errs, loc, v| Ok(collect(errs, loc, pyd::list(v)?, validate_stat))).flatten();
        let augmentation = errs.field(obj, "", "augmentation", Some(|| None), |_, _, v| if v.is_null() { Ok(None) } else { pyd::float(v).map(Some) });
        if !errs.is_empty() {
            return Err(errs.message());
        }
        Ok(Gem {
            id: id.unwrap_or_default(),
            tier: tier.unwrap_or(GemTier::Mystic),
            kind: kind.unwrap_or(GemType::Lesser),
            element: element.unwrap_or(GemElement::Water),
            restriction: restriction.flatten(),
            ability: ability.flatten(),
            level: level.unwrap_or_default(),
            stats: stats.unwrap_or_default(),
            augmentation: augmentation.flatten(),
        })
    }

    /// The final `cls(...)` of `Gem.create`, which validates the raw arguments it kept.
    fn from_parts(p: Parts) -> Result<Gem, String> {
        let mut obj = Map::new();
        obj.insert("tier".into(), p.tier);
        obj.insert("type".into(), p.kind);
        obj.insert("level".into(), p.level);
        obj.insert("augmentation".into(), p.augmentation);
        let mut errs = Errors::new("Gem");
        let tier = enum_field(&mut errs, &obj, "", "tier", GemTier::VALUES, GemTier::from_value);
        let kind = enum_field(&mut errs, &obj, "", "type", GemType::VALUES, GemType::from_value);
        let level = errs.field(&obj, "", "level", None, |_, _, v| pyd::int(v));
        let augmentation = errs.field(&obj, "", "augmentation", Some(|| None), |_, _, v| if v.is_null() { Ok(None) } else { pyd::float(v).map(Some) });
        if !errs.is_empty() {
            return Err(errs.message());
        }
        Ok(Gem {
            id: default_id(),
            tier: tier.unwrap_or(GemTier::Mystic),
            kind: kind.unwrap_or(GemType::Lesser),
            element: p.element,
            restriction: p.restriction,
            ability: p.ability,
            level: level.unwrap_or_default(),
            stats: p.stats,
            augmentation: augmentation.flatten(),
        })
    }

    /// `Gem.create(**kwargs)`.
    pub fn create(kwargs: &Map<String, Value>) -> Result<Gem, String> {
        const PARAMS: [&str; 8] = ["tier", "type", "element", "restriction", "augmentation", "level", "procs", "generation"];
        if let Some(k) = kwargs.keys().find(|k| !PARAMS.contains(&k.as_str())) {
            return Err(format!("Gem.create() got an unexpected keyword argument '{k}'"));
        }
        let rng = &mut rand::thread_rng();
        let arg = |k: &str| kwargs.get(k).cloned().unwrap_or(Value::Null);
        let pick = |values: &[i64], rng: &mut rand::rngs::ThreadRng| json!(*values.choose(rng).unwrap());

        let tier = if crate::args::truthy(&arg("tier")) { arg("tier") } else { pick(GemTier::VALUES, rng) };
        let kind = if crate::args::truthy(&arg("type")) { arg("type") } else { pick(GemType::VALUES, rng) };
        let element = match arg("element") {
            v if !crate::args::truthy(&v) => *GemElement::ALL.choose(rng).unwrap(),
            v => lookup::<GemElement>(&v, GemElement::from_value, GemElement::PY_NAME)?,
        };
        let augmentation = arg("augmentation");
        let restriction = if py::eq_int(&kind, GemType::Lesser.value()) {
            match arg("restriction") {
                Value::Null => Some(*GemRestriction::ALL.choose(rng).unwrap()),
                v => Some(lookup(&v, GemRestriction::from_value, GemRestriction::PY_NAME)?),
            }
        } else {
            None
        };
        let level = match kwargs.get("level") {
            None => Int(1),
            Some(v) => Num::from_json(v).ok_or_else(|| format!("'<' not supported between instances of 'int' and '{}'", py::type_name(v)))?,
        };
        let capped = if 15.0 < level.f() { Int(15) } else { level };
        let extra_containers = match capped {
            Int(i) => Int(i.div_euclid(5)),
            Float(f) => Float((f / 5.0).floor()),
        };

        let generation = arg("generation");
        let mut stats: Vec<Stat> = if !crate::args::truthy(&generation) {
            let pool = match restriction {
                None => *[StatPool::Physical, StatPool::Magic].choose(rng).unwrap(),
                Some(GemRestriction::Fierce) => StatPool::Physical,
                Some(GemRestriction::Arcane) => StatPool::Magic,
            };
            let mut candidates = pool.stats(element).to_vec();
            let (picked, _) = candidates.partial_shuffle(rng, 3);
            let mut stats: Vec<Stat> = picked.iter().map(|&t| Stat::new(t)).collect();
            if element == GemElement::Cosmic {
                let stat = &mut stats[rng.gen_range(0..=2)];
                stat.kind = GemStatType::Light;
                stat.locked = true;
            }
            stats
        } else {
            let mut stats = Vec::new();
            for t in py::iterate(&generation)? {
                let mut errs = Errors::new("Stat");
                let mut obj = Map::new();
                obj.insert("type".into(), t);
                let kind = enum_field(&mut errs, &obj, "", "type", GemStatType::VALUES, GemStatType::from_value);
                if !errs.is_empty() {
                    return Err(errs.message());
                }
                let mut stat = Stat::new(kind.unwrap_or(GemStatType::Light));
                stat.locked = stat.kind == GemStatType::Light;
                stats.push(stat);
            }
            stats
        };

        let container = || -> Result<StatContainer, String> {
            if augmentation.is_null() {
                return Ok(StatContainer::new(None));
            }
            let mut errs = Errors::new("StatContainer");
            let mut obj = Map::new();
            obj.insert("base".into(), augmentation.clone());
            let base = errs.field(&obj, "", "base", None, |_, _, v| pyd::float(v));
            if !errs.is_empty() {
                return Err(errs.message());
            }
            Ok(StatContainer::new(base))
        };
        for stat in stats.iter_mut() {
            stat.containers.push(container()?);
        }
        match kwargs.get("procs") {
            None | Some(Value::Null) => {
                let Int(n) = extra_containers else {
                    return Err("'float' object cannot be interpreted as an integer".into());
                };
                for _ in 0..n.max(0) {
                    let index = rng.gen_range(0..=2usize);
                    let c = container()?;
                    stats.get_mut(index).ok_or(INDEX_ERROR)?.containers.push(c);
                }
            }
            Some(procs) => {
                for (i, proc) in py::iterate(procs)?.iter().enumerate() {
                    let n = match proc {
                        Value::Bool(b) => *b as i64,
                        Value::Number(n) if n.is_i64() || n.is_u64() => n.as_i64().unwrap_or(i64::MAX),
                        other => return Err(format!("'{}' object cannot be interpreted as an integer", py::type_name(other))),
                    };
                    for _ in 0..n.max(0) {
                        let c = container()?;
                        stats.get_mut(i).ok_or(INDEX_ERROR)?.containers.push(c);
                    }
                }
            }
        }

        let max_level = GemTier::ALL.iter().find(|t| py::eq_int(&tier, t.value())).map(|&t| get_gem_max_level(t));
        let level = match max_level {
            None => return Err(format!("'<' not supported between instances of 'NoneType' and '{}'", level.type_name())),
            Some(max) if (max as f64) < level.f() => Int(max),
            Some(_) => level,
        };
        let ability = py::eq_int(&kind, GemType::Empowered.value()).then(|| *abilities(element).choose(rng).unwrap());
        Gem::from_parts(Parts { tier, kind, element, restriction, ability, level: level.json(), stats, augmentation })
    }

    fn augment_level(&self) -> Option<f64> {
        self.augmentation
    }

    pub fn has_stat(&self, kind: GemStatType) -> bool {
        self.stats.iter().any(|s| s.kind == kind)
    }

    /// `reroll_stat_type` (Spark).
    pub fn reroll_stat_type(&mut self, kind: GemStatType) -> Result<bool, String> {
        let in_use: Vec<GemStatType> = self.stats.iter().map(|s| s.kind).collect();
        if !self.has_stat(kind) {
            return Ok(false);
        }
        let pool: &[GemStatType] = match self.restriction {
            Some(GemRestriction::Fierce) => StatPool::Physical.stats(self.element),
            Some(GemRestriction::Arcane) => StatPool::Magic.stats(self.element),
            None => stat_restrictions(self.element),
        };
        let Some(stat) = self.stats.iter_mut().find(|s| s.kind == kind && !s.locked) else {
            return Ok(false);
        };
        let mut unused: Vec<GemStatType> = pool.iter().copied().filter(|s| !in_use.contains(s)).collect();
        if in_use.contains(&GemStatType::PhysicalDamage) {
            unused.retain(|&s| s != GemStatType::MagicDamage);
        }
        if in_use.contains(&GemStatType::MagicDamage) {
            unused.retain(|&s| s != GemStatType::PhysicalDamage);
        }
        stat.kind = *unused.choose(&mut rand::thread_rng()).ok_or(EMPTY_SEQUENCE)?;
        Ok(true)
    }

    /// `move_proc` (Flare).
    pub fn move_proc(&mut self, kind: GemStatType) -> Result<bool, String> {
        let Some(i) = self.stats.iter().position(|s| s.kind == kind) else {
            return Ok(false);
        };
        if self.stats[i].containers.len() == 1 {
            return Ok(false);
        }
        let last = self.stats[i].containers.pop().ok_or(INDEX_ERROR)?;
        let others: Vec<usize> = (0..self.stats.len()).filter(|&j| self.stats[j].kind != kind).collect();
        let j = *others.choose(&mut rand::thread_rng()).ok_or(EMPTY_SEQUENCE)?;
        self.stats[j].containers.push(last);
        Ok(true)
    }

    pub fn level_up(&mut self) -> Result<bool, String> {
        if self.level < get_gem_max_level(self.tier) {
            self.level += 1;
        } else {
            return Ok(false);
        }
        if matches!(self.level, 5 | 10 | 15) {
            let index = rand::thread_rng().gen_range(0..=2usize);
            let c = StatContainer::new(self.augment_level());
            self.stats.get_mut(index).ok_or(INDEX_ERROR)?.containers.push(c);
        }
        Ok(true)
    }

    fn ability_name(&self) -> Option<&'static str> {
        self.ability.map(GemAbility::display_name)
    }

    fn gem_name(&self) -> Result<Value, String> {
        if self.kind == GemType::Lesser {
            let r = self.restriction.ok_or("'NoneType' object has no attribute 'display_name'")?;
            Ok(json!(format!("{} {} Gem", r.display_name(), self.tier.display_name())))
        } else {
            Ok(json!(self.ability_name()))
        }
    }

    fn quality(&self) -> f64 {
        let (mut total, mut count) = (0.0, 0usize);
        for c in self.stats.iter().flat_map(|s| &s.containers) {
            total += c.value().f();
            count += 1;
        }
        if count == 0 {
            return 0.0;
        }
        py::round_to(total / count as f64 * 100.0, 1) / 100.0
    }

    fn power_rank(&self) -> Result<i64, String> {
        let mut power_rank = if self.kind == GemType::Lesser { 0.0 } else { 100.0 };
        let [lo, hi] = get_gem_pr_threshold(self.kind, self.tier);
        for stat in &self.stats {
            let progress = lo as f64 + (hi - lo) as f64 * stat.augmentation_progress()?.f();
            power_rank += progress * stat.containers.len() as f64;
        }
        for _ in &self.stats {
            for level in 1..=self.level {
                power_rank += get_increment_power_rank(self.tier, level).unwrap_or(0) as f64;
            }
        }
        Ok(py::round_int(power_rank)?)
    }

    fn stat_values(&self) -> Result<Value, String> {
        let pr_increments = Int(pr_increment_total(self.tier, self.level));
        let mut out = Vec::new();
        for stat in &self.stats {
            let base = get_stat_base(self.kind, self.tier, stat.kind);
            let [t0, t1] = get_stat_threshold(self.kind, self.tier, stat.kind).ok_or("'NoneType' object is not subscriptable")?;
            let base = base.ok_or("unsupported operand type(s) for *: 'NoneType' and 'float'")?;
            let progress = t0 + (t1 - t0) * stat.augmentation_progress()?;
            let mut value = base * progress * Int(stat.containers.len() as i64);
            value = value + base * pr_increments;
            let mut entry = Map::new();
            entry.insert(stat.kind.display_name().into(), value.json());
            out.push(Value::Object(entry));
        }
        Ok(Value::Array(out))
    }

    /// `model_dump(mode='json')`, which runs (and can raise from) the computed fields.
    pub fn dump(&self) -> Result<Value, String> {
        let stats = self.stats.iter().map(Stat::dump).collect::<Result<Vec<_>, _>>()?;
        let gem_name = self.gem_name()?;
        Ok(json!({
            "id": self.id,
            "tier": self.tier.value(),
            "type": self.kind.value(),
            "element": self.element.value(),
            "restriction": self.restriction.map(GemRestriction::value),
            "ability": self.ability.map(GemAbility::value),
            "level": self.level,
            "stats": stats,
            "augmentation": self.augmentation.map(py::json_float),
            "ability_name": self.ability_name(),
            "gem_name": gem_name,
            "is_max_level": self.level == get_gem_max_level(self.tier),
            "quality": py::json_float(self.quality()),
            "power_rank": self.power_rank()?,
            "stat_values": self.stat_values()?,
        }))
    }
}

/// `SomeEnum(v)` (a plain call, not pydantic).
pub fn lookup<T>(v: &Value, from: fn(i64) -> Option<T>, name: &str) -> Result<T, String> {
    py::enum_key(v).and_then(from).ok_or_else(|| format!("{} is not a valid {}", py::repr_latin1(v), name))
}

/// models/trove/gems.py `PartialGem`: a gem known only by its Power Rank.
#[derive(Clone, Debug)]
pub struct PartialGem {
    pub tier: GemTier,
    pub kind: GemType,
    pub level: i64,
    pub power_rank: i64,
    pub containers: Option<i64>,
}

impl PartialGem {
    pub fn default_container_count(&self) -> i64 {
        self.level.min(15).div_euclid(5) + 3
    }

    pub fn expected_power_rank_range(&self) -> (i64, i64) {
        let count = self.containers.filter(|&c| c != 0).unwrap_or_else(|| self.default_container_count());
        let [lo, hi] = get_gem_pr_threshold(self.kind, self.tier);
        let (mut min_pr, mut max_pr) = (lo * count, hi * count);
        if self.kind == GemType::Empowered {
            min_pr += 100;
            max_pr += 100;
        }
        for level in 1..=self.level {
            let inc = get_increment_power_rank(self.tier, level).unwrap_or(0);
            min_pr += inc * 3;
            max_pr += inc * 3;
        }
        (min_pr, max_pr)
    }

    pub fn is_within_expected_range(&self) -> bool {
        let (lo, hi) = self.expected_power_rank_range();
        lo <= self.power_rank && self.power_rank <= hi
    }

    pub fn progress(&self) -> Result<f64, String> {
        let (lo, hi) = self.expected_power_rank_range();
        Ok(if self.power_rank < lo {
            -1.0
        } else if self.power_rank > hi {
            1.0
        } else if hi == lo {
            return Err("division by zero".into());
        } else {
            (self.power_rank - lo) as f64 / (hi - lo) as f64
        })
    }
}
