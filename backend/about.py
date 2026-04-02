import os
import platform

import eel


@eel.expose
def get_system_info():
    try:
        return {
            "os": platform.system(),
            "os_release": platform.release(),
            "os_version": platform.version(),
            "architecture": platform.machine(),
            "processor": platform.processor()
        }
    except Exception as e:
        return {"error": str(e)}

@eel.expose
def get_app_license():
    for filename in ["LICENSE.md", "LICENSE", "license", "license.txt"]:
        if os.path.exists(filename):
            with open(filename, "r", encoding="utf-8") as f:
                return f.read()
    return "License file not found."