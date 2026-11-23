---
id: BUG-0025
title: In Polaris desktop the top right of the window shows different or missing buttons compared with the web
status: fixed-watching
area: desktop
location: dashboard/packages/ui/src/shell/window-controls.ts
related:
  - dashboard/packages/ui/src/styles/tokens.css
  - dashboard/packages/ui/src/shell/app-shell.tsx
  - dashboard/packages/ui/src/components/dialog.tsx
  - dashboard/apps/web/src/app/(app)/apps/deploy/service-detail.tsx
  - desktop/src/main/windows.ts
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "fix(ui): the desktop app's window buttons never cover a control the web shows"
---

## What was seen

In the desktop app the top-right corner of the window showed different buttons
than the same dashboard in a browser. The window's own minimize, maximize and
close were expected there; other controls were different or missing.

## Cause (confirmed in code)

The desktop window has no title bar (`titleBarStyle: "hidden"` with
`titleBarOverlay`, `desktop/src/main/windows.ts`): the system's buttons are
drawn over the top right of the page, about 138 px wide and 47 px tall at 100%
zoom, and the page is told where through `env(titlebar-area-*)`. No header
control is gated on the desktop bridge (only the update button and the account
menu's "Servers" are added there, by design). The differences all came from
that overlay:

| Where | Desktop vs web | Cause |
|-------|----------------|-------|
| Deploy service, database and volume panels | Bell, follow logs, push, full screen and close sat under the window buttons: visible in a browser, unreachable in the app | The panels pin themselves with `top-0 h-full`, so their header is in the band the buttons cover |
| Every dialog that fills a phone-width window (`max-sm:top-0`, wide dialogs and `max-sm:inset-0` editors) | Close and the dialog's own top-right actions under the buttons when the window is narrow | Same: pinned to the top edge with no room for the band |
| Left drawers (navigation, Polar and Polar settings sidebars, calendar), the map viewer, the wall panel sheet | Their top edge under the band; their right end reaches the buttons in a narrow window | `top-0` / `inset-0` placement |
| Image viewer, presenter view, slide show, arcade game player and phone pad, Places screensaver, audience show | Close / end / menu in the top right under the buttons | `fixed inset-0` surfaces outside the dialog primitive |
| The header itself | At the same window width the app has about 138 px less room; the left side (app switcher, scope, a page's header controls such as Deploy's project and environment) ran on under the search and account controls | The left group shrank (`min-w-0`) but did not clip, so its overflow painted under the controls on the right |
| Header items that only carry a tooltip (badges, status marks) | Tooltip in a browser, nothing in the app | The header is the window's drag region and a drag region swallows hover; only a fixed list of interactive roles was exempt |

## Fix

One shared rule, `clearWindowControls` (`packages/ui/src/shell/window-controls.ts`):
it reads a surface's own classes and, wherever it is pinned to the top
(`top-0`, `inset-0`, `inset-y-0`, at the base, `max-sm:` or `max-md:`), moves
that edge to `--window-controls-height` and takes the band off a full-window
height at the same width. `--window-controls-height` is `0px` in a browser, so
nothing moves there.

- `DialogContent` applies it to every dialog, so the deploy panels, the
  phone-width full-screen dialogs and the drawers start below the buttons with
  no change at the call sites. (`SheetContent`, Polar's panel and toasts already
  placed themselves against the band.)
- The full-window surfaces that are not dialogs pass their classes through it.
- The header's left group clips at its own edge (`overflow: clip` with a 0.5rem
  clip margin, so focus rings and badges survive); the account controls are
  `shrink-0` and always whole, ending where the window buttons begin
  (`--window-controls-width`, now a token).
- Every item in the bar (`.app-titlebar > * > *`) and anything with a `title`
  is `app-region: no-drag`; only the gaps between items move the window.

## Verified

- `packages/ui/test/window-controls.test.tsx`: the header renders the same
  actions with `window.polarisDesktop` present as without it, the account
  controls sit in `.app-titlebar-end`, the left group clips, the tokens reserve
  the buttons' width and exempt every bar item from the drag region, the helper
  cases, and a dialog with the service panel's placement starts below the band.
- `apps/web/test/ui/window-controls-band.test.ts`: a sweep of `packages/ui` and
  every `apps/*/src` fails on any `fixed inset-0` surface (other than a
  see-through backdrop) that neither goes through `clearWindowControls` nor
  places itself against `--window-controls-height`. It found two more sites
  (arcade phone pad, audience show), now fixed.
- `npm run build` of the dashboard.

## Not verified

- The real desktop window was not run: the overlay geometry (138 x 47 px) is
  read from `desktop/src/main/windows.ts` and `desktop/src/shared/title-bar.ts`,
  not observed. No change in `desktop/` was needed.
- The header still picks what it shows (labels, the search field) by window
  width, not by the width left beside the buttons, so at a width where the bar
  is full the app clips the left side sooner than a browser does. Moving the
  header's breakpoints to a container query on the usable width is the
  follow-up that would make the two identical at every width.
- The mail composer's full posture (`md:inset-10`, 40 px from the top) still
  overlaps the band by about 7 px at its top-right corner; its own buttons are
  below that, so nothing is covered.

## If it happens again

Check whether the control is pinned to the top edge without going through
`clearWindowControls`; the sweep test names the file. For a header item, check
it is a direct item of a header group or has a `title`, and that the left group
is what overflows.
