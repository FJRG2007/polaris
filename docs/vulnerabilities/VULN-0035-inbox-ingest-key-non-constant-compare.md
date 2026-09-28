---
id: VULN-0035
title: Inbox ingest key compared in non-constant time
status: fixed
severity: low
cwe: CWE-208
stride: Spoofing
cvss: "3.1"
cvss_vector: CVSS:3.1/AV:A/AC:H/PR:N/UI:N/S:U/C:N/I:L/A:N
location: dashboard/apps/web/src/app/api/inbox/ingest/route.ts
component: inbox
reachability: INTERNAL
exploitability: HARD
confidence: 70
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
The shared ingest key was checked with !==, a timing side channel on the internal ingest route.

## Root cause / data flow
Plain string comparison.

## Evidence
White-box source trace; not exercised against a running instance.

Timing measurements against POST /api/inbox/ingest.

## Impact
Recovering the key would allow injecting fake inbound messages.

## Remediation
Digests are compared with timingSafeEqual, as lib/cron/authorize.ts does.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/api/inbox/ingest/route.ts.
