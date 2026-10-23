---
name: app-logos
description: Procedure for drawing a new Polaris app logo, or redrawing one, so it matches the existing set (the colored gradient glyphs in the launcher, sidebar, search, store, home widgets and install wizard). Use whenever an app is added to the registry (dashboard/apps/web/src/lib/apps.ts), an app's logo is changed, or a change touches dashboard/packages/ui/src/shell/app-logo.tsx or its tests.
---

# App logos

Every app logo is drawn in one file, `dashboard/packages/ui/src/shell/app-logo.tsx`,
and rendered through one component, `AppLogo`. The drawing rules are written in
that file's header comment. This skill is the procedure that applies them. Do not
restate the rules anywhere else. If a rule changes, change it in that comment.

## Before drawing

1. Read the header comment of `app-logo.tsx` and three or four existing entries in
   `LOGOS`, including one that uses `mask` (`tools`), so the new glyph is drawn
   the way the others are.
2. Use the app's registry id as the key, not its display name. `home` is Places,
   `games` is Game servers and `admin` is Management. Check `POLARIS_APPS` in
   `dashboard/apps/web/src/lib/apps.ts`.
3. Pick the glyph: one plain object that names what the app is for (a folder, a
   shield, a house). Make it original. Never copy, trace or name another
   product's icon or brand, in the code, comments, commits or tests.

## Drawing it

Add one entry to `LOGOS`, with a one-line comment above it saying what the glyph
shows. Follow the existing entries:

- **Canvas.** 32 x 32 units. The glyph stays inside 4..28 on both axes, so every
  logo has the same optical size and margin.
- **Two layers.** Draw the body with `base`, the three-stop gradient. Draw one
  part that catches the light with `face`, the lighter two-stop gradient. Never
  write `url(#...)` or a gradient of your own. Use the fills `draw` receives.
- **White details.** A cut-in detail (a keyhole, a line, a dot) is drawn with
  `WHITE`, or with `LINE` for strokes. It always sits inside a filled shape,
  never on the page.
- **Soft geometry.** Corner radii 3 to 7 units. Strokes and thin parts 2.6 to 3.4
  units, never thinner, so the glyph still reads at 16px.
- **Overlaps.** To cut one shape out of another, use the `mask` id passed to
  `draw` (see `tools`). Never hardcode an id: the same logo can appear twice on
  one page.

## Picking the palette

`palette` is three hex stops, lightest first: `[light, mid, deep]`.

- Roughly the 300 / 500 / 700 steps of one hue family (for example
  `["#A5B4FC", "#6366F1", "#4338CA"]`). The deep stop may drift toward a
  neighbouring hue, as `drive` does from amber to orange.
- Mid-to-deep stops only. No near-white or near-black end, so the logo keeps its
  shape on a light page and on a dark one.
- Read every existing `palette` first. Choose a hue family that no app next to
  it in the launcher's default order already uses. If the free hues run out,
  pick the one furthest from both neighbours.

## Check it

1. Write the logo's file: `npm run logos -w @polaris/ui` renders every entry in
   `LOGOS` to `packages/ui/assets/app-logos/<id>.svg`, the file the public site
   and every other surface outside the dashboard shows. Commit the files with
   the change; `packages/ui/test/app-logo-files.test.ts` fails while they differ.
   Never edit those files by hand, and never point a surface at another copy.
2. `packages/ui/test/app-logo.test.tsx` covers every id in `LOGOS`, and
   `apps/web/test/navigation/app-launcher.test.tsx` fails for a registered app
   with no logo. Run both.
3. Render it before calling it done. Draw the new logo next to three existing
   ones at 16, 24 and 40 px, on a light and a dark background, in a headless
   browser (never a visible window). Look at the screenshot. At 16px the glyph
   must still be recognisable, and its weight must match its neighbours. Keep
   the preview page and screenshots in the scratchpad, never in the repo.
4. The logo is decorative: `AppLogo` already sets `aria-hidden`, and the app's
   name is always written beside it. Do not add a title or label.

Surfaces that show an app reuse `AppLogo` with the app's previous icon as
`fallback`, so an installed app without a logo keeps its icon. A new surface
that shows apps does the same. Never draw a logo inline.
