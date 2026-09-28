---
id: VULN-0032
title: Server metrics answered from cache before the ownership check
status: fixed
severity: low
cwe: CWE-285
stride: Information Disclosure
cvss: "3.5"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:N/A:N
location: dashboard/apps/web/src/lib/server-metrics-service.ts
component: servers
reachability: AUTHENTICATED
exploitability: EASY
confidence: 80
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A system.manage user read cached metrics of servers owned by someone else.

## Root cause / data flow
getServerMetrics returned the cache hit before checking ownership.

## Evidence
White-box source trace; not exercised against a running instance.

Request metrics for another owner's server id right after its owner loaded them.

## Impact
Disclosure of another owner's server metrics.

## Remediation
Ownership is checked before the cache.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/server-metrics-service.ts; test test/servers/metrics-owner-first.test.ts.
