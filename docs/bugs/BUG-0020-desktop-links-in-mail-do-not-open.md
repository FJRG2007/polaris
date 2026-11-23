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
  - desktop/src/main/default-browser.ts
  - dashboard/apps/web/src/app/(app)/mail/frame-document.ts
  - dashboard/apps/web/src/app/(app)/mail/sanitize.ts
  - dashboard/apps/web/src/components/rich-text/code-run.tsx
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

## Second fix (desktop 0.1.60, dashboard image)

The first fix could only say "Couldn't open the link" when a route rejected.
The owner's report (right-click > Open link in browser does nothing either,
Windows 11, Brave as the https default) fits Windows' hand-over resolving
with no browser appearing, which no dialog can catch, and `rundll32` reported
success whether or not anything opened. So opening a link no longer depends
on that hand-over alone:

- **Windows (`default-browser.ts`).** The default browser's registered command
  is read (`HKCU\...\UrlAssociations\<scheme>\UserChoice` ProgId, then
  `HKCR\<ProgId>\shell\open\command`), parsed the way Windows does (quoted or
  unquoted `.exe`, `%1`/`%L`, `%VAR%`, `CommandLineToArgvW` quoting) and
  started with an argument array, never a shell; `cmd`, PowerShell,
  `rundll32` and other programs that run their argument are refused. That
  start is the first route because its success can be seen (the process was
  created). `shell.openExternal` is the second route (a Store browser has no
  command). `rundll32` is gone.
- **macOS / Linux.** `shell.openExternal`, then `open` / `xdg-open`, whose exit
  code is checked.
- **Copy link always reachable.** The dialog with Copy link when every route
  fails; Copy link on every link's right-click menu; and the tray menu keeps
  "Copy last link opened" for a link the system took without a browser
  showing it.
- **Mail relative links.** The sanitizer still strips the message's `<base>`
  but resolves relative links against it first; the frame no longer resolves
  a still-relative link against the Polaris page (it opened a Polaris
  address) and refuses it instead.
- **Other frames.** The code-block page preview had no popups: a
  `target=_blank` link was blocked and a plain one navigated the frame into a
  page that refuses framing. It now has `allow-popups
  allow-popups-to-escape-sandbox` and opens absolute links in a new window
  (outside the app in the desktop). Agent session HTML artifacts gained
  `allow-popups-to-escape-sandbox`.

Not yet confirmed on the owner's machine: whether Brave starts from the
direct launch there. Status stays **open** until they confirm on 0.1.60.

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
  `shell.openExternal`.
- `desktop/test/main/default-browser.test.ts`: Brave, Chrome (current and
  older), Edge, Firefox, Opera (unquoted path), Outlook command lines;
  `%VAR%` expansion; localised `reg.exe` output; ProgId traversal and
  shell programs refused.
- `desktop/test/electron/links/` (`npm run test:electron`): the harness above,
  now in the repo, with the registry reader, launcher, `shell.openExternal`,
  dialog and clipboard injected as recorders. Also checks the dialog and Copy
  link when every route fails.
- `dashboard/apps/web/test/mail/message-base.test.ts`,
  `dashboard/apps/web/test/rich-text/preview-links.test.ts`.
- Not exercised: a real browser starting from the direct launch (never run
  here, so no browser opens on this machine).

## History of earlier attempts

- `3b611440ab` (2026-11-20) - mail: links in the frame were popups out of a
  sandbox; the frame now posts the address and the page opens it through
  `openLink`, the one path for every outside link.
- `8f63af237d` - desktop: an outside link that fails to open is logged and
  retried through the Windows URL handler instead of being dropped.
- `036c284d0f` (2026-11-21, desktop 0.1.48, BUG-0006) - a plain click on a link
  to another site is taken by the preload and opened outside before the page
  starts to leave. Main frame only; it never sees clicks inside the mail frame.
- `2b4a9d8d07` (desktop 0.1.58) - the dialog with Copy link, `links.log`, and
  SVG/area/relative links in the mail frame. Did not fix the owner's case.
- `f0988c488e` - Polaris's own right-click menu everywhere, including over a
  link in a message (posted out of the frame as `polarisMailMenu`).

## If it happens again

Desktop version, the link's address (Copy link), whether right-click > Open link
in browser works for it, and the default browser on that machine.
