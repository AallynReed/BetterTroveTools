import traceback
import math
from itertools import permutations, product

import eel

from backend.response import resp, standardize_response
from models.trove.gem_bases import (get_empowered_gem_pr_threshold,
                                    get_gem_max_level,
                                    get_increment_power_rank_empowered,
                                    get_increment_power_rank_lesser,
                                    get_lesser_gem_pr_threshold,
                                    get_stat_base_empowered,
                                    get_stat_base_lesser,
                                    get_stat_threshold_empowered,
                                    get_stat_threshold_lesser)
from models.trove.gem_constants import (GEM_STAT_RESTRICTIONS, GemElement,
                                        GemRestriction, GemStatType, GemTier,
                                        GemType)
from models.trove.gems import PartialGem


FOCUS_OPTIONS = {
    "optimized_all": {
        "label": "Superior + Precise + Rough",
        "values": [12.5, 5.0, 2.5],
        "keys": ["superior", "precise", "rough"],
    },
    "optimized_precise_rough": {
        "label": "Precise + Rough",
        "values": [5.0, 2.5],
        "keys": ["precise", "rough"],
    },
    "rough_only": {
        "label": "Rough Only",
        "values": [2.5],
        "keys": ["rough"],
    },
}

FOCUS_RECIPES = {
    "rough": {
        "label": "Rough Focus",
        "materials": {
            "bound_brilliance": 1,
            "heart_of_darkness": 4,
            "flux": 1200,
        },
    },
    "precise": {
        "label": "Precise Focus",
        "materials": {
            "bound_brilliance": 1,
            "water_gem_dust": 3000,
            "air_gem_dust": 3000,
            "fire_gem_dust": 3000,
            "flux": 2000,
        },
    },
    "superior": {
        "label": "Superior Focus",
        "materials": {
            "bound_brilliance": 1,
            "diamond_dragonite": 30,
            "titan_soul": 3,
            "flux": 50000,
        },
    },
}


def _gem_pr_increment_total(gem_tier: GemTier, gem_type: GemType, level: int) -> int:
    increment_func = (
        get_increment_power_rank_lesser
        if gem_type == GemType.LESSER
        else get_increment_power_rank_empowered
    )
    return sum(increment_func(gem_tier, current_level) for current_level in range(1, level + 1))


def _infer_element(stat_types: list[GemStatType]) -> GemElement:
    return GemElement.COSMIC if GemStatType.LIGHT in stat_types else GemElement.WATER


def _infer_restriction(stat_types: list[GemStatType]) -> GemRestriction | None:
    if GemStatType.PHYSICAL_DAMAGE in stat_types:
        return GemRestriction.FIERCE
    if GemStatType.MAGIC_DAMAGE in stat_types:
        return GemRestriction.ARCANE
    return None


def _calculate_focus_counts(remaining_percent: float, option_key: str) -> dict:
    option = FOCUS_OPTIONS[option_key]
    counts = {key: 0 for key in ["superior", "precise", "rough"]}
    remaining_units = max(0, math.ceil((remaining_percent - 1e-9) / 2.5))
    unit_values = [int(round(value / 2.5)) for value in option["values"]]

    for focus_key, unit_value in zip(option["keys"], unit_values):
        counts[focus_key] = remaining_units // unit_value
        remaining_units %= unit_value

    if remaining_units > 0:
        smallest_key = option["keys"][-1]
        counts[smallest_key] += math.ceil(remaining_units / unit_values[-1])

    counts["total"] = counts["superior"] + counts["precise"] + counts["rough"]
    return counts


