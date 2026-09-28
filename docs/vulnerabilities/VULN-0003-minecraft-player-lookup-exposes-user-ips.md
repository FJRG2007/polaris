---
id: VULN-0003
title: Game server player lookup exposes any user's session IP addresses
status: accepted-risk
severity: medium
cwe: CWE-359
stride: Information Disclosure
cvss: "4.3"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N
location: dashboard/apps/game-servers/src/screens/installed/minecraft-actions.ts
component: apps/minecraft
reachability: AUTHENTICATED
exploitability: EASY
confidence: 85
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: null
fix_commit: null
---

## Summary
Any member who creates a game server looks up any username or email and gets that person's live session IPs, and learns whether an email is registered.

## Root cause / data flow
findMinecraftPlayerByUserAction returns the matched user's session IPs without their consent; the code comments describe it as intended.

## Evidence
White-box source trace; not exercised against a running instance.

Create a game server, then call findMinecraftPlayerByUserAction(<id>, "victim@example.com").

## Impact
Network location disclosure of any user on the instance.

## Remediation
An instance setting, Management > Security > "Show player addresses to game server managers", decides whether the lookup returns addresses to non-admins. It stays on by default so the existing flow keeps working; turned off, a manager gets the linked username with no addresses and a note to ask the player, while administrators still see them.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: left open pending a product decision; see Remediation.
- 2026-09-28: fixed as an administrator decision: lib/apps/player-address-policy.ts, the gate in minecraft-actions.ts, the notice in minecraft-player-dialogs.tsx and the card under app/(app)/admin/security; test test/apps/minecraft-player-addresses.test.ts.
- 2026-09-29: carried onto the game-servers app. Its player list now also shows linked players' sign-in addresses to anybody with games.read, so the same setting masks session-sourced rules through forViewer() in lib/minecraft/player-access.ts on every screen that receives the list; enforcement reads the rows directly and is unchanged. Setting helper moved to dashboard/apps/web/src/lib/player-address-policy.ts.
- 2026-09-28: recorded as accepted-risk rather than fixed. The setting is on by default, so out of the box a game server manager still receives other accounts' session addresses; an administrator has to turn it off to close the exposure.
