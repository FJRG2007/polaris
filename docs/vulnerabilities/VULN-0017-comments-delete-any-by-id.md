---
id: VULN-0017
title: Any comment on the instance can be deleted or resolved by id
status: fixed
severity: high
cwe: CWE-639
stride: Tampering
cvss: "6.5"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N
location: dashboard/apps/web/src/lib/comments/comments.ts
component: comments
reachability: AUTHENTICATED
exploitability: EASY
confidence: 95
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A default member with access to one service, host or task space deletes or resolves any comment on the instance, or every comment at once.

## Root cause / data flow
The actions authorized the app, host or task, then remove/setResolved acted on { id: commentId } alone with moderator rights; a filter object as the id matched every row.

## Evidence
White-box source trace; not exercised against a running instance.

deleteServiceCommentAction({applicationId: <own>, commentId: {not:""}}) -> every comment deleted.

## Impact
Destruction of discussion history across all deploy, server and task threads.

## Remediation
remove and setResolved take the authorized thread and match on it; non-string ids are refused.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/comments/comments.ts and its callers; test test/comments/comments.test.ts.
