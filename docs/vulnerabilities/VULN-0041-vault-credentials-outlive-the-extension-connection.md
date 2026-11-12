---
id: VULN-0041
title: Vault access token and client key keep working after the extension is disconnected
status: fixed
severity: high
cwe: CWE-613
stride: Elevation of Privilege
cvss: "7.1"
cvss_vector: CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:H/I:H/A:N
location: dashboard/apps/web/src/lib/vault/auth.ts
component: vault/extension
reachability: AUTHENTICATED
exploitability: MODERATE
confidence: 90
discovered: 2026-11-12
last_seen: 2026-11-12
fixed: 2026-11-12
fix_commit: null
---

## Summary
Disconnecting the browser extension revoked its refresh tokens, but not what it had already been handed:

- the vault access token (good for an hour), which `authenticateVault` accepted without asking whether the connection that let the device in was still live;
- the account client key (an API key good for ninety days), which nothing revoked.

A disconnect that raced the approval could also leave behind a refresh token or client key issued after the revocation sweep.

## Root cause / data flow
`connectAuthorizeClaim` -> `issueVaultToken` and `issueClientKey`. `revokeExtensionSession` -> `endConnections` revoked the `vaultRefreshToken` rows of the connection's devices, then marked the connection. `authenticateVault` checked the account, the stamp and `vault.use`, but not the device's connection. The client key was bound only to a device identifier, which disconnecting never used.

## Evidence
White-box source trace (reported by an AI scan, confirmed by reading the code), and tests for authentication, refresh, claims and disconnecting. Not exercised against a running instance.

## Impact
Somebody holding a copy of the extension's credentials keeps reading and writing the vault for up to an hour through the token, and for up to ninety days through the client key, after the owner ended the connection.

## Remediation
- (PR #1186) `authenticateVault` refuses a token whose device belongs to a revoked connection, or to another account. Refreshing refuses the same.
- (PR #1186) Disconnecting marks the connection first and sweeps afterwards. Issuing a token takes a conditional write on the live connection inside the same transaction, so a disconnect and an issuance cannot both win.
- Disconnecting also deletes the client keys issued to the connection's devices (`revokeClientKeys`). A claim checks the connection again once its client key exists, and takes the key back if the connection ended meanwhile.
- A device that signs in again with the master password is released from a connection that was ended, so the stricter check does not lock that device out of the vault for good.

## History
- 2026-11-12: reported by an AI security scan; the token and race parts fixed in PR #1186 (CodeRabbit), the client key and the sign-in regression added on top the same day; tests `test/vault/auth.test.ts`, `test/vault/refresh.test.ts`, `test/vault/authorize-claim.test.ts`, `test/vault/client-key-issue.test.ts`, `test/vault/sign-in.test.ts`, `test/account/extension-sessions.test.ts`.
