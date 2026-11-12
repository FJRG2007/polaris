---
id: VULN-0039
title: A participant removed from a meeting keeps hearing and sending through the media server
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
confidence: 90
discovered: 2026-11-12
last_seen: 2026-11-12
fixed: 2026-11-12
fix_commit: null
---

## Summary
A host removing somebody from a meeting refused their seat in the database and told browsers through the roster, but never told the media server. A browser that ignored the roster stayed in the room, receiving and publishing media.

## Root cause / data flow
`removeFromMeetingAction` -> `removeFromMeeting` updated `meetingParticipant` (`admission: "denied"`, `leftAt`) and published a roster event. `applyToSeat(..., { kind: "remove" })`, which calls the media server's `removeParticipant` and which the moderator's disconnect already used, was not called.

## Evidence
White-box source trace (reported by an AI scan, confirmed by reading the code), and a test of the action. Not exercised against a running media server.

## Impact
A person shown out of a private meeting keeps listening to it, and can keep speaking into it, until their own connection drops.

## Remediation
`removeFromMeetingAction` calls `applyToSeat(meetingId, participantId, { kind: "remove" })` after refusing the seat. When the media server does not confirm it, the host is told that the removal was saved but not confirmed, rather than being shown a removal that has not happened.

## History
- 2026-11-12: reported by an AI security scan; confirmed and fixed the same day; test `test/chat/meeting-removal-reaches-media.test.ts`.
