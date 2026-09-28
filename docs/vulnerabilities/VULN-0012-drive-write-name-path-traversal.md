---
id: VULN-0012
title: Drive upload and create/mkdir/rename write outside the folder that was authorized
status: fixed
severity: high
cwe: CWE-22
stride: Tampering
cvss: "7.1"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:L
location: dashboard/apps/web/src/app/api/drive/upload/route.ts:45
component: drive
reachability: AUTHENTICATED
exploitability: EASY
confidence: 90
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A user allowed to write into one folder of a shared or organization Drive creates, overwrites, or renames files anywhere on that connection, including folders denied to them or behind a lock password.

## Root cause / data flow
The upload route and createFileAction/mkdirAction authorized p but wrote to normalizeRelPath(p + "/" + name), so name=../../hr/x escaped; renameAction never checked the destination folder.

## Evidence
White-box source trace; not exercised against a running instance.

PUT /api/drive/upload?c=<conn>&p=team/inbox&name=../../hr/payroll.xlsx -> overwrites hr/payroll.xlsx.

## Impact
Integrity loss on any file of a shared or organization Drive by a user with write access to one folder.

## Remediation
Authorization runs on the folder the resolved target actually lands in; a rename into another folder requires write access there.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/app/api/drive/upload/route.ts, dashboard/apps/web/src/app/(app)/drive/actions.ts; tests test/drive/upload-target-authz.test.ts, test/drive/write-target-authz.test.ts.
