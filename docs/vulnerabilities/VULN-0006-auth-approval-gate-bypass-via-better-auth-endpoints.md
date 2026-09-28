---
id: VULN-0006
title: Sign-in approval gate bypassed through better-auth HTTP endpoints (2FA enable, revoke-other-sessions)
status: fixed
severity: high
cwe: CWE-863
stride: Elevation of Privilege
cvss: "8.1"
cvss_vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N
location: dashboard/packages/auth/src/auth.ts:869
component: auth
reachability: EXTERNAL
exploitability: EASY
confidence: 90
discovered: 2026-09-28
last_seen: 2026-09-28
fixed: 2026-09-28
fix_commit: null
---

## Summary
An attacker who knows only an account's password signs in and is held for approval, but better-auth's own endpoints never consult Polaris's approval state. Enabling their own TOTP, or revoking every other session, turns the held session into an approved one and hands them the account.

## Root cause / data flow
The SessionState row is created by the Polaris guard on first page load. better-auth issues a normal session, and /two-factor/enable, /two-factor/verify-totp, /revoke-other-sessions and /change-password accept it. createSessionState then computes `requireApproval && !twoFactorEnabled` (now false), or finds no approver left.

## Evidence
White-box source trace; not exercised against a running instance.

POST /api/auth/sign-in/email -> POST /api/auth/two-factor/enable {password} -> POST /api/auth/two-factor/verify-totp {code}. The replacement session is approved. Alternative: sign in, POST /api/auth/revoke-other-sessions, open /.

## Impact
Full takeover of any account protected by the approval gate, with the attacker also owning the account's TOTP.

## Remediation
Refuse the account-changing endpoints (CLEARED_ONLY_ENDPOINTS) while sessionHeldBack() says the session is pending, locked, or would be held for approval.

## History
- 2026-09-28: discovered by Helio (source audit), status open.
- 2026-09-28: fixed in dashboard/packages/auth/src/auth.ts; test dashboard/packages/auth/test/passkeys/registration-gate.test.ts.
