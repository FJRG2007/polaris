---
id: BUG-0078
title: A dialog form opens again holding what was typed the last time
status: fixed-watching
area: ui
location: dashboard/packages/ui/src/lib/use-reset-on-open.ts
related:
  - dashboard/packages/ui/test/dialog-form-reset.test.tsx
  - dashboard/apps/web/test/design/dialog-form-reset-guard.test.ts
  - dashboard/apps/web/test/account/phone-card.test.tsx
  - dashboard/apps/web/src/app/(app)/account/phone-card.tsx
reported: 2026-11-28
fixed: 2026-11-28
fix_commit:
---

## What was seen

Account > Phone numbers > "Add phone number": a number typed and cancelled was
still in the box the next time the dialog opened. The same happened in many add,
invite, connect and edit dialogs across the dashboard and the apps.

## Cause

`DialogContent` (Radix) unmounts its children while closed, so state kept inside
the content always starts again. Most dialogs keep their fields in the component
that renders the `Dialog` root instead, and that component stays mounted while
the dialog is closed, so its `useState` values survived every close - typed
values, errors, "code sent" steps, and passwords or codes kept in memory.

## Fix

`useResetOnOpen(open, reset)` in `@polaris/ui` resets the owner's form state
while rendering the open that follows a close (so no frame shows the old
values), and again 400 ms after a close (after the exit animation), so secrets
do not stay in memory. A flow that steps through a confirm passes the open state
of the whole flow (Add phone: number -> password -> save), so the step in
between keeps what was typed.

A codemod applied it to 83 owners; the rest were checked by hand, dialog by
dialog in the components that render several. `dialog-form-reset-guard.test.ts`
parses every Dialog and Sheet root and judges each on its own open state: a
field passes when a reset tied to that dialog's open state, a render-time
reseed, or every action that opens the dialog puts it back. A component with
two dialogs and a reset for only one fails for the other. The few fields kept
on purpose (an import's progress, the map style) are listed with the reason,
and the test fails when an entry is no longer needed.
