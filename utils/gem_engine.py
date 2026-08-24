import base64
import itertools
import json
import os
import re
from typing import Dict, List

from models.trove.builds import (BuildConfig, BuildType, Class, DamageType,
                                 StatName, TroveClass)
from utils.functions import get_attr

# Blessing of the Lilypad - the ally buff. Ally stat values in builds/ally.json
# are already the level-30 numbers, so the buff multiplies those directly.
# Measured per stat class, not per ally: damage and crit damage ride one 31%
# class, light is its own 15.5%, power rank takes nothing. Stability and
# Movement Speed have no measured multiplier yet, so they stay unbuffed.
LILYPAD_MULTIPLIERS = {
    "Light": 1.155,
    "Physical Damage": 1.31,
    "Magic Damage": 1.31,
    "Critical Damage": 1.31,
}


# Bounty Hunt - the Sundered Uplands boss buff, unlocked by the star chart but
# only live while the player is actually holding it, so it needs its own toggle
# rather than being folded into the chart's passive stats. Two nodes grant it and
# the Minor one overwrites the Major, so at most one is ever active.
BOUNTY_HUNT_NODES = ("Bounty Hunt Boon", "Bounty Hunt")


def _no_bounty_hunt() -> dict:
    return {"available": False, "name": None, "physical": 0.0, "magic": 0.0}


def _stat_value(stats: list, name: str) -> float:
    for stat in stats or []:
        if stat.get("name") == name:
            return stat.get("value") or 0.0
    return 0.0


def apply_lilypad(name: str, value: float, active: bool) -> float:
    """An ally's L30 stat value, with the Lilypad buff applied when active."""
    return value * LILYPAD_MULTIPLIERS.get(name, 1.0) if active else value


