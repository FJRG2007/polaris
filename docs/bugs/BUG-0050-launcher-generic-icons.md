---
id: BUG-0050
title: Launcher rows show a generic picture instead of the program's or game's icon
status: fixed-watching
area: desktop
location: clients/desktop/src/main/launcher-icons.ts
related:
  - clients/desktop/src/main/launcher-apps.ts
  - clients/desktop/src/main/launcher-programs.ts
  - clients/desktop/src/main/launcher-stores.ts
  - clients/desktop/src/main/launcher.ts
  - clients/desktop/src/renderer/launcher.tsx
  - clients/desktop/test/main/launcher-icons.test.ts
  - clients/desktop/test/main/launcher-stores.test.ts
reported: 2026-11-26
fixed: 2026-11-26
fix_commit:
---

## What was seen

In the launcher, most programs and nearly every Steam game were drawn with
the same generic shortcut picture, or with no picture at all, instead of their
own icon. Store apps (Microsoft Store, MSIX) had none.

## Cause

Several separate gaps, each leaving a class of rows without its icon:

- `mergePrograms` keeps the first copy of a program it meets. For a Steam or
  Epic game that is the Start menu `.url` file, which carries no icon, so the
  store adapter's icon for the same game was thrown away.
- Shortcuts were drawn from the `.lnk` or `.url` file itself. Chromium's
  `getFileIcon` looks up anything that is not an exe, dll or ico by its
  extension, so every shortcut got the generic shortcut picture.
- Steam's icon was only looked for as `librarycache/<id>_icon.jpg`, which newer
  clients no longer write.
- Packaged (MSIX/UWP) apps were listed without their install folder, so their
  logo could never be read.
- A store game with no picture of its own (Ubisoft; Epic or GOG without an
  exe recorded) had no fallback.
- The desktop's own launcher panel never drew `row.icon`, and its content
  security policy had no `img-src`, so a data URL would not have loaded.

## Fix

- A later copy of a program fills in an `icon` the first copy lacks.
- A `.lnk` is drawn from its IconLocation or its target, a `.url` from its
  IconFile.
- Steam: the `Steam App <id>` uninstall entry's DisplayIcon `.ico` first, then
  the flat `librarycache` jpg, then the per-app folder `librarycache/<id>/`.
- Packaged apps: the listing also returns InstallLocation, and the logo comes
  from the AppxManifest `Square44x44Logo`, choosing among its targetsize and
  scale variants (`pickAsset`, preferring 32 px and above).
- A store game without a picture falls back to the exe in its folder, and
  otherwise to its kind's glyph.
- The panel draws `row.icon`; its CSP allows `img-src data:`.
- The cached program listing's `INDEX_VERSION` is 3, so every install reads
  its programs again and picks the icons up.

## Verification

- `clients/desktop/test/main/launcher-icons.test.ts`: shortcut icon sources,
  the asset variant ranking, the merge keeping an icon from a later copy.
- `clients/desktop/test/main/launcher-stores.test.ts`: Steam with both cache
  layouts and with the uninstall `.ico`; a packaged app's logo from its
  manifest.
- Not exercised on a real Windows machine. EA app games have no store adapter
  yet. The per-app Steam file layout comes from community reports, not a Valve
  document.
