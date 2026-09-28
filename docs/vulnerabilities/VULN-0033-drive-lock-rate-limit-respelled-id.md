---
id: VULN-0033
title: Drive lock-password rate limit bypassed by respelling the lock id
status: fixed
severity: low
cwe: CWE-307
stride: Spoofing
cvss: "3.7"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N
location: dashboard/apps/web/src/app/(app)/drive/access-actions.ts
component: drive
reachability: AUTHENTICATED
exploitability: MEDIUM
confidence: 70
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
Each spelling of the same lock id (upper case, no dashes) got its own ten password attempts.

## Root cause / data flow
The throttle key used the raw id while the database accepted the variants.

## Evidence
White-box source trace; not exercised against a running instance.

Alternate unlockPathAction calls across case and dash variants of the lock id.

## Impact
Brute force of Drive lock passwords beyond the intended limit.

## Remediation
The id is validated as a UUID and lowercased before the limit key is built.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/(app)/drive/access-actions.ts.
