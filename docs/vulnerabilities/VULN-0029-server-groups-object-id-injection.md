---
id: VULN-0029
title: Object as server group id deletes other owners' memberships and firewall rules
status: fixed
severity: medium
cwe: CWE-943
stride: Tampering
cvss: "4.9"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:H/A:N
location: dashboard/apps/web/src/app/(app)/apps/servers/actions.ts
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
A user with system.manage passed a filter object as the group id and deleted group memberships and firewall rules of other owners.

## Root cause / data flow
Group and server ids were not validated as strings before reaching Prisma filters.

## Evidence
White-box source trace; not exercised against a running instance.

Call the delete-group action with groupId {not:""}.

## Impact
Removal of other owners' server grouping and firewall configuration.

## Remediation
UUID validation on the group id and on each server id.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/(app)/apps/servers/actions.ts.
