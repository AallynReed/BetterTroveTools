from backend.gems_and_builds.gem_evaluator import evaluate_gem
from models.trove.gem_constants import GemStatType, GemTier, GemType


def test_evaluate_gem_returns_candidate_results():
    response = evaluate_gem({
        "type": GemType.LESSER.value,
        "tier": GemTier.MYSTIC.value,
        "level": 15,
        "stats": [
            {"type": GemStatType.PHYSICAL_DAMAGE.value, "value": 14616, "extra_containers": 1},
            {"type": GemStatType.CRITICAL_DAMAGE.value, "value": 180.3, "extra_containers": 1},
            {"type": GemStatType.CRITICAL_HIT.value, "value": 18.03, "extra_containers": 1},
        ],
    })

    assert response["success"] is True
    assert len(response["results"]) == 1
    assert response["best_match"]["type"] == GemType.LESSER.value
    assert response["best_match"]["calculated_power_rank"] > 0


def test_evaluate_gem_rejects_physical_and_magic_combo():
    response = evaluate_gem({
        "type": GemType.LESSER.value,
        "tier": GemTier.MYSTIC.value,
        "level": 1,
        "stats": [
            {"type": GemStatType.PHYSICAL_DAMAGE.value, "value": 1, "extra_containers": 0},
            {"type": GemStatType.MAGIC_DAMAGE.value, "value": 1, "extra_containers": 0},
            {"type": GemStatType.CRITICAL_DAMAGE.value, "value": 1, "extra_containers": 0},
        ],
    })

    assert response["success"] is False
    assert response["code"] == "GEM_EVALUATOR_INVALID_COMBINATION"
