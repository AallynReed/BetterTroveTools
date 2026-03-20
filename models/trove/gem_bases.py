from .gem_constants import (EMPOWERED_GENERATION_MODE, GEM_ABILITIES,
                            GEM_STAT_RESTRICTIONS, GEM_TYPE_RESTRICTIONS,
                            LESSER_GENERATION_MODE, MAGIC_GEM_STAT_POOL,
                            PHYSICAL_GEM_STAT_POOL, AugmentType, GemAbility,
                            GemElement, GemRestriction, GemStatType, GemTier,
                            GemType, GenerationType)


def get_gem_max_level(gem_tier, gem_type):
    match gem_tier, gem_type:
        case GemTier.RADIANT, _:
            return 23
        case GemTier.STELLAR, _:
            return 25
        case GemTier.CRYSTAL, _:
            return 30
        case GemTier.MYSTIC, _:
            return 35
    return None


def get_level_pr_increment(level, gem_base):
    match level:
        case 1 | 5 | 10 | 15:
            return 0
        case _ if level > 15 and level % 5 == 0:
            return gem_base * 5
        case _ if 1 < level < 15:
            return gem_base
        case _ if level > 15:
            return gem_base * 2
    return None


def get_increment_power_rank_lesser(gem_tier, level):
    match gem_tier:
        case GemTier.RADIANT:
            return get_level_pr_increment(level, 3)
        case GemTier.STELLAR:
            return get_level_pr_increment(level, 5)
        case GemTier.CRYSTAL:
            return get_level_pr_increment(level, 7)
        case GemTier.MYSTIC:
            return get_level_pr_increment(level, 9)
    return None


def get_increment_power_rank_empowered(gem_tier, level):
    match gem_tier:
        case GemTier.RADIANT:
            return get_level_pr_increment(level, 3)
        case GemTier.STELLAR:
            return get_level_pr_increment(level, 5)
        case GemTier.CRYSTAL:
            return get_level_pr_increment(level, 7)
        case GemTier.MYSTIC:
            return get_level_pr_increment(level, 9)
    return None


def get_stat_base_lesser(
    gem_tier: GemTier, gem_element: GemElement, gem_stat_type: GemStatType
):
    match gem_tier, gem_element, gem_stat_type:
        case (
            GemTier.RADIANT | GemTier.STELLAR,
            _,
            GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE,
        ):
            return 14
        case GemTier.RADIANT | GemTier.STELLAR, _, GemStatType.CRITICAL_DAMAGE:
            return 0.2
        case GemTier.RADIANT | GemTier.STELLAR, _, GemStatType.CRITICAL_HIT:
            return 0.02
        case GemTier.RADIANT | GemTier.STELLAR, _, GemStatType.MAX_HEALTH_BONUS:
            return 0.5
        case GemTier.RADIANT | GemTier.STELLAR, _, GemStatType.MAX_HEALTH:
            return 50
        case GemTier.RADIANT | GemTier.STELLAR, _, GemStatType.LIGHT:
            return 1
        case GemTier.CRYSTAL, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return 16
        case GemTier.CRYSTAL, _, GemStatType.CRITICAL_DAMAGE:
            return 3 / 14
        case GemTier.CRYSTAL, _, GemStatType.CRITICAL_HIT:
            return 0.3 / 14
        case GemTier.CRYSTAL, _, GemStatType.MAX_HEALTH_BONUS:
            return 0.5
        case GemTier.CRYSTAL, _, GemStatType.MAX_HEALTH:
            return 50
        case GemTier.CRYSTAL, _, GemStatType.LIGHT:
            return 5 / 7
        case GemTier.MYSTIC, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return 168 / 9
        case GemTier.MYSTIC, _, GemStatType.CRITICAL_DAMAGE:
            return 2.5 / 9
        case GemTier.MYSTIC, _, GemStatType.CRITICAL_HIT:
            return 0.25 / 9
        case GemTier.MYSTIC, _, GemStatType.MAX_HEALTH_BONUS:
            return 5.25 / 9
        case GemTier.MYSTIC, _, GemStatType.MAX_HEALTH:
            return 525 / 9
        case GemTier.MYSTIC, _, GemStatType.LIGHT:
            return 5 / 9
    return None