class StarChartParser:
    COMPACT_CODE_PREFIX = "SC:"
    ROOT_TO_ABBREV = {
        "combat": "c",
        "gathering": "g",
        "pve": "p",
    }
    ABBREV_TO_ROOT = {value: key for key, value in ROOT_TO_ABBREV.items()}

    def __init__(self, star_chart_raw_data: dict):
        """
        Takes the raw star_chart.json dictionary and builds a flat 
        O(1) lookup map for instant node resolution.
        """
        self.node_map = {}
        self.parent_map = {}
        if star_chart_raw_data:
            for constell in star_chart_raw_data.values():
                self._flatten_tree(constell)
        self.selectable_paths = sorted(
            path for path, node in self.node_map.items() if node.get("Type") != "Root"
        )
        self.path_to_id = {path: index for index, path in enumerate(self.selectable_paths)}
        self.bounty_nodes = {
            path: node for path, node in self.node_map.items()
            if node.get("Name") in BOUNTY_HUNT_NODES and node.get("Ability_Values")
        }

    def _flatten_tree(self, node: dict, parent_path: str = None):
        if "Path" in node:
            self.node_map[node["Path"]] = node
            self.parent_map[node["Path"]] = parent_path
        for child in node.get("Stars", []):
            self._flatten_tree(child, node.get("Path"))

    def _expand_terminal_path(self, path: str) -> set[str]:
        expanded = set()
        current_path = path

        while current_path and current_path in self.node_map:
            node = self.node_map[current_path]
            if node.get("Type") == "Root":
                break
            if current_path in expanded:
                break

            expanded.add(current_path)
            parent_path = self.parent_map.get(current_path)
            if not parent_path or self.node_map.get(parent_path, {}).get("Type") == "Root":
                break
            current_path = parent_path

        return expanded

    def _decode_compact_path(self, token: str) -> str | None:
        compact_token = str(token or "").strip().lower()
        if not compact_token:
            return None

        root_name = self.ABBREV_TO_ROOT.get(compact_token[0])
        if not root_name:
            return None

        segments = re.findall(r"[a-z]+|\d+", compact_token[1:])
        path = ".".join([root_name, *segments])
        node = self.node_map.get(path)
        if not node or node.get("Type") == "Root":
            return None
        return path

    def _decode_build_code(self, build_code: str) -> set[str]:
        compact_code = str(build_code or "").strip()
        if not compact_code:
            return set()

        if compact_code.startswith(self.COMPACT_CODE_PREFIX) or compact_code.startswith("v2:"):
            selected_paths = set()
            payload = compact_code.split(":", 1)[1]

            if "|" in payload:
                for token in payload.split("|"):
                    path = self._decode_compact_path(token)
                    if path:
                        selected_paths.update(self._expand_terminal_path(path))
                return selected_paths

            padded_payload = payload + ("=" * ((4 - len(payload) % 4) % 4))
            decoded_bytes = base64.urlsafe_b64decode(padded_payload.encode("utf-8"))

            for node_id in decoded_bytes:
                if 0 <= node_id < len(self.selectable_paths):
                    selected_paths.update(self._expand_terminal_path(self.selectable_paths[node_id]))

            return selected_paths

        decoded_string = base64.b64decode(compact_code).decode('utf-8')
        return {path for path in decoded_string.split('$') if path in self.node_map}

    def parse_build_code(self, build_code: str) -> dict:
        """
        Decodes the string, filters out overwritten nodes, and aggregates 
        only permanent passive stats.
        """
        result = {
            "stats": {},
            "abilities": set(),
            "ability_values": {}, # Kept separate for future buff-toggling UI
            "paths_count": 0,
            "bounty_hunt": _no_bounty_hunt(),
        }
        
        if not build_code or not self.node_map:
            return result

        try:
            selected_paths = self._decode_build_code(build_code)
        except Exception as e:
            print(f"Failed to decode Star Chart code: {e}")
            return result

        result["paths_count"] = len(selected_paths)

        # 1. Identify all Overwritten paths
        overwrites = set()
        for path in selected_paths:
            node = self.node_map.get(path)
            if node and "Overwrites" in node:
                overwrites.update(node["Overwrites"])

        # 2. Filter out the overwritten nodes
        active_paths = selected_paths - overwrites

        result["bounty_hunt"] = self._bounty_hunt(active_paths)

        # 3. Aggregate everything else
        for path in active_paths:
            node = self.node_map.get(path)
            if not node:
                continue

            # FIX: Only aggregate passive Stats. Ignore Ability_Values (procs) for base coefficient.
            passive_stats = node.get("Stats", [])
            
            for stat in passive_stats:
                name = stat.get("name")
                if not name:
                    continue

                raw_val = stat.get("value", 0)
                try:
                    val = float(raw_val) if raw_val is not None else 0.0
                except (TypeError, ValueError):
                    val = 0.0
                is_pct = stat.get("percentage", False)

                if name not in result["stats"]:
                    result["stats"][name] = {"flat": 0.0, "pct": 0.0}

                if is_pct:
                    result["stats"][name]["pct"] += val
                else:
                    result["stats"][name]["flat"] += val

            # Gather abilities for the UI summary
            if "Abilities" in node:
                result["abilities"].update(node["Abilities"])

        # Convert set to list for JSON serialization later if needed
        result["abilities"] = list(result["abilities"])
        return result

    def _bounty_hunt(self, active_paths: set) -> dict:
        """Which Bounty Hunt tier this chart unlocks, with the buff's own values.

        The Minor upgrade overwrites the Major boon, so ``active_paths`` already
        leaves at most one of them standing - no tie to break here.
        """
        for path in sorted(active_paths):
            node = self.bounty_nodes.get(path)
            if not node:
                continue
            values = node["Ability_Values"]
            return {
                "available": True,
                "name": node.get("Name"),
                "physical": _stat_value(values, "Physical Damage"),
                "magic": _stat_value(values, "Magic Damage"),
            }
        return _no_bounty_hunt()


