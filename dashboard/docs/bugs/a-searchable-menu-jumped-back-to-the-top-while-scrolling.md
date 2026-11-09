# A searchable menu jumped back to the top while scrolling

**Found:** November 2026. **Fixed in:**
`dashboard/packages/ui/src/lib/menu-search-focus.ts`.
**Guarded by:** `dashboard/packages/ui/test/menu-search-focus.test.ts`.

## What was seen

Scrolling down Polar's model picker with the mouse wheel kept snapping the list
back up to the search field at its top, so a model further down could not be
reached by scrolling. The same happened in every menu with a search field over a
list long enough to scroll.

## What it actually was

Two pieces of correct behaviour met each other:

- The menu library focuses the menu surface whenever the pointer leaves an
  option. When the wheel scrolls the list, the options slide out from under a
  pointer that has not moved, so the browser fires one of those leaves after
  another.
- A menu with a search field passes the focus the surface gets on to the field
  (`redirectMenuFocus`), so typing keeps going into the search.

That hand-off called `field.focus()` without options. A plain `focus()` scrolls
the focused element into view, and the field sits at the top of the scrolling
list, so each scroll step brought the list back to the top. The same hand-off
also selected the field's text, so after the pointer crossed an option, the next
letter typed replaced the half-typed search instead of adding to it.
`refocusMenuSearch`, used after picking in a menu that stays open, made the same
unscrolled `focus()` call.

## The fix

- The hand-off focuses the field with `{ preventScroll: true }`.
- The text is selected only when focus enters the menu from outside it (the
  menu opening). It is not selected when focus comes back from one of the menu's
  own options.
- `refocusMenuSearch` focuses with `{ preventScroll: true }` as well.

Because the fix is in the shared helper, it covers every menu that uses
`MenuSearch`.

## What stops it coming back

`menu-search-focus.test.ts` imitates the pointer leaving an option. It fails if
the field is focused in a way that scrolls, or if the half-typed search is
selected. Both cases fail without the fix.
