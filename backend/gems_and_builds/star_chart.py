import json
import os
from math import cos, radians, sin
from utils.helper import get_storage_file, read_storage, write_storage
from backend.response import resp, standardize_response

import eel


def rotate(origin, point, angle):
    ox, oy = origin
    px, py = point
    qx = ox + cos(angle) * (px - ox) - sin(angle) * (py - oy)
    qy = oy + sin(angle) * (px - ox) + cos(angle) * (py - oy)
    return qx, qy

def build_branch(back_rotate, last_position, distance, stars):
    total_angle = 193
    splits = len(stars) + 1
    division = total_angle / splits
    for i, child in enumerate(stars, 1):
        child_rotation = division * i
        child_position = last_position[0] - distance, last_position[1]
        final_rotation = child_rotation + back_rotate
        
        rotated_position = rotate(last_position, child_position, radians(final_rotation))
        child["Coords"] = rotated_position
        
        if child.get("Stars"):
            build_branch(
                -((total_angle / 2) - final_rotation),
                rotated_position,
                distance,
                child["Stars"],
            )

def rotate_branch(star, origin, angle, distance):
    if not star.get("Stars"):
        return
    for child in star["Stars"]:
        child["Coords"] = rotate(origin, child.get("Coords", [0, 0]), angle)
        rotate_branch(child, origin, angle, distance)

_chart_cache = None  # (mtime, computed_chart, origin)


@eel.expose
@standardize_response
def get_calculated_star_chart():
    try:
        json_path = os.path.join(os.getcwd(), "web", "assets", "data", "star_chart.json")

        # The geometry is a deterministic function of the static star_chart.json,
        # so compute it once and reuse until the source file changes.
        global _chart_cache
        try:
            mtime = os.path.getmtime(json_path)
        except OSError:
            mtime = 0
        if _chart_cache is not None and _chart_cache[0] == mtime:
            return resp(True, data=_chart_cache[1], origin=_chart_cache[2])

        with open(json_path, "r", encoding="utf-8") as f:
            star_chart = json.load(f)

        origin = (500, 500)
        point_distance = 60
        constellations = ["Combat", "Gathering", "Pve"]
        constell_backs = [0, -2, -4]

        for i, (constellation_name, back_rotate) in enumerate(zip(constellations, constell_backs)):
            if constellation_name not in star_chart:
                continue
                
            total_angle = 360
            division = total_angle / len(constellations)
            branch_rotation = division * i
            
            position = origin[0], origin[1] - point_distance
            rotated_position = rotate(origin, position, radians(branch_rotation))
            
            constell = star_chart[constellation_name]
            constell["Coords"] = rotated_position
            distance = 47
            
            build_branch(back_rotate, position, distance, constell.get("Stars", []))
            rotate_branch(constell, origin, radians(branch_rotation), distance)

        _chart_cache = (mtime, star_chart, origin)
        return resp(True, data=star_chart, origin=origin)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return resp(False, error=str(e), code="STAR_CHART_CALC_FAILED")


@eel.expose
@standardize_response
def save_star_chart_template(name, base64_code):
    try:
        data = read_storage()
        
        if "star_chart_templates" not in data:
            data["star_chart_templates"] = {}
            
        data["star_chart_templates"][name] = base64_code
        write_storage(data)
        
        return resp(True)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return resp(False, error=str(e), code="STAR_CHART_SAVE_TEMPLATE_FAILED")

@eel.expose
@standardize_response
def get_star_chart_templates():
    try:
        data = read_storage()
        templates = data.get("star_chart_templates", {})
        return resp(True, data=templates, templates=templates)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return resp(False, data={}, templates={}, error=str(e), code="STAR_CHART_GET_TEMPLATES_FAILED")

@eel.expose
@standardize_response
def delete_star_chart_template(name):
    try:
        data = read_storage()
        if "star_chart_templates" in data and name in data["star_chart_templates"]:
            del data["star_chart_templates"][name]
            write_storage(data)
        return resp(True)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return resp(False, error=str(e), code="STAR_CHART_DELETE_TEMPLATE_FAILED")