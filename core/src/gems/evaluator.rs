//! backend/gems_and_builds/gem_evaluator.py: reads a gem's quality and focus cost
//! from its stat values or Power Rank.

use serde_json::{json, Map, Value};

use super::constants::*;
use super::model::{lookup, PartialGem};
use crate::py::{self, Int};
use crate::{Args, Cmd, Resp};

pub fn commands() -> Vec<Cmd> {
    vec![
        Cmd::std("evaluate_gem", |a| guarded(a, "evaluate_gem", evaluate_gem, "GEM_EVALUATOR_FAILED")),
        Cmd::std("guess_gem_procs", |a| guarded(a, "guess_gem_procs", guess_gem_procs, "GEM_EVALUATOR_GUESS_FAILED")),
        Cmd::std("guess_gem_stats", |a| guarded(a, "guess_gem_stats", guess_gem_stats, "GEM_EVALUATOR_STAT_GUESS_FAILED")),
        Cmd::std("evaluate_gem_simple", |a| guarded(a, "evaluate_gem_simple", evaluate_gem_simple, "GEM_EVALUATOR_SIMPLE_FAILED")),
        Cmd::std("get_gem_stat_range", |a| guarded(a, "get_gem_stat_range", get_gem_stat_range, "GEM_STAT_RANGE_FAILED")),
        Cmd::std("simulate_next_focus", |a| guarded(a, "simulate_next_focus", simulate_next_focus, "GEM_EVALUATOR_SIM_FAILED")),
    ]
}

/// Each endpoint takes one `data` argument and turns any exception into `resp(False, error=str(e), code=...)`.
fn guarded(a: &Args, name: &str, f: fn(&Value) -> Result<Value, String>, code: &str) -> anyhow::Result<Value> {
    super::arity(a, name, &["data"], 1)?;
    Ok(f(a.get(0)).unwrap_or_else(|e| Resp::fail(e, code).into()))
}

/// How far outside [0, 1] a stat's progress still counts as plausible input.
const PROGRESS_TOLERANCE: f64 = 0.05;

struct FocusOption {
    key: &'static str,
    label: &'static str,
    values: &'static [f64],
    keys: &'static [&'static str],
}

const FOCUS_OPTIONS: [FocusOption; 3] = [
    FocusOption { key: "optimized_all", label: "Superior + Precise + Rough", values: &[12.5, 5.0, 2.5], keys: &["superior", "precise", "rough"] },
    FocusOption { key: "optimized_precise_rough", label: "Precise + Rough", values: &[5.0, 2.5], keys: &["precise", "rough"] },
    FocusOption { key: "rough_only", label: "Rough Only", values: &[2.5], keys: &["rough"] },
];

const FOCUS_KEYS: [&str; 3] = ["superior", "precise", "rough"];

fn recipe(focus: &str) -> &'static [(&'static str, i64)] {
    match focus {
        "rough" => &[("bound_brilliance", 1), ("heart_of_darkness", 4), ("flux", 1200)],
        "precise" => &[("bound_brilliance", 1), ("water_gem_dust", 3000), ("air_gem_dust", 3000), ("fire_gem_dust", 3000), ("flux", 2000)],
        _ => &[("bound_brilliance", 1), ("diamond_dragonite", 30), ("titan_soul", 3), ("flux", 50000)],
    }
}

/// Focus counts in `superior, precise, rough` order, plus the total.
#[derive(Clone, Copy, Default)]
struct Counts {
    by_kind: [i64; 3],
}

impl Counts {
    fn total(&self) -> i64 {
        self.by_kind.iter().sum()
    }

    fn json(&self) -> Map<String, Value> {
        let mut m = Map::new();
        for (k, v) in FOCUS_KEYS.iter().zip(self.by_kind) {
            m.insert((*k).into(), json!(v));
        }
        m.insert("total".into(), json!(self.total()));
        m
    }
}

