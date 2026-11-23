# Chat E2EE - phase 1: the account key and its locks

Status of phase 1 of [chat-e2ee-proposal.md](chat-e2ee-proposal.md) (sections 3.1-3.4, 4.5, 11, 13, 14). The password lock is on by default since 2026-11-23 ("Switched on" below); everything else sits behind the internal rollout flag.

## What exists

`dashboard/packages/chat-crypto` (`@polaris/chat-crypto`), client side, WebCrypto plus two vetted libraries:

| Module | Content |
| --- | --- |
| `account-key` | `AK` = 32 random bytes. Ed25519 signing pair and X-Wing (X25519 + ML-KEM-768) HPKE pair derived with HKDF-SHA256 under distinct versioned labels. Private signing key non-extractable |
| `locks` | One envelope format for every lock: `version \|\| kind \|\| salt(32) \|\| AES-256-GCM(AK)`. Key and nonce come from HKDF over a fresh 256-bit salt (never a bare random nonce). AAD = header + canonical(label, userId, kind, lockId, akVersion). Closed lists for version and kind. One coarse error for every failure |
| `device-lock` | Non-extractable HKDF `CryptoKey` + envelope in IndexedDB, one database per account (`polaris-chat-keys:<userId>`); sign-out deletes only that database |
| `password-lock` / `opaque-server` | OPAQUE (RFC 9807). `exportKey` imported straight into a non-extractable key and used as the lock secret. Argon2id profiles fixed in code (v1 128 MiB t=3, v2 19 MiB t=2 for new records; a registration never takes its profile from the server). Client identity = userId, so a record is bound to its account |
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

## Phase 1 inventory (ledger)

Authoritative list: proposal section 14, phase 1. A row is done only with the commit and the test that prove it.

| # | Unit | State | Evidence |
| --- | --- | --- | --- |
| 1 | `AK` (Ed25519 + X-Wing), lock envelope format, hybrid PQ envelope | done | `31dad22234`, `packages/chat-crypto/test/locks.test.ts` |
| 2 | Device lock (IndexedDB, non-extractable key) | done | `31dad22234` |
| 3 | Password lock over OPAQUE (RFC 9807), Argon2id 128 MiB | done (flag) | `31dad22234`, `6773c1b644`, `opaque-sign-in.test.ts` |
| 4 | Passkey PRF lock | done (flag) | `892c916da1`, `passkey-prf-ceremony.test.ts` |
| 5 | QR approval carries `AK` | done (flag) | `892c916da1`, `qr-key-transfer.test.ts`, `qr-approval.test.ts` |
| 6 | Server tables, routes, sealed OPAQUE setup | done (flag) | `6773c1b644` |
| 7 | Adoption of existing password accounts at next sign-in, no lockout | done (flag) | `6773c1b644` |
| 8 | Password + second factor accounts get `AK` and the password lock | done (flag) | held password across the challenge page (`lib/chat/e2ee/held-password.ts`), `account-key-client.test.ts` "a sign-in that owed a second factor", `held-password.test.ts` |
| 9 | A new browser opens an existing password lock when the sign-in brought no envelope (adoption, challenge) | done (flag) | `openWithUnlock` in `account-key-client.ts`; wrong password / reset elsewhere never replaces the lock (test) |
| 10 | Native key stores: desktop `safeStorage`, Android Keystore, iOS Keychain | code done | `packages/chat-crypto/src/platform-store.ts` + tests; `desktop/src/main/key-wrap.ts` + `desktop/test/main/key-wrap.test.ts`; `mobile/android/.../ChatKeyStore.java`, `mobile/ios/Polaris/ChatKeyStore.swift`. Android and iOS not compiled on this machine; no app release cut yet |
| 11 | Extension key store | not applicable in phase 1 | the extension renders no chat and never holds `AK`; its role (bundle verification) is phase 3 |
| 12 | Sign-out removes the account's device lock (proposal 3.3); "sign out of all" removes every one | done | `lib/account-switch.ts`, `forgetEveryDeviceLock` test |
| 13 | Accounts with no password and no PRF passkey (magic link, connection, SSO) | open, by design until phase 2 | a device-only `AK` would be orphaned by the first cleared browser with nothing to re-key it; they get `AK` through the QR approval today and through `ORK` in phase 2 (proposal 3.3 rows 3-4) |
| 14 | Retire the better-auth password hash | blocked | see below |
| 15 | Password lock live for everyone | on by default (2026-11-23); passkey PRF locks and the QR hand-over still behind the chat flag | see "Switched on" below |
| 16 | Notice on every device when one is added or `AK` opens with the password only | open | needs the device list of phase 2 |
| 17 | Transparency log behind `AccountKeyVerifier` | phase 3 | - |

