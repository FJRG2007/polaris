---
id: VULN-0044
title: Password rules are client-enforced under OPAQUE
status: accepted-risk
severity: low
cwe: CWE-602
stride: Tampering
cvss: "2.6"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:L/A:N
location: dashboard/apps/web/src/lib/chat/e2ee/password-rules.ts
component: auth/password-lock
reachability: AUTHENTICATED
exploitability: MODERATE
confidence: 100
discovered: 2026-11-23
last_seen: 2026-11-23
fixed: null
fix_commit: null
---

## Summary
With the password lock on, a new password becomes an OPAQUE record in the browser and the server never sees it. The length, identity and breached-password rules therefore run in the client (`startCheckedRegistration`), not on the server. A modified client can register a password that breaks them.

## Root cause / data flow
OPAQUE (RFC 9807) is built so the server learns nothing about the password, which is the point of the password lock (docs/chat-e2ee-phase1.md). A rule that needs the password - its length, whether it contains the account's name, whether it is in the breach corpus - can only be checked where the password exists. Bitwarden, 1Password and Proton enforce their password policy the same way.

## Evidence
By design; recorded at the owner's request when the password lock was switched on. `apps/web/test/chat/e2ee/password-rules.test.ts` covers the client check.

## Impact
Limited to the account whose owner runs the modified client: they can only weaken their own password. Nobody else's account, record or key is reachable through it. Adoption at sign-in (moving an existing account onto OPAQUE) does not re-check, because that password was checked by the server when it was set.

## Remediation
Accepted. Mitigations in place: per-address and per-account rate limits on every OPAQUE route, the second factor still challenged after an OPAQUE sign-in, the breached check run client-side by k-anonymity through `/api/polaris/pwned/[prefix]`, and the server still enforcing the rules on every route where it receives the password (`/sign-in/email`, sign-up, reset, change, the adoption's hash check). Client integrity verification (docs/integrity.md once it exists) narrows who can run a modified client.

## History
- 2026-11-23: filed as accepted risk when the password lock was switched on by default.
