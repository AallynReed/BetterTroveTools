from datetime import UTC, datetime
from enum import IntEnum
from random import choice, randint, random, sample
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, computed_field

from .gem_bases import (EMPOWERED_GENERATION_MODE, GEM_ABILITIES,
                        GEM_STAT_RESTRICTIONS, GEM_TYPE_RESTRICTIONS,
                        LESSER_GENERATION_MODE, MAGIC_GEM_STAT_POOL,
                        PHYSICAL_GEM_STAT_POOL, AugmentType, GemAbility,
                        GemElement, GemRestriction, GemStatType, GemTier,
                        GemType, GenerationType, get_augment_base,
                        get_empowered_gem_pr_threshold, get_gem_max_level,
                        get_increment_power_rank_empowered,
                        get_increment_power_rank_lesser,
                        get_lesser_gem_pr_threshold, get_stat_base_empowered,
                        get_stat_base_lesser, get_stat_threshold_empowered,
                        get_stat_threshold_lesser)


class Augment(BaseModel):
    type: AugmentType
    count: int = 0


class StatContainer(BaseModel):
    base: float = Field(default_factory=random)
    augments: List[Augment] = Field(default_factory=lambda: list(Augment(type=t) for t in AugmentType))

    def __str__(self):
        return f"StatContainer(value={round(self.value * 100, 2)}%)"

    def __repr__(self):
        return self.__str__()

    def add_augment(self, augment: AugmentType):
        for aug in self.augments:
            if aug.type == augment:
                aug.count += 1

    @computed_field
    @property
    def increase(self) -> float:
        increase = 0
        for aug in self.augments:
            base = get_augment_base(aug.type) / 100
            increase += base * aug.count
        return increase

    @computed_field
    @property
    def value(self) -> float:
        return min(self.base + self.increase, 1)

    @computed_field
    @property
    def real_value(self) -> float:
        return self.base + self.increase

class Stat(BaseModel):
    type: GemStatType
    containers: List[StatContainer] = Field(default_factory=list)
    locked: bool = False

    def __str__(self):
        return f"Stat(type={self.type.display_name}, locked={self.locked}, containers={self.containers})"

    def __repr__(self):
        return self.__str__()

    @computed_field
    @property
    def augmentation_progress(self) -> float:
        value = 0
        for container in self.containers:
            value += container.real_value
        return min(value / len(self.containers), 1)

    def add_augment(self, augment: AugmentType):
        if self.augmentation_progress == 1:
            return False
        for container in self.containers:
            if container.real_value >= 1:
                continue
            container.add_augment(augment)
            return True

    def get_lesser_stat_base(self, gem_tier, gem_element):
        return get_stat_base_lesser(gem_tier, gem_element, self.type)

    def get_empowered_stat_base(self, gem_tier, gem_element):
        return get_stat_base_empowered(gem_tier, gem_element, self.type)

    def get_lesser_thresholds(self, gem_tier, gem_element):
        return get_stat_threshold_lesser(gem_tier, gem_element, self.type)

    def get_empowered_thresholds(self, gem_tier, gem_element):
        return get_stat_threshold_empowered(gem_tier, gem_element, self.type)


