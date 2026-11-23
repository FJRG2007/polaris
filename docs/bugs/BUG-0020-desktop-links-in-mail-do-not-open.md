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

Steps 1-4 were exercised in a real Electron run and work;
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

## Narrowed down (2026-11-23)

The owner tried right-click > "Open link in browser" on the same link: that
does nothing either. That menu item calls the main process's `openExternal`
directly, without the mail frame, the page or `window.open`, so the failure is
in step 5: the hand-over from the main process to Windows. The machine's https
default is Brave (`BraveHTML`, registered and installed), and the installed
0.1.57 bundle's `openOutside` is the same code as the source.

Still not seen: whether `shell.openExternal` rejects there (then `rundll32`
runs, and `rundll32` reports success whether or not a browser started) or
resolves without a browser appearing. Neither was observable, because a failure
was only written to the main process's console. The exact Windows-side cause is
therefore still open.

## Fix (desktop 0.1.58, dashboard image)

- **Desktop, `open-external.ts`.** The address is trimmed and normalised
  (`new URL().href`) before any route, and never shortened. When every route
  fails, a dialog says "Couldn't open the link", shows the address and offers
  Copy link, instead of nothing. Every failure is also written to
  `links.log` in the app's logs folder (`%APPDATA%\Polaris\logs`), with one
  previous file kept, so the next report carries the reason.
- **Mail frame (`frameDocument`).** The script decides first what the link
  points at and only cancels the click when it opens it, scrolls to it, or
  refuses its scheme. SVG `<a>` (with `href` or `xlink:href`), image-map
  `<area>` and relative addresses (resolved against the frame's base) are now
  read and opened; before, an SVG link was cancelled and dropped. The link menu
  reads links the same way.

The status stays **open** until the owner confirms links open on 0.1.58. If
they still do not and no dialog appears, `shell.openExternal` is resolving
without a browser starting; `links.log` will then be empty, which is itself
the answer, and the next step is a different route on Windows.

## Regression test

- `desktop/test/main/open-external.test.ts`: a several-thousand-character
  tracking link reaches the system whole; an address with spaces is normalised
  before both routes; `file:`, `javascript:`, custom schemes and UNC paths never
  reach a route.
- `dashboard/apps/web/test/mail/frame-links.test.ts`: SVG, `xlink:href`,
  `<area>`, relative and long links open; an anchor with no address is left
  alone; a custom scheme is refused; the link menu reads SVG links; the frame's
  sandbox has popups and never `allow-same-origin`.
- Real Electron run (headless, `--mute-audio`, CDP clicks, `shell.openExternal`
  recorded instead of called): the desktop's own `openPolarisWindow`, built
  preload and the dashboard's real mail frame and `openLink`. Mail button left
  and middle click, a plain link and a `target=_blank` link all reach
  `shell.openExternal`. This harness is not in the repo yet.
- Not exercised: the real Windows hand-over to a browser, and the dialog.

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
