# Better Trove Tools

![GitHub Release](https://img.shields.io/github/v/release/AallynReed/BetterTroveTools?style=for-the-badge&color=blue)
![GitHub Repo stars](https://img.shields.io/github/stars/AallynReed/BetterTroveTools?style=for-the-badge&color=gold)
![GitHub last commit](https://img.shields.io/github/last-commit/AallynReed/BetterTroveTools?style=for-the-badge&color=green)
![GitHub issues](https://img.shields.io/github/issues/AallynReed/BetterTroveTools?style=for-the-badge)

Better Trove Tools is a desktop companion for Trove players, collectors, and modders. It combines live game utilities, build planning, mod management, archive tooling, and game-file powered codexes into a single local-first app.

## Features

### Home dashboard
- Live rotation tracking for daily and weekly bonuses.
- Merchant tracking for Luxion, Corruxion, Fluxion, and biome-based schedules.
- Community content carousels for YouTube, Twitch, and BiliBili.
- Official Trove news feed with quick filtering and collapse controls.
- Trovesaurus event calendar integration.
- Interactive yearly rotation calendar with timeline filters, time-mode switching, and quick jumps.

### Gems and builds
- Gem Builds planner for class-focused optimization.
- Star Chart builder with saved templates and shareable build codes.
- Gem Evaluator for reviewing gem quality and decisions.
- Gem Simulator for leveling, augmenting, sparking, and flaring experiments.

### Calculators
- Power Rank calculator.
- Mastery calculator.
- Magic Find calculator with Star Chart integration.
- Light calculator.

### Codexes
- Ally Codex built from Trove game files with category, stats, abilities, mastery, geode mastery, designer, blueprint, and decoded ally power rank.
- Mount Codex built from Trove game files with category, movement stats, mastery, designer, and blueprint data.
- Dragon Codex for dragon-category mounts.
- Memento Codex with category, mastery, and source context such as biome, boss, or creature origin when available.
- Recipe Codex built from `prefabs/recipes` with decoded outputs, ingredient counts, category grouping, and output prefab metadata.

### Mod manager
- Manage installed mods per Trove installation.
- Enable, disable, update, and delete mods.
- Conflict detection for overlapping active mods.
- Rename local mod files to match internal titles.
- Search, filter, and quickly jump through results.
- Built-in onboarding tips and shortcut hints.
- Trovesaurus browser with direct install and update support.
- Preview images and open Trovesaurus mod or author pages from inside the app.
- `btt://` deep link support.

### Modder tools
- Build `.tmod` packages from loose files.
- Extract existing `.tmod` files for editing.
- Edit existing `.tmod` files in memory and compile them back out with title-based file naming.
- Project manager for persistent mod workspaces.
- Active version workspaces for project iteration.
- Preview image and `.cfg` support when building mods.
- Auto-structure and override-detection tools for packaging files correctly.
- One-click "Test in Game" override deployment and cleanup.
- File Explorer for Trove archives and extracted content.
- Update Tracker for patch-to-patch archive diffing and targeted extraction.
- Third-party software directory for common Trove modding tools.

### Game-file powered data
- Reads Trove `.tfi` and `.tfa` archives directly.
- Uses cache-backed runtime parsing instead of relying only on bundled static data.
- Includes decoding work for allies, mounts, mementos, mastery groups, geode mastery, localized names, descriptions, and related metadata.

### App and quality-of-life features
- Multi-language interface support.
- Accent color and app font customization.
- Home page content toggles for a calmer dashboard.
- Custom Trove directory management for Live, PTS, and custom installs.
- Local-first design with an external request tracker for transparency.
- Built-in update checking through GitHub releases.
