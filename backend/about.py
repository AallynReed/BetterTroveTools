import os
import platform
import sys

import eel
from backend.response import resp, standardize_response


@eel.expose
@standardize_response
def get_system_info():
    try:
        data = {
            "os": platform.system(),
            "os_release": platform.release(),
            "os_version": platform.version(),
            "architecture": platform.machine(),
            "processor": platform.processor(),
            # True when running from source; False in the packaged (frozen) build.
            "dev_mode": not getattr(sys, "frozen", False),
        }
        return resp(True, data=data, **data)
    except Exception as e:
        return resp(False, error=str(e), code="SYSTEM_INFO_FAILED")

@eel.expose
@standardize_response
def get_app_license():
    for filename in ["LICENSE.md", "LICENSE", "license", "license.txt"]:
        if os.path.exists(filename):
            with open(filename, "r", encoding="utf-8") as f:
                text = f.read()
                return resp(True, data={"text": text}, text=text)
    text = "License file not found."
    return resp(False, data={"text": text}, error=text, code="LICENSE_NOT_FOUND", text=text)