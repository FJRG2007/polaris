---
id: BUG-0041
title: The launcher's first open after hours unused is jerky, and its dimmed backdrop behaves oddly
status: open
area: desktop
location: clients/desktop/src/main/launcher.ts
related:
  - clients/desktop/src/main/windows.ts
  - docs/bugs/BUG-0040-launcher-search-not-focused.md
reported: 2026-11-25
fixed:
fix_commit:
---

## What was seen

In Polaris desktop on Windows, the first Alt+Space after the launcher has not
been used for hours opens with a jerky animation; later opens are smooth. The
dimmed backdrop shown behind the launcher also "does something odd". The
reporter asked whether Raycast shows such a backdrop at all.

## Cause

Not confirmed yet; under investigation. Candidates being checked: the hidden
window being throttled or its memory trimmed by Windows while idle, the first
frame painted cold, work run on open competing with the animation, and how the
backdrop window is drawn.

## If it happens again

Note how long Polaris desktop had been idle, the desktop version, and what
the backdrop did (flash, late fade, wrong screen, covers the taskbar).
