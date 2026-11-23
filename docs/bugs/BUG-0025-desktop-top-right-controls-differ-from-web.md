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

## Reopened 2026-11-23: the video viewer, the seam, the picture that would not move

Reported again with the picture viewer's zoom controls under the window buttons,
"and in Deploy", plus an ugly edge along the buttons' band, worse with a dialog
open, and a picture at fit that could no longer be dragged.

- **Video viewer** (`apps/web/src/components/video-viewer.tsx`): `fixed inset-0`
  with its close at the top right and no `clearWindowControls`. The sweep let it
  through because any `bg-black/` surface counted as a backdrop.
- **The seam**: the window buttons are one flat colour, read by the desktop
  preload (`desktop/src/shared/title-bar.ts`) as the first *opaque* background
  under them. With a dialog open that skipped the dimmed backdrop and took the
  undimmed page, so a light block sat in the corner of a dark screen. A
  full-window surface moved below the band also left the app's header,
  undimmed, with its bottom border showing above it.
- **The picture at fit**: the shared gesture engine (d75d1ab73b) only moved a
  zoomed picture; the viewer's own drag before it moved one at any zoom.

### Fix

- The preload composites every layer at the point (`elementsFromPoint`, each
  background's alpha times its opacity) and reads again on `transitionend` /
  `animationend`, so the buttons take the dimmed colour once a backdrop has
  faded in. `rgbaOf` also reads `rgb(r g b / a)` and `color(srgb ...)`.
- `windowControlsBand(background)` (`packages/ui/src/shell/window-controls.ts`):
  a fixed layer filling the band above a full-window surface with its own
  ground (and dragging the window). Used by the picture and video viewers, the
  presenter, the slide show, the audience show, the arcade player and phone
  pad, and the Places screensaver.
- `useZoomPan({ looseAtFit: true })`: a single pointer moves an unzoomed
  picture, and it stays where it is let go until the zoom changes, it is reset,
  or another picture opens. Only the picture viewer passes it; cameras and call
  tiles keep the old behaviour.
- The sweep (`apps/web/test/ui/window-controls-band.test.ts`) reads each JSX
  `className` as a whole - every string in a `cn(...)`, conditionals, and the
  right-hand side of same-file constants - over `apps/*/src` and
  `packages/*/src`, and treats `fixed` + `inset-0`/`inset-y-0`, or `top-0` with
  a right edge, as reaching the buttons. Only a childless layer counts as a
  backdrop. Checked by pointing it at the old video viewer, which it names.

### Verified

- `packages/ui/test/image-viewer-window-controls.test.tsx`: the viewer starts
  below the band, its zoom and close have no ancestor pinned back to the top,
  and the band above it has the viewer's ground.
- `apps/web/test/components/use-zoom-pan.test.tsx`: a drag moves an unzoomed
  picture with `looseAtFit`, it stays, and a zoom puts it back.
- `desktop/test/shared/title-bar.test.ts`: an 80% black backdrop over a white
  header gives `#333333`; nothing opaque gives no colour.

### Not verified

- The real Electron window was not run. Both items that were open here are
  closed in "Pickers and menus" below.

### If it happens again

A control under the buttons: the sweep names the file unless the surface goes
through `clearWindowControls`. A lighter or darker block under the buttons:
compare `composite(...)` with what is drawn there at the point the preload
samples (just left of the buttons, 8px down).

## Pickers and menus 2026-11-23

- **Controls portalled into the bar** (Deploy's project and environment,
  Analytics' scope and site, the firewall scope): the bar's copy showed at
  `md:` (window width) while the bar clips by its own width, so in the app,
  between 768 px and 768 px plus the buttons, the pickers were cut off and the
  page copy was hidden. The bar's copy now shows at `tb-md:`, and the page copy
  at `md:hidden under-tb-md:flex`. `TitlebarWidths`
  (`packages/ui/src/shell/titlebar-widths.tsx`, mounted in the shell's frame)
  measures the frame's content box, the width `tb-*` queries, and lists on
  `<html data-titlebar-under>` the screens it is narrower than; the preset's
  `under-tb-<screen>:` variant matches that. Both read `TITLEBAR_SCREENS`
  (`shell/titlebar-screens.ts`).
- **Menus, lists, popovers, the calendar, the virtual keyboard and the diagram
  editor's popovers** take the band in their top collision padding through
  `clearOfWindowControls` (`shell/window-controls.ts`), which reads
  `navigator.windowControlsOverlay` when the popper renders.

### Verified

- `apps/web/test/ui/titlebar-widths.test.ts`: `under-tb-md:` compiles to
  `:root[data-titlebar-under~="md"]`, `TITLEBAR_SCREENS` equals Tailwind's
  screens, and every `HeaderPortal` user has no window-width class in the
  portal (or on an element it places by name) and a page copy that comes back
  with `under-tb-*`. Pointing it at the old project shell fails.
- `packages/ui/test/window-controls-poppers.test.tsx`: the padding is unchanged
  in a browser and with the overlay off, takes 47 px at the top with it on;
  every Radix popper content in `packages/ui` and the diagram editor goes
  through `clearOfWindowControls` (fails if one does not); `TitlebarWidths`
  writes and clears the attribute.
- Headless Chrome (`--mute-audio`), band simulated as 138 x 47 px and a stubbed
  `windowControlsOverlay`, widths 700/820/900/1100/1440, light and dark, with
  and without a dialog: the picture viewer's controls and the dialog's close
  never overlap the buttons; at 820 and 900 (window past `md`, bar under it) the
  page copy shows and the bar copy is hidden, at 1100 and up the reverse, never
  both or neither; a menu's available height drops from 728 px to 681 px with
  the band (760 - 63 - 16).

### Not verified

- The real Electron window, and the real `windowControlsOverlay` geometry.
