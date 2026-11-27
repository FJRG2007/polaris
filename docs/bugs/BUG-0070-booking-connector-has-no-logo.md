---
id: BUG-0070
title: The Booking.com connector shows a monogram instead of its logo
status: fixed-watching
area: polar
location: dashboard/apps/web/src/components/polar/connector-marks.tsx
related:
  - dashboard/apps/web/src/lib/polar/connectors/catalog.ts
  - dashboard/apps/web/test/polar/connectors/marks.test.ts
reported: 2026-11-27
fixed: 2026-11-27
fix_commit:
---

## What was seen

Polar settings, connector catalog: the card "Booking.com - Travel - Search stays
and availability as a Booking.com partner." had no logo, only a coloured "BC"
monogram, while every other connector showed its brand mark.

## Cause

The catalog entry's `logo` key is `booking`, and `ConnectorLogo` had no mark for
that key: Simple Icons 13.21.0, the version the other marks were copied from,
had none for Booking.com. A key with no mark silently falls back to the monogram,
and nothing checked that every catalog entry resolved to a mark.

## Fix

Booking.com's mark (slug `bookingdotcom`, Simple Icons 16.38.1, sourced from
Booking Holdings' media room) is copied verbatim as `BookingMark` and registered
under `booking`. It draws in `currentColor` like the other marks, following the
theme's foreground (about 17:1 on the surface in light and dark; the brand blue
#003A9A would be 1.9:1 on the dark surface). The mark table is exported as
`CONNECTOR_MARKS` and a test asserts every catalog entry's key resolves to one.
Booking.com was the only entry without a mark.

## Verification

Web typecheck, `test/polar/connectors` + `test/i18n` (37 files, 3621 tests) and
the production build passed locally before the push; dashboard-ci on the
`booking-logo` branch. The card itself was not looked at in a browser.
