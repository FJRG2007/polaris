---
id: VULN-0015
title: Environment-limited deploy access reaches other environments through the Elsewhere board
status: fixed
severity: high
cwe: CWE-863
stride: Elevation of Privilege
cvss: "7.6"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:L/A:L
location: dashboard/apps/web/src/app/(app)/apps/deploy/external-actions.ts
component: deploy
reachability: AUTHENTICATED
exploitability: EASY
confidence: 90
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A project member limited to development moves a production service to an external provider account they linked, which decrypts its secrets, sends them to that account and stops the service.

## Root cause / data flow
Move out checked only the destination environment; move home, add, refresh, deploy, rename and remove checked the project only.

## Evidence
White-box source trace; not exercised against a running instance.

As a development-only member, run the move-out action on a production application id with a provider account the caller owns.

## Impact
Disclosure of production secrets and outage of production services by a lower-privileged member.

## Remediation
The moved service goes through requireApplicationAccess; board rows are checked against their own environment via externalServiceEnvironment; add uses requireEnvironmentAccess.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/(app)/apps/deploy/external-actions.ts, lib/deploy/external-services.ts; test test/deploy/elsewhere-environment-scope.test.ts.
