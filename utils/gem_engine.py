import json
import os
import itertools
import base64
from typing import List, Dict

from models.trove.builds import (
    Class,
    StatName,
    BuildConfig,
    BuildType,
    DamageType,
    TroveClass
)
from utils.functions import get_attr


class StarChartParser:
    def __init__(self, star_chart_raw_data: dict):
        """
        Takes the raw star_chart.json dictionary and builds a flat 
        O(1) lookup map for instant node resolution.
        """
        self.node_map = {}
        if star_chart_raw_data:
            for constell in star_chart_raw_data.values():
                self._flatten_tree(constell)

    def _flatten_tree(self, node: dict):
        if "Path" in node:
            self.node_map[node["Path"]] = node
        for child in node.get("Stars", []):
            self._flatten_tree(child)

    def parse_build_code(self, base64_code: str) -> dict:
        """
        Decodes the string, filters out overwritten nodes, and aggregates 
        only permanent passive stats.
        """
        result = {
            "stats": {}, 
            "abilities": set(),
            "ability_values": {} # Kept separate for future buff-toggling UI
        }
        
        if not base64_code or not self.node_map:
            return result

        try:
            decoded_string = base64.b64decode(base64_code).decode('utf-8')
            selected_paths = set(decoded_string.split('$'))
        except Exception as e:
            print(f"Failed to decode Star Chart code: {e}")
            return result

        # 1. Identify all Overwritten paths
        overwrites = set()
        for path in selected_paths:
            node = self.node_map.get(path)
            if node and "Overwrites" in node:
                overwrites.update(node["Overwrites"])

        # 2. Filter out the overwritten nodes
        active_paths = selected_paths - overwrites

        # 3. Aggregate everything else
        for path in active_paths:
            node = self.node_map.get(path)
            if not node:
                continue

            # FIX: Only aggregate passive Stats. Ignore Ability_Values (procs) for base coefficient.
            passive_stats = node.get("Stats", [])
            
            for stat in passive_stats:
                name = stat["name"]
                val = stat.get("value", 0)
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
        
        # Auto-Ally Fallback
        if config.ally == "boot_clown":
            if damage_type == StatName.magic_damage:
                config.ally = "phoenix_stars"
            else:
                config.ally = "spidermonkey_stars"
        
        if config.build_type in [BuildType.health]:
            first = self.sum_file_values("health") + get_attr(self.selected_class.stats, name=StatName("Maximum Health")).value
            second = self.sum_file_values("health_per") + get_attr(self.selected_class.stats, name=StatName("Maximum Health %")).value
            if self.selected_class.subclass in [Class.chloromancer]:
                second += 60
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
                    if stat["name"] == damage_type.value:
                        if stat["percentage"]: fourth += stat["value"]
                        else: first += stat["value"]
                    if stat["name"] == StatName.critical_damage.value:
                        if stat["percentage"]: fifth += stat["value"]
                        else: second += stat["value"]
                    if stat["name"] == StatName.light.value: third += stat["value"]

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
                print(f"Parsed Star Chart Stats: {chart_stats}")  # Debugging output

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

        raw_builds = []
        builder = self.generate_combinations(farm=config.build_type in [BuildType.farm])
        
        for build_tuple in builder:
            build = list(build_tuple)
            gem_first, gem_second, gem_third = self.calculate_gem_stats(config, build)
            
            cfirst = first + gem_first
            csecond = second + gem_second
            cthird = third + gem_third
            
            class_bonus = next((b.value for b in self.selected_class.bonuses if b.name == damage_type), None)
            
            final = cfirst * (1 + fourth / 100)
            if class_bonus is not None:
                final *= 1 + (class_bonus / 100)
                
            coefficient = round(final * (1 + (csecond * (fifth / 100)) / 100), 2)
            
            raw_builds.append([
                build, cfirst, csecond, int(cthird * (sixth / 100)), fourth, fifth, final, class_bonus, coefficient
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
                "base_dmg": round(build_data[1], 2),
                "crit_dmg": round(build_data[2], 1),
                "light": build_data[3],
                "bonus_dmg": build_data[4],
                "total_dmg": build_data[6],
                "class_bonus": build_data[7],
                "coefficient": build_data[8]
            })

        return formatted_results