def _build_focus_plan(display_progress: float, containers: int) -> dict:
    current_percent = round(display_progress * 100, 2)
    remaining_percent = max(0.0, 100.0 - current_percent)
    per_container = {
        option_key: _calculate_focus_counts(remaining_percent, option_key)
        for option_key in FOCUS_OPTIONS
    }
    totals = {}
    for option_key, option in FOCUS_OPTIONS.items():
        container_counts = per_container[option_key]
        total_counts = {
            "superior": container_counts["superior"] * containers,
            "precise": container_counts["precise"] * containers,
            "rough": container_counts["rough"] * containers,
            "total": container_counts["total"] * containers,
        }
        recipe_totals = {}
        for focus_key in ["superior", "precise", "rough"]:
            focus_count = total_counts[focus_key]
            if focus_count <= 0:
                continue
            for material_key, amount in FOCUS_RECIPES[focus_key]["materials"].items():
                recipe_totals[material_key] = recipe_totals.get(material_key, 0) + amount * focus_count
        totals[option_key] = {
            "label": option["label"],
            **total_counts,
            "recipe_totals": recipe_totals,
        }
    return {
        "current_percent": current_percent,
        "remaining_percent": round(remaining_percent, 2),
        "per_container": per_container,
        "totals": totals,
    }


def _summarize_focus_totals(plan: dict) -> dict:
    return {
        option_key: {
            "key": option_key,
            "label": option["label"],
            **plan["totals"][option_key],
        }
        for option_key, option in FOCUS_OPTIONS.items()
    }


def _guess_stat_types_and_procs(
    gem_tier: GemTier,
    gem_type: GemType,
    level: int,
    stat_values: list[float],
):
    candidate_types = list(GEM_STAT_RESTRICTIONS[GemElement.COSMIC])
    best_assignment = None
    best_distribution = None
    best_candidate = None
    best_score = None

    for stat_types in permutations(candidate_types, len(stat_values)):
        if (
            GemStatType.PHYSICAL_DAMAGE in stat_types
            and GemStatType.MAGIC_DAMAGE in stat_types
        ):
            continue

        stats_payload = [
            {"type": stat_type.value, "value": stat_value, "extra_containers": 0}
            for stat_type, stat_value in zip(stat_types, stat_values)
        ]
        distribution = _guess_distribution(gem_tier, gem_type, level, stats_payload)
        candidate = _build_candidate_with_distribution(
            gem_tier, gem_type, level, stats_payload, distribution
        )
        score = _distribution_score(candidate)
        if best_score is None or score < best_score:
            best_score = score
            best_assignment = [stat_type.value for stat_type in stat_types]
            best_distribution = distribution
            best_candidate = candidate

    return best_assignment or [], best_distribution or [0, 0, 0], best_candidate