class GemOptimizerEngine:
    def __init__(self, base_path: str = "web/assets/data"):
        self.base_path = base_path
        
        self.classes_data = self._load_json("classes.json")
        self.foods = self._load_json("builds/food.json")
        self.allies = self._load_json("builds/ally.json")
        
        face_dmg_data = self._load_json("builds/face_damage.json")
        self.face_damage = face_dmg_data.get("Face", 0) if face_dmg_data else 0
        
        self.gem_stats = self._load_json("mystic.json")
        
        # Initialize the robust Star Chart parser
        star_chart_raw = self._load_json("star_chart.json")
        self.star_parser = StarChartParser(star_chart_raw)

        self.classes = {}
        if self.classes_data:
            for trove_class in self.classes_data:
                self.classes[trove_class["name"]] = TroveClass(**trove_class)

    def _load_json(self, relative_path: str) -> dict:
        full_path = os.path.join(self.base_path, relative_path)
        try:
            with open(full_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError:
            return {}
        except json.JSONDecodeError:
            return {}

    def sum_file_values(self, relative_path: str) -> float:
        data = self._load_json(f"builds/{relative_path}.json")
        return sum(data.values()) if data else 0.0

    def generate_combinations(self, farm=False):
        first_set = [[i, 9 - i] for i in range(10)]
        second_set = [[i, 18 - i] for i in range(19)]
        third_set = [
            [x, y, z] for x in range(4) for y in range(4) for z in range(4)
            if x + y + z == 3 and (z == 3 if not farm else True)
        ]
        fourth_set = [
            [x, y, z] for x in range(7) for y in range(7) for z in range(7)
            if x + y + z == 6 and (z == 6 if not farm else True)
        ]
        return itertools.product(first_set, second_set, third_set, fourth_set)

    def calculate_gem_stats(self, config: BuildConfig, build):
        first, second, third = 0, 0, 0
        cosmic_first, cosmic_second = 0, 0

        if not self.gem_stats:
            return 0, 0, 0

        if config.build_type == BuildType.health:
            first_lesser = self.gem_stats["Lesser"]["Maximum Health"]
            first_empowered = self.gem_stats["Empowered"]["Maximum Health"]
            second_lesser = self.gem_stats["Lesser"]["Maximum Health %"]
            second_empowered = self.gem_stats["Empowered"]["Maximum Health %"]
        else:
            first_lesser = self.gem_stats["Lesser"]["Damage"]
            first_empowered = self.gem_stats["Empowered"]["Damage"]
            second_lesser = self.gem_stats["Lesser"]["Critical Damage"]
            second_empowered = self.gem_stats["Empowered"]["Critical Damage"]
            
        third_lesser = self.gem_stats["Lesser"]["Light"]
        third_empowered = self.gem_stats["Empowered"]["Light"]

        first += 3 * first_empowered[0] + 6 * first_lesser[0]
        second += 3 * second_empowered[0] + 6 * second_lesser[0]
        third += 1 * third_empowered[0] + 2 * third_lesser[0]
        cosmic_first += 1 * first_empowered[0] + 2 * first_lesser[0]
        cosmic_second += 1 * second_empowered[0] + 2 * second_lesser[0]

        first += first_empowered[1] * build[0][0]
        second += second_empowered[1] * build[0][1]
        first += first_lesser[1] * build[1][0]
        second += second_lesser[1] * build[1][1]
        
        cosmic_first += first_empowered[1] * build[2][0]
        cosmic_second += second_empowered[1] * build[2][1]
        third += third_empowered[1] * build[2][2]
        
        cosmic_first += first_lesser[1] * build[3][0]
        cosmic_second += second_lesser[1] * build[3][1]
        third += third_lesser[1] * build[3][2]

        first = (first + cosmic_first) * 1.1
        second = (second + cosmic_second) * 1.1
        third = third * 1.1
        
        return first, second, third

    def calculate_builds(self, config: BuildConfig) -> List[Dict]:
        if not self.classes:
            raise Exception("Class data not loaded. Please ensure classes.json exists.")

        self.selected_class = self.classes.get(config.character.value)
        self.selected_subclass = self.classes.get(config.subclass.value)
        
        damage_type = StatName.magic_damage if self.selected_class.damage_type == DamageType.magic else StatName.physical_damage

        if config.build_type in [BuildType.health]:
            first = self.sum_file_values("health") + get_attr(self.selected_class.stats, name=StatName("Maximum Health")).value
            second = self.sum_file_values("health_per") + get_attr(self.selected_class.stats, name=StatName("Maximum Health %")).value
            third, fourth, fifth, sixth = 0, 0, 100, 100
            damage_type = StatName.maximum_health
        else:
            first = self.sum_file_values("damage")
            second = self.sum_file_values("critical_damage")
            third = self.sum_file_values("light")
            fourth = self.sum_file_values("bonus_damage")
            fifth, sixth = 100, 100
            
            first += get_attr(self.selected_class.stats, name=damage_type).value
            second += get_attr(self.selected_class.stats, name=StatName("Critical Damage")).value
            
            if not config.no_face:
                first += self.face_damage
                
            first += self.sum_file_values(f"{damage_type.name}/dragons_damage") + self.sum_file_values("dragons_damage")
            second += self.sum_file_values("dragons_critical_damage")
            
            if config.food and config.food in self.foods:
                food_data = self.foods[config.food]
                for stat in food_data.get("stats", []):
                    if stat["name"] == damage_type.value:
                        if stat["percentage"]: fourth += stat["value"]
                        else: first += stat["value"]
                    if stat["name"] == StatName.critical_damage.value: second += stat["value"]
                    if stat["name"] == StatName.light.value: third += stat["value"]
                
            if config.ally and config.ally in self.allies:
                ally_data = self.allies[config.ally]
                for stat in ally_data.get("stats", []):
                    value = apply_lilypad(stat["name"], stat["value"], config.ally_buff)
                    if stat["name"] == damage_type.value:
                        if stat["percentage"]: fourth += value
                        else: first += value
                    if stat["name"] == StatName.critical_damage.value:
                        if stat["percentage"]: fifth += value
                        else: second += value
                    if stat["name"] == StatName.light.value: third += value

            second -= 48.1 * (3 - config.critical_damage_count)
            
            if Class.solarion in [config.character, config.subclass]: third += 140
            if damage_type == StatName.physical_damage and config.subclass in [Class.lunar_lancer]: first += 750
            if damage_type == StatName.magic_damage and config.subclass in [Class.ice_sage, Class.shadow_hunter]: first += 750
            if config.subclass in [Class.bard, Class.boomeranger]: second += 20
            
            if config.subclass_active:
                if config.subclass in [Class.bard]: fourth += 45; second += 45
                if config.subclass in [Class.gunslinger]: fourth += 5.5
                if config.subclass in [Class.lunar_lancer, Class.candy_barbarian]: fourth += 30
                
            if config.berserker_battler: third += 750
            if config.litany: sixth += 1

            # --- PARSED STAR CHART INTEGRATION ---
            if config.star_chart:
                parsed_chart = self.star_parser.parse_build_code(config.star_chart)
                chart_stats = parsed_chart["stats"]

                dmg_stat = chart_stats.get(damage_type.value, {})
                crit_stat = chart_stats.get("Critical Damage", {})
                light_stat = chart_stats.get("Light", {})

                # Apply Flats
                first += dmg_stat.get("flat", 0)
                second += crit_stat.get("flat", 0)
                third += light_stat.get("flat", 0)

                # Apply Percentages
                fourth += dmg_stat.get("pct", 0)
                fifth += crit_stat.get("pct", 0)
                sixth += light_stat.get("pct", 0)

                # The chart only unlocks Bounty Hunt; the buff itself is a 4h drop
                # from a boss, so it counts only when the player says it is up.
                bounty = parsed_chart["bounty_hunt"]
                if config.bounty_hunt and bounty["available"]:
                    fourth += bounty["magic" if damage_type == StatName.magic_damage else "physical"]

        # Rankings are decided several decimals below the display rounding, so
        # high precision widens every result field to 8 places instead of 1-2.
        precise = bool(config.high_precision)

        def rd(value, digits):
            return round(value, 8 if precise else digits)

        class_bonus = next((b.value for b in self.selected_class.bonuses if b.name == damage_type), None)

        raw_builds = []
        builder = self.generate_combinations(farm=config.build_type in [BuildType.farm])

        for build_tuple in builder:
            build = list(build_tuple)
            gem_first, gem_second, gem_third = self.calculate_gem_stats(config, build)
            
            cfirst = first + gem_first
            csecond = second + gem_second
            cthird = third + gem_third

            final = cfirst * (1 + fourth / 100)
            if class_bonus is not None:
                final *= 1 + (class_bonus / 100)
                
            coefficient = rd(final * (1 + (csecond * (fifth / 100)) / 100), 2)
            light_value = rd(cthird * (sixth / 100), 2)

            raw_builds.append([
                build, cfirst, csecond, light_value, fourth, fifth, final, class_bonus, coefficient
            ])

        raw_builds.sort(
            key=lambda x: ([abs(x[3] - config.light), -x[-1]] if config.light else -x[-1])
        )

        formatted_results = []
        for i, build_data in enumerate(raw_builds[:200]): 
            build_arrays = build_data[0]
            
            boosts = []
            for arr in build_arrays: boosts.extend(arr)
            
            if not config.light or (config.light and config.build_type in [BuildType.health]):
                del boosts[9] 
                del boosts[6] 
                
            if not config.light and config.build_type not in [BuildType.health]:
                boosts = boosts[:4]
                
            build_text = "/".join(str(x) for x in boosts[:4])
            if len(boosts) > 4:
                build_text += " + " + "/".join(str(x) for x in boosts[4:])

            formatted_results.append({
                "rank": i + 1,
                "layout": build_text,
                "base_dmg": rd(build_data[1], 2),
                "crit_dmg": rd(build_data[2], 1),
                "light": build_data[3],
                "bonus_dmg": rd(build_data[4], 8),
                "crit_bonus": rd(build_data[5] - 100, 8),
                "total_dmg": rd(build_data[6], 2),
                "class_bonus": build_data[7],
                "coefficient": build_data[8]
            })

        return formatted_results