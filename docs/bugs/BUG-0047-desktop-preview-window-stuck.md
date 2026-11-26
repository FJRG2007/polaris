---
id: BUG-0047
title: The live preview's "Open in new tab" opens a window that cannot be moved or resized
status: fixed-watching
area: desktop
location: clients/desktop/src/main/windows.ts
related:
  - clients/desktop/src/main/navigation.ts
  - clients/desktop/src/main/ipc.ts
  - clients/desktop/test/main/window-chrome.test.ts
  - dashboard/apps/web/src/components/polar/polar-code-workspace.tsx
reported: 2026-11-26
fixed: 2026-11-26
fix_commit:
---

## What was seen

In Polar Code's Live Preview on Windows, "Open in new tab" opened a window
with no way to drag it anywhere or resize it.

## Cause

The link is `/api/agents/preview/<session>/<signature>/<port>/` on the
Polaris's own address, so `contain()`'s window-open handler treated it as a
dashboard screen and opened a Polaris window: title bar hidden
(`titleBarStyle: "hidden"` plus the Window Controls Overlay), the page expected
to draw the region that drags it. Every dashboard screen does (`app-drag-strip`
in the root layout); the preview is the agent's own page and draws none. The
band given to pages without one (`foreignPageCss` on `dom-ready`) was skipped
too, because that check only asked whether the URL was on the Polaris.

The same held for every route handler on the Polaris opened in a window - a
file, a raw paste, a CLI script.

The window also loaded the dashboard's preload, and the bridge's check
(`fromPolaris`) compared only the frame's URL with the Polaris. The preview is
served in a sandbox with an opaque origin, but its URL is the Polaris's, so the
agent's page in its own window passed it.

## Fix

- A window opened on the Polaris for anything that is not a dashboard screen
  (`popupChrome` in `navigation.ts`: `/api`, `/_next`, `/.well-known` and the
  handlers outside `/api`) gets the system's own frame - moves, resizes and
  snaps like any window - and no preload, so no bridge. A hidden title bar
  needs the page to declare its own `app-region: drag` (Electron's custom title
  bar guide), which only the dashboard does.
- A Polaris window whose main frame lands on such a page gets the draggable
  band under the window buttons, as a provider's page already did.
- The bridge answers only a frame whose origin is the Polaris's and whose page
  is a dashboard screen (`isPolarisFrame`).
- A test reads the dashboard's route handlers outside `/api`, so a new one
  that is not classified fails it.

## Unverified

Not run in a real Electron window on this machine (no GUI launches here).