class Gem(BaseModel):
    model_config = ConfigDict(use_enum_values=False)
    id: int = Field(default_factory=lambda: int(datetime.now(UTC).timestamp()*100))
    tier: GemTier
    type: GemType
    element: GemElement
    restriction: Optional[GemRestriction] = None
    ability: Optional[GemAbility] = None
    level: int
    stats: List[Stat]
    augmentation: Optional[float] = None

    def __str__(self):
        return f"Gem(id={self.id}, name={self.gem_name})"
    
    def __repr__(self):
        return self.__str__()

    @classmethod
    def create(cls, tier=None, type=None, element=None, restriction=None, augmentation=None, level=1, procs=None, generation=None):
        if not tier:
            tier = choice(list(GemTier))
        if not type:
            type = choice(list(GemType))
        if not element:
            element = choice(list(GemElement))
        else:
            element = GemElement(element)
        if augmentation is not None:
            aug = {"base": augmentation}
        else:
            aug = {}
        if type == GemType.LESSER:
            if restriction is None:
                restriction = choice(list(GemRestriction))
            else:
                restriction = GemRestriction(restriction)
        else:
            restriction = None
        extra_containers = min(level, 15) // 5
        if not generation:
            if restriction is None:
                gem_stat_pool = choice([PHYSICAL_GEM_STAT_POOL, MAGIC_GEM_STAT_POOL])
            else:
                gem_stat_pool = PHYSICAL_GEM_STAT_POOL if restriction == GemRestriction.FIERCE else MAGIC_GEM_STAT_POOL
            stat_types = sample(gem_stat_pool[element], 3)
            stats = [Stat(type=t) for t in stat_types]
            if element == GemElement.COSMIC:
                index = randint(0, 2)
                stats[index].type = GemStatType.LIGHT
                stats[index].locked = True
        else:
            stats = [Stat(type=t) for t in generation]
            for stat in stats:
                if stat.type == GemStatType.LIGHT:
                    stat.locked = True
        for stat in stats:
            stat.containers.append(StatContainer(**aug))
        if procs is None:
            for _ in range(extra_containers):
                index = randint(0, 2)
                stats[index].containers.append(StatContainer(**aug))
        else:
            print(procs)
            for i, proc in enumerate(procs):
                for _ in range(proc):
                    stats[i].containers.append(StatContainer(**aug))
        max_level = get_gem_max_level(tier, type)
        level = min(level, max_level)
        ability = choice(list(GEM_ABILITIES[element])) if type == GemType.EMPOWERED else None
        return cls(tier=tier, type=type, element=element, restriction=restriction, level=level, stats=stats, augmentation=augmentation, ability=ability)

    @property
    def augment_level(self):
        if self.augmentation is not None:
            return {"base": self.augmentation}
        else:
            return {}

    def has_stat(self, stat_type):
        return any(stat.type == stat_type for stat in self.stats)

    def reroll_stat_type(self, stat_type):
        in_use = [s.type for s in self.stats]
        if not self.has_stat(stat_type):
            return False
        for stat in self.stats:
            if stat.type == stat_type and not stat.locked:
                if self.restriction:
                    pool = PHYSICAL_GEM_STAT_POOL if self.restriction == GemRestriction.FIERCE else MAGIC_GEM_STAT_POOL
                else:
                    pool = GEM_STAT_RESTRICTIONS
                stat_types = pool[self.element]
                unused = [s for s in stat_types if s not in in_use]
                if GemStatType.PHYSICAL_DAMAGE in in_use:
                    if GemStatType.MAGIC_DAMAGE in unused:
                        unused.remove(GemStatType.MAGIC_DAMAGE)
                if GemStatType.MAGIC_DAMAGE in in_use:
                    if GemStatType.PHYSICAL_DAMAGE in unused:
                        unused.remove(GemStatType.PHYSICAL_DAMAGE)
                stat.type = choice(unused)
                return True
        return False

    def move_proc(self, stat_type):
        if not self.has_stat(stat_type):
            return False
        for stat in self.stats:
            if stat.type == stat_type:
                if len(stat.containers) == 1:
                    return False
                last_container = stat.containers[-1]
                stat.containers = stat.containers[:-1]
                other_stats = [s for s in self.stats if s.type != stat_type]
                other_stat = choice(other_stats)
                other_stat.containers.append(last_container)
                return True
        return False


    def level_up(self):
        max_level = get_gem_max_level(self.tier, self.type)
        if self.level < max_level:
            self.level += 1
        else:
            return False
        if self.level in [5, 10, 15]:
            index = randint(0, 2)
            self.stats[index].containers.append(StatContainer(**self.augment_level))
        return True
    
    @property
    def container_count(self):
        i = 0
        for stat in self.stats:
            for container in stat.containers:
                i += 1
        return i

    def set_level(self, level):
        if self.level == level:
            return False
        max_level = get_gem_max_level(self.tier, self.type)
        level = min(level, max_level)
        self.level = level
        final_containers = 3
        for l in range(5, 16, 5):
            final_containers += 1
        if self.container_count != final_containers:
            diff = final_containers - self.container_count
            if diff > 0:
                for _ in range(diff):
                    stat = choice(self.stats)
                    stat.containers.append(StatContainer(**self.augment_level))
            else:
                for _ in range(-diff):
                    stat = choice([s for s in self.stats if len(s.containers) > 1])
                    if stat.containers:
                        stat.containers.pop()
        return True

    @computed_field
    @property
    def ability_name(self) -> str:
        if self.ability:
            return self.ability.display_name
        return None

    @computed_field
    @property
    def gem_name(self) -> str:
        if self.type == GemType.LESSER:
            return f"{self.restriction.display_name} {self.tier.display_name} Gem"
        else:
            return self.ability_name

    @computed_field
    @property
    def is_max_level(self) -> bool:
        max_level = get_gem_max_level(self.tier, self.type)
        return self.level == max_level

    @computed_field
    @property
    def quality(self) -> float:
        total_value = 0
        count = 0
        for stat in self.stats:
            for container in stat.containers:
                total_value += container.value
                count += 1
        
        if count == 0: return 0.0
        return round((total_value / count) * 100, 1) / 100

    def get_lesser_power_rank_increment(self):
        return get_increment_power_rank_lesser(self.tier, self.level)

    def get_empowered_power_rank_increment(self):
        return get_increment_power_rank_empowered(self.tier, self.level)

    @computed_field
    @property
    def power_rank(self) -> int:
        # 1. Get the 'static' PR from levels (the guaranteed gains)
        # This part doesn't change regardless of gem quality
        level_pr = 0
        for l in range(2, self.level + 1):
            if self.type == GemType.LESSER:
                level_pr += get_increment_power_rank_lesser(self.tier, l)
            else:
                level_pr += get_increment_power_rank_empowered(self.tier, l)

        # 2. Get the 'variable' PR from stats (Base rolls + Procs)
        # Each container is a "roll" of [min_base to max_base]
        if self.type == GemType.LESSER:
            thresholds = get_lesser_gem_pr_threshold(self.tier, self.element)
        else:
            thresholds = get_empowered_gem_pr_threshold(self.tier, self.element)
        
        min_base_pr = thresholds[0]
        diff = thresholds[1] - thresholds[0]
        
        variable_pr = 0
        for stat in self.stats:
            for container in stat.containers:
                # PR per container = Min + (Percentage * Range)
                variable_pr += min_base_pr + (container.value * diff)
                
        return round(level_pr + variable_pr)

    @computed_field
    @property
    def stat_values(self) -> List[dict]:
        calculated = []
        pr_increments = 0
        for level in range(1, self.level + 1):
            if self.type == GemType.LESSER:
                pr_increments += get_increment_power_rank_lesser(self.tier, level)
            else:
                pr_increments += get_increment_power_rank_empowered(self.tier, level)
        for stat in self.stats:
            if self.type == GemType.LESSER:
                stat_base = stat.get_lesser_stat_base(self.tier, stat)
                thresholds = stat.get_lesser_thresholds(self.tier, self.element)
            else:
                stat_base = stat.get_empowered_stat_base(self.tier, stat)
                thresholds = stat.get_empowered_thresholds(self.tier, self.element)
            progress = thresholds[0] + (thresholds[1] - thresholds[0]) * stat.augmentation_progress
            stat_value = stat_base * progress * len(stat.containers)
            stat_value += stat_base * pr_increments
            calculated.append({stat.type.display_name: stat_value})
        return calculated