def get_stat_base_empowered(
    gem_tier: GemTier, gem_element: GemElement, gem_stat_type: GemStatType
):
    match gem_tier, gem_element, gem_stat_type:
        case (
            GemTier.RADIANT | GemTier.STELLAR,
            _,
            GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE,
        ):
            return 14
        case GemTier.RADIANT | GemTier.STELLAR, _, GemStatType.CRITICAL_DAMAGE:
            return 0.2
        case GemTier.RADIANT | GemTier.STELLAR, _, GemStatType.CRITICAL_HIT:
            return 0.02
        case GemTier.RADIANT | GemTier.STELLAR, _, GemStatType.MAX_HEALTH_BONUS:
            return 0.5
        case GemTier.RADIANT | GemTier.STELLAR, _, GemStatType.MAX_HEALTH:
            return 50
        case GemTier.RADIANT | GemTier.STELLAR, _, GemStatType.LIGHT:
            return 1
        case GemTier.CRYSTAL, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return 16
        case GemTier.CRYSTAL, _, GemStatType.CRITICAL_DAMAGE:
            return 3 / 14
        case GemTier.CRYSTAL, _, GemStatType.CRITICAL_HIT:
            return 0.3 / 14
        case GemTier.CRYSTAL, _, GemStatType.MAX_HEALTH_BONUS:
            return 0.5
        case GemTier.CRYSTAL, _, GemStatType.MAX_HEALTH:
            return 50
        case GemTier.CRYSTAL, _, GemStatType.LIGHT:
            return 5 / 7
        case GemTier.MYSTIC, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return 28
        case GemTier.MYSTIC, _, GemStatType.CRITICAL_DAMAGE:
            return 2.5 / 9
        case GemTier.MYSTIC, _, GemStatType.CRITICAL_HIT:
            return 0.25 / 9
        case GemTier.MYSTIC, _, GemStatType.MAX_HEALTH_BONUS:
            return 5.25 / 9
        case GemTier.MYSTIC, _, GemStatType.MAX_HEALTH:
            return 525 / 9
        case GemTier.MYSTIC, _, GemStatType.LIGHT:
            return 5 / 9
    return None


def get_stat_threshold_lesser(
    gem_tier: GemTier, gem_element: GemElement, gem_stat_type: GemStatType
):
    match gem_tier, gem_element, gem_stat_type:
        case GemTier.RADIANT, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return [85, 113]
        case GemTier.RADIANT, _, GemStatType.CRITICAL_DAMAGE:
            return [85, 113]
        case GemTier.RADIANT, _, GemStatType.CRITICAL_HIT:
            return [85, 113]
        case GemTier.RADIANT, _, GemStatType.MAX_HEALTH_BONUS:
            return [85, 113]
        case GemTier.RADIANT, _, GemStatType.MAX_HEALTH:
            return [85, 113]
        case GemTier.RADIANT, _, GemStatType.LIGHT:
            return [85, 113]
        case GemTier.STELLAR, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return [150, 200]
        case GemTier.STELLAR, _, GemStatType.CRITICAL_DAMAGE:
            return [150, 200]
        case GemTier.STELLAR, _, GemStatType.CRITICAL_HIT:
            return [150, 200]
        case GemTier.STELLAR, _, GemStatType.MAX_HEALTH_BONUS:
            return [150, 200]
        case GemTier.STELLAR, _, GemStatType.MAX_HEALTH:
            return [150, 200]
        case GemTier.STELLAR, _, GemStatType.LIGHT:
            return [150, 200]
        case GemTier.CRYSTAL, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return [210, 280]
        case GemTier.CRYSTAL, _, GemStatType.CRITICAL_DAMAGE:
            return [560 / 3, 770 / 3]
        case GemTier.CRYSTAL, _, GemStatType.CRITICAL_HIT:
            return [560 / 3, 770 / 3]
        case GemTier.CRYSTAL, _, GemStatType.MAX_HEALTH_BONUS:
            return [245, 315]
        case GemTier.CRYSTAL, _, GemStatType.MAX_HEALTH:
            return [245, 315]
        case GemTier.CRYSTAL, _, GemStatType.LIGHT:
            return [280, 385]
        case GemTier.MYSTIC, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return [270, 360]
        case GemTier.MYSTIC, _, GemStatType.CRITICAL_DAMAGE:
            return [187.2, 297]
        case GemTier.MYSTIC, _, GemStatType.CRITICAL_HIT:
            return [187.2, 297]
        case GemTier.MYSTIC, _, GemStatType.MAX_HEALTH_BONUS:
            return [315, 405]
        case GemTier.MYSTIC, _, GemStatType.MAX_HEALTH:
            return [315, 405]
        case GemTier.MYSTIC, _, GemStatType.LIGHT:
            return [495, 585]
    return None


