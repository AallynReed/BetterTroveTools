from enum import Enum
from typing import Optional

from pydantic import BaseModel


class BuildType(Enum):
    light = "Light"
    farm = "Farm"
    health = "Health"


class Class(Enum):
    bard = "Bard"
    boomeranger = "Boomeranger"
    candy_barbarian = "Candy Barbarian"
    chloromancer = "Chloromancer"
    dino_tamer = "Dino Tamer"
    dracolyte = "Dracolyte"
    fae_trickster = "Fae Trickster"
    gunslinger = "Gunslinger"
    ice_sage = "Ice Sage"
    knight = "Knight"
    lunar_lancer = "Lunar Lancer"
    neon_ninja = "Neon Ninja"
    pirate_captain = "Pirate Captain"
    revenant = "Revenant"
    shadow_hunter = "Shadow Hunter"
    solarion = "Solarion"
    tomb_raiser = "Tomb Raiser"
    vanguardian = "Vanguardian"


class DamageType(Enum):
    magic = "Magic"
    physical = "Physical"


class Weapon(Enum):
    sword = "Sword"
    bow = "Bow"
    gun = "Gun"
    staff = "Staff"
    spear = "Spear"
    fist = "Fist"


class Attribute(Enum):
    infinite_attackspeed = "Infinite Attack Speed"


class StatName(Enum):
    magic_damage = "Magic Damage"
    physical_damage = "Physical Damage"
    maximum_health = "Maximum Health"
    maximum_health_per = "Maximum Health %"
    energy = "Energy"
    health_regen = "Health Regen"
    energy_regen = "Energy Regen"
    movement_speed = "Movement Speed"
    attack_speed = "Attack Speed"
    jump = "Jump"
    critical_hit = "Critical Hit"
    critical_damage = "Critical Damage"
    light = "Light"


class Stat(BaseModel):
    name: StatName
    value: Optional[float]
    percentage: bool


class AbilityType(Enum):
    active = "Active"
    passive = "Passive"
    upgrade = "Upgrade"


class AbilityStage(BaseModel):
    name: str
    base: float
    multiplier: float


class Ability(BaseModel):
    name: str
    icon: str
    type: AbilityType
    stages: list[AbilityStage]

    @property
    def icon_path(self):
        return f"images/abilities/{self.icon}.png"


class TroveClass(BaseModel):
    name: Class
    qualified_name: str
    shorts: list[str]
    damage_type: DamageType
    weapons: list[Weapon]
    attributes: list[Attribute]
    stats: list[Stat]
    bonuses: list[Stat]
    subclass: dict
    abilities: list[Ability] = []

    @property
    def image_path(self):
        return f"images/classes/{self.name.name}.png"

    @property
    def icon_path(self):
        return f"images/classes/icons/{self.name.name}.png"


class BuildConfig(BaseModel):
    build_type: BuildType = BuildType.light
    character: Class = Class.bard
    subclass: Class = Class.boomeranger
    food: str = "zephyr_rune"
    ally: str = "boot_clown"
    ally_buff: bool = True
    high_precision: bool = False
    berserker_battler: bool = False
    critical_damage_count: int = 3
    no_face: bool = False
    light: int = 0
    subclass_active: bool = False
    litany: bool = False
    bounty_hunt: bool = False        # ignored unless star_chart unlocks the node
    star_chart: Optional[str] = None

    def __eq__(self, other):
        if not isinstance(other, BuildConfig):
            return False
        keys = self.__fields__.keys()
        for key in keys:
            if getattr(self, key) != getattr(other, key):
                return False
        return True

    def __ne__(self, other):
        return not self.__eq__(other)


class HealthOptimizerConfig(BaseModel):
    character: Class = Class.bard
    star_chart: Optional[str] = None
    weapon_ch: bool = False
    ring_ch: bool = False
    hat_health: bool = False
    face_health: bool = False