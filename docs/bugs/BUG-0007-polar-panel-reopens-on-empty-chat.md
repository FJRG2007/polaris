---
id: BUG-0007
title: Polar's side panel opens on the old chat, then on an empty one when opened again
status: regressed
area: polar / side panel
location: dashboard/apps/web/src/components/polar/polar-panel.tsx
related:
  - dashboard/apps/web/src/lib/polar/display.ts
reported: 2026-11-21
fixed: 2026-11-21
fix_commit: "fix(polar): Polar opened again in the same tab stays on the chat it was last in"
---

## Regressed

This fix made the old chat come back on every opening within a tab, which
is what was reported again as BUG-0016. The cause and the fix that replaced
this one are there.

## What was seen

Opening the Polar side panel showed an old conversation. Closing it and
opening it again showed a new, empty conversation. Reported weeks before it
was fixed.

## Cause (confirmed in code)

`PolarChat` decides on mount which chat to show. It reopened the remembered
chat when the chat was scoped, when "Reopen the last chat" was on (off by
default), or when `reloaded()` said this was the first chat since the browser
reloaded the page. `reloaded()` answers true only once per page load, so the
first opening after a reload brought the old chat back and every later opening
on the same page started a new one. The test suite asserted that sequence
("starts on a new chat when opened again after a reload"). The full page
`/polar`, the desktop and mobile apps (which draw the same page) had it too.

An earlier fix (`8f471acd3e`) made each tab remember its own chat in session
storage, but the mount still only read it on the same three conditions.

## Fix

On mount, with none of those conditions, Polar now reopens the chat this tab
was last in (its session storage). A tab that asked for a new chat keeps it
empty. The setting still decides how a new visit (a new tab) starts.

## Verified

- `test/polar/panel-reopen.test.tsx`: with the setting off, the panel opened
  after a reload comes back to the old chat and, closed and opened again,
  stays on it. Fails on the code before the fix.
- `test/polar/panel.test.tsx` ("opening Polar again"): the tab's own chat comes
  back with the setting off (fails before the fix); a new chat the tab asked
  for stays new, whatever the setting; a new tab still starts on a new chat.

## Not verified

- Not exercised in a browser.

## If it happens again

The values of `polar.thread` in the tab's session storage and in local storage
before and after closing the panel, and whether "Reopen the last chat" is on.
