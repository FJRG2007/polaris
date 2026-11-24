---
id: BUG-0031
title: The desktop voice widget shows initials instead of people's profile pictures
status: fixed-watching
area: desktop / calls
location: clients/desktop/src/main/voice-widget.ts
related:
  - clients/desktop/src/shared/voice-widget.ts
  - clients/desktop/src/renderer/voice-widget.ts
  - clients/desktop/src/renderer/voice-widget.html
  - clients/desktop/src/preload/app.ts
  - dashboard/apps/web/src/app/(app)/chat/desktop-voice-widget.ts
  - dashboard/apps/web/src/lib/desktop-bridge.ts
reported: 2026-11-23
fixed: 2026-11-23
fix_commit: "feat(desktop): the voice widget shows faces and looks like Discord's, with its options"
---

## What was seen

In a call, the desktop voice widget drew a coloured circle with initials for
everybody, even for people who have a profile picture that the call room
itself shows.

Expected: each person's picture, as in the call, and initials only for somebody
with no picture (or whose picture cannot be loaded).

## Cause (confirmed in code)

The picture never got to the widget, for three reasons stacked on top of
each other:

1. The dashboard never sent one. `voiceWidgetState` published `id`, `name`,
   `speaking`, `muted` and `deafened`, and no account id or picture path.
2. The desktop could not have accepted one. The person schema in
   `clients/desktop/src/shared/voice-widget.ts` is a `strictObject`, so a page that
   added a field would have had its whole state refused and the widget closed.
3. The widget could not have loaded one either. Its page is a local file with
   `default-src 'none'` (no `img-src`), and it has no sign-in to the Polaris:
   `/api/avatar/<id>` answers 401 to anyone not signed in or seated in the call.

## Fix

- The dashboard adds `picture` (`/api/avatar/<userId>`, none for a guest), but
  only for an app that says it draws faces (`voiceWidgetPictures` on the
  bridge). An older app never sees the field, so its strict schema stays happy.
- The desktop's schema takes an optional `picture`. The main process resolves it
  against the origin of the page in the call (only a plain path on that same
  origin, `serverPath`), fetches it with that page's session, so its sign-in or
  guest seat applies, keeps only a PNG or JPEG of avatar size (the same checks
  as notice icons), scales it to 64 px and sends it to the widget as a data URL
  once per face. No picture (the blank pixel), a refusal or a timeout leaves the
  initials.
- The widget's CSP allows `img-src data:` and nothing else. A picture that fails
  to decode is removed, so the initials under it show.

## Verified

- Unit tests: the schema takes and bounds `picture`, and the dashboard sends
  it only to an app that draws faces and never for a guest.
- A headless render of the widget page with faces sent (and one broken) draws
  the pictures, and the initials for the broken and missing ones.
- Not exercised: a real call in the packaged app, including the authenticated
  fetch of `/api/avatar` with the page's session and the overlay over a game.
