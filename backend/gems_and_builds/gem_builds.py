import eel
from pathlib import Path
from utils.gem_engine import GemOptimizerEngine
from models.trove.builds import BuildConfig
from backend.response import resp, standardize_response

try:
    import tkinter as tk
    from tkinter import filedialog
except Exception:  # python3-tk not installed (common on minimal Linux setups)
    tk = None
    filedialog = None

gem_engine = None
try:
    gem_engine = GemOptimizerEngine(base_path="web/assets/data")
    print(f"Gem Engine loaded {len(gem_engine.classes)} classes.")
except Exception as e:
    print(f"CRITICAL ERROR loading Gem Engine: {e}")

@eel.expose
@standardize_response
def get_trove_classes():
    if not gem_engine:
        return resp(False, data=[], error="Gem engine unavailable.", code="ENGINE_NOT_READY")
    try:
        classes = [{"name": name, "value": cls.name.value} for name, cls in gem_engine.classes.items()]
        return resp(True, data=classes, classes=classes)
    except Exception as e:
        print(f"Error serving classes: {e}")
        return resp(False, data=[], classes=[], error=str(e), code="GET_CLASSES_FAILED")

@eel.expose
@standardize_response
def get_food_data():
    if not gem_engine:
        return resp(False, data={}, error="Gem engine unavailable.", code="ENGINE_NOT_READY")
    try:
        foods = gem_engine.foods
        return resp(True, data=foods, **foods)
    except Exception as e:
        print(f"Error serving foods: {e}")
        return resp(False, data={}, error=str(e), code="GET_FOODS_FAILED")

@eel.expose
@standardize_response
def get_ally_data():
    if not gem_engine:
        return resp(False, data={}, error="Gem engine unavailable.", code="ENGINE_NOT_READY")
    try:
        allies = gem_engine.allies
        return resp(True, data=allies, **allies)
    except Exception as e:
        print(f"Error serving allies: {e}")
        return resp(False, data={}, error=str(e), code="GET_ALLIES_FAILED")

@eel.expose
@standardize_response
def calculate_gem_builds(config_dict):
    if not gem_engine:
        return resp(False, error="Engine failed to initialize. Check console for path errors.", code="ENGINE_NOT_READY")
    try:
        config = BuildConfig(**config_dict)
        builds = gem_engine.calculate_builds(config)
        if isinstance(builds, dict):
            return resp(True, data=builds, **builds)
        return resp(True, data={"builds": builds}, builds=builds)
    except Exception as e:
        print(f"Math Error: {e}")
        return resp(False, error=str(e), code="CALCULATE_GEM_BUILDS_FAILED")
    
@eel.expose
@standardize_response
def save_gem_builds_csv(csv_text, default_file_name="gem_builds_export.csv"):
    """Native Save As dialog for the Gem Builds CSV export. Desktop only — the
    web/Android builds fall back to a browser download (see gem_builds.js)."""
    if filedialog is None:
        return resp(False, error="No native file dialog is available on this system.",
                    code="FILE_DIALOG_UNAVAILABLE")
    if not isinstance(csv_text, str) or not csv_text.strip():
        return resp(False, error="There is nothing to export.", code="EMPTY_EXPORT")

    root = tk.Tk()
    root.attributes('-topmost', True)
    root.withdraw()
    save_path_str = filedialog.asksaveasfilename(
        title="Export Gem Builds As...",
        initialfile=default_file_name or "gem_builds_export.csv",
        defaultextension=".csv",
        filetypes=[("CSV Files", "*.csv"), ("All Files", "*.*")]
    )
    root.destroy()

    if not save_path_str:
        return {"success": False, "canceled": True}

    try:
        # utf-8-sig so Excel picks up the encoding without a manual import step.
        Path(save_path_str).write_text(csv_text, encoding="utf-8-sig", newline="")
        return {"success": True, "path": save_path_str}
    except Exception as e:
        print(f"Error saving gem builds CSV: {e}")
        return resp(False, error=str(e), code="SAVE_GEM_BUILDS_CSV_FAILED")


@eel.expose
@standardize_response
def parse_star_chart_code(base64_code):
    try:
        parsed = gem_engine.star_parser.parse_build_code(base64_code)
        if isinstance(parsed, dict):
            return resp(True, data=parsed, **parsed)
        return resp(True, data={"result": parsed}, result=parsed)
    except Exception as e:
        print(f"Error parsing star chart for UI: {e}")
        return resp(False, data={"stats": {}, "abilities": []}, stats={}, abilities=[], error=str(e), code="PARSE_STAR_CHART_CODE_FAILED")