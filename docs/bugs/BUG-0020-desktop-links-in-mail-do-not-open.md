---
id: BUG-0020
title: A link in a received email does nothing when clicked in Polaris desktop
status: open
area: mail / desktop
location: dashboard/apps/web/src/app/(app)/mail/message-body.tsx
related:
  - dashboard/apps/web/src/lib/open-link.ts
  - clients/desktop/src/main/windows.ts
  - clients/desktop/src/main/open-external.ts
  - clients/desktop/src/main/default-browser.ts
  - dashboard/apps/web/src/app/(app)/mail/frame-document.ts
  - dashboard/apps/web/src/app/(app)/mail/sanitize.ts
  - dashboard/apps/web/src/components/rich-text/code-run.tsx
  - clients/desktop/src/main/navigation.ts
  - clients/desktop/src/preload/outside-links.ts
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

## Why it stayed silent for weeks (2026-11-24, desktop 0.1.93)

Reported again from Settings > Updates: the commit links do nothing. The
Windows busy cursor shows for a moment, then no tab. The owner was on 0.1.87
and 0.1.88. What was checked on that machine (read-only), and what it shows:

- **The click gets to the browser.** The commit link is a plain
  `<a target="_blank">` (`update-changelog.tsx`), which goes through
  `setWindowOpenHandler` to `openExternal`. The installed 0.1.88 `app.asar`
  has the same `routesFor` code as the source. The busy cursor is Windows
  starting `brave.exe`.
- **The browser gets the right command line.** A stub exe started through the
  real `registeredLaunch` + `launchDetached`, with the machine's real
  `BraveHTML` command, received
  `--single-argument https://.../commit/abc123?x=1&y=2#frag` as one argument,
  unchanged. Quoting, `&` and `#` are ruled out.
- **The environment is clean.** The running Polaris process's environment
  block (read from its PEB) has no `ELECTRON_*`, `CHROME_*`, `GOOGLE_*` or
  `NODE_OPTIONS`. Polaris and Brave both run at medium integrity, not
  elevated, in session 1. The working directory (`app-0.1.88`) exists. The
  stub confirmed that a started browser inherits Polaris's parent process,
  job, environment and working directory.
- **Brave never received the links.** Brave's history (all three profiles)
  has no commit page opened from outside since 2026-11-12, the last time a
  Polaris commit link worked (transition `AUTO_TOPLEVEL`). Every commit visit
  after that was clicked inside Brave. A cold start does work: Brave's
  current browser process was started at 11:35 by a mail link
  (`--single-argument https://yesim.tech/...`), and history shows that page
  opening from outside at the same second. So the link is lost in the
  hand-over: the step where a second `brave.exe` gives the link to the copy
  already running.
- **Polaris called it a success.** `launchDetached` resolved on the process's
  `spawn` event. That only means `brave.exe` was created, and with Brave
  already running, the created process is just a messenger. Chromium's own
  exit codes say whether the messenger delivered the link.
  `--single-argument` skips the fast path (`chrome_exe_main_win.cc` returns 0
  only from `AttemptFastNotify`, and only with no other switch), so a
  delivered link exits with `NORMAL_EXIT_PROCESS_NOTIFIED` = 24
  (`chrome/common/chrome_result_codes.h`). A refused one exits with another
  code, for example 21, `PROFILE_IN_USE`, which means the messenger could not
  reach the running window. Polaris never read the code, so a refused
  hand-over counted as opened: the second route never ran and the dialog
  never showed.
- **The log could never be written.** `links.log` goes in
  `app.getPath("logs")` (`%APPDATA%\Polaris\logs`). That folder does not
  exist on the owner's machine: Electron names it but does not create it.
  `appendFileSync` into a missing folder throws, and the throw was swallowed.
  "No links.log" said nothing about the routes. Every failure since 0.1.58
  went unrecorded.

