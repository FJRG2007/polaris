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
| `passkey-lock` | WebAuthn PRF: fixed per-account PRF input, credential id as lock id. An assertion without PRF output yields `null` and no lock - never an error |
| `hybrid-envelope` | RFC 9180 HPKE base mode, X-Wing KEM (0x647a) + HKDF-SHA256 + AES-256-GCM, header as AAD, purpose and binding in `info`. Suite is a closed list of one |

Tests (`packages/chat-crypto/test`, 31): round trips for every lock, own known-answer vectors (lock envelope, signing public key), every-byte tamper, envelopes swapped across account / lock / kind / version, id boundary shift, wrong password, record under another account, missing record, another server setup, replayed OPAQUE finish, swapped password envelope, wrong HPKE recipient / purpose / binding / suite byte, and the 11.1 items this phase covers (1 derived nonces, 2 complete AAD, 4 domain separation and canonical encoding, 11 no hand-rolled secret comparison, 12 CSPRNG only, 13 closed lists).

### Libraries

| Library | Version (pinned) | Why |
| --- | --- | --- |
| `@serenity-kit/opaque` | 1.1.0 | The maintained JS/WASM binding of `opaque-ke` (Meta's Rust OPAQUE, the implementation behind WhatsApp's encrypted backups, NCC Group audit 2021). Implements RFC 9807, ristretto255, runs in browser and Node from one package, configurable Argon2id. MIT, published with provenance |
| `@hpke/core` | 1.10.1 | RFC 9180 on WebCrypto, maintained, tested against the RFC vectors |
| `@hpke/hybridkem-x-wing` | 0.7.1 | X-Wing (draft-connolly-cfrg-xwing-kem-06) for `@hpke/core`; pulls `mlkem` 2.7.1 (same maintainer). Pre-1.0 and tracking a draft: the KEM id is in every envelope header, so a final-RFC change becomes a new suite entry, never a silent reinterpretation |
| `fake-indexeddb` (dev) | 6.2.8 | Exercises the real IndexedDB store code in Node |

## What remains of phase 1

1. **Server storage.** Prisma models (additive, rerunnable migration per `test/updates/migrations-rerunnable.test.ts`): `ChatAccountKey` (userId, akVersion, signPublicKey, hpkePublicKey), `ChatAccountKeyLock` (userId, kind, lockId, akVersion, envelope; unique on userId+kind+lockId), `ChatOpaqueRecord` (userId, record), `ChatOpaqueLogin` (id, userId, state, expiresAt; deleted on finish, swept on expiry), and the OPAQUE `serverSetup` stored encrypted with `encryptSecret(..., POLARIS_MASTER_KEY)` so a database-only theft does not carry it. Generated on first use, so no `.env` key is needed.
2. **Routes** (Zod discriminated union, `backgroundUser()`, 404 while the flag is off, `rateLimit` per user on login start): register start/finish (record and envelope written in one transaction), login start/finish, put/delete passkey envelope, read public keys. The password envelope is released **only** after `finishLogin` succeeds, so a stolen session cookie does not yield material for offline guessing. Re-registering the password lock should require the existing step-up grant.
3. **Native key stores** (Keychain, Keystore, DPAPI/safeStorage) for desktop, Android, iOS.
4. **QR approval lock** (below) and the **sign-in migration** (below).

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

**Not implemented in this deliverable.** It changes the production sign-in path for every account and cannot be done safely before item 1-2 above exist and the better-auth session path is wired and tested. It is the next step of phase 1.

## QR approval carries `AK`

The existing QR device flow (`qr-sign-in-device-flow`) gains an end-to-end channel: the new device shows, inside the QR, an ephemeral X-Wing public key plus a hash of its device credential; the approving device, already holding `AK`, seals `AK` with `hybrid-envelope` (purpose `qr-approval`, binding = the flow's id and both device ids) and posts the envelope through the existing approval request. The server relays bytes it cannot open. Item 17 of 11.1 (key-compromise impersonation) is answered by having the approver sign the envelope with the `AK` signing key and the new device check it against the transparency log (phase 3) before trusting anything it unlocks. Not implemented yet.
