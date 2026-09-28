---
id: VULN-0014
title: Any deploy member mounts other accounts' agent homes and database archives as a server folder
status: fixed
severity: high
cwe: CWE-22
stride: Information Disclosure
cvss: "8.1"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:L/A:N
location: dashboard/apps/web/src/lib/deploy-volume-service.ts:145
component: deploy
reachability: AUTHENTICATED
exploitability: EASY
confidence: 85
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A default member with deploy.manage creates a bind volume whose source is agent-homes/... or pitr/... and reads other accounts' coding-agent sign-ins and git credentials, or database WAL archives, from their own container.

## Root cause / data flow
Bind sources are relative to one volume root shared by every account; the create and update actions only normalized the path, and hostd confines only to that root.

## Evidence
White-box source trace; not exercised against a running instance.

createVolumeAction({applicationId, name:"x", mountPath:"/steal", kind:"bind", source:"agent-homes/shared"}), redeploy, read /steal in the service console.

## Impact
Theft of other users' agent credentials and of managed database contents.

## Remediation
isReservedBindSource/bindSourceAllowed refuse the reserved roots, the deploy tree's ancestors and other projects' branches at create, update and deploy time.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/deploy-volume-service.ts, lib/deploy-service.ts; test test/deploy/bind-source.test.ts.
