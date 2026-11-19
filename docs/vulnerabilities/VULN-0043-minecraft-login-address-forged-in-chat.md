---
id: VULN-0043
title: A Minecraft player's allowed address can be forged by quoting a login line in chat
status: fixed
severity: medium
cwe: CWE-345
stride: Spoofing
cvss: "5.4"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:N
location: dashboard/apps/game-servers/src/lib/minecraft/parse.ts
component: game-servers/player-access
reachability: AUTHENTICATED
exploitability: EASY
confidence: 95
discovered: 2026-11-19
last_seen: 2026-11-19
fixed: 2026-11-19
fix_commit: f6460c6da
---

## Summary
A game server that binds players to the addresses they were allowed from read each player's address from the server log. It took any line that contained `Name[/ip:port] logged in`, so a player connecting from a network they were not allowed on could type that text in chat, with an allowed address in it, and be read as connecting from there. The server's address check and the chat relay then trusted the forged address.

## Root cause / data flow
`parseJoinAddresses` matched `/([A-Za-z0-9_]{3,16})\[\/(ip):\d+\]\s+logged in/g` anywhere in the log, with no anchor to the start of a line or to the server's own log envelope. A chat line (`[12:00:00 INFO]: <Bob> Bob[/5.5.5.5:1] logged in ...`) matched, and as the later match it replaced the real login's address. The map feeds `enforcePlayerAddresses` (`player-access.ts`) and the chat relay (`chat-relay.ts`).

## Evidence
White-box source trace (reported by CodeRabbit in PR #1187, confirmed by reading the code), and unit tests: forged lines after Paper, vanilla, async-chat and Forge prefixes are ignored, and a player whose chat quotes an allowed address is still kicked. Not exercised against a running server.

## Impact
A player admitted to a server on one network could keep playing from a network the owner had not allowed. Needs a player account already on the server.

## Remediation
Each log line is matched whole: first the server's own envelope (Paper, vanilla, Forge/NeoForge, optionally with the container's timestamp), then the complete login record `Name[/ip:port] logged in with entity id N at (...)`. A login quoted inside a chat message no longer matches.

## History
- 2026-11-19: reported by CodeRabbit (PR #1187); confirmed, cherry-picked to main and documented the same day.
