# Chat E2EE - phase 1: the account key and its locks

Status of phase 1 of [chat-e2ee-proposal.md](chat-e2ee-proposal.md) (sections 3.1-3.4, 4.5, 11, 13, 14). Everything here sits behind the internal rollout flag; nothing is wired into a screen.

## What exists

`dashboard/packages/chat-crypto` (`@polaris/chat-crypto`), client side, WebCrypto plus two vetted libraries:

| Module | Content |
| --- | --- |
| `account-key` | `AK` = 32 random bytes. Ed25519 signing pair and X-Wing (X25519 + ML-KEM-768) HPKE pair derived with HKDF-SHA256 under distinct versioned labels. Private signing key non-extractable |
| `locks` | One envelope format for every lock: `version \|\| kind \|\| salt(32) \|\| AES-256-GCM(AK)`. Key and nonce come from HKDF over a fresh 256-bit salt (never a bare random nonce). AAD = header + canonical(label, userId, kind, lockId, akVersion). Closed lists for version and kind. One coarse error for every failure |
| `device-lock` | Non-extractable HKDF `CryptoKey` + envelope in IndexedDB, one database per account (`polaris-chat-keys:<userId>`); sign-out deletes only that database |
| `password-lock` / `opaque-server` | OPAQUE (RFC 9807). `exportKey` imported straight into a non-extractable key and used as the lock secret. Argon2id 128 MiB, t=3, p=1, fixed in code as profile v1 (never read from the server, so it cannot be downgraded). Client identity = userId, so a record is bound to its account |
| `passkey-lock` | WebAuthn PRF: one fixed, labelled PRF input (the passkey sign-in is usernameless, so the input is asked for before the account is known; the per-credential authenticator secret makes the output unique), account + credential id in the binding. An assertion without PRF output yields `null` and no lock - never an error |
| `hybrid-envelope` | RFC 9180 HPKE base mode, X-Wing KEM (0x647a) + HKDF-SHA256 + AES-256-GCM, header as AAD, purpose and binding in `info`. Suite is a closed list of one |
| `qr-approval` | `AK` through the QR sign-in: ephemeral X-Wing offer, commitment in the link fragment, hybrid envelope (purpose `qr-approval`, binding = flow id + new device id + approver device id) signed with the `AK` signing key, and an `AccountKeyVerifier` that must answer `true` before the key is accepted |

Tests (`packages/chat-crypto/test`, 31): round trips for every lock, own known-answer vectors (lock envelope, signing public key), every-byte tamper, envelopes swapped across account / lock / kind / version, id boundary shift, wrong password, record under another account, missing record, another server setup, replayed OPAQUE finish, swapped password envelope, wrong HPKE recipient / purpose / binding / suite byte, and the 11.1 items this phase covers (1 derived nonces, 2 complete AAD, 4 domain separation and canonical encoding, 11 no hand-rolled secret comparison, 12 CSPRNG only, 13 closed lists).

### Libraries

| Library | Version (pinned) | Why |
| --- | --- | --- |
| `@serenity-kit/opaque` | 1.1.0 | The maintained JS/WASM binding of `opaque-ke` (Meta's Rust OPAQUE, the implementation behind WhatsApp's encrypted backups, NCC Group audit 2021). Implements RFC 9807, ristretto255, runs in browser and Node from one package, configurable Argon2id. MIT, published with provenance |
| `@hpke/core` | 1.10.1 | RFC 9180 on WebCrypto, maintained, tested against the RFC vectors |
| `@hpke/hybridkem-x-wing` | 0.7.1 | X-Wing (draft-connolly-cfrg-xwing-kem-06) for `@hpke/core`; pulls `mlkem` 2.7.1 (same maintainer). Pre-1.0 and tracking a draft: the KEM id is in every envelope header, so a final-RFC change becomes a new suite entry, never a silent reinterpretation |
| `fake-indexeddb` (dev) | 6.2.8 | Exercises the real IndexedDB store code in Node |

## Server side (in place, behind the flag)

