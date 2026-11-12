---
id: VULN-0038
title: An open terminal keeps running commands after its account is banned or signed out
status: fixed
severity: medium
cwe: CWE-613
stride: Elevation of Privilege
cvss: "6.4"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:H/I:H/A:H
location: dashboard/apps/web/ws-server.mjs
component: deploy/terminal
reachability: AUTHENTICATED
exploitability: MODERATE
confidence: 90
discovered: 2026-11-12
last_seen: 2026-11-12
fixed: 2026-11-12
fix_commit: b7298dfd8
---

## Summary
A terminal (server shell, container, agent session) is authorized once, when its one-shot ticket is redeemed. Banning the account, or an administrator ending its sessions, ended the sign-ins but not the terminals already attached: the socket kept writing input into the shell with the authority it had when it opened.

## Root cause / data flow
`ws-server.mjs` redeems the ticket, opens the shell, and from then on writes every message into `session.stream`. The persistent registry (`terminal-sessions.mjs`) holds server shells for up to the idle limit. Nothing in either re-checked the account, and nothing in the ban or session-ending path told the sidecar.

## Evidence
White-box source trace (reported by an AI scan, confirmed by reading the code). Unit tests on the registry and the sidecar's internal call. Not exercised against a running instance.

## Impact
Somebody whose access was taken away keeps a shell on a server or container until they close it. Needs an account that was allowed a terminal in the first place.

## Remediation
- Ending an account's sessions (`dropSessions`: ban, suspension, an administrator ending them) also calls the sidecar's new `end-user` action, which closes every terminal of that account, of every kind, with close code 4003.
- In case that call never arrives, the sidecar asks the web app once a minute which of the accounts holding a terminal are banned or gone (`/api/deploy/terminal/standing`, internal key only) and closes theirs.

## History
- 2026-11-12: reported by an AI security scan; confirmed and fixed the same day; test `test/terminal/account-ended-and-paced.test.ts`.
