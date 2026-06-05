#!/usr/bin/env bash
#
# Better Trove Tools - Linux launcher.
#
# Sets up a virtualenv, installs Python deps, builds the small native hash
# helper (trove.so) from trove.c, sanity-checks the system packages pywebview
# and the file dialogs need, then launches the app.
#
# Usage:
#   ./run.sh            # set up (first run) and launch
#   ./run.sh --setup    # set up only, don't launch
#   ./run.sh --rebuild  # force-rebuild trove.so even if it exists
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

VENV="$HERE/.venv-linux"
PY="${PYTHON:-python3}"
DO_LAUNCH=1
FORCE_REBUILD=0
for arg in "$@"; do
    case "$arg" in
        --setup)   DO_LAUNCH=0 ;;
        --rebuild) FORCE_REBUILD=1 ;;
        *) echo "Unknown option: $arg"; exit 2 ;;
    esac
done

info()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; }

# --- 1. Python ---------------------------------------------------------------
if ! command -v "$PY" >/dev/null 2>&1; then
    err "python3 not found. Install Python 3.10+ and re-run (set \$PYTHON to override)."
    exit 1
fi

# --- 2. virtualenv + pip deps ------------------------------------------------
if [ ! -d "$VENV" ]; then
    info "Creating virtualenv at $VENV"
    "$PY" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

info "Installing Python dependencies (requirements-linux.txt)"
pip install --quiet --upgrade pip
pip install --quiet -r "$HERE/requirements-linux.txt"

# --- 3. native hash helper (trove.so) ---------------------------------------
if [ "$FORCE_REBUILD" = "1" ] || [ ! -f "$HERE/trove.so" ] || [ "$HERE/trove.c" -nt "$HERE/trove.so" ]; then
    if command -v cc >/dev/null 2>&1; then
        info "Building trove.so from trove.c"
        cc -O2 -shared -fPIC -o "$HERE/trove.so" "$HERE/trove.c"
    elif command -v gcc >/dev/null 2>&1; then
        info "Building trove.so from trove.c (gcc)"
        gcc -O2 -shared -fPIC -o "$HERE/trove.so" "$HERE/trove.c"
    elif [ -f "$HERE/trove.so" ]; then
        warn "No C compiler found; using the committed trove.so. (Install gcc to rebuild.)"
    else
        err "No C compiler (cc/gcc) and no prebuilt trove.so. Install build-essential / gcc."
        exit 1
    fi
fi

# --- 4. backend sanity checks (warn, don't block) ----------------------------
missing_backend=1
if python -c "import gi; gi.require_version('WebKit2','4.1')" >/dev/null 2>&1 \
   || python -c "import gi; gi.require_version('WebKit2','4.0')" >/dev/null 2>&1; then
    missing_backend=0
fi
if [ "$missing_backend" = "1" ] && python -c "import PyQt6.QtWebEngineWidgets" >/dev/null 2>&1; then
    missing_backend=0
fi
if [ "$missing_backend" = "1" ] && python -c "import PyQt5.QtWebEngineWidgets" >/dev/null 2>&1; then
    missing_backend=0
fi
if [ "$missing_backend" = "1" ]; then
    warn "No pywebview backend detected. The window may fail to open."
    warn "  GTK (recommended): sudo apt install python3-gi gir1.2-webkit2-4.1"
    warn "  or Qt:             pip install pyqt6 pyqt6-webengine qtpy"
fi

if ! python -c "import tkinter" >/dev/null 2>&1; then
    warn "python3-tk not found. The app still runs, but 'Browse for folder' and"
    warn "modder-tools file dialogs won't work. Install: sudo apt install python3-tk"
fi

# --- 5. launch ---------------------------------------------------------------
if [ "$DO_LAUNCH" = "1" ]; then
    info "Launching Better Trove Tools"
    exec python "$HERE/main.py"
else
    info "Setup complete. Launch with: source $VENV/bin/activate && python main.py"
fi