| Piece | Where |
| --- | --- |
| Tables `ChatAccountKey`, `ChatAccountKeyLock`, `OpaqueRecord`, `OpaqueLogin`, `OpaqueServerSetup` | `packages/db/prisma/migrations/20271214000000_chat_e2ee_account_key` (additive, rerunnable) |
| Server setup sealed with `encryptSecret(..., POLARIS_MASTER_KEY)`, made on first use; a replaced master key drops every record and the accounts fall back to their password hash | `apps/web/src/lib/chat/e2ee/opaque-service.ts` |
| `/api/e2ee/sign-in` (no session: OPAQUE sign-in, adoption) and `/api/e2ee/keys` (session: public keys, passkey envelopes, OPAQUE unlock of the password envelope). Zod discriminated unions, JSON content type required (no simple cross-site posts), rate limits per address and per account, one refusal body for every cause, 404 while `POLARIS_INTERNAL_CHAT_E2EE` is not `1` | `apps/web/src/lib/chat/e2ee/handlers.ts`, `schemas.ts` |
| Sealed better-auth endpoint `/polaris/opaque-sign-in`: 404 off the wire, challenged by the second factor like `/sign-in/email`, recorded as a password sign-in, refused for an enforced identity-provider domain | `packages/auth/src/opaque-sign-in.ts` |

The password envelope is released only by a successful OPAQUE finish **and** a full session: never to a sign-in still owing its second factor, never by the adoption's verify step, never by a plain read. It is written only by the session's unlock, alongside the proof.

## Sign-in migration to OPAQUE (owner decision: mandatory for every password account)

Requirement: every existing account keeps signing in with its current password exactly as today and moves to OPAQUE on its next successful sign-in; nobody can ever be locked out by the transition.

Design:

1. **Old hash kept.** better-auth's `account.password` (scrypt) is not touched until an OPAQUE record for that user has been written **and verified by a full OPAQUE login in the same sign-in**. Only then is the account marked `opaque` (a new nullable column, so existing rows read as "not yet migrated").
2. **Adoption at next sign-in.** For an unmigrated account the sign-in form keeps posting the password to better-auth as today. After better-auth accepts it (and after 2FA, if the account has it), the client - still holding the typed password - runs OPAQUE registration, then an OPAQUE login against the new record, and creates the password lock for `AK`. Any failure at any step leaves the account on the old path and it is retried next sign-in. Writes are keyed by userId with an upsert, so two concurrent sign-ins produce one record, and the verification login uses whichever record won.
3. **After migration.** The form runs OPAQUE first (`startLogin` with a null record for unknown or unmigrated accounts answers indistinguishably, so it is no account-existence oracle). Server `finishLogin` success creates the better-auth session through the same session-creation path the password route uses, so 2FA, trusted devices, new-device grace, standing and lockdown keep applying unchanged. The scrypt hash is deleted only after the account has signed in with OPAQUE at least once more on a later sign-in.
4. **Password reset / admin recovery.** A reset writes a new OPAQUE record (registration from the reset form, client side). `AK` is not recoverable from the new password: it comes back from a device, passkey PRF or (phase 2) the organisation quorum, then a new password envelope is sealed. The reset flow itself is unchanged for the user.
5. **Untouched.** Passkey, magic-link, connection sign-in and 2FA are not modified; they never had a password to migrate.
6. **Clients on several versions.** Desktop, extension and mobile sign-in to an older or newer host keep using the better-auth password route until both sides advertise OPAQUE; the server keeps accepting it for unmigrated accounts and for migrated accounts while the scrypt hash still exists.

Required tests before this ships: existing account signs in before and after migration; migration interrupted after registration and before verification (still signs in, retries); concurrent sign-ins; password reset on migrated and unmigrated accounts; 2FA and passkey accounts byte-for-byte unchanged.

**Implemented behind the internal flag.** The sign-in form (`oauth/login`) is rendered with `opaqueSignIn={chatE2eeEnabled()}`; while it is false the form runs exactly the code it ran before and never loads the OPAQUE chunk. With it on: OPAQUE first, the better-auth password sign-in whenever OPAQUE does not end in a session, and the adoption (`adoptOpaque`) right after a password sign-in succeeds, before the page moves on - so accounts with a second factor adopt too. In this round the better-auth hash is never deleted; dropping it is a separate, later step once the stack is on and every client speaks OPAQUE. Covered by `apps/web/test/chat/e2ee/opaque-sign-in.test.ts` (before/after, interrupted, concurrent, password reset, password changed mid-login, 2FA, accounts without a password, replaced master key, replay, unknown addresses, cross-account envelope) and `packages/auth/test/sign-in/opaque-endpoint.test.ts`.

Known residuals: a known address costs two more indexed reads than an unknown one at sign-in start (the same order of difference `/sign-in/email` has); `OpaqueLogin` rows are bounded by the per-address limit and swept on every start, not by a global cap.

