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
  - dashboard/packages/ui/src/tailwind-preset.ts
  - dashboard/apps/web/src/app/(app)/mail/composer.tsx
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
- The bar picks what it shows by the room it has, not by the window: the shell's
  header sits in `.app-titlebar-frame`, a size container (`titlebar`) that keeps
  the window buttons' width clear, and its items switch on `tb-sm:`/`tb-lg:`/
  `tb-xl:` (`packages/ui/src/tailwind-preset.ts`), container queries at the
  screen breakpoints' own px widths. In a browser the frame is the whole window,
  so they equal `sm:`/`lg:`; in the app a 1100 px window shows what a 962 px
  browser shows. Switched: the header's gaps and padding, the search field
  (`lg:flex-1`) and its trigger, the Polaris mark and name, the scope switcher's
  name and chevron, Polar's label and shortcut.
- The mail composer goes through `clearWindowControls` (it was missed by the
  sweep: `fixed` and `inset-0` are in different strings there), and its full
  posture's `md:inset-10` top is `2.5rem` plus the band.

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
- `apps/web/test/ui/titlebar-widths.test.ts`: Tailwind with the preset emits
  `@container titlebar (min-width: 640px)` and the rest for every screen width,
  the same px as the `sm:` media query; the header's items use `tb-*`; the
  composer's posture goes through `clearWindowControls`. The ui test asserts no
  window-width variant is left anywhere inside the rendered shell frame.
- Headless Chrome on the rendered `AppShell` (its real classes, Tailwind over
  them, the palette trigger's classes from source), with the buttons' 138 px
  simulated as the frame's end padding: at a 1078 px viewport the search shows
  as a field with no buttons and as an icon with them; at 1178 px with them it
  is a field again (bar 1040 px); at 978 and 1008 px with none it is an icon;
  the account control ends 16 px before the simulated buttons.
- `npm run build` of `apps/web` (after `npx prisma generate` in packages/db; the
  first attempt on 2026-11-23 failed on a stale Prisma client, not on this
  change).

## Not verified

- The real desktop window was not run: the overlay geometry (138 x 47 px) is
  read from `desktop/src/main/windows.ts` and `desktop/src/shared/title-bar.ts`,
  not observed. No change in `desktop/` was needed.
- The real `env(titlebar-area-*)` values in Electron were not observed; the
  frame's end padding was simulated in Chrome.
- Controls a page portals into the header slot (Deploy's project and
  environment pickers) keep their own window-width classes; the left group
  still clips them where the bar is full.

## If it happens again

Check whether the control is pinned to the top edge without going through
`clearWindowControls`; the sweep test names the file. For a header item, check
it is a direct item of a header group or has a `title`, and that the left group
is what overflows.
