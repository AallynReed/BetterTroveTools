import json
import os
import traceback
from copy import deepcopy
from pathlib import Path

import eel

from models.trove.gem_bases import (AugmentType, GemAbility, GemElement,
                                    GemRestriction, GemStatType, GemTier,
                                    GemType)
from models.trove.gems import Gem
from utils.helper import get_storage_file, read_storage, write_storage

@eel.expose
def load_gem_storage():
    try:
        storage = read_storage()
        return storage.get("gem_simulator", {})
    except Exception as e:
        traceback.print_exc()
        return {}

@eel.expose
def save_gem_storage(gem_data):
    try:
        storage = read_storage()
        storage["gem_simulator"] = gem_data
        write_storage(storage)
        return True
    except Exception as e:
        traceback.print_exc()
        return False

@eel.expose
def get_gem_lookups():
    try:
        types = {t.name.replace("_", " ").title(): t.value for t in sorted(list(GemType), key=lambda x: x.value)}
        elements = {e.name.replace("_", " ").title(): e.value for e in sorted(list(GemElement), key=lambda x: x.value)}
        tiers = {t.name.replace("_", " ").title(): t.value for t in sorted(list(GemTier), key=lambda x: x.value)}
        restrictions = {r.name.replace("_", " ").title(): r.value for r in sorted(list(GemRestriction), key=lambda x: x.value)}
        stat_types = {s.name.replace("_", " ").title(): s.value for s in sorted(list(GemStatType), key=lambda x: x.value)}
        augment_types = {a.name.replace("_", " ").title(): a.value for a in sorted(list(AugmentType), key=lambda x: x.value)}
        
        return {
            "success": True,
            "data": {
                "types": types,
                "elements": elements,
                "tiers": tiers,
                "restrictions": restrictions,
                "stat_types": stat_types,
                "augment_types": augment_types
            }
        }
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def create_gem(data):
    try:
        gem = Gem.create(**data) if data else Gem.create()
        return {"success": True, "gem": gem.model_dump(mode='json')}
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def mass_update_gems(gem_data):
    try:
        gems = []
        for gem in gem_data:
            if gem is None:
                gems.append(None)
            else:
                gems.append(Gem(**gem).model_dump(mode='json'))
        return {"success": True, "gems": gems}
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def level_up_gem(gem_data):
    try:
        gem = Gem(**gem_data)
        success = gem.level_up()
        if not success:
            return {"success": False, "error": "Gem is already at max level."}
        return {"success": True, "gem": gem.model_dump(mode='json')}
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def augment_gem(gem_data, stat_id, augment_id):
    try:
        gem = Gem(**gem_data)
        stat_enum = GemStatType(stat_id)
        
        if not gem.has_stat(stat_enum):
            return {"success": False, "error": "Stat type not found in gem"}
            
        for stat in gem.stats:
            if stat.type == stat_enum:
                success = stat.add_augment(AugmentType(augment_id))
                if not success:
                    return {"success": False, "error": "Stat is already fully augmented"}
                return {"success": True, "gem": gem.model_dump(mode='json')}
                
        return {"success": False, "error": "Failed to augment"}
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def spark_gem(gem_data, stat_id):
    try:
        gem = Gem(**gem_data)
        stat_enum = GemStatType(stat_id)
        
        if not gem.has_stat(stat_enum):
            return {"success": False, "error": "Stat type not found in gem"}
            
        success = gem.reroll_stat_type(stat_enum)
        if not success:
            return {"success": False, "error": "Failed to reroll stat. It might be locked."}
            
        return {"success": True, "gem": gem.model_dump(mode='json')}
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}

@eel.expose
def flare_gem(gem_data, stat_id):
    try:
        gem = Gem(**gem_data)
        stat_enum = GemStatType(stat_id)
        
        if not gem.has_stat(stat_enum):
            return {"success": False, "error": "Stat type not found in gem"}
            
        success = gem.move_proc(stat_enum)
        if not success:
            return {"success": False, "error": "Cannot move boost from a stat with only one proc."}
            
        return {"success": True, "gem": gem.model_dump(mode='json')}
    except Exception as e:
        traceback.print_exc()
        return {"success": False, "error": str(e)}