import json
import os
import traceback
from copy import deepcopy
from pathlib import Path

import eel
from backend.response import resp, standardize_response

from models.trove.gem_bases import (AugmentType, GemAbility, GemElement,
                                    GemRestriction, GemStatType, GemTier,
                                    GemType)
from models.trove.gems import Gem
from utils.helper import get_storage_file, read_storage, write_storage

@eel.expose
@standardize_response
def load_gem_storage():
    try:
        storage = read_storage()
        gem_data = storage.get("gem_simulator", {})
        return resp(True, data=gem_data, gem_simulator=gem_data)
    except Exception as e:
        traceback.print_exc()
        return resp(False, data={}, gem_simulator={}, error=str(e), code="GEM_STORAGE_LOAD_FAILED")

@eel.expose
@standardize_response
def save_gem_storage(gem_data):
    try:
        storage = read_storage()
        storage["gem_simulator"] = gem_data
        write_storage(storage)
        return resp(True)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_STORAGE_SAVE_FAILED")

@eel.expose
@standardize_response
def get_gem_lookups():
    try:
        types = {t.name.replace("_", " ").title(): t.value for t in sorted(list(GemType), key=lambda x: x.value)}
        elements = {e.name.replace("_", " ").title(): e.value for e in sorted(list(GemElement), key=lambda x: x.value)}
        tiers = {t.name.replace("_", " ").title(): t.value for t in sorted(list(GemTier), key=lambda x: x.value)}
        restrictions = {r.name.replace("_", " ").title(): r.value for r in sorted(list(GemRestriction), key=lambda x: x.value)}
        stat_types = {s.name.replace("_", " ").title(): s.value for s in sorted(list(GemStatType), key=lambda x: x.value)}
        augment_types = {a.name.replace("_", " ").title(): a.value for a in sorted(list(AugmentType), key=lambda x: x.value)}
        
        data = {
            "types": types,
            "elements": elements,
            "tiers": tiers,
            "restrictions": restrictions,
            "stat_types": stat_types,
            "augment_types": augment_types,
        }
        return resp(True, data=data)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_LOOKUPS_FAILED")

@eel.expose
@standardize_response
def create_gem(data):
    try:
        gem = Gem.create(**data) if data else Gem.create()
        payload = gem.model_dump(mode='json')
        return resp(True, data={"gem": payload}, gem=payload)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_CREATE_FAILED")

@eel.expose
@standardize_response
def mass_update_gems(gem_data):
    try:
        gems = []
        for gem in gem_data:
            if gem is None:
                gems.append(None)
            else:
                gems.append(Gem(**gem).model_dump(mode='json'))
        return resp(True, data={"gems": gems}, gems=gems)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_MASS_UPDATE_FAILED")

@eel.expose
@standardize_response
def level_up_gem(gem_data):
    try:
        gem = Gem(**gem_data)
        success = gem.level_up()
        if not success:
            return resp(False, error="Gem is already at max level.", code="GEM_MAX_LEVEL")
        payload = gem.model_dump(mode='json')
        return resp(True, data={"gem": payload}, gem=payload)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_LEVEL_UP_FAILED")

@eel.expose
@standardize_response
def augment_gem(gem_data, stat_id, augment_id):
    try:
        gem = Gem(**gem_data)
        stat_enum = GemStatType(stat_id)
        
        if not gem.has_stat(stat_enum):
            return resp(False, error="Stat type not found in gem", code="GEM_STAT_NOT_FOUND")
            
        for stat in gem.stats:
            if stat.type == stat_enum:
                success = stat.add_augment(AugmentType(augment_id))
                if not success:
                    return resp(False, error="Stat is already fully augmented", code="GEM_STAT_MAX_AUGMENT")
                payload = gem.model_dump(mode='json')
                return resp(True, data={"gem": payload}, gem=payload)
                
        return resp(False, error="Failed to augment", code="GEM_AUGMENT_FAILED")
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_AUGMENT_FAILED")

@eel.expose
@standardize_response
def spark_gem(gem_data, stat_id):
    try:
        gem = Gem(**gem_data)
        stat_enum = GemStatType(stat_id)
        
        if not gem.has_stat(stat_enum):
            return resp(False, error="Stat type not found in gem", code="GEM_STAT_NOT_FOUND")
            
        success = gem.reroll_stat_type(stat_enum)
        if not success:
            return resp(False, error="Failed to reroll stat. It might be locked.", code="GEM_REROLL_FAILED")
            
        payload = gem.model_dump(mode='json')
        return resp(True, data={"gem": payload}, gem=payload)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_REROLL_FAILED")

@eel.expose
@standardize_response
def flare_gem(gem_data, stat_id):
    try:
        gem = Gem(**gem_data)
        stat_enum = GemStatType(stat_id)
        
        if not gem.has_stat(stat_enum):
            return resp(False, error="Stat type not found in gem", code="GEM_STAT_NOT_FOUND")
            
        success = gem.move_proc(stat_enum)
        if not success:
            return resp(False, error="Cannot move boost from a stat with only one proc.", code="GEM_MOVE_PROC_FAILED")
            
        payload = gem.model_dump(mode='json')
        return resp(True, data={"gem": payload}, gem=payload)
    except Exception as e:
        traceback.print_exc()
        return resp(False, error=str(e), code="GEM_MOVE_PROC_FAILED")
