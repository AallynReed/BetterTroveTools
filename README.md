<div align="center">

# Better Trove Tools

**A desktop companion for Trove players, collectors, and modders.**

Live game utilities, build planning, mod management, archive tooling, and game‑file‑powered codexes — all in a single, fast, local‑first app.

<!-- Project status -->
![GitHub Release](https://img.shields.io/github/v/release/AallynReed/BetterTroveTools?style=for-the-badge&color=blue&cacheSeconds=21600)
![GitHub Repo stars](https://img.shields.io/github/stars/AallynReed/BetterTroveTools?style=for-the-badge&color=gold&cacheSeconds=21600)
![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/AallynReed/BetterTroveTools/total?style=for-the-badge&cacheSeconds=21600)
![GitHub last commit](https://img.shields.io/github/last-commit/AallynReed/BetterTroveTools?style=for-the-badge&color=green&cacheSeconds=21600)
![GitHub issues](https://img.shields.io/github/issues/AallynReed/BetterTroveTools?style=for-the-badge&cacheSeconds=21600)

<!-- Platforms -->
![Windows](https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)
![Android](https://img.shields.io/badge/Android-3DDC84?style=for-the-badge&logo=android&logoColor=white)

<!-- Tech stack -->
![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri%202-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)
![Vue.js](https://img.shields.io/badge/Vue.js%203-4FC08D?style=for-the-badge&logo=vuedotjs&logoColor=white)
![Runtime](https://img.shields.io/badge/Runtime-WebView2-0078D6?style=for-the-badge&logo=microsoftedge&logoColor=white)

<!-- Project meta -->
![Localization](https://img.shields.io/badge/Languages-9-orange?style=for-the-badge&logo=googletranslate&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-8A2BE2?style=for-the-badge)

[**Download**](https://trove.aallyn.net) · [Releases](https://github.com/AallynReed/BetterTroveTools/releases) · [Report a bug](https://github.com/AallynReed/BetterTroveTools/issues)

</div>

---

## Table of contents

- [Overview](#overview)
- [Feature highlights](#feature-highlights)
- [Home dashboard](#home-dashboard)
- [Gems & builds](#gems--builds)
- [Calculators](#calculators)
- [Codexes](#codexes)
- [Mod manager](#mod-manager)
- [Modder tools](#modder-tools)
- [Game file engine](#game-file-engine)
- [App & quality of life](#app--quality-of-life)
- [Built for speed](#built-for-speed)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Localization](#localization)
- [Tech stack](#tech-stack)
- [License](#license)

---

## Overview

Better Trove Tools is a **local‑first desktop application**: it runs on your own machine, reads your installed Trove game files directly, and only reaches out to the internet for the things that genuinely need it (community content, news, mod downloads, and update checks). Every external request is logged and visible to you in‑app for full transparency.

A native **Rust** backend does the heavy lifting (archive parsing, codex building, mod packaging), and the interface renders in the system webview (**WebView2** on Windows, **WebKitGTK** on Linux) through [Tauri](https://tauri.app) instead of bundling a full browser engine, keeping the download small and the engine security‑patched by the OS.

There's also a companion website at **[trove.aallyn.net](https://trove.aallyn.net)** — download the app there, or browse the live dashboard, leaderboards, codexes, and mods hub straight from your browser.

---

## Feature highlights

| Area | What you get |
| --- | --- |
| 🏠 **Home dashboard** | Live rotations, merchant tracking, community feeds, official news, and an interactive yearly calendar |
| 💎 **Gems & builds** | Gem build planner, Star Chart builder, gem evaluator, and a full gem simulator |
| 🧮 **Calculators** | Power Rank, Mastery, Magic Find, and Light — with Star Chart integration |
| 📖 **Codexes** *(beta)* | Allies, mounts, dragons, mementos, recipes, items, fish, and badges built straight from game files |
| 🧩 **Mod manager** | Install, enable, update, and resolve conflicts across every Trove install, plus a built‑in Trovesaurus browser |
| 🛠️ **Modder tools** | Build / extract / edit `.tmod` packages, browse archives, diff patches, and deploy test overrides |
| ⚙️ **Quality of life** | Multi‑language UI, theming, command palette, and a background job queue |

---

## Home dashboard

- **Live rotation tracking** for daily and weekly bonuses.
- **Merchant tracking** for Luxion, Corruxion, and Fluxion, plus biome‑based merchant schedules.
- **Community content carousels** for YouTube, Twitch, and BiliBili.
- **Official Trove news feed** with category filtering and collapse controls.
- **Trovesaurus event calendar** integration.
- **Interactive yearly rotation calendar** with timeline filters, time‑mode switching, and quick jumps.
- **Server time & timezone tools** — a live Trove server clock, side‑by‑side world clocks, and a converter that produces ready‑to‑paste **Discord timestamps**.
- **Customizable layout** — reorder dashboard sections, collapse what you don't use, and pin your most‑used tools to the Quick Tools tray (auto or manual).

## Gems & builds

- **Gem Builds planner** for class‑focused optimization, with a **Blessing of the Lilypad** toggle (the ally buff, on top of your level‑30 ally) and a **high precision** mode that shows every number to 8 decimals instead of rounding.
- **Star Chart builder** with a pan/zoom node map, saved templates, and shareable build codes.
- **Gem Evaluator** for reviewing gem quality and upgrade decisions.
- **Gem Simulator** for leveling, augmenting, sparking, and flaring experiments.

## Calculators

- **Power Rank** calculator, with the ally at level 30 and its Blessing of the Lilypad buff.
- **Mastery** calculator (Trove and Geode).
- **Magic Find** calculator with Star Chart integration.
- **Light** calculator.

## Codexes

> Built dynamically from your installed Trove game files and cache‑backed for fast reopening. *(Beta)*

- **Ally Codex** — category, stats, abilities, mastery, geode mastery, designer, blueprint, and decoded ally power rank.
- **Mount Codex** — category, movement stats, mastery, designer, and blueprint data.
- **Dragon Codex** — dragon‑category mounts.
- **Memento Codex** — category, mastery, and source context (biome, boss, or creature origin when available).
- **Recipe Codex** — decoded outputs, ingredient counts, category grouping, and output prefab metadata from `prefabs/recipes`.
- **Item, Fish, and Badge** codexes — searchable, filterable catalogs decoded from game data.

## Mod manager

- Manage installed mods **per Trove installation** (Live, PTS, and custom installs).
- **Enable, disable, update, and delete** mods.
- **Conflict detection** for overlapping active mods.
- **Rename** local mod files to match their internal titles.
- **Search, filter, and quick‑jump** through results.
- Built‑in **onboarding tips** and shortcut hints.
- **Trovesaurus browser** with direct install and update support.
- Preview images and open Trovesaurus mod or author pages from inside the app.
- **`btt://` deep link** support for one‑click installs from the web.

## Modder tools

- **Build `.tmod` packages** from loose files, with preview image and `.cfg` support.
- **Extract** existing `.tmod` files for editing.
- **Edit** existing `.tmod` files in memory and recompile them with title‑based file naming.
- **Project manager** with persistent mod workspaces and active version workspaces for iteration.
- **Auto‑structure & override‑detection** tools for packaging files correctly.
- One‑click **"Test in Game"** override deployment and cleanup.
- **File Explorer** for browsing Trove archives and extracted content, with fast parallel mass extraction.
- **Update Tracker** for patch‑to‑patch archive diffing, baseline caching, and targeted extraction of only what changed.
- **Blueprint Editor** *(experimental preview)* — open `.qb` and Trove `.blueprint` packages, inspect voxel assets in 3D, and export back to Qubicle Binary format.
- **Third‑party software directory** for common Trove modding tools.

## Game file engine

- Reads Trove **`.tfi` index** and **`.tfa` archive** files directly.
- Uses **cache‑backed runtime parsing** instead of relying only on bundled static data, so codexes and tooling stay current with your installed build.
- Includes decoding work for **allies, mounts, mementos, mastery groups, geode mastery, localized names, descriptions, and related metadata**.
- Archive reads, hashing, and extraction are processed in **parallel across CPU cores** for fast tree loads, baseline builds, and bulk extraction.

## App & quality of life

- **Multi‑language interface** support (9 languages).
- **Accent color** and **app font** customization.
- **Custom Trove directory management** for Live, PTS, and custom installs.
- **Command palette / Quick Open** (`Ctrl/Cmd + K`) to jump to any tool or action instantly.
- **Background job queue** for long‑running operations like extraction and scanning.
- **Home page content toggles** for a calmer dashboard.
- **Local‑first design** with an external request tracker for full transparency.
- **Built‑in update checking** through GitHub releases, with one‑click in‑app self‑update.

## Built for speed

Better Trove Tools is engineered to feel instant:

- **Native Rust backend** — every codex builds in under a second (the slowest used to take ~9 s), update scans finish in under 2 s instead of 12–17 s, and the app starts without loading a Python runtime.
- **Lazy‑loaded views** — only the code for the screen you open is fetched, keeping startup snappy.
- **Parallel archive processing** — `.tfa` decompression, hashing, and extraction fan out across CPU cores.
- **Cache‑aware everywhere** — game‑install detection, codex datasets, and archive trees are cached and only rebuilt when the underlying files actually change.
- **Idle‑friendly** — background timers pause when the window isn't visible.

---

## Requirements

The desktop app renders its interface in the **Microsoft Edge WebView2 runtime** instead of bundling a browser, keeping the download small and the engine automatically security‑patched.

- **Windows 11** — WebView2 is preinstalled; nothing to do.
- **Windows 10 and earlier** — usually delivered through Windows Update, and the installer downloads it if it's missing. If the app still reports the runtime as missing, install the free **Evergreen WebView2 Runtime** from Microsoft:
  - Download page: <https://developer.microsoft.com/microsoft-edge/webview2/>
  - Direct Evergreen Bootstrapper: <https://go.microsoft.com/fwlink/p/?LinkId=2124703>

WebView2 is a standalone component, so it stays installed even if Microsoft Edge itself is removed.

**Linux** renders through the system **WebKitGTK** (pulled in automatically by the `.deb`, bundled in the AppImage). See [Install on Linux](#install-on-linux) below. Windows remains the primary, fully‑featured target; Linux runs the same UI and tools, with Windows‑only bits (self‑update, the registry‑based auto‑detect) gracefully disabled.

---

## Getting started

### Install the app

1. Download the latest installer from the [**website**](https://trove.aallyn.net) or the [**GitHub Releases**](https://github.com/AallynReed/BetterTroveTools/releases) page.
2. Run the `.msi` installer (on Linux, see [Install on Linux](#install-on-linux)).
3. Launch **Better Trove Tools** — it will auto‑detect your Trove installations (Glyph and Steam) and check for updates.

The app keeps itself up to date: when a newer release is available it offers a one‑click in‑app update that downloads the installer, applies it, and relaunches automatically.

> [!NOTE]
> Updating from **2026.10.06 or earlier** (the Python builds) moves the app to `Program Files\Better Trove Tools`. The old updater can't relaunch it from there, so start it once from the Start menu after that update. Settings, caches and mod configs carry over untouched.

### Build from source

Needs [Rust](https://rustup.rs) (stable) and Node.js. On Linux, also the WebKitGTK dev packages (`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev` on Debian/Ubuntu).

```bash
npm ci
npx tauri dev                    # run the app
cargo test -p btt-core           # backend tests
npx tauri build --bundles msi    # or appimage,deb on Linux
```

The backend lives in `core/` (`btt-core`, one module per area of the app); the window, tray and IPC in `src-tauri/`. The page keeps calling `eel.<name>(...)()`: `web/js/tauri_bridge.js` carries those calls to `btt-core`.

### Install on Linux

Download `BetterTroveTools-<version>-linux-x86_64.AppImage` (any distro: `chmod +x` and run) or `BetterTroveTools-<version>-linux-amd64.deb` (Debian/Ubuntu: `sudo apt install ./BetterTroveTools-*.deb`) from the Releases page.

#### NixOS (flake)

The flake in this repo builds the app from source. Add it as an input and pull the package into your system config:

```nix
{
  inputs.better-trove-tools.url = "github:AallynReed/BetterTroveTools";
}
```

```nix
{ inputs, pkgs, ... }:
{
  environment.systemPackages = [
    inputs.better-trove-tools.packages.${pkgs.system}.default
  ];
}
```

Or try it without installing: `nix run github:AallynReed/BetterTroveTools`. Packaged for `x86_64-linux`. Original Nix packaging by [@Redhawk18](https://github.com/Redhawk18).

**What works on Linux:** the full UI, calculators, gems/builds, Star Chart, home dashboard, Trovesaurus browsing, and — when a Trove install is present (e.g. via **Steam/Proton**, which is auto‑detected) — the codexes and mod management, since those only *read* the game files.

**What's Windows‑only:** the in‑app self‑updater and "Test in Game" (which runs the Windows game `.exe`). If no Trove installation is detected, install‑dependent tools are skipped gracefully and the app prompts you to add a directory in **Settings → Directories** (point it at any valid Trove folder manually).

**Where your data lives:** settings, caches and downloads go to `$XDG_DATA_HOME/BetterTroveTools` (`~/.local/share/BetterTroveTools` by default). Change it in **Settings → Directories → Data Folder**, or set `BTT_DATA_DIR` before launching — useful for a second drive or a sandboxed install. The setting is remembered in `$XDG_CONFIG_HOME/BetterTroveTools/data_dir`; the environment variable wins over it, existing files aren't moved, and the new location applies on the next launch. (Windows keeps `%APPDATA%/Trove`, which it shares with the game's own mod configs.)

**Mod configs under Proton:** mods that ship a config get a `.cfg` written to Trove's own AppData folder, which under Steam Play lives inside the Wine prefix. Set **Settings → Directories → Mod Config Folder** to `…/steamapps/compatdata/<id>/pfx/drive_c/users/steamuser/AppData/Roaming/Trove/ModCfgs` and mod settings reach the game; leave it empty and the app skips writing configs on Linux, since the default folder isn't one Trove reads. The change applies immediately — installed mods are re-checked on save.

### Cutting a release (maintainers)

Releases are built automatically by [`.github/workflows/compiler.yml`](.github/workflows/compiler.yml) when a GitHub Release is **created**:

1. Bump `APP_VERSION` in `metadata.json` and commit.
2. Create the release — tag and **release name** should match the version (the asset filenames use the release name), e.g. with the GitHub CLI:
   ```bash
   gh release create 2026.06.01 --title 2026.06.01 --notes "What changed..."
   ```
   (Or use the Releases page → *Draft a new release*.)
3. The workflow then attaches the bundles to that release (built by `npx tauri build`):
   - `BetterTroveTools-<version>-win64.msi` — Windows installer.
   - `BetterTroveTools-<version>-linux-x86_64.AppImage` and `BetterTroveTools-<version>-linux-amd64.deb` — Linux.

The Windows job needs a `COMPILER` repository secret (a token with `contents: write`) to upload assets.

---

## Localization

The interface is available in **9 languages**:

🇺🇸 English · 🇧🇷 Português (Brasil) · 🇪🇸 Español · 🇫🇷 Français · 🇩🇪 Deutsch · 🇷🇺 Русский · 🇯🇵 日本語 · 🇰🇷 한국어 · 🇨🇳 简体中文

Translations are loaded from `web/assets/locale/` and the active language can be switched at any time from the sidebar.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| **Backend** | Rust (`btt-core`) |
| **Desktop shell** | [Tauri 2](https://tauri.app) on **WebView2** (Windows) / **WebKitGTK** (Linux) |
| **Page ↔ backend bridge** | Tauri IPC behind an eel-compatible `eel` object |
| **Frontend** | Vue 3, vanilla JS, modular CSS |
| **Game data** | Custom `.tfi` / `.tfa` archive and `.binfab` parsers, Steam library detection |
| **Packaging** | Tauri bundler (MSI, AppImage, deb) |

---

## License

Released under the [MIT License](LICENSE). © 2026‑Present **Aallyn Reed**.

> Better Trove Tools is a community project and is not affiliated with or endorsed by Trion Worlds, Gamigo, or the official Trove team. *Trove* and related assets are property of their respective owners.
