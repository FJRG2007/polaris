---
id: VULN-0036
title: A player's kept inventory returned to a caller with no access to the server
status: fixed
severity: low
cwe: CWE-863
stride: Information Disclosure
cvss: "3.1"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N
location: dashboard/apps/game-servers/src/screens/installed/minecraft-actions.ts
component: apps/minecraft
reachability: AUTHENTICATED
exploitability: HARD
confidence: 90
discovered: 2026-10-06
last_seen: 2026-10-06
fixed: 2026-10-06
fix_commit: 28ed2453e
---

## Summary
Any signed-in account that knew a game server's id could read the last inventory Polaris kept for any player on it, without access to that server.

## Root cause / data flow
readPlayerInventoryAction called requireGameServer inside the same try block as the live read. Its catch fell back to the kept snapshot for any error, so the "Server not found" refusal for a caller without games.read on that server reached readSnapshot(installedAppId, player) and returned the stored items.

## Evidence
White-box source trace, confirmed by a test that calls the action with the standing refused and a snapshot stored: before the fix it returned the items; after it, an error and no storage read. Not exercised against a running instance.

## Impact
Disclosure of what a player was carrying when last seen, on a server the caller cannot see. Needs the server's UUID, which is not listed to anyone without access.

## Remediation
The standing is checked on its own before anything is read, and a refusal returns an error. The live-or-kept reading moved to readPlayerInventory in lib/minecraft/inventory-service.ts, which the players screen and the games_player_inventory assistant tool both call after their own access check.

## History
- 2026-10-06: discovered while adding the assistant's inventory tool; fixed in the same change (#417); test test/apps/game-inventory-player-read.test.ts.