**Why the hash is not retired (14).** Retiring `account.password` while any of these still verifies the password against it would lock people out, which the owner forbids: `changePasswordAction` and `promoteEmailAction` (current password), better-auth's two-factor enable/disable (password), the step-up password proof, the reset and sign-up forms (they write the hash), administrator credential resets, and every client or host version that signs in through `/sign-in/email`. Each needs an OPAQUE equivalent first, and the OPAQUE path itself is still behind the internal flag. Order: move those flows to OPAQUE, switch the flag on, then delete the hash for accounts that signed in over OPAQUE at least twice - checked against the state, never a version number.

## Switched on (15)

The owner decided to switch the password lock on, on the condition that nobody notices at sign-in: same form, same speed, sessions kept, nobody locked out.

- **Switch.** `passwordLockEnabled()` (`lib/chat/e2ee/flag.ts`) is on with nothing set, so every install has it after the update with no `.env` change. `POLARIS_INTERNAL_PASSWORD_LOCK=0` is the kill switch: the form runs only `/sign-in/email` and both OPAQUE routes answer 404. It gates `/api/e2ee/sign-in` and the `state`, `create-account-key` and `unlock-*` operations; the passkey lock operations and the QR key hand-over stay on `chatE2eeEnabled()` (the form's separate `chatKeys` prop).
- **Sign-in speed.** Every OPAQUE client step runs in a Web Worker (`password-worker.ts`, `password-worker-client.ts`), never on the page's thread. A submit runs at most one Argon2id before the redirect (the OPAQUE login). The adoption (registration + verification) and opening or sealing the account key are queued in the background (`adoptInBackground`, `settleInBackground`) and never awaited: the page moves on at once. A failure anywhere, including a worker that does not start, leaves the account on its password hash and the next sign-in tries again. The held password is dropped when its job ends. A full navigation right after sign-in (the mobile shell, an OAuth client's redirect) can cut a background adoption short; it is then retried at the next sign-in.
- **Profile v2.** Measured headless (Chromium 1248, CPU throttling through DevTools, OPAQUE client finish only, median of 3; 2026-11-23, on a loaded dev machine):

  | CPU | v1 128 MiB t=3 | 64 MiB t=3 | 46 MiB t=1 | v2 19 MiB t=2 |
  | --- | --- | --- | --- | --- |
  | 1x | 291 ms | 274 ms | 62 ms | 53 ms |
  | 4x | 2012 ms | 1409 ms | 485 ms | 486 ms |
  | 6x | 3650 ms | 1667 ms | 386 ms | 289 ms |
  | 6x + memory pressure | 3394 ms | 1338 ms | 304 ms | 249 ms |

  The old sign-in costs the browser nothing and the server one scrypt (~58 ms); the OPAQUE server steps cost ~1 ms. v1 is seconds slower on a slow phone, so new records use v2, OWASP's second Argon2id configuration (19 MiB, t=2, p=1), the largest that stays under 300 ms at 6x (46 MiB, the first configuration, came out at 386 ms). `OpaqueRecord.ksfVersion` (migration `20271227000000_opaque_record_ksf_version`, additive, default 1) records the profile; the three start replies report it; v1 records keep working. The client always registers with the current profile fixed in code, so a server can never choose a cheaper one for a new password; a wrong version in a login reply only makes that login fail. A start for an account with no record names the current profile, so it reads like a new account; a v1 record would read differently, and v1 records only exist where the internal flag was set before this change.
