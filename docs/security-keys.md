# Passkeys and hardware security keys

How Polaris handles passkeys and roaming FIDO2/U2F authenticators (YubiKey,
SoloKey, Google Titan and similar), what an administrator can require, and the
gaps that remain. Written from the code as of 2026-11-21.

## What works today

| Area | State |
| --- | --- |
| Several keys per account | Yes. Account > Security > Passkeys registers any number; each must have a distinct name. |
| Security keys as passkeys | Yes. Registration never sets `authenticatorAttachment`, so the browser offers USB, NFC and Bluetooth keys as well as the device's own passkey. |
| User verification (PIN, biometrics) | `userVerification: "preferred"`, the passkey plugin's default: a key with a PIN asks for it, a key without one still works. |
| Resident and non-resident credentials | `residentKey: "preferred"`. A key with no room for a discoverable credential still registers one that is not discoverable; sign-in narrows the prompt to the typed account's credentials (`lib/passkey-sign-in.ts`), so both kinds sign in. |
| Removing a key | Account > Security. Refused for the last key when the instance requires keys of that account (see below). |
| Vault unlock | `lib/vault/passkey-client.ts` asks for `userVerification: "required"` and works with any authenticator that supports the PRF extension; many security keys do not, and the Vault says so. |

## Requiring passkeys or security keys

Admin > Security > **Require passkeys or security keys**: Nobody (default),
Administrators, Everyone.

- Nothing changes for anybody until an administrator picks Administrators or
  Everyone. A policy stored before the setting existed reads as Nobody.
- A covered account's session must have been opened with a passkey or a
  security key (`SessionState.signInMethod = "passkey"`). Any other session -
  password, emailed link, connected account, QR code, or one whose sign-in was
  never recorded - is held on `/oauth/security-key` at its next request,
  including sessions opened before the requirement was turned on.
- That screen signs in again with a key. An account with no key registers one
  there first (password confirmed, as on the account page), then signs in with
  it. Registering alone does not release the session: it was still opened with
  something a look-alike site could collect.
- Saving the requirement is refused while the administrator saving it has no
  key, which also proves keys work at this instance's address. An instance on a
  bare IP cannot register passkeys at all, so it cannot turn this on.
- The last key of a covered account cannot be removed (checked in a
  serializable transaction, so two removals cannot race past it).
- Recovery cannot downgrade a covered account: a password reset or a recovery
  sign-in opens a password session, which the guard holds like any other until
  the person signs in with a key.

- A covered account with no key yet enrols its first one from a session opened
  with its password (and second factor, when it has one). That first enrolment
  is as strong as that sign-in; every sign-in after it needs the key.
- Somebody who has lost every key they registered cannot get past the screen,
  and no recovery path deletes keys. Until an administrator recovery for keys
  exists, the way back is an administrator narrowing the requirement (Everyone
  to Administrators, or Nobody) while the person registers a new key.

Enforced in `guardSession` (`lib/session-guard.ts`), after the second-factor
requirement, so an account owing both arms the second factor first.

## Gaps

- **Step-up for sensitive actions does not accept a key yet.** The mid-session
  proofs (`STEP_UP_PROOFS`) are the authenticator, emailed/WhatsApp/Telegram
  codes and the password. Adding a key needs a WebAuthn assertion verified on
  the server without opening a new session, which the passkey plugin does not
  offer; it would mean verifying with `@simplewebauthn/server` directly against
  the stored credential and counter.
- **No attestation, so no allowlist of key models.** The passkey plugin
  hard-codes `attestationType: "none"` and never verifies an attestation
  statement. With `none`, browsers may replace the AAGUID with zeros, and an
  unverified AAGUID can be forged by any client. Requiring hardware-bound or
  FIPS-certified keys therefore cannot be done safely as configured. Doing it
  properly means: request `direct` attestation, verify the statement against the
  FIDO Metadata Service BLOB (signed JWT, root certificate pinned, refreshed on a
  schedule and cached for offline instances), refuse registrations whose AAGUID
  is not on the administrator's list, and keep the verified result with the
  credential. That is a patch to the plugin's registration endpoint plus a
  metadata refresher, not a setting.
- **Key model labels** follow from the same limit: the `aaguid` column is stored,
  but it is only meaningful when the browser kept it and only trustworthy once
  attestation is verified.
- **API keys, MCP tokens and app passwords** are not sessions and are not
  covered by the requirement.
- **Polaris Desktop (Electron).** Not changed here and not exercised on a device.
  WebAuthn runs in Electron's Chromium: on Windows through the system WebAuthn
  API (Windows Hello and USB/NFC keys); on macOS, Electron does not offer
  iCloud Keychain passkeys, and security-key support there is unverified.
- **Android app.** The WebView enables WebAuthn for the app
  (`WEB_AUTHENTICATION_SUPPORT_FOR_APP`, `MainActivity.java`) and the server
  accepts the app's own origin, so passkeys and keys go through Android's
  credential manager where the OS supports it. Not exercised on a device.
- **iOS app.** No `webcredentials` associated domain is configured, so
  WKWebView offers no passkeys or security keys. A covered account cannot sign
  in from the iOS app; it has to use the browser.
