---
id: VULN-0042
title: A terminal that stops reading makes the sidecar queue shell output without limit
status: fixed
severity: medium
cwe: CWE-770
stride: Denial of Service
cvss: "4.9"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:N/A:H
location: dashboard/apps/web/ws-server.mjs
component: deploy/terminal
reachability: AUTHENTICATED
exploitability: EASY
confidence: 90
discovered: 2026-11-12
last_seen: 2026-11-12
fixed: 2026-11-12
fix_commit: b7298dfd8
---

## Summary
The terminal sidecar sent every chunk of a shell's output to its WebSocket as it arrived, without waiting for it to be delivered. A user who started a command with endless output and then stopped reading the socket made the shared sidecar hold more and more of it in memory, until every terminal on the instance went down with it.

## Root cause / data flow
`session.stream.on("data", (chunk) => ws.send(chunk))` in `ws-server.mjs`, and the same in the server-shell sink in `terminal-sessions.mjs`. There was no backpressure from `ws.bufferedAmount` to the stream and no limit on what could be queued.

## Evidence
White-box source trace (reported by an AI scan, confirmed by reading the code), and unit tests with a socket that does not drain. Not exercised against a running instance.

## Impact
Memory exhaustion of the terminal sidecar, taking down every open terminal. Needs an account allowed to open a terminal.

## Remediation
`sendPaced` (`terminal-sessions.mjs`) pauses the shell's stream once more than 1 MiB is waiting on the socket, and resumes it when the socket drains to half of that. A single write that leaves more than 16 MiB queued closes the socket (1013). A server shell left without a viewer is resumed, so its output goes to the bounded scrollback as before.

## History
- 2026-11-12: reported by an AI security scan; confirmed and fixed the same day; test `test/terminal/account-ended-and-paced.test.ts`.