- **Slow submit.** `components/slow-submit-label.tsx`: after 300 ms (a CSS delay, no timer) the busy label gives way, in the same grid cell, to a line with a shield; no layout shift, motion dropped for reduced motion. The encryption line shows only when the submit actually ran the key stretching (the form is told by `signInWithOpaque`), a neutral line otherwise.

## Password rules under OPAQUE

The server never sees a password registered over OPAQUE, so the rules are enforced in the client, as Bitwarden, 1Password and Proton do. `lib/chat/e2ee/password-rules.ts` (`startCheckedRegistration`) runs before any registration of a new password and reuses the server's own rules: `passwordField` (10-256, the bounds `recoveryResetSchema` also uses), `passwordMatchesIdentity` (behind `refuseIdentityPassword`), and the breached check by k-anonymity through `/api/polaris/pwned/[prefix]` (fails open, like every breach check here). Adoption at sign-in does not re-check: that password was checked by the server when it was set.

What a modified client could bypass: the rules for its own account's password, nothing else - no other account, record or key. What the server still enforces: rate limits per address and per account on every OPAQUE route, the second factor after an OPAQUE sign-in, and every rule on each route where it still receives the password (`/sign-in/email`, sign-up, reset, the old change action, the adoption's hash check). Recorded as accepted risk [VULN-0044](vulnerabilities/VULN-0044-password-rules-client-enforced-under-opaque.md); client integrity verification (docs/integrity.md once it exists) narrows it further.

## Password flows over OPAQUE

Goal: no flow that proves or sets a password sends it to the server. Two primitives, both on `/api/e2ee/keys` (session required, behind `passwordLockEnabled()`), finished by the server action itself so the result is spent once and bound to the session that runs it:

- **Proof** (`proof-start`, then the action calls `provesPassword`): an OPAQUE login against the account's verified record. The login state carries the session id; a finish from another session, for another account, replayed, or absent (the browser already knew the password was wrong - it still sends the login id, so the attempt is spent, counted and audited) is refused. Limited per account (`e2ee-proof:`), on top of the action's own limits.
- **Set** (`set-start`, `set-verify`, then the action calls `setPasswordOverOpaque`): the browser runs the shared rule guard (`startCheckedRegistration`), registers, and proves the new record with a full login before anything is written. The record waits inside that login state, never where an exchange could use it. The commit is one transaction: the better-auth hash becomes the hash of a random secret nobody keeps and the record is stored verified, tagged with that hash. Every check still made against the hash would then refuse the owner too, so better-auth's `password.verify` is wrapped (`passwordFallback` in `packages/auth/src/auth.ts`, answered by `passwordOpensHashlessAccount` in `opaque-service.ts`): on a mismatch it finds the verified record tagged with exactly that hash (indexed by `passwordTag`) and runs both halves of an OPAQUE login on the server with the password it was handed (one Argon2id). That check runs on a bounded pool of worker threads (`clear-password-pool.ts`: at most two threads, a short queue, a 10 s cap; a full queue is a refusal), never on the event loop, and only once the per-account limit (`opaque-clear:`, ten failures in a row, cleared by the right password) and the per-address limit (`opaque-clear-address:`) have room, so wrong passwords cannot stall the server. So the time taken does not say whether an account is hash-less, every account-password mismatch and every hash (which is how better-auth answers an unknown address) is padded to one floor (`passwordCheckFloorMs`: 1.5 times the slowest of the last 16 pool checks, between 250 ms and 3 s); a right password is never padded. PINs, recovery answers and sent codes use better-auth's hasher directly (`hashSecret`/`verifySecret`), outside both. That keeps every route that still receives a password - an old client's `/sign-in/email`, 2FA enable/disable and its policy, the lock screen, vault, quick PIN, passkey confirmation - working for these accounts until each moves to a proof; it sees no password those routes did not already receive. An old client's reset or an administrator writing a real hash retires the record by its tag, as before. Limited per account (`e2ee-set:`).

