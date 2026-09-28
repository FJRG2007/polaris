---
id: VULN-0023
title: API streams and badges skip the session guard (approval, idle lock, address pin, required 2FA)
status: fixed
severity: medium
cwe: CWE-285
stride: Elevation of Privilege
cvss: "5.4"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:N
location: dashboard/apps/web/src/app/api/office/[id]/content/route.ts:49
component: auth
reachability: AUTHENTICATED
exploitability: EASY
confidence: 85
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A session the guard would refuse (pending approval, idle-locked, replayed cookie, owed 2FA) still read the mail, chat and notification streams and read or wrote office documents.

## Root cause / data flow
15 routes called resolveSession()/getSession() directly instead of the guard.

## Evidence
White-box source trace; not exercised against a running instance.

Sign in with the password only to an account that needs approval; GET /api/mail/rail returns mailbox data.

## Impact
Bypass of every per-session protection for the data those routes serve.

## Remediation
backgroundUser() runs the full guard without refreshing the idle stamp; the data-bearing routes and lib/chat/meeting-seat.ts use it; edge/authorize runs guardSession.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/session.ts, the session guard and the affected routes; test test/access/background-user.test.ts.
