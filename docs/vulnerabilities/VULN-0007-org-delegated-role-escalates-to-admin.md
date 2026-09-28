---
id: VULN-0007
title: Organization members with people.manage or roles.manage can grant themselves admin
status: fixed
severity: high
cwe: CWE-269
stride: Elevation of Privilege
cvss: "8.1"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N
location: dashboard/apps/web/src/app/(app)/account/organizations/actions.ts
component: orgs
reachability: AUTHENTICATED
exploitability: EASY
confidence: 85
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A member whose custom organization role holds people.manage or roles.manage can hand out any role, admin included, to themselves or to an account they control.

## Root cause / data flow
The set-role, invite, default-invite-role, remove-member and create/update-role actions check the permission to manage people or roles but never compare the granted role with the caller's own.

## Evidence
White-box source trace; not exercised against a running instance.

setOrgMemberRoleAction(orgId, <own member id>, "admin") as a member holding only people.manage -> the caller becomes org admin.

## Impact
Any delegated role becomes full organization admin, with access to every org resource.

## Remediation
requireWithinOwn, requireRoleWithinOwn and requireMemberWithinOwn in lib/orgs/org-service.ts refuse roles broader than the caller's; the owner and instance admins are exempt.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/(app)/account/organizations/actions.ts, dashboard/apps/web/src/lib/orgs/org-service.ts; test test/orgs/org-permissions.test.ts.