Browser side: `lib/chat/e2ee/password-flows-client.ts`, loaded on submit only. `opaquePasswordReady()` (the `state` op: adopted, plus the name and address the rules check against) decides the path; null - lock switched off, account not moved yet, a host without these ops, a network failure - keeps the old action. A worker or network failure before the commit throws `PasswordFlowUnavailable` and the form uses the old action too; nothing is half-written. Every Argon2id is in the password worker, which now reports a refused password apart from a broken worker. The submit shows `SlowSubmitLabel` with the encryption line only when OPAQUE runs.

| Flow | State | Evidence |
| --- | --- | --- |
| Change password (`changePasswordOpaqueAction`; old `changePasswordAction` kept for unmoved accounts) | done | `apps/web/test/chat/e2ee/opaque-password-flows.test.ts` |
| Step-up password proof through `StepUpDialog` / `proveStepUpAction` (`opaque-password` proof = the "password" choice) | done | same file, "a step-up password becomes its OPAQUE proof" |
| Step-up proofs sent by the screens that embed `StepUpFields` directly (org delete, account and org successor, lockdown, lift, close account) | done | `stepUpProofToSend` (`lib/step-up-proof-client.ts`) on the client, `anyStepUpProofSchema` in each action; `test/account/step-up-opaque-proofs.test.ts` (org delete by review: same one-line schema swap) |
| Promote an alternate address to primary (`promoteEmailOpaqueAction`; old `promoteEmailAction` kept) | done | `apps/web/test/account/promote-email-opaque.test.ts`, `packages/auth/test/account/emails.test.ts` |
| Forgot-password reset, recovery completion, `recoverPasswordAction`, sign-up, admin reset, 2FA enable/disable and policy, session lock screen, vault, chat lock ops | open | reset, recovery and sign-up need a token-authorised variant of the set primitive (no session) |
| Desktop, extension, mobile, TV | nothing to change | none posts a password itself; they sign in through the web form |

An account whose password was set over OPAQUE has no usable password hash any more, so the kill switch (`POLARIS_INTERNAL_PASSWORD_LOCK=0`) must never take OPAQUE away from it. With the switch, nothing is moved onto OPAQUE (no adoption, `adopt-*`/`verify-*` answer 404, and the OPAQUE flows answer 404 for an account not on it yet), but an account already on OPAQUE (a verified record for its current password) keeps all of it: `sign-in-start`/`sign-in-finish` stay up (a start for any other address runs against no record and cannot finish), `/api/e2ee/keys` answers that account, and `provesPassword`/`setPasswordOverOpaque` accept it (`opaqueFlowsOpen`). The sign-in form runs `/sign-in/email` first and tries OPAQUE only when that refuses the password, so accounts that still have a hash never pay for the second try. Pinned by the "kill switch" cases in `opaque-password-flows.test.ts`.

## Adversarial review checklist (phase 1)

| Check | Result |
| --- | --- |
| The held password never reaches storage, is taken once, expires, is dropped on abandon | pinned by `held-password.test.ts` |
| An unlock answering for another account is refused | test |
| A lock that does not open is never overwritten with a new key | test |
| Platform-sealed values are bound to the server origin (desktop: inside the ciphertext; Android/iOS: GCM associated data) | desktop test; Android/iOS by code review only |
| A platform store that is reset, locked, another, or throws reads as no device copy, never an error or another key | `platform-store.test.ts` |
| An existing plain device record moves under the platform store on first read and stays readable when the store refuses | test |
| Linux without a secret service is not trusted as a store | desktop test |
| Only the Polaris main frame reaches the desktop and iOS stores | `fromPolaris` / frame check; Android's JavaScript interface is visible to every frame of the WebView, so a third-party frame could ask it to open a sealed device envelope, which is still useless without that origin's IndexedDB key |

## What remains of phase 1

1. Rows 13, 14, 15 and 16 above, and app releases carrying row 10 (desktop tag, Android build, iOS build - the iOS one needs the owner's Apple signing).
2. The password lock after a reset is re-sealed on a password sign-in in a browser that already holds `AK`; a reset done only on new browsers re-seals at the first such sign-in.
3. The transparency log behind `AccountKeyVerifier` (phase 3).