def get_stat_threshold_empowered(
    gem_tier: GemTier, gem_element: GemElement, gem_stat_type: GemStatType
):
    match gem_tier, gem_element, gem_stat_type:
        case GemTier.RADIANT, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return [113, 150]
        case GemTier.RADIANT, _, GemStatType.CRITICAL_DAMAGE:
            return [113, 150]
        case GemTier.RADIANT, _, GemStatType.CRITICAL_HIT:
            return [113, 150]
        case GemTier.RADIANT, _, GemStatType.MAX_HEALTH_BONUS:
            return [113, 150]
        case GemTier.RADIANT, _, GemStatType.MAX_HEALTH:
            return [113, 150]
        case GemTier.RADIANT, _, GemStatType.LIGHT:
            return [113, 150]
        case GemTier.STELLAR, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return [200, 266]
        case GemTier.STELLAR, _, GemStatType.CRITICAL_DAMAGE:
            return [200, 266]
        case GemTier.STELLAR, _, GemStatType.CRITICAL_HIT:
            return [200, 266]
        case GemTier.STELLAR, _, GemStatType.MAX_HEALTH_BONUS:
            return [200, 266]
        case GemTier.STELLAR, _, GemStatType.MAX_HEALTH:
            return [200, 266]
        case GemTier.STELLAR, _, GemStatType.LIGHT:
            return [200, 266]
        case GemTier.CRYSTAL, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return [245, 350]
        case GemTier.CRYSTAL, _, GemStatType.CRITICAL_DAMAGE:
            return [700 / 3, 910 / 3]
        case GemTier.CRYSTAL, _, GemStatType.CRITICAL_HIT:
            return [700 / 3, 910 / 3]
        case GemTier.CRYSTAL, _, GemStatType.MAX_HEALTH_BONUS:
            return [315, 385]
        case GemTier.CRYSTAL, _, GemStatType.MAX_HEALTH:
            return [315, 385]
        case GemTier.CRYSTAL, _, GemStatType.LIGHT:
            return [350, 420]
        case GemTier.MYSTIC, _, GemStatType.PHYSICAL_DAMAGE | GemStatType.MAGIC_DAMAGE:
            return [210, 300]
        case GemTier.MYSTIC, _, GemStatType.CRITICAL_DAMAGE:
            return [252, 342]
        case GemTier.MYSTIC, _, GemStatType.CRITICAL_HIT:
            return [252, 342]
        case GemTier.MYSTIC, _, GemStatType.MAX_HEALTH_BONUS:
            return [405, 495]
        case GemTier.MYSTIC, _, GemStatType.MAX_HEALTH:
            return [405, 495]
        case GemTier.MYSTIC, _, GemStatType.LIGHT:
            return [495, 630]
    return None


def get_lesser_gem_pr_threshold(
    gem_tier: GemTier,
    gem_element: GemElement,
):
    match gem_tier, gem_element:
        case GemTier.RADIANT, _:
            return [85, 113]
        case GemTier.STELLAR, _:
            return [150, 200]
        case GemTier.CRYSTAL, _:
            return [175, 250]
        case GemTier.MYSTIC, _:
            return [200, 260]
    return None


def get_empowered_gem_pr_threshold(
    gem_tier: GemTier,
    gem_element: GemElement,
):
    match gem_tier, gem_element:
        case GemTier.RADIANT, _:
            return [113, 150]
        case GemTier.STELLAR, _:
            return [200, 266]
        case GemTier.CRYSTAL, _:
            return [220, 280]
        case GemTier.MYSTIC, _:
            return [240, 300]
    return None

def get_augment_base(augment: AugmentType):
    match augment:
        case AugmentType.ROUGH:
            return 2.5
        case AugmentType.PRECISE:
            return 5
        case AugmentType.SUPERIOR:
            return 12.5
    return None

def get_augment_power(augment: AugmentType, container_count: int):
    match augment:
        case AugmentType.ROUGH:
            return 2.5 / container_count
        case AugmentType.PRECISE:
            return 5 / container_count
        case AugmentType.SUPERIOR:
            return 12.5 / container_count
    return None