So the root cause of "nothing happens" is that a refused hand-over to the
running browser was reported as success, and nothing saw it. Not proven: why
Brave turns down a messenger started by Polaris when Brave is already
running. The environment, arguments, integrity level and click path above
are ruled out. What is left is something the messenger inherits from Polaris
as its parent: its job object, which comes from whatever started Polaris
(the jobs here are held by Task Scheduler and the Program Compatibility
Assistant, and can't be read without elevation), or the foreground hand-off.
With this fix, the next failed click writes Brave's exit code to `links.log`,
and that code names the reason.

### Fix (desktop 0.1.93)

- `launchDetached` (`default-browser.ts`) waits to see what the started
  browser does. Exit 24 or 0 means the link was handed over. Still running
  after 8 s means it became the browser (a cold start). Any other exit
  rejects with the code and what it means.
- `openOutsideOutcome` (`open-external.ts`): a refused hand-over moves on to
  `shell.openExternal`. That route can't confirm anything opened, so the
  outcome is `unconfirmed`, and the person sees "The link may not have
  opened" with the address and Copy link. Every route failing still shows
  "Couldn't open the link". A Store browser, which has no registered
  command, goes straight to the system route with no dialog.
- `links.log`: the folder is created first, and every attempt is written,
  successes too. Each entry has the route, the link's scheme and host (never
  the whole address, which can carry tokens) and, for a failure, the exit
  code.

## The alert after every click (2026-11-24, desktop 0.1.106)

On 0.1.104 the owner saw a Windows alert box, "The link may not have opened",
after clicking a link. `links.log` on that machine (Polaris and Brave not
elevated, Brave the https default):

```
21:44:14.875Z Opening https://github.com through the default browser's registered command failed: ...brave.exe exited with code 1: the browser exited without taking the link
21:44:14.932Z Opened https://github.com through the system's URL handler (not confirmed)
```

### Cause

Two separate things.

- **The alert was ours.** 0.1.93 answered every refused hand-over that
  `shell.openExternal` then accepted with `dialog.showMessageBox`, the native
  alert box, because `shell.openExternal` cannot say whether a page opened.
  In other words, the alert came up every time the direct start was refused,
  even when Windows had accepted the link.
- **Why Brave refused it.** The `brave.exe` that Polaris starts is only a
  messenger, because Brave is already running, and it exits with code 1
  without delivering the link. In Chromium's startup code (read for this entry:
  `chrome/app/chrome_exe_main_win.cc`, `chrome/app/chrome_main_delegate.cc`,
  `chrome/browser/process_singleton_win.cc`,
  `chrome/browser/win/chrome_process_finder.cc`,
  `chrome/common/chrome_result_codes.h`,
  `content/public/common/result_codes.h`), a messenger that delivered exits
  with 0 (`AttemptFastNotify`) or 24 (`NORMAL_EXIT_PROCESS_NOTIFIED`). One
  that could not reach the running window exits with 21 (`PROFILE_IN_USE`,
  which is also returned for `LOCK_ERROR`). The only literal exit 1 is
  `HasDeprecatedArguments`, a command line containing `chromehtml:`, and that
  is not this link. Otherwise 1 is `content::RESULT_CODE_KILLED`, the code a
  process is terminated with. So the messenger did not fail at any point
  where Chromium decides. It was stopped or refused by something it runs
  under. The environment, arguments, integrity level and working directory
  were already ruled out (see above), and every route Polaris had started the
  browser as Polaris's own child: the direct start, and `shell.openExternal`,
  which is `ShellExecuteW` inside the Polaris process. A cold start works,
  and so does a link clicked anywhere else in Windows. That leaves what the
  messenger inherits from its parent, starting with its job object (libuv
  starts a `detached` child without `CREATE_BREAKAWAY_FROM_JOB`, so it stays
  in every job Polaris is in). **Not proven:** which inherited property
  Brave's messenger stops on. Reading the jobs needs elevation, and running a
  browser is off limits on that machine.

### Fix

