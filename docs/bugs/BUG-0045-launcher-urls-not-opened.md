---
id: BUG-0045
title: Typing an address into the launcher or the search panel does not offer to open it
status: fixed-watching
area: desktop
location: dashboard/packages/core/src/typed-url.ts
related:
  - clients/desktop/src/main/launcher.ts
  - clients/desktop/src/shared/launcher.ts
  - dashboard/apps/web/src/components/command-palette.tsx
reported: 2026-11-25
fixed: 2026-11-25
fix_commit:
---

## What was seen

Typing an address such as `example.com` or `https://example.com/docs` into the
desktop launcher, or into the dashboard's search panel, offered only "Search
the web", never to open the address itself.

## Cause

The launcher's rows (`rowsFor` in `clients/desktop/src/main/launcher.ts`) had
no address row, and the search panel (`command-palette.tsx`) had none either.

## Fix

- One shared rule, `typedUrl` in `dashboard/packages/core/src/typed-url.ts`
  (Flow Launcher's Url plugin rules): `http(s)://` and `mailto:` as typed,
  `https://` added to a bare domain, `http://` to `localhost`, IPv4 and
  `[IPv6]` with an optional port. Pure numbers, text with spaces and every
  other scheme (`file:`, `javascript:`, custom ones) are never offered.
- The launcher's first row is "Open <host>", opened through `openExternal`
  after the safe-URL check; the search panel's first row opens the address in
  a new tab with `noopener`.

## If it happens again

Note exactly what was typed and whether the row was missing or did nothing
when chosen.
