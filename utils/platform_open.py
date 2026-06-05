"""Cross-platform helpers for opening paths and URLs in the user's desktop
environment (file manager / browser), so the rest of the app doesn't hardcode
Windows tools like ``explorer.exe``.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def open_in_file_manager(target: Path, select_file: bool = False) -> None:
    """Reveal *target* in the platform file manager.

    When ``select_file`` is set and the target is a file, the file is
    highlighted/selected where the platform supports it; otherwise the
    containing directory is opened.

    Windows  -> explorer (with /select for highlighting)
    macOS    -> open (with -R for reveal/select)
    Linux    -> xdg-open on the directory (no portable "select file" exists;
                most file managers don't accept a select argument, so we open
                the parent directory instead)
    """
    target = Path(target)

    if sys.platform == "win32":
        if select_file and target.is_file():
            subprocess.Popen(["explorer", "/select,", str(target)])
        else:
            open_target = target.parent if target.is_file() else target
            subprocess.Popen(["explorer", str(open_target)])
        return

    if sys.platform == "darwin":
        if select_file and target.is_file():
            subprocess.Popen(["open", "-R", str(target)])
        else:
            open_target = target.parent if target.is_file() else target
            subprocess.Popen(["open", str(open_target)])
        return

    # Linux / other POSIX: open the containing directory. There is no portable
    # "select this file" across GTK/KDE/etc. file managers.
    open_target = target.parent if target.is_file() else target
    subprocess.Popen(["xdg-open", str(open_target)])