- **Windows routes (`open-external.ts`).** The order is: the registered
  command (its exit code can be read), then **the desktop's Explorer**
  (`handToShell` in `default-browser.ts`), then `shell.openExternal`.
  `explorer.exe "<url>"` passes the address to the Explorer that is already
  running and exits, so the browser is started by the shell, outside Polaris's
  process tree, the way a link clicked anywhere else in Windows is opened.
  This is the same reason `explorer.exe <program>` is the known way to start a
  program unelevated from an elevated one (Raymond Chen, *How can I launch an
  unelevated process from my elevated process and vice versa?*, The Old New
  Thing, 2013-11-18). The launcher already starts Store apps the same way
  (`explorer.exe shell:AppsFolder\...`). The address goes as one quoted
  argument with `windowsVerbatimArguments`. `new URL().href` encodes quotes
  and spaces, and an address with a comma, which Explorer splits on, skips
  this route and goes to `shell.openExternal`.
- **No native alert for a link, ever.** `dialog` is gone from
  `open-external.ts`. A route that accepted the link with no refusal to read
  shows nothing. Only when every route refused does the window show a small
  card in the corner (`preload/link-notice.ts`): the address, Copy link
  (through the existing clipboard channel) and Close. It does not block, it
  goes away after 15 s, it stays while hovered or focused, and it lives in a
  shadow root.
- **A browser started by Polaris gets a clean environment**
  (`browserEnvironment`). `ELECTRON_*`, `CHROME_*` (for example
  `CHROME_CRASHPAD_PIPE_NAME`, which points a Chromium process at another
  program's crash handler, `components/crash/core/app/crashpad_win.cc`) and
  `NODE_OPTIONS` are dropped, both for the direct start and for Explorer.
  This variable set was already absent on the owner's machine, so this is
  defence, not the fix.
- `links.log` keeps one line per attempt, by scheme and host only. A click
  that the direct start refuses now reads "...failed: ...code 1" followed by
  "Opened ... through the Windows shell (Explorer) (not confirmed)".

Status stays **open** until the owner confirms on 0.1.106 that a link opens in
Brave with Brave already running and no alert. If the log then shows Explorer
taking the link but no tab, the shell's own start is being refused too, and the
machine's jobs are the next thing to read, elevated.

## Regression test

- `clients/desktop/test/main/open-external.test.ts`: a several-thousand-character
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
- `clients/desktop/test/main/default-browser.test.ts`: Brave, Chrome (current and
  older), Edge, Firefox, Opera (unquoted path), Outlook command lines;
  `%VAR%` expansion; localised `reg.exe` output; ProgId traversal and
  shell programs refused.
- `clients/desktop/test/electron/links/` (`npm run test:electron`): the harness above,
  now in the repo, with the registry reader, launcher, `shell.openExternal`,
  dialog and clipboard injected as recorders. Also checks the dialog and Copy
  link when every route fails.
- `dashboard/apps/web/test/mail/message-base.test.ts`,
  `dashboard/apps/web/test/rich-text/preview-links.test.ts`.
- `clients/desktop/test/main/default-browser.test.ts` > `launchDetached`: run against
  this test's own Node exiting with a browser's codes. 24 and 0 resolve; 21
  and 1 reject with the code (this test fails on the 0.1.60-0.1.92 launcher,
  which resolved on spawn); a process still running resolves.
- `clients/desktop/test/main/open-external.test.ts`: a refused hand-over goes to
  Explorer and is `unconfirmed` with nothing shown; an address Explorer can't
  take goes to `shell.openExternal`; only every route refusing is `failed`; a
  Store browser and a delivered hand-over are `opened`; the log names the
  host, never the token; `open-external.ts` has no `dialog`.
- `clients/desktop/test/main/hand-to-shell.test.ts` (`spawn` recorded, nothing
  started): Explorer from `%SystemRoot%`, the address as one quoted verbatim
  argument, detached, without `ELECTRON_*`/`CHROME_*`; comma, quote and space
  addresses and a missing Explorer fall through.
- `clients/desktop/test/main/default-browser.test.ts` > `launchDetached`: a real child
  process exits 24 only when `CHROME_CRASHPAD_PIPE_NAME` and `NODE_OPTIONS`
  did not reach it. This fails when the scrub is removed.
- `clients/desktop/test/main/link-notice.test.ts`: the card takes only the words the
  main process sends.
- Not exercised: Explorer actually starting Brave, and the in-window card
  drawn in a real window. `test/electron/links` checks both, but it was not
  run, because Electron is not launched on the owner's machine.
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
