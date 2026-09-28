---
id: VULN-0005
title: Drive lock unlock cookie never expires and survives a password change
status: fixed
severity: low
cwe: CWE-613
stride: Spoofing
cvss: "3.1"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N
location: dashboard/apps/web/src/lib/access-lock-service.ts:125
component: drive
reachability: AUTHENTICATED
exploitability: EASY
confidence: 80
discovered: 2026-09-28
last_seen: 2026-09-29
fixed: 2026-09-29
fix_commit: null
---

## Summary
The unlock cookie for a password-locked Drive path is HMAC("lock-unlock:<lockId>"), identical for every user and with no expiry inside it, so anyone who once unlocked keeps access after the password changes.

## Root cause / data flow
The value carries no expiry and no password version; lib/link-guards.ts keeps the format so existing cookies stay valid. The caller must still pass the Drive permissions on the path.

## Evidence
White-box source trace; not exercised against a running instance.

Unlock once and copy the cookie; the owner changes the lock password; the copied cookie still unlocks.

## Impact
The lock password cannot be rotated to revoke someone who already knew it.

## Remediation
Every password-unlock cookie (Drive lock, share link, file and text drop point, snippet, notes share, office doc link) is now <expiresAt>.<HMAC> over scope, id, sha256 of the password hash, user id (Drive lock only) and the expiry. The server enforces the 12h expiry, and any password change invalidates earlier unlocks. Cookie names and prompts are unchanged; old-format cookies ask for the password once more.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: left open pending a product decision; see Remediation.
- 2026-09-29: fixed in lib/link-guards.ts, lib/access-lock-service.ts and the share, drop, snippet, notes and office unlock services and call sites; tests test/drive/unlock-cookies.test.ts, test/access/link-guards.test.ts, test/office/link-pass.test.ts.