class PartialGem(BaseModel):
    tier: GemTier
    type: GemType
    level: int
    power_rank: int

    @computed_field
    @property
    def power_rank_thresholds(self) -> tuple:
        if self.type == GemType.LESSER:
            return get_lesser_gem_pr_threshold(self.tier, GemElement.WATER)
        else:
            return get_empowered_gem_pr_threshold(self.tier, GemElement.WATER)
        
    def get_increment_power_rank(self, level):
        if self.type == GemType.LESSER:
            return get_increment_power_rank_lesser(self.tier, level)
        else:
            return get_increment_power_rank_empowered(self.tier, level)

    @computed_field
    @property
    def expected_power_rank_range(self) -> tuple:
        container_count = min(self.level, 15) // 5 + 3
        thresholds = self.power_rank_thresholds
        min_pr = thresholds[0] * container_count
        max_pr = thresholds[1] * container_count
        if self.type == GemType.EMPOWERED:
            min_pr += 100
            max_pr += 100
        for level in range(1, self.level + 1):
            pr_increment = self.get_increment_power_rank(level)
            min_pr += pr_increment * 3
            max_pr += pr_increment * 3
        return (round(min_pr), round(max_pr))

    @computed_field
    @property
    def is_within_expected_range(self) -> bool:
        min_pr, max_pr = self.expected_power_rank_range
        return min_pr <= self.power_rank <= max_pr
    
    @computed_field
    @property
    def progress(self) -> float:
        min_pr, max_pr = self.expected_power_rank_range
        if self.power_rank < min_pr:
            return -1.0
        elif self.power_rank > max_pr:
            return 1.0
        else:
            return (self.power_rank - min_pr) / (max_pr - min_pr)