def _evaluate_gem_candidate(
    gem_tier: GemTier,
    gem_type: GemType,
    level: int,
    stats_payload: list[dict],
):
    stat_types = [GemStatType(stat["type"]) for stat in stats_payload]
    element = _infer_element(stat_types)
    restriction = _infer_restriction(stat_types)
    pr_increments_total = _gem_pr_increment_total(gem_tier, gem_type, level)
    pr_bonus = 100 if gem_type == GemType.EMPOWERED else 0
    estimated_power_rank = pr_bonus + pr_increments_total * 3
    pr_thresholds = (
        get_lesser_gem_pr_threshold(gem_tier, element)
        if gem_type == GemType.LESSER
        else get_empowered_gem_pr_threshold(gem_tier, element)
    )
    total_container_progress = 0.0
    total_containers = 0
    per_stat = []
    issues = []

    for stat_payload in stats_payload:
        stat_type = GemStatType(stat_payload["type"])
        stat_value = float(stat_payload["value"])
        extra_containers = int(stat_payload["extra_containers"])
        containers = 1 + extra_containers

        if gem_type == GemType.LESSER:
            stat_base = get_stat_base_lesser(gem_tier, element, stat_type)
            thresholds = get_stat_threshold_lesser(gem_tier, element, stat_type)
        else:
            stat_base = get_stat_base_empowered(gem_tier, element, stat_type)
            thresholds = get_stat_threshold_empowered(gem_tier, element, stat_type)

        threshold_progress = ((stat_value / stat_base) - pr_increments_total) / containers
        raw_progress = (threshold_progress - thresholds[0]) / (thresholds[1] - thresholds[0])
        display_progress = max(0.0, min(1.0, raw_progress))
        pr_contribution = (
            pr_thresholds[0] + (pr_thresholds[1] - pr_thresholds[0]) * display_progress
        ) * containers

        estimated_power_rank += pr_contribution
        total_container_progress += display_progress * containers
        total_containers += containers

        per_stat.append({
            "type": stat_type.value,
            "display_name": stat_type.display_name,
            "entered_value": stat_value,
            "extra_containers": extra_containers,
            "containers": containers,
            "progress": round(display_progress, 4),
            "quality_percent": round(display_progress * 100, 2),
            "estimated_pr_contribution": round(pr_contribution, 2),
            "is_within_range": -0.02 <= raw_progress <= 1.02,
            "raw_progress": round(raw_progress, 4),
            "threshold_progress": round(threshold_progress, 4),
            "focus_plan": _build_focus_plan(display_progress, containers),
        })

        if raw_progress < -0.02:
            issues.append(f"{stat_type.display_name} is below the minimum possible value for this level and proc spread.")
        elif raw_progress > 1.02:
            issues.append(f"{stat_type.display_name} is above the maximum possible value for this level and proc spread.")

    rounded_pr = round(estimated_power_rank)
    overall_quality = (total_container_progress / total_containers) if total_containers else 0.0
    gem_focus_totals = {}
    for option_key, option in FOCUS_OPTIONS.items():
        superior_total = sum(stat["focus_plan"]["totals"][option_key]["superior"] for stat in per_stat)
        precise_total = sum(stat["focus_plan"]["totals"][option_key]["precise"] for stat in per_stat)
        rough_total = sum(stat["focus_plan"]["totals"][option_key]["rough"] for stat in per_stat)
        recipe_totals = {}
        for stat in per_stat:
            for material_key, amount in stat["focus_plan"]["totals"][option_key]["recipe_totals"].items():
                recipe_totals[material_key] = recipe_totals.get(material_key, 0) + amount
        gem_focus_totals[option_key] = {
            "key": option_key,
            "label": option["label"],
            "superior": superior_total,
            "precise": precise_total,
            "rough": rough_total,
            "total": superior_total + precise_total + rough_total,
            "recipe_totals": recipe_totals,
        }
    return {
        "type": gem_type.value,
        "type_name": gem_type.display_name,
        "element": element.value,
        "element_name": element.display_name,
        "restriction": restriction.value if restriction else None,
        "restriction_name": restriction.display_name if restriction else "Any",
        "quality": round(overall_quality, 4),
        "quality_percent": round(overall_quality * 100, 2),
        "calculated_power_rank": rounded_pr,
        "has_issues": len(issues) > 0,
        "issues": issues,
        "focus_totals": gem_focus_totals,
        "stats": per_stat,
    }


def _build_candidate_with_distribution(
    gem_tier: GemTier,
    gem_type: GemType,
    level: int,
    stats_payload: list[dict],
    distribution: list[int],
):
    normalized_stats = []
    for stat_payload, extra_containers in zip(stats_payload, distribution):
        normalized = dict(stat_payload)
        normalized["extra_containers"] = extra_containers
        normalized_stats.append(normalized)
    return _evaluate_gem_candidate(gem_tier, gem_type, level, normalized_stats)


def _distribution_score(candidate: dict) -> tuple:
    raw_progress = [stat["raw_progress"] for stat in candidate["stats"]]
    clamped_progress = [stat["progress"] for stat in candidate["stats"]]
    out_of_range_penalty = sum(
        abs(progress - min(max(progress, 0.0), 1.0))
        for progress in raw_progress
    )
    spread_penalty = max(clamped_progress) - min(clamped_progress)
    overcap_penalty = sum(max(progress - 1.0, 0.0) for progress in raw_progress)
    undercap_penalty = sum(max(0.0 - progress, 0.0) for progress in raw_progress)
    return (
        round(out_of_range_penalty, 6),
        round(spread_penalty, 6),
        round(overcap_penalty + undercap_penalty, 6),
    )


