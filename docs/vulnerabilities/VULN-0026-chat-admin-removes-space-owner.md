---
id: VULN-0026
title: Chat space admin can remove the space owner
status: fixed
severity: medium
cwe: CWE-285
stride: Tampering
cvss: "4.3"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N
location: dashboard/apps/web/src/lib/chat/chat-service.ts
component: chat
reachability: AUTHENTICATED
exploitability: EASY
confidence: 75
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A space admin removed the owner from the space and from their private channels.

## Root cause / data flow
Banning refused to act on the owner; removeSpaceMember and removeChannelMember did not.

## Evidence
White-box source trace; not exercised against a running instance.

As a space admin, call the remove-member action on the owner's user id.

## Impact
The owner locked out of their own space.

## Remediation
The same owner guard applies to removal.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/chat/chat-service.ts.
