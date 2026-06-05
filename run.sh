#!/usr/bin/env bash
#
# Better Trove Tools - Linux launcher.
#
# Sets up a virtualenv, installs Python deps, sanity-checks the system packages
# pywebview and the file dialogs need, then launches the app. Pure Python now --
# no native library to build.
#
# Usage:
#   ./run.sh            # set up (first run) and launch
#   ./run.sh --setup    # set up only, don't launch
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

VENV="$HERE/.venv-linux"
PY="${PYTHON:-python3}"
DO_LAUNCH=1
for arg in "$@"; do
    case "$arg" in
        --setup)   DO_LAUNCH=0 ;;
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

# --- 3. webview backend ------------------------------------------------------
# pywebview needs GTK (system PyGObject + WebKit2) or Qt (pip) to open a window.
# A plain venv can't see a system-installed `gi`, so the reliable, self-contained
# path is to pip-install the Qt backend into the venv when nothing is present.
have_backend() {
    python -c "import gi; gi.require_version('WebKit2','4.1')" >/dev/null 2>&1 \
        || python -c "import gi; gi.require_version('WebKit2','4.0')" >/dev/null 2>&1 \
        || python -c "import PyQt6.QtWebEngineWidgets" >/dev/null 2>&1 \
        || python -c "import PySide6.QtWebEngineWidgets" >/dev/null 2>&1 \
        || python -c "import PyQt5.QtWebEngineWidgets" >/dev/null 2>&1
}

if ! have_backend; then
    if [ "${BTT_NO_AUTO_QT:-}" = "1" ]; then
        warn "No pywebview backend found and BTT_NO_AUTO_QT=1, skipping auto-install."
    else
        info "No webview backend found. Installing the Qt backend into the venv"
        info "(one-time, ~150 MB). Prefer lighter native GTK? See README 'Install on Linux'."
        pip install --quiet pyqt6 pyqt6-webengine qtpy || true
    fi
fi

if ! have_backend; then
    err "No usable pywebview backend. Install one of:"
    err "  Qt  (pip, self-contained): pip install pyqt6 pyqt6-webengine qtpy"
    err "  GTK (lighter, native):     sudo apt install python3-gi gir1.2-webkit2-4.1"
    err "                             (GTK needs a venv created with --system-site-packages)"
    exit 1
fi

if ! python -c "import tkinter" >/dev/null 2>&1; then
    warn "python3-tk not found. The app still runs, but 'Browse for folder' and"
    warn "modder-tools file dialogs won't work. Install: sudo apt install python3-tk"
fi

# --- 4. launch ---------------------------------------------------------------
if [ "$DO_LAUNCH" = "1" ]; then
    info "Launching Better Trove Tools"
    exec python "$HERE/main.py"
else
    info "Setup complete. Launch with: source $VENV/bin/activate && python main.py"
fi
