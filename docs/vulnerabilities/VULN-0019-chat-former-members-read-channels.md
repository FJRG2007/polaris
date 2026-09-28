---
id: VULN-0019
title: Former members keep reading space channels through search and the live stream
status: fixed
severity: high
cwe: CWE-285
stride: Information Disclosure
cvss: "6.5"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N
location: dashboard/apps/web/src/lib/chat/access.ts
component: chat
reachability: AUTHENTICATED
exploitability: EASY
confidence: 85
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
A user removed from a chat space or organization keeps receiving its messages in search results, toasts and the live stream.

## Root cause / data flow
reachableChannelIds counted any leftover channel-member row as access; that row is created on read and survives leaving.

## Evidence
White-box source trace; not exercised against a running instance.

Read a channel, get removed from the space, then call searchMessagesAction or follow /api/chat/stream.

## Impact
Continued disclosure of private conversations to removed members.

## Remediation
A member row in a space's channel counts only while the space is still reachable.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/apps/web/src/lib/chat/access.ts; test test/chat/chat-access.test.ts.
