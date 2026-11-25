---
id: BUG-0044
title: The launcher does not find installed games such as Grand Theft Auto V, by name or by "gta"
status: fixed-watching
area: desktop
location: clients/desktop/src/main/launcher-programs.ts
related:
  - clients/desktop/src/main/launcher-apps.ts
  - clients/desktop/src/main/launcher-exe-info.ts
  - clients/desktop/src/main/launcher-stores.ts
  - clients/desktop/src/shared/launcher.ts
reported: 2026-11-25
fixed: 2026-11-25
fix_commit:
---

## What was seen

In Polaris desktop on Windows, searching the launcher for an installed game -
"Grand Theft Auto" or "gta" - showed nothing for it, or ranked "Git Bash"
alongside it. The reporter asked for it to work for every program and game, as
Raycast does, not as a fix for one title.

## Cause

Two causes, both general:

- **Not discovered.** The launcher listed the Start menu's shortcuts, packaged
  apps and the Epic, Steam, GOG and Ubisoft libraries only. Rockstar installs
  Grand Theft Auto V with no Start menu shortcut: only an uninstall entry in
  the registry and, usually, a Desktop shortcut - neither of which was read.
  The same held for EA app, Battle.net and Riot games and for programs known
  only through `App Paths`.
- **Weak matching.** "gta" found no acronym step: it fell to letters-in-order
  (score 20), tied with "Git Bash". There was no accent folding and a program
  was matched by its label only, never its executable's name.

## Fix

- Sources, in Vicinae's order, one list with one dedupe map keyed by what each
  program starts (executable, launch link, packaged app id) or its name:
  packaged apps, Start menu, both Desktops (the user's from
  `app.getPath("desktop")`, which follows OneDrive, and the public one), store
  libraries, `App Paths` (only executables with a `FileDescription`, never the
  Windows folder's or `WindowsApps`), uninstall entries (both registry views,
  HKLM and HKCU; the entry's icon executable, or the install folder's plausible
  main executable). `.lnk` targets are read without resolving them; a `.url`
  is read for its address so a Steam shortcut and the Steam row are one.
- Rockstar games start through `Launcher.exe -launchTitleInFolder <folder>` and
  Battle.net games through `Battle.net.exe --exec="launch <product>"`
  (Playnite's adapters, MIT), falling back to the game's own executable.
- Matching: initials tier above letters-in-order ("gta" -> Grand Theft Auto V),
  word starts at capitals and digits, accent folding, and every alias scored
  (executable name minus "Play" and version, install folder name, other
  sources' names).
- The listing is kept on disk (versioned, schema-checked) so the first open
  after a restart answers at once, read again when a watched folder's changes
  settle (3 s, at most 20 s), on an open after 10 minutes, and by the game
  watcher after 30 hours.

## If it happens again

Note the program's name as Windows shows it in Settings > Apps, where its
shortcut lives (if any), the store that installed it, and the desktop version.