def _guess_distribution(
    gem_tier: GemTier,
    gem_type: GemType,
    level: int,
    stats_payload: list[dict],
) -> list[int]:
    available_extra_containers = min(level, 15) // 5
    best_distribution = None
    best_score = None

    for distribution in product(range(4), repeat=3):
        if sum(distribution) != available_extra_containers:
            continue
        candidate = _build_candidate_with_distribution(
            gem_tier, gem_type, level, stats_payload, list(distribution)
        )
        score = _distribution_score(candidate)
        if best_score is None or score < best_score:
            best_score = score
            best_distribution = list(distribution)

    return best_distribution or [0, 0, 0]


@eel.expose
@standardize_response
def evaluate_gem(data):
    try:
        gem_tier = GemTier(int(data.get("tier", GemTier.MYSTIC.value)))
        gem_type = GemType(int(data.get("type", GemType.LESSER.value)))
        level = int(data.get("level", 1))
        stats_payload = data.get("stats", [])

        if len(stats_payload) != 3:
            return resp(False, error="Exactly 3 stats are required.", code="GEM_EVALUATOR_INVALID_STATS")

        available_extra_containers = min(level, 15) // 5
        selected_types = []
        extra_container_total = 0
        should_guess_procs = bool(data.get("auto_guess_procs", False))

        for stat in stats_payload:
            stat_type = GemStatType(int(stat.get("type", 0)))
            if stat_type in selected_types:
                return resp(False, error="Gem stats must be unique.", code="GEM_EVALUATOR_DUPLICATE_STATS")
            selected_types.append(stat_type)

            extra_containers = int(stat.get("extra_containers", 0))
            if extra_containers < 0:
                return resp(False, error="Extra containers cannot be negative.", code="GEM_EVALUATOR_INVALID_CONTAINERS")
            extra_container_total += extra_containers

        if GemStatType.PHYSICAL_DAMAGE in selected_types and GemStatType.MAGIC_DAMAGE in selected_types:
            return resp(False, error="Physical Damage and Magic Damage cannot be on the same gem.", code="GEM_EVALUATOR_INVALID_COMBINATION")

        if should_guess_procs or extra_container_total != available_extra_containers:
            guessed_distribution = _guess_distribution(gem_tier, gem_type, level, stats_payload)
            for index, extra_containers in enumerate(guessed_distribution):
                stats_payload[index]["extra_containers"] = extra_containers
        else:
            guessed_distribution = [int(stat.get("extra_containers", 0)) for stat in stats_payload]

        candidate = _evaluate_gem_candidate(gem_tier, gem_type, level, stats_payload)

        return resp(
            True,
            data={
                "results": [candidate],
                "best_match": candidate,
                "available_extra_containers": available_extra_containers,
                "guessed_distribution": guessed_distribution,
            },
            results=[candidate],
            best_match=candidate,
            available_extra_containers=available_extra_containers,
            guessed_distribution=guessed_distribution,
        )
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_EVALUATOR_FAILED")


