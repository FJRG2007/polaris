# Tab strips crushed their labels on a phone

**Found:** November 2026. **Fixed in:**
`dashboard/packages/ui/src/components/segmented-control.tsx`,
`dashboard/packages/ui/src/components/scroll-row.tsx`, and the hand-drawn
strips listed below.
**Guarded by:** `dashboard/apps/web/test/design/tab-strips.test.tsx`.

## What was seen

On a phone, the UPS screen in Places showed its eight tabs - Overview, Energy,
Power, Battery, Events, Commands, Variables, Settings - as a row of "O...",
"E...", "P...". None of them could be read, so the only way to find a section
was to tap each one in turn. On a desktop the same row looked fine, which is
why it went unnoticed: nothing about it is wrong until the window is narrow.

## What it actually was

`SegmentedControl`, the shared control most detail screens use as their tab
strip, gave every option `min-w-0 flex-1 truncate`. That was written to keep a
set of long labels inside a narrow column, and with two or three options it
did. With eight, `min-w-0` let each option shrink to an eighth of a 360px row,
and `truncate` cut every label down to its first letter. The screen even had
an `overflow-x-auto` wrapper around the control, which never engaged: the
control had already made itself narrow enough to fit.

The hand-drawn underline strips (notifications, a container, a volume, a
server, a drop point, a watched subject) had the same defect another way: a
plain `flex` row with no overflow, so their last tabs ran off the side of the
screen or a two-word label wrapped onto two lines.

## The fix

- `SegmentedControl` is now a `ScrollRow`, and its options are `flex-1
  shrink-0 basis-auto whitespace-nowrap`: they still share the width when they
  fit, and are never narrower than their labels when they do not - the track
  scrolls instead.
- `ScrollRow` keeps the chosen child in view (`aria-current`,
  `aria-selected`, `aria-checked`), on mount, when the row resizes and when the
  choice changes from a link or a key press, so a strip opened on its sixth tab
  shows it.
- A focus ring inside a `ScrollRow` is drawn on the item's own edge
  (`tokens.css`), since a scrolling row clips the outside one.
- The hand-drawn strips became `ScrollRow`s with `shrink-0 whitespace-nowrap`
  tabs, and the UPS screen and the clock's tabs dropped the wrappers that had
  tried to do the control's job.

## What stops it coming back

`tab-strips.test.tsx` renders `SegmentedControl` with the UPS's eight labels
and fails if the track stops being a scrolling `ScrollRow`, if an option can
shrink or truncate, or if the chosen option is not scrolled into view. It also
scans every app's source for a `tablist`, a `role="tab"`, an underline tab, or
a hand-drawn option marked chosen that is `flex-1 truncate`, in a row that
neither scrolls nor wraps. The rule is "Tab strips" in `dashboard/docs/design.md`.