/// An insertion-ordered material tally.
#[derive(Clone, Default)]
struct Materials(Vec<(&'static str, i64)>);

impl Materials {
    fn add(&mut self, key: &'static str, amount: i64) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 += amount,
            None => self.0.push((key, amount)),
        }
    }

    fn json(&self) -> Value {
        Value::Object(self.0.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect())
    }
}

#[derive(Clone)]
struct OptionTotals {
    counts: Counts,
    recipe_totals: Materials,
}

impl OptionTotals {
    /// `{"label", superior, precise, rough, total, "recipe_totals"}`, with `key` first when given.
    fn json(&self, option: &FocusOption, with_key: bool) -> Value {
        let mut m = Map::new();
        if with_key {
            m.insert("key".into(), json!(option.key));
        }
        m.insert("label".into(), json!(option.label));
        m.extend(self.counts.json());
        m.insert("recipe_totals".into(), self.recipe_totals.json());
        Value::Object(m)
    }
}

struct FocusPlan {
    current_percent: f64,
    remaining_percent: f64,
    per_container: [Counts; 3],
    totals: [OptionTotals; 3],
}

impl FocusPlan {
    fn json(&self) -> Value {
        let per: Map<String, Value> = FOCUS_OPTIONS.iter().zip(&self.per_container).map(|(o, c)| (o.key.to_string(), Value::Object(c.json()))).collect();
        let totals: Map<String, Value> = FOCUS_OPTIONS.iter().zip(&self.totals).map(|(o, t)| (o.key.to_string(), t.json(o, false))).collect();
        json!({
            "current_percent": py::json_float(self.current_percent),
            "remaining_percent": py::json_float(py::round_to(self.remaining_percent, 2)),
            "per_container": per,
            "totals": totals,
        })
    }

    /// `_summarize_focus_totals`.
    fn summary(&self) -> Value {
        Value::Object(FOCUS_OPTIONS.iter().zip(&self.totals).map(|(o, t)| (o.key.to_string(), t.json(o, true))).collect())
    }
}

fn calculate_focus_counts(remaining_percent: f64, option: &FocusOption) -> Counts {
    let mut counts = Counts::default();
    let mut remaining = ((remaining_percent - 1e-9) / 2.5).ceil().max(0.0) as i64;
    let units: Vec<i64> = option.values.iter().map(|v| (v / 2.5).round_ties_even() as i64).collect();
    let slot = |k: &str| FOCUS_KEYS.iter().position(|x| *x == k).unwrap();
    for (key, unit) in option.keys.iter().zip(&units) {
        counts.by_kind[slot(key)] = remaining.div_euclid(*unit);
        remaining = remaining.rem_euclid(*unit);
    }
    if remaining > 0 {
        let last = units[units.len() - 1];
        counts.by_kind[slot(option.keys[option.keys.len() - 1])] += (remaining as f64 / last as f64).ceil() as i64;
    }
    counts
}

fn build_focus_plan(display_progress: f64, containers: i64) -> FocusPlan {
    let current_percent = py::round_to(display_progress * 100.0, 2);
    let remaining_percent = if 0.0 < 100.0 - current_percent { 100.0 - current_percent } else { 0.0 };
    let per_container = [0, 1, 2].map(|i| calculate_focus_counts(remaining_percent, &FOCUS_OPTIONS[i]));
    let totals = per_container.map(|c| {
        let counts = Counts { by_kind: c.by_kind.map(|n| n * containers) };
        let mut recipe_totals = Materials::default();
        for (focus, &count) in FOCUS_KEYS.iter().zip(&counts.by_kind) {
            if count <= 0 {
                continue;
            }
            for &(material, amount) in recipe(focus) {
                recipe_totals.add(material, amount * count);
            }
        }
        OptionTotals { counts, recipe_totals }
    });
    FocusPlan { current_percent, remaining_percent, per_container, totals }
}

/// One stat of an evaluated gem.
struct StatEval {
    kind: GemStatType,
    entered_value: f64,
    extra_containers: i64,
    containers: i64,
    progress: f64,
    quality_percent: f64,
    pr_contribution: f64,
    within: bool,
    raw_progress: f64,
    threshold_progress: f64,
    focus_plan: FocusPlan,
}

/// A proc spread's rank key, lowest best: (out-of-range penalty, -total, stat spread).
type Score = (f64, i64, f64);

/// `_evaluate_gem_candidate`'s result.
struct Candidate {
    kind: GemType,
    element: GemElement,
    restriction: Option<GemRestriction>,
    quality: f64,
    power_rank: i64,
    issues: Vec<String>,
    stats: Vec<StatEval>,
    level: i64,
    tier: GemTier,
}

impl Candidate {
    fn quality_percent(&self) -> f64 {
        py::round_to(self.quality * 100.0, 2)
    }

    fn focus_totals(&self) -> Vec<OptionTotals> {
        (0..FOCUS_OPTIONS.len())
            .map(|i| {
                let mut counts = Counts::default();
                let mut recipe_totals = Materials::default();
                for stat in &self.stats {
                    let t = &stat.focus_plan.totals[i];
                    for k in 0..3 {
                        counts.by_kind[k] += t.counts.by_kind[k];
                    }
                    for &(m, a) in &t.recipe_totals.0 {
                        recipe_totals.add(m, a);
                    }
                }
                OptionTotals { counts, recipe_totals }
            })
            .collect()
    }

    fn json(&self) -> Value {
        let totals = self.focus_totals();
        let focus_totals: Map<String, Value> = FOCUS_OPTIONS.iter().zip(&totals).map(|(o, t)| (o.key.to_string(), t.json(o, true))).collect();
        let mut headline = focus_totals["optimized_precise_rough"].clone();
        headline["strategy"] = json!("optimized_precise_rough");
        let stats: Vec<Value> = self
            .stats
            .iter()
            .map(|s| {
                json!({
                    "type": s.kind.value(),
                    "display_name": s.kind.display_name(),
                    "entered_value": py::json_float(s.entered_value),
                    "extra_containers": s.extra_containers,
                    "containers": s.containers,
                    "progress": py::json_float(s.progress),
                    "quality_percent": py::json_float(s.quality_percent),
                    "estimated_pr_contribution": py::json_float(s.pr_contribution),
                    "is_within_range": s.within,
                    "raw_progress": py::json_float(s.raw_progress),
                    "threshold_progress": py::json_float(s.threshold_progress),
                    "focus_plan": s.focus_plan.json(),
                })
            })
            .collect();
        json!({
            "type": self.kind.value(),
            "type_name": self.kind.display_name(),
            "element": self.element.value(),
            "element_name": self.element.display_name(),
            "restriction": self.restriction.map(GemRestriction::value),
            "restriction_name": self.restriction.map(GemRestriction::display_name).unwrap_or("Any"),
            "quality": py::json_float(py::round_to(self.quality, 4)),
            "quality_percent": py::json_float(self.quality_percent()),
            "calculated_power_rank": self.power_rank,
            "has_issues": !self.issues.is_empty(),
            "issues": self.issues,
            "focus_totals": focus_totals,
            "headline_cost": headline,
            "stats": stats,
            "level": self.level,
            "tier": self.tier.value(),
        })
    }

    /// `_distribution_score`.
    fn score(&self, total: i64) -> Score {
        let mut penalty = 0.0;
        for s in &self.stats {
            let clamped = clamp01(s.raw_progress);
            penalty += (s.raw_progress - clamped) * (s.raw_progress - clamped);
        }
        let progresses = self.stats.iter().map(|s| s.progress);
        let max = progresses.clone().fold(f64::NAN, |m, p| if m.is_nan() || p > m { p } else { m });
        let min = progresses.fold(f64::NAN, |m, p| if m.is_nan() || p < m { p } else { m });
        let spread = (max - min) * (max - min) * 0.25;
        (py::round_to(penalty, 9), -total, py::round_to(spread, 9))
    }
}

/// `max(0.0, min(1.0, x))`.
fn clamp01(x: f64) -> f64 {
    let m = if x < 1.0 { x } else { 1.0 };
    if m > 0.0 { m } else { 0.0 }
}

fn infer_element(types: &[GemStatType]) -> GemElement {
    if types.contains(&GemStatType::Light) { GemElement::Cosmic } else { GemElement::Water }
}

fn infer_restriction(types: &[GemStatType]) -> Option<GemRestriction> {
    if types.contains(&GemStatType::PhysicalDamage) {
        Some(GemRestriction::Fierce)
    } else if types.contains(&GemStatType::MagicDamage) {
        Some(GemRestriction::Arcane)
    } else {
        None
    }
}

fn stat_type(v: &Value) -> Result<GemStatType, String> {
    lookup(v, GemStatType::from_value, GemStatType::PY_NAME)
}

fn evaluate_candidate(tier: GemTier, kind: GemType, level: i64, stats: &[Map<String, Value>]) -> Result<Candidate, String> {
    let types = stats.iter().map(|s| stat_type(s.get("type").ok_or("'type'")?)).collect::<Result<Vec<_>, String>>()?;
    let element = infer_element(&types);
    let restriction = infer_restriction(&types);
    let pr_increments_total = pr_increment_total(tier, level);
    let pr_bonus = if kind == GemType::Empowered { 100.0 } else { 0.0 };
    let mut power_rank = pr_bonus + (pr_increments_total * 3) as f64;
    let [pr_lo, pr_hi] = get_gem_pr_threshold(kind, tier);
    let (mut progress_total, mut container_total) = (0.0, 0i64);
    let mut per_stat = Vec::with_capacity(stats.len());
    let mut issues = Vec::new();

    for (stat, &st) in stats.iter().zip(&types) {
        let value = py::to_float(stat.get("value").ok_or("'value'")?)?;
        let extra = py::int(stat.get("extra_containers").ok_or("'extra_containers'")?)?;
        let containers = 1 + extra;
        let base = get_stat_base(kind, tier, st);
        let thresholds = get_stat_threshold(kind, tier, st);
        let (Some(base), Some([t0, t1])) = (base, thresholds) else {
            return Err("unsupported operand type(s) for /: 'float' and 'NoneType'".into());
        };
        if containers == 0 {
            return Err("division by zero".into());
        }
        let threshold_progress = ((value / base.f()) - pr_increments_total as f64) / containers as f64;
        let raw = (threshold_progress - t0.f()) / (t1 - t0).f();
        let display = clamp01(raw);
        let contribution = (pr_lo as f64 + (pr_hi - pr_lo) as f64 * display) * containers as f64;
        power_rank += contribution;
        progress_total += display * containers as f64;
        container_total += containers;
        let within = (-PROGRESS_TOLERANCE..=1.0 + PROGRESS_TOLERANCE).contains(&raw);
        if raw < -PROGRESS_TOLERANCE {
            issues.push(format!("{} is below the minimum possible value for this level and proc spread.", st.display_name()));
        } else if raw > 1.0 + PROGRESS_TOLERANCE {
            issues.push(format!("{} is above the maximum possible value for this level and proc spread.", st.display_name()));
        }
        per_stat.push(StatEval {
            kind: st,
            entered_value: value,
            extra_containers: extra,
            containers,
            progress: py::round_to(display, 4),
            quality_percent: py::round_to(display * 100.0, 2),
            pr_contribution: py::round_to(contribution, 2),
            within,
            raw_progress: py::round_to(raw, 4),
            threshold_progress: py::round_to(threshold_progress, 4),
            focus_plan: build_focus_plan(display, containers),
        });
    }
    let quality = if container_total != 0 { progress_total / container_total as f64 } else { 0.0 };
    Ok(Candidate { kind, element, restriction, quality, power_rank: py::round_int(power_rank)?, issues, stats: per_stat, level, tier })
}

/// `_build_candidate_with_distribution`.
fn candidate_with(tier: GemTier, kind: GemType, level: i64, stats: &[Map<String, Value>], distribution: &[i64]) -> Result<Candidate, String> {
    let normalized: Vec<Map<String, Value>> = stats
        .iter()
        .zip(distribution)
        .map(|(s, &d)| {
            let mut s = s.clone();
            s.insert("extra_containers".into(), json!(d));
            s
        })
        .collect();
    evaluate_candidate(tier, kind, level, &normalized)
}

/// `min(level, 15) // 5`.
fn available_extra(level: i64) -> i64 {
    level.min(15).div_euclid(5)
}

/// `_guess_distribution`: the proc spread whose values fit best.
fn guess_distribution(tier: GemTier, kind: GemType, level: i64, stats: &[Map<String, Value>]) -> Result<Vec<i64>, String> {
    let available = available_extra(level);
    let mut best: Option<(Score, Vec<i64>)> = None;
    for a in 0..4 {
        for b in 0..4 {
            for c in 0..4 {
                let total = a + b + c;
                if total > available {
                    continue;
                }
                let dist = vec![a, b, c];
                let score = candidate_with(tier, kind, level, stats, &dist)?.score(total);
                if best.as_ref().is_none_or(|(s, _)| score < *s) {
                    best = Some((score, dist));
                }
            }
        }
    }
    Ok(best.map(|(_, d)| d).unwrap_or_else(|| vec![0, 0, 0]))
}

fn get_or<'a>(data: &'a Map<String, Value>, key: &str, default: &'a Value) -> &'a Value {
    data.get(key).unwrap_or(default)
}

/// `GemTier(int(data.get("tier", MYSTIC)))`, `GemType(int(data.get("type", LESSER)))`.
fn tier_and_type(data: &Map<String, Value>) -> Result<(GemTier, GemType), String> {
    let tier = lookup(&json!(py::int(get_or(data, "tier", &json!(4)))?), GemTier::from_value, GemTier::PY_NAME)?;
    let kind = lookup(&json!(py::int(get_or(data, "type", &json!(1)))?), GemType::from_value, GemType::PY_NAME)?;
    Ok((tier, kind))
}

fn read_gem(data: &Map<String, Value>) -> Result<(GemTier, GemType, i64), String> {
    let (tier, kind) = tier_and_type(data)?;
    Ok((tier, kind, py::int(get_or(data, "level", &json!(1)))?))
}

/// The stats list, `len()`-checked like Python.
fn stats_payload(data: &Map<String, Value>, message: &str) -> Result<Result<Vec<Value>, Value>, String> {
    let items = py::items(get_or(data, "stats", &json!([])))?;
    if items.len() != 3 {
        return Ok(Err(Resp::fail(message, "GEM_EVALUATOR_INVALID_STATS").into()));
    }
    Ok(Ok(items))
}

/// The duplicate / Physical+Magic checks both endpoints run. Hands back the stats as
/// dicts once every check passed.
fn check_types(items: &[Value], extra_check: bool) -> Result<Result<Vec<Map<String, Value>>, Value>, String> {
    let mut selected = Vec::new();
    let mut stats = Vec::new();
    for item in items {
        let stat = py::as_dict(item)?;
        stats.push(stat.clone());
        let t = stat_type(&json!(py::int(get_or(stat, "type", &json!(0)))?))?;
        if selected.contains(&t) {
            return Ok(Err(Resp::fail("Gem stats must be unique.", "GEM_EVALUATOR_DUPLICATE_STATS").into()));
        }
        selected.push(t);
        if extra_check && py::int(get_or(stat, "extra_containers", &json!(0)))? < 0 {
            return Ok(Err(Resp::fail("Extra containers cannot be negative.", "GEM_EVALUATOR_INVALID_CONTAINERS").into()));
        }
    }
    if selected.contains(&GemStatType::PhysicalDamage) && selected.contains(&GemStatType::MagicDamage) {
        return Ok(Err(Resp::fail("Physical Damage and Magic Damage cannot be on the same gem.", "GEM_EVALUATOR_INVALID_COMBINATION").into()));
    }
    Ok(Ok(stats))
}

fn evaluate_gem(data: &Value) -> Result<Value, String> {
    let data = py::as_dict(data)?;
    let (tier, kind, level) = read_gem(data)?;
    let items = match stats_payload(data, "Exactly 3 stats are required.")? {
        Ok(items) => items,
        Err(resp) => return Ok(resp),
    };
    let available = available_extra(level);
    let should_guess = crate::args::truthy(get_or(data, "auto_guess_procs", &json!(false)));
    let mut stats = match check_types(&items, true)? {
        Ok(stats) => stats,
        Err(resp) => return Ok(resp),
    };
    let mut extra_total = 0;
    for s in &stats {
        extra_total += py::int(get_or(s, "extra_containers", &json!(0)))?;
    }
    let guessed = if should_guess || extra_total > available {
        let guessed = guess_distribution(tier, kind, level, &stats)?;
        for (s, &d) in stats.iter_mut().zip(&guessed) {
            s.insert("extra_containers".into(), json!(d));
        }
        guessed
    } else {
        stats.iter().map(|s| py::int(get_or(s, "extra_containers", &json!(0)))).collect::<Result<Vec<_>, _>>()?
    };
    let candidate = evaluate_candidate(tier, kind, level, &stats)?.json();
    let data = json!({
        "results": [candidate],
        "best_match": candidate,
        "available_extra_containers": available,
        "guessed_distribution": guessed,
    });
    Ok(Resp::ok(data).spread().into())
}

fn guess_gem_procs(data: &Value) -> Result<Value, String> {
    let data = py::as_dict(data)?;
    let (tier, kind, level) = read_gem(data)?;
    let items = match stats_payload(data, "Exactly 3 stats are required.")? {
        Ok(items) => items,
        Err(resp) => return Ok(resp),
    };
    let stats = match check_types(&items, false)? {
        Ok(stats) => stats,
        Err(resp) => return Ok(resp),
    };
    let guessed = guess_distribution(tier, kind, level, &stats)?;
    let preview = candidate_with(tier, kind, level, &stats, &guessed)?.json();
    let data = json!({
        "guessed_distribution": guessed,
        "preview": preview,
        "available_extra_containers": available_extra(level),
    });
    Ok(Resp::ok(data).spread().into())
}

fn guess_gem_stats(data: &Value) -> Result<Value, String> {
    let data = py::as_dict(data)?;
    let (tier, kind, level) = read_gem(data)?;
    let items = match stats_payload(data, "Exactly 3 stat values are required.")? {
        Ok(items) => items,
        Err(resp) => return Ok(resp),
    };
    let values = items.iter().map(|s| Ok(py::to_float(get_or(py::as_dict(s)?, "value", &json!(0)))?)).collect::<Result<Vec<f64>, String>>()?;

    let candidates = stat_restrictions(GemElement::Cosmic);
    let mut best: Option<(Score, Vec<i64>, Vec<i64>, Candidate)> = None;
    for perm in permutations(candidates.len(), values.len()) {
        let types: Vec<GemStatType> = perm.iter().map(|&i| candidates[i]).collect();
        if types.contains(&GemStatType::PhysicalDamage) && types.contains(&GemStatType::MagicDamage) {
            continue;
        }
        let payload: Vec<Map<String, Value>> = types
            .iter()
            .zip(&values)
            .map(|(t, v)| json!({"type": t.value(), "value": v, "extra_containers": 0}).as_object().cloned().unwrap_or_default())
            .collect();
        let dist = guess_distribution(tier, kind, level, &payload)?;
        let candidate = candidate_with(tier, kind, level, &payload, &dist)?;
        let score = candidate.score(dist.iter().sum());
        if best.as_ref().is_none_or(|(s, ..)| score < *s) {
            best = Some((score, types.iter().map(|t| t.value()).collect(), dist, candidate));
        }
    }
    let (types, dist, preview) = match best {
        Some((_, types, dist, c)) => (json!(types), json!(dist), c.json()),
        None => (json!([]), json!([0, 0, 0]), Value::Null),
    };
    let data = json!({"guessed_types": types, "guessed_distribution": dist, "preview": preview});
    Ok(Resp::ok(data).spread().into())
}

/// `itertools.permutations(range(n), k)`, in its order.
fn permutations(n: usize, k: usize) -> Vec<Vec<usize>> {
    fn go(n: usize, k: usize, cur: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if cur.len() == k {
            out.push(cur.clone());
            return;
        }
        for i in 0..n {
            if !cur.contains(&i) {
                cur.push(i);
                go(n, k, cur, out);
                cur.pop();
            }
        }
    }
    let mut out = Vec::new();
    if k <= n {
        go(n, k, &mut Vec::new(), &mut out);
    }
    out
}

fn evaluate_gem_simple(data: &Value) -> Result<Value, String> {
    let data = py::as_dict(data)?;
    let level = py::int(get_or(data, "level", &json!(1)))?;
    let power_rank = py::int(get_or(data, "power_rank", &json!(0)))?;
    let tier_filter = data.get("tier").filter(|v| !v.is_null());
    let type_filter = data.get("type").filter(|v| !v.is_null());
    let mut candidates: Vec<(bool, i64, i64, Value)> = Vec::new();

    for &tier in GemTier::ALL {
        if let Some(f) = tier_filter {
            if py::int(f)? != tier.value() {
                continue;
            }
        }
        for &kind in GemType::ALL {
            if let Some(f) = type_filter {
                if py::int(f)? != kind.value() {
                    continue;
                }
            }
            if level > get_gem_max_level(tier) {
                continue;
            }
            let mut partial = PartialGem { tier, kind, level, power_rank, containers: None };
            let mut containers = partial.default_container_count();
            for count in (3..=containers).rev() {
                let probe = PartialGem { containers: Some(count), ..partial.clone() };
                let (lo, hi) = probe.expected_power_rank_range();
                if lo <= power_rank && power_rank <= hi {
                    partial = probe;
                    containers = count;
                    break;
                }
            }
            let (min_pr, max_pr) = partial.expected_power_rank_range();
            let distance = if power_rank < min_pr {
                min_pr - power_rank
            } else if power_rank > max_pr {
                power_rank - max_pr
            } else {
                0
            };
            let progress = clamp01(partial.progress()?);
            let plan = build_focus_plan(progress, containers);
            let within = partial.is_within_expected_range();
            let entry = json!({
                "tier": tier.value(),
                "tier_name": tier.display_name(),
                "type": kind.value(),
                "type_name": kind.display_name(),
                "level": level,
                "power_rank": power_rank,
                "min_power_rank": min_pr,
                "max_power_rank": max_pr,
                "quality_percent": py::json_float(py::round_to(progress * 100.0, 2)),
                "is_within_range": within,
                "distance": distance,
                "containers": containers,
                "boosts": containers - 3,
                "focus_totals": plan.summary(),
            });
            candidates.push((!within, distance, tier.value(), entry));
        }
    }
    candidates.sort_by_key(|c| (c.0, c.1, c.2));
    let results: Vec<Value> = candidates.into_iter().map(|c| c.3).collect();
    let best = results.first().cloned().unwrap_or(Value::Null);
    Ok(Resp::ok(json!({"results": results, "best_match": best})).spread().into())
}

fn get_gem_stat_range(data: &Value) -> Result<Value, String> {
    let data = py::as_dict(data)?;
    let (tier, kind) = tier_and_type(data)?;
    let st =stat_type(&json!(py::int(get_or(data, "stat_type", &Value::Null))?))?;
    let level = py::int(get_or(data, "level", &json!(1)))?.max(1);
    let extra = py::int(get_or(data, "extra_containers", &json!(0)))?.max(0);
    let containers = 1 + extra;

    let element = match data.get("element").filter(|v| !v.is_null()) {
        Some(raw) => lookup(&json!(py::int(raw)?), GemElement::from_value, GemElement::PY_NAME)?,
        None => {
            let empty = json!([]);
            let companions = get_or(data, "companion_stat_types", &empty);
            let Value::Array(list) = companions else {
                return Err(match companions {
                    Value::String(_) => "can only concatenate str (not \"list\") to str".to_string(),
                    other => format!("unsupported operand type(s) for +: '{}' and 'list'", py::type_name(other)),
                });
            };
            let mut types: Vec<GemStatType> = list.iter().filter_map(|v| py::int(v).ok().and_then(GemStatType::from_value)).collect();
            types.push(st);
            infer_element(&types)
        }
    };

    let pr_increments_total = Int(pr_increment_total(tier, level));
    let thresholds = get_stat_threshold(kind, tier, st);
    let (Some(base), Some([t0, t1])) = (get_stat_base(kind, tier, st), thresholds) else {
        return Err("'NoneType' object is not subscriptable".into());
    };
    let containers_n = Int(containers);
    let min_value = base * (t0 * containers_n + pr_increments_total);
    let max_value = base * (t1 * containers_n + pr_increments_total);
    Ok(Resp::ok(json!({
        "stat_type": st.value(),
        "stat_display_name": st.display_name(),
        "element": element.value(),
        "containers": containers,
        "min_value": min_value.json(),
        "max_value": max_value.json(),
        "stat_base": base.json(),
        "thresholds": [t0.json(), t1.json()],
    }))
    .into())
}

fn simulate_next_focus(data: &Value) -> Result<Value, String> {
    let data = py::as_dict(data)?;
    let (tier, kind) = tier_and_type(data)?;
    let level = py::int(get_or(data, "level", &json!(1)))?.max(1);
    let items = match stats_payload(data, "Exactly 3 stats are required.")? {
        Ok(items) => items,
        Err(resp) => return Ok(resp),
    };
    let mut stats = Vec::new();
    for item in &items {
        let stat = py::as_dict(item)?;
        if !crate::args::truthy(get_or(stat, "type", &Value::Null)) {
            return Ok(Resp::fail("All three stat types are required.", "GEM_EVALUATOR_INVALID_STATS").into());
        }
        stats.push(stat.clone());
    }

    let baseline = evaluate_candidate(tier, kind, level, &stats)?;
    let baseline_quality = baseline.quality_percent();
    let baseline_pr = baseline.power_rank;
    let pr_increments_total = Int(pr_increment_total(tier, level));

    let mut sims: Vec<(f64, i64, Value)> = Vec::new();
    for (index, stat) in stats.iter().enumerate() {
        let st = stat_type(&json!(py::int(py::subscript(&Value::Object(stat.clone()), "type")?)?))?;
        let extra = py::int(get_or(stat, "extra_containers", &json!(0)))?;
        let containers = Int(1 + extra);
        let (Some(base), Some([_, t1])) = (get_stat_base(kind, tier, st), get_stat_threshold(kind, tier, st)) else {
            return Err("'NoneType' object is not subscriptable".into());
        };
        let maxed = base * (t1 * containers + pr_increments_total);
        let mut simulated = stats.clone();
        simulated[index].insert("value".into(), maxed.json());
        let sim = evaluate_candidate(tier, kind, level, &simulated)?;
        let quality_gain = py::round_to(sim.quality_percent() - baseline_quality, 2);
        let pr_gain = sim.power_rank - baseline_pr;
        sims.push((
            quality_gain,
            pr_gain,
            json!({
                "stat_index": index,
                "stat_type": st.value(),
                "stat_display_name": st.display_name(),
                "current_quality_percent": py::json_float(baseline.stats[index].quality_percent),
                "current_value": py::json_float(py::to_float(get_or(stat, "value", &json!(0)))?),
                "maxed_value": maxed.round(4).json(),
                "resulting_quality_percent": py::json_float(sim.quality_percent()),
                "resulting_power_rank": sim.power_rank,
                "quality_gain_percent": py::json_float(quality_gain),
                "pr_gain": pr_gain,
            }),
        ));
    }
    let first_max = |key: fn(&(f64, i64, Value)) -> f64| {
        let mut best: Option<&(f64, i64, Value)> = None;
        for s in &sims {
            if best.is_none_or(|b| key(s) > key(b)) {
                best = Some(s);
            }
        }
        best.map(|b| b.2.clone()).unwrap_or(Value::Null)
    };
    let best_quality = first_max(|s| s.0);
    let best_pr = first_max(|s| s.1 as f64);
    Ok(Resp::ok(json!({
        "baseline_quality_percent": py::json_float(baseline_quality),
        "baseline_power_rank": baseline_pr,
        "per_stat": sims.into_iter().map(|s| s.2).collect::<Vec<_>>(),
        "best_for_quality": best_quality,
        "best_for_power_rank": best_pr,
    }))
    .into())
}
