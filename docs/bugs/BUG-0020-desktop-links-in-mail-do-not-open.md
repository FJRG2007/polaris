---
id: BUG-0020
title: A link in a received email does nothing when clicked in Polaris desktop
status: open
area: mail / desktop
location: dashboard/apps/web/src/app/(app)/mail/message-body.tsx
related:
  - dashboard/apps/web/src/lib/open-link.ts
  - desktop/src/main/windows.ts
  - desktop/src/main/open-external.ts
  - desktop/src/main/navigation.ts
  - desktop/src/preload/outside-links.ts
reported: 2026-11-23
fixed: null
fix_commit: null
---

## What was seen

In Polaris desktop, clicking a link inside a received email - for example a
button with a link in it - does nothing, however many times it is pressed.
Reported before; still happening.

## The path a click takes

1. The message is drawn in a sandboxed `srcdoc` frame
   (`sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`,
   no same-origin) with `<base target="_blank">`.
2. The frame's own script (`follow` in `frameDocument`) cancels the click and
   posts `{ polarisMailOpen: href }` to the page.
3. The page checks it (`framedOpenHref`) and calls `openLink`, which calls
   `window.open(href, "_blank", "noopener,noreferrer")`.
4. Desktop's `setWindowOpenHandler` (`contain` in `windows.ts`) classifies the
   address with `openVerdict`, denies the window and calls `openExternal`.
5. `openOutside` (`open-external.ts`) calls `shell.openExternal`; on Windows a
   rejection is retried through `rundll32 url.dll,FileProtocolHandler`. A
   failure of both is only logged, so on screen it is "nothing happened".

## Cause

Not confirmed yet. Steps 1-4 were exercised in a real Electron run and work;
the failing step has not been observed.

What was run (headless Electron 44.3.0, hidden window, `--mute-audio`, clicks
sent as real input through the browser's input router with CDP
`Input.dispatchMouseEvent`):

- The desktop's own `openPolarisWindow` (so the real `contain`, window-open
  handler and `will-navigate` guard), the built preload `app.js` and the real
  right-click menu, against a local server sending the live `/mail` frame
  headers.
- The dashboard's real `frameDocument`, `framedOpenHref` and `openLink`, with a
  typical email button (`<td><a href="https://..." target="_blank">`).
- `shell.openExternal` replaced by a recorder so no browser was started.

Results - every case reached `shell.openExternal` with the right address:

| Click | Result |
|-------|--------|
| Mail button, left click | opened outside |
| Mail button, middle click | opened outside |
| Plain link in the page (no target) | opened outside (preload path) |
| `target=_blank` link in the page | opened outside (window-open path) |
| Mail frame with its script removed (native `<base target=_blank>` popup) | window-open handler reached |

So the remaining candidates, none of them proven:

- **The OS hand-off (step 5).** `shell.openExternal` and the `rundll32`
  fallback both failing on Windows for the specific address (email tracking
  links are long and heavily escaped). A failure there is only written to the
  main process's console, which an installed app does not keep anywhere, so it
  is invisible both to the person and to us.
- **The message's own markup.** The frame script calls `preventDefault()`
  before it checks the address, so any link it cannot read as http(s) or
  mailto is swallowed silently: an SVG `<a>` (its `href` is not a string), a
  relative or custom-scheme address. An `<area>` link is not seen by the
  script at all.
- **An older client.** The installed app on the reporting machine was 0.1.56
  at the time of this entry.

## Fix

None yet. Next steps, in order:

1. Get the failing message: the raw `href` of the button (Copy link from the
   right-click menu), and whether "Open link in browser" from that same menu
   works. The menu goes straight to step 5, so this splits "the click never
   arrives" from "Windows refuses the address".
2. Make step 5 visible: when `openOutside` returns false, tell the page so it
   can show "Couldn't open the link" with Copy link, instead of nothing.
3. In the frame script, cancel the click only once the address is known to be
   openable, and read SVG `<a>` and `<area>` links too.

## Regression test

The harness used above (desktop `openPolarisWindow` + preload + real mail frame,
CDP clicks, recorded `shell.openExternal`) is to be added under
`desktop/test/` as the regression test once the cause is confirmed.

## History of earlier attempts

- `3b611440ab` (2026-11-20) - mail: links in the frame were popups out of a
  sandbox; the frame now posts the address and the page opens it through
  `openLink`, the one path for every outside link.
- `8f63af237d` - desktop: an outside link that fails to open is logged and
  retried through the Windows URL handler instead of being dropped.
- `036c284d0f` (2026-11-21, desktop 0.1.48, BUG-0006) - a plain click on a link
  to another site is taken by the preload and opened outside before the page
  starts to leave. Main frame only; it never sees clicks inside the mail frame.
- `f0988c488e` - Polaris's own right-click menu everywhere, including over a
  link in a message (posted out of the frame as `polarisMailMenu`).

## If it happens again

Desktop version, the link's address (Copy link), whether right-click > Open link
in browser works for it, and the default browser on that machine.
