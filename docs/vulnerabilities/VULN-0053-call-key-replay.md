---
id: VULN-0053
title: A call key message played again puts a browser back on a key somebody who left still holds
status: fixed
severity: medium
cwe: CWE-294
stride: Information Disclosure
cvss: "5.3"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:H/I:N/A:N
location: dashboard/apps/web/src/app/(app)/chat/call-e2ee-session.ts
component: chat/calls
reachability: AUTHENTICATED
exploitability: DIFFICULT
confidence: 90
discovered: 2026-11-28
last_seen: 2026-11-28
fixed: 2026-11-28
fix_commit: 2027f905cc
---

## Summary
An encrypted call's key messages travel through the media server. A browser took any key message from the current leader, whatever its generation, and setting a key in LiveKit's frame cryptor also makes it the key the browser encrypts with. A media server that kept an earlier key message and sent it again could put that browser back on an earlier generation, one a participant who has since left still holds, so that participant could read what the browser sent after they left.

## Root cause / data flow
`opened()` in `call-e2ee-session.ts` refused a message only when it came from someone other than the leader with a generation not above the one held. A message from the leader was taken at any generation. The wrap binds room, generation, leader, recipient and epoch, but the per-call key pairs stay the same for the whole call, so an earlier message still opens. `ParticipantKeyHandler.setKeyFromMaterial` (livekit-client 2.22.0, `livekit-client.e2ee.worker.mjs`) sets `currentKeyIndex` to the slot it was given. The message's own `pub` was also used for the key agreement without comparing it with the key pair its sender announced.

## Evidence
Found reading the key exchange during the E2EE audit of 2026-11-28; reproduced by `test/chat/call-e2ee-session.test.ts` ("refuses a key message the server plays again").

## Impact
Needs the media server (or whoever runs it) to replay traffic and a former participant to hold the earlier key and the encrypted media. A call bound to the conversation's MLS group is affected the same way: the replayed message carries a valid binding.

## Remediation
- A key message is taken only when its generation is above the last one taken from that sender's per-call key pair (identity and public key).
- It must be wrapped with the public key the sender announced for the call; one that arrives before the announcement is kept and read when the announcement lands.
- Tests: `dashboard/apps/web/test/chat/call-e2ee-session.test.ts`.

## History
- 2026-11-28: found and fixed in the E2EE audit.
