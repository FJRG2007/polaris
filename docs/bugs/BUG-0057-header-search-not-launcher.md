---
id: BUG-0057
title: The desktop app's header search opens a smaller search than Alt+Space
status: fixed-watching
area: desktop
location: dashboard/apps/web/src/lib/search/open-search.ts
related:
  - dashboard/apps/web/src/components/command-palette.tsx
  - dashboard/apps/web/src/components/favorite-apps.tsx
  - dashboard/apps/web/src/app/(embed)/launcher/launcher-search.tsx
  - clients/desktop/src/main/launcher.ts
  - clients/desktop/src/main/ipc.ts
  - clients/desktop/src/preload/app.ts
  - clients/desktop/src/preload/launcher.ts
  - clients/desktop/test/main/launcher-warm.test.ts
  - dashboard/apps/web/test/search/palette-desktop-launcher.test.tsx
reported: 2026-11-26
fixed: 2026-11-26
fix_commit:
---

## What was seen

In the desktop app's main window, clicking the search field in the header
opened a search with only Polaris results - no apps, games or computer
commands - while Alt+Space opened the full launcher with all of them.

## Cause

The main window is the dashboard page, and every way into search from it -
the header button, Ctrl/Cmd+K, a "search for this" request from elsewhere on
the page, the "More apps" row in the sidebar and in the phone sheet - opened
the page's own panel. Only the launcher window, which the global key opens,
asks the desktop app for this computer's rows. The main window's bridge had no
call to bring that window up.

## Fix

- The main window's bridge has `showLauncher(query)`. It shows the launcher
  window, already holding the text, and answers false when the launcher is
  switched off. The launcher's `opened` message now carries that text to both
  the desktop's own panel and the instance's `/launcher` page.
- On the page, `openDesktopLauncher` uses the call when it exists. In a
  browser, in a desktop build older than the call, with the launcher switched
  off, or when the call fails, it opens the page's own panel as before.
- The header button, the search key, open requests without a scope and the
  "More apps" rows go through it. Chat's scoped search and its Ctrl+K quick
  switcher stay on the page, because the launcher has no Chat scope.

## Verification

- `clients/desktop/test/main/launcher-warm.test.ts`: `showLauncher` shows the
  window with the text, never hides it on a second ask, and waits for the
  first draw during warm-up.
- `clients/desktop/test/shared/launcher.test.ts`: the text is made one line
  and capped.
- `dashboard/apps/web/test/search/palette-desktop-launcher.test.tsx`: browser,
  old desktop, launcher off and failed call fall back to the page's panel. The
  header button, the key and a request open the launcher with the text, Chat
  keeps its own. The launcher window's palette opens with the text it gets.
- Not exercised in a running desktop app.
