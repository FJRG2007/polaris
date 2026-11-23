---
id: BUG-0030
title: The @ picker is a small desktop popover on an iPhone
status: fixed-watching
area: chat
location: dashboard/apps/web/src/components/rich-text/suggestion.tsx
related:
  - dashboard/apps/web/src/components/rich-text/block-menu.tsx
  - dashboard/apps/web/src/components/rich-text/emoji-suggestion.tsx
  - dashboard/apps/web/src/app/(app)/chat/composer.tsx
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "fix(chat): a message goes out at once, the @ list starts from who is here, and the phone docks it"
---

## What was seen

On an iPhone the @ list was the desktop popover: narrow, anchored at the caret
near the keyboard, with small rows.

## Cause (confirmed in code)

Every list under the caret (@, #, / and :) mounts through `mountPopup`, which
only ever handed the element to the suggestion plugin's Floating UI mount - a
caret-anchored popover sized for a mouse. Nothing distinguished a phone.

## Fix

- `mountPopup` docks the list on a phone (`(max-width: 640px) and (pointer:
  coarse)`), the way Discord and WhatsApp mobile do: full visible width, its
  bottom on the composer box (`data-popup-dock`), max height bounded by the room
  above it in the visual viewport (`dockFrame`, pure), safe-area insets, and
  re-placed on `visualViewport` resize/scroll and box resize. Rows are 48 px
  with 32 px faces. Picking still uses mouse-down with `preventDefault`, so the
  editor keeps focus and the keyboard stays open; a scroll gesture never picks.
- One change for all four lists: the @/# list, the "/" block menu and the ":"
  emoji list share `mountPopup` and `POPUP_LAYER_CLASS`. Desktop is unchanged.

## Verified

- Unit: `dockFrame` in `test/rich-text/mention-known.test.ts`.
- Not exercised: real iOS Safari, and the headless 390x844 check in en-US and
  es-ES was not run in this change. No new visible text was added.