## Account key after sign-in (implemented behind the flag)

`apps/web/src/lib/chat/e2ee/account-key-client.ts`, loaded only by screens rendered with the flag on; every step swallows its failures and never fails or delays a sign-in visibly.

- **Passkey.** `signInWithPasskeys(allow, extensions)` asks for PRF (`prfExtension()`) only when the flag is on; with it off the call and the options are exactly the old ones. The PRF output stays in the tab: the assertion posted to `verify-authentication` is built field by field and carries no extension results (pinned by a test). `settleAfterPasskey` opens `AK` from this credential's lock, or seals that lock - from this browser's device copy, or from a brand-new `AK` when the account has none.
- **Password.** After an OPAQUE sign-in or an adoption that ended in a full session, `settleAfterPassword` opens the released envelope; when there is none, or it no longer opens (password reset), it takes the key this browser can reach (device copy, or a new `AK` for an account with none) and seals the password lock through the OPAQUE unlock, the only path allowed to write it.
- **Every `AK` is checked against the account's published public keys** before it is kept or sealed under another lock, so a stale device copy or a swapped envelope never spreads. Two sign-ins racing to create the first key: the server keeps one (unique per account) and the refused one seals nothing.
- `/api/e2ee/keys` `state` now also returns `userId`.

## QR approval carries `AK` (implemented behind the flag)

- **New browser** (`oauth/login/qr-panel.tsx`, `carryKeys`): makes an ephemeral X-Wing pair and a random 128-bit device id per flow, sends the 1216-byte public key with `openSignInCode`, and adds `#k=<commitment>.<newDeviceId>` to the QR's link. The key is too large for a QR read off a screen, so the QR carries `SHA-256(canonical(label, flowId, newDeviceId, publicKey))` instead; the fragment never reaches a server. Flow id = the user code.
- **Approver** (`account/scan`): `scanTarget` keeps that exact fragment; the page passes this session's id (the approver device id) only with the flag on and an offer present. The client recomputes the commitment against the server's copy of the offer and seals `AK` (from its device lock, checked against the published key) only on a match; the transfer travels with the PIN-checked decision (`qrKeyTransferSchema`, dropped rather than refusing the answer when malformed).
- **Server** (`qr-sign-in-service.ts`): stores the offer (`DeviceCode.e2eeOffer`) and the transfer (`e2eeApproval`, migration `20271223000000_chat_e2ee_qr_key_transfer`, additive), the latter only after the PIN passed, only for a code with an offer, only when the transfer names the answering session, and before the answer lands. `redeemSignInCodeWithKeys` hands it over in the poll that spends the row, so it is delivered once. With the flag off no new column is read or written.
- **New browser on approval**: `openQrApproval` opens the envelope under the binding, verifies the Ed25519 signature with the key derived from the `AK` inside, then asks the `AccountKeyVerifier`. Phase 1's verifier (`publishedKeyVerifier`) compares with the server-published key, marked `enigma:` for the phase 3 transparency log; only an explicit `true` accepts, a throw or anything else refuses.

Residual until phase 3: a server that consistently publishes a key it forged is not caught by the published-key verifier (that is what the transparency log is for).

## What remains of phase 1

1. Native key stores (Keychain, Keystore, DPAPI/safeStorage) for desktop, Android, iOS.
2. Retiring the better-auth hash for adopted accounts (only when the stack is switched on).
3. Password-only accounts with a second factor: the password lock and a first `AK` are created only on a sign-in that reaches a full session on the page still holding the password (a trusted device, or a passkey sign-in). The 2FA page has no password, so an account that always answers a challenge and has no passkey gets neither until then.
4. The password lock after a reset is re-sealed on a password sign-in in a browser that already holds `AK` (device lock); a reset done only on new browsers re-seals at the first such sign-in.
5. The notice on every device of the account when one is added or `AK` is unlocked with the password only (design 3.2, 11.1 item 20) - with the device list of phase 2.
6. The transparency log behind `AccountKeyVerifier` (phase 3).

Tests added in this round: `packages/chat-crypto/test/qr-approval.test.ts` (19), `apps/web/test/chat/e2ee/qr-key-transfer.test.ts` (10), `account-key-client.test.ts` (14), `passkey-prf-ceremony.test.ts` (2). Mutation runs confirmed the verifier, commitment, signature and approver-session checks are each caught by a failing test.
