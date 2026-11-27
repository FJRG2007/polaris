---
id: BUG-0063
title: An action the host service is too old for says "update" with no way to do it
status: fixed-watching
area: security
location: dashboard/apps/security-scans/src/screens/error-line.tsx
related:
  - dashboard/apps/security-scans/src/screens/security-view.tsx
  - dashboard/apps/security-scans/src/screens/firewall-panel.tsx
  - dashboard/apps/security-scans/src/screens/ssh-panel.tsx
  - dashboard/packages/hostd-client/src/client.ts
  - dashboard/apps/web/test/security-scans/screens/error-line.test.tsx
  - dashboard/apps/web/test/security-scans/lib/local-daemon.test.ts
reported: 2026-11-27
fixed: 2026-11-27
fix_commit:
---

## What was seen

Pressing **Restart now** (or any host action newer than the install) on the
machine Polaris runs on, before Polaris had been updated, showed a line of text
asking to update from Settings, with nothing to press. The page did not say
which machine was out of date.

## Cause

The host service refuses an action it does not know with a 400, which the
client already reads as `daemonOutdated`. The screen only rendered that code's
text; no error line on the page could offer an action.

## Fix

- One error line (`ErrorLine`) renders every action failure on the security
  page: the notice, the package, firewall and SSH dialogs.
- `daemonOutdated` says the machine Polaris runs on needs a Polaris update and
  offers **Update Polaris** (`/admin/updates`) to an administrator; anybody else
  is told to ask one.
- An unknown error code reads as the generic failure instead of its key.

## Not exercised

A real host service of an older version (no Docker on the development
machine); the 400 -> `daemonOutdated` mapping is asserted against the client.
