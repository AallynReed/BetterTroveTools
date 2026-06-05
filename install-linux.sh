#!/usr/bin/env bash
#
# Install Better Trove Tools as a desktop app for the current user (no root).
#
# Run this once after extracting a release tarball (or cloning the repo). It
# sets up the virtualenv + dependencies, installs an application-menu launcher
# and icon, so "Better Trove Tools" shows up like any other installed app.
#
# Usage:
#   ./install-linux.sh            # install / update
#   ./install-linux.sh --uninstall
#
# Note: the launcher points at THIS folder. If you move it later, re-run this.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/256x256/apps"
DESKTOP_FILE="$APPS_DIR/better-trove-tools.desktop"
ICON_FILE="$ICON_DIR/better-trove-tools.png"

if [ "${1:-}" = "--uninstall" ]; then
    rm -f "$DESKTOP_FILE" "$ICON_FILE"
    update-desktop-database "$APPS_DIR" 2>/dev/null || true
    echo "Removed the menu launcher and icon. The app folder + venv are left in place;"
    echo "delete this folder and '$DATA_HOME/BetterTroveTools' (settings/cache) to fully remove."
    exit 0
fi

# 1. venv + Python deps + system-package checks (run.sh does all of this).
echo "==> Setting up the app (venv + dependencies)"
bash "$HERE/run.sh" --setup

# 2. Icon.
mkdir -p "$ICON_DIR"
cp "$HERE/web/favicon.png" "$ICON_FILE"

# 3. Desktop entry. Exec runs the venv's Python directly so launching is instant
#    (no dependency re-check on every start).
mkdir -p "$APPS_DIR"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Better Trove Tools
Comment=Desktop companion for Trove players, collectors, and modders
Exec=bash -c 'cd "$HERE" && exec .venv-linux/bin/python main.py'
Path=$HERE
Icon=better-trove-tools
Terminal=false
Categories=Game;Utility;
StartupWMClass=Better Trove Tools
EOF
chmod +x "$DESKTOP_FILE" 2>/dev/null || true
update-desktop-database "$APPS_DIR" 2>/dev/null || true

echo ""
echo "==> Installed. Launch 'Better Trove Tools' from your application menu,"
echo "    or run ./run.sh from this folder."
