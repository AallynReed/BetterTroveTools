import eel
from utils.gem_engine import GemOptimizerEngine
from models.trove.builds import BuildConfig

gem_engine = None
try:
    gem_engine = GemOptimizerEngine(base_path="web/assets/data")
    print(f"Gem Engine loaded {len(gem_engine.classes)} classes.")
except Exception as e:
    print(f"CRITICAL ERROR loading Gem Engine: {e}")

@eel.expose
def get_trove_classes():
    if not gem_engine:
        return []
    try:
        return [{"name": name, "value": cls.name.value} for name, cls in gem_engine.classes.items()]
    except Exception as e:
        print(f"Error serving classes: {e}")
        return []

@eel.expose
def get_food_data():
    if not gem_engine:
        return {}
    try:
        return gem_engine.foods
    except Exception as e:
        print(f"Error serving foods: {e}")
        return {}

@eel.expose
def get_ally_data():
    if not gem_engine:
        return {}
    try:
        return gem_engine.allies
    except Exception as e:
        print(f"Error serving allies: {e}")
        return {}

@eel.expose
def calculate_gem_builds(config_dict):
    if not gem_engine:
        raise Exception("Engine failed to initialize. Check console for path errors.")
    try:
        config = BuildConfig(**config_dict)
        return gem_engine.calculate_builds(config)
    except Exception as e:
        print(f"Math Error: {e}")
        raise e
    
@eel.expose
def parse_star_chart_code(base64_code):
    try:
        return gem_engine.star_parser.parse_build_code(base64_code)
    except Exception as e:
        print(f"Error parsing star chart for UI: {e}")
        return {"stats": {}, "abilities": []}