@eel.expose
@standardize_response
def guess_gem_procs(data):
    try:
        gem_tier = GemTier(int(data.get("tier", GemTier.MYSTIC.value)))
        gem_type = GemType(int(data.get("type", GemType.LESSER.value)))
        level = int(data.get("level", 1))
        stats_payload = data.get("stats", [])

        if len(stats_payload) != 3:
            return resp(False, error="Exactly 3 stats are required.", code="GEM_EVALUATOR_INVALID_STATS")

        selected_types = []
        for stat in stats_payload:
            stat_type = GemStatType(int(stat.get("type", 0)))
            if stat_type in selected_types:
                return resp(False, error="Gem stats must be unique.", code="GEM_EVALUATOR_DUPLICATE_STATS")
            selected_types.append(stat_type)

        if GemStatType.PHYSICAL_DAMAGE in selected_types and GemStatType.MAGIC_DAMAGE in selected_types:
            return resp(False, error="Physical Damage and Magic Damage cannot be on the same gem.", code="GEM_EVALUATOR_INVALID_COMBINATION")

        guessed_distribution = _guess_distribution(gem_tier, gem_type, level, stats_payload)
        candidate = _build_candidate_with_distribution(
            gem_tier, gem_type, level, stats_payload, guessed_distribution
        )

        return resp(
            True,
            data={
                "guessed_distribution": guessed_distribution,
                "preview": candidate,
                "available_extra_containers": min(level, 15) // 5,
            },
            guessed_distribution=guessed_distribution,
            preview=candidate,
            available_extra_containers=min(level, 15) // 5,
        )
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_EVALUATOR_GUESS_FAILED")


@eel.expose
@standardize_response
def guess_gem_stats(data):
    try:
        gem_tier = GemTier(int(data.get("tier", GemTier.MYSTIC.value)))
        gem_type = GemType(int(data.get("type", GemType.LESSER.value)))
        level = int(data.get("level", 1))
        raw_stats = data.get("stats", [])

        if len(raw_stats) != 3:
            return resp(False, error="Exactly 3 stat values are required.", code="GEM_EVALUATOR_INVALID_STATS")

        stat_values = [float(stat.get("value", 0)) for stat in raw_stats]
        guessed_types, guessed_distribution, candidate = _guess_stat_types_and_procs(
            gem_tier, gem_type, level, stat_values
        )

        return resp(
            True,
            data={
                "guessed_types": guessed_types,
                "guessed_distribution": guessed_distribution,
                "preview": candidate,
            },
            guessed_types=guessed_types,
            guessed_distribution=guessed_distribution,
            preview=candidate,
        )
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_EVALUATOR_STAT_GUESS_FAILED")


@eel.expose
@standardize_response
def evaluate_gem_simple(data):
    try:
        level = int(data.get("level", 1))
        power_rank = int(data.get("power_rank", 0))
        tier_filter = data.get("tier")
        type_filter = data.get("type")
        candidates = []

        for gem_tier in GemTier:
            if tier_filter is not None and int(tier_filter) != gem_tier.value:
                continue
            for gem_type in GemType:
                if type_filter is not None and int(type_filter) != gem_type.value:
                    continue
                max_level = get_gem_max_level(gem_tier, gem_type)
                if level > max_level:
                    continue
                partial = PartialGem(
                    tier=gem_tier,
                    type=gem_type,
                    level=level,
                    power_rank=power_rank,
                )
                min_pr, max_pr = partial.expected_power_rank_range
                if power_rank < min_pr:
                    distance = min_pr - power_rank
                elif power_rank > max_pr:
                    distance = power_rank - max_pr
                else:
                    distance = 0
                progress = max(0.0, min(1.0, partial.progress))
                containers = min(level, 15) // 5 + 3
                focus_plan = _build_focus_plan(progress, containers)
                candidates.append({
                    "tier": gem_tier.value,
                    "tier_name": gem_tier.display_name,
                    "type": gem_type.value,
                    "type_name": gem_type.display_name,
                    "level": level,
                    "power_rank": power_rank,
                    "min_power_rank": min_pr,
                    "max_power_rank": max_pr,
                    "quality_percent": round(progress * 100, 2),
                    "is_within_range": partial.is_within_expected_range,
                    "distance": distance,
                    "focus_totals": _summarize_focus_totals(focus_plan),
                })

        candidates.sort(key=lambda item: (not item["is_within_range"], item["distance"], item["tier"]))
        best_match = candidates[0] if candidates else None
        return resp(True, data={"results": candidates, "best_match": best_match}, results=candidates, best_match=best_match)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_EVALUATOR_SIMPLE_FAILED")
