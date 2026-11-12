---
id: VULN-0040
title: A seat kept after losing access to a conversation goes on minting tickets for its call
status: fixed
severity: high
cwe: CWE-863
stride: Information Disclosure
cvss: "6.5"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N
location: dashboard/apps/web/src/lib/chat/meetings.ts
component: chat/calls
reachability: AUTHENTICATED
exploitability: MODERATE
confidence: 85
discovered: 2026-11-12
last_seen: 2026-11-12
fixed: 2026-11-12
fix_commit: null
---

## Summary
Joining a conversation's call checks that the person can read the conversation. After that, the open seat was treated as continuing authority: the media ticket and the heartbeat were proved by the seat alone. Someone removed from the conversation (or the space, or who lost the role) while in its call could keep requesting fresh tickets for the call.

## Root cause / data flow
`callTokenAction` -> `resolveSeat` -> `seatForUser` returned any open `meetingParticipant` row for the account, and `joinToken` signed a ten-minute room grant for it. Nothing re-asked `channelAccess`, and removing a member does not close their call seats.

## Evidence
White-box source trace (reported by an AI scan, confirmed by reading the code), and a test of `seatForUser`. Not exercised against a running instance.

## Impact
Continued access to a private call's audio and video for somebody who may no longer read that conversation.

## Remediation
`seatForUser` asks `channelAccess` for a meeting that belongs to a conversation. When the answer is no, it closes the seat, tells the media server to drop the connection, and returns no seat. Every request proved by an account's seat (ticket, heartbeat, the room's chat) goes through it, so the check holds however the access was taken away.

## History
- 2026-11-12: reported by an AI security scan; confirmed and fixed the same day; test `test/chat/seat-follows-conversation-access.test.ts`.
