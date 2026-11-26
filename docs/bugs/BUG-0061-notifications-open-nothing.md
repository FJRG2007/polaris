---
id: BUG-0061
title: Security and system notifications open a page that says nothing about them
status: fixed-watching
area: notifications
location: dashboard/packages/core/src/schemas/notifications.ts
related:
  - dashboard/apps/security-scans/src/model/landing.ts
  - dashboard/apps/security-scans/src/screens/security-view.tsx
  - dashboard/apps/security-scans/src/lib/service.ts
  - dashboard/apps/security-scans/src/lib/firewall-service.ts
  - dashboard/apps/web/src/lib/notifications/dispatch.ts
  - dashboard/apps/web/src/lib/notification-service.ts
  - dashboard/apps/web/src/lib/ups/ups-service.ts
  - dashboard/apps/web/src/lib/scan-service.ts
  - dashboard/apps/web/test/notifications/event-targets.test.ts
reported: 2026-11-26
fixed: 2026-11-26
fix_commit:
---

## What was seen

Notifications such as "a server still takes passwords", "a server has no
firewall", "a server needs a restart" or "a UPS stopped answering" opened a
page that did not show what they were about: the security ones landed on the
Images tab, others on a generic list (`/apps/servers`, `/drive`,
`/admin/users`, `/admin/settings`), and some carried no link at all.

## Cause

Every call site chose its own link, nothing checked it, and a notification
written without one opened nothing. The security alerts linked the security
page without saying which section, so it opened on its default tab.

## Fix

- Every catalogue kind now declares `target`, the page where the reader acts on
  it. A notification sent without a link, or stored before this change, opens
  that kind's page (`eventFallbackHref`) - on delivery and when the bell reads
  old rows.
- Security alerts open the server's Host tab at the exact section
  (`?focus=firewall|ssh|updates|restart`), which rings, scrolls into view and
  opens the review dialog.
- Polaris handles what it safely can: it turns on a firewall that would close
  nothing in use (with the 120 s self-rollback), and schedules a needed restart
  for 04:30 unless players were on a game server in the last 24 h or a deploy
  is running, in which case it asks.
- Generic links fixed: disk space opens the server, a UPS report opens its
  Drive folder, a UPS that stopped answering opens that UPS, an account recovery
  opens that user's security page, address alerts open Domains, upload scans
  open their drop point.

## Verification

`test/notifications/event-targets.test.ts` walks every page in the dashboard
and its apps and fails for any kind whose target, or its fallback, is not a
page. `test/security-scans` covers the focus links, the automatic firewall and
the restart decision. Not exercised on a live host (no Docker here).
