---
id: VULN-0025
title: Task space or folder admin can make themselves owner
status: fixed
severity: medium
cwe: CWE-269
stride: Elevation of Privilege
cvss: "5.4"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:L
location: dashboard/apps/web/src/app/(app)/tasks/actions.ts
component: tasks
reachability: AUTHENTICATED
exploitability: EASY
confidence: 85
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A space admin stored the role owner on themselves and could then delete the space.

## Root cause / data flow
role was not validated in the add and set-role actions for space and folder members.

## Evidence
White-box source trace; not exercised against a running instance.

setSpaceMemberRoleAction(space, <self>, "owner") then deleteSpaceAction(space).

## Impact
Loss of an entire task space by a delegated admin.

## Remediation
Roles are checked against core.SPACE_ROLES, as grantSpaceTeamAction already did.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/(app)/tasks/actions.ts.
