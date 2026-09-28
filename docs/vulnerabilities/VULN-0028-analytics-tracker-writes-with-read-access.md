---
id: VULN-0028
title: Read access disables or rotates another project's analytics tracker
status: fixed
severity: medium
cwe: CWE-285
stride: Tampering
cvss: "4.3"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N
location: dashboard/apps/web/src/app/(app)/apps/analytics/actions.ts
component: analytics
reachability: AUTHENTICATED
exploitability: EASY
confidence: 85
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
Any member who can see a service on an internal project turned off or rotated its tracker, breaking its analytics.

## Root cause / data flow
setTrackerEnabledAction and rotateTrackerKeyAction only required read access.

## Evidence
White-box source trace; not exercised against a running instance.

Call rotateTrackerKeyAction on another project's service id.

## Impact
Loss of analytics collection for projects the caller does not manage.

## Remediation
Both require service.configure.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/(app)/apps/analytics/actions.ts; test test/deploy/analytics-tracker-writes.test.ts.
