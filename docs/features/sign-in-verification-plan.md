# Sign-in verification: phone approval, passwordless, risk, phone number

Inventory and coverage ledger for the sign-in verification work asked for on
2026-11-23. A unit is ticked only once it is verified (tests, build), never
because a similar one worked.

## Prior art

- Microsoft Authenticator: number matching is on for every push, the sign-in page
  shows a number that has to be entered in the app, and an app too old to do it
  cannot approve at all - the same rule used here for an outdated phone app.
  <https://learn.microsoft.com/en-us/entra/identity/authentication/how-to-mfa-number-match>
- Google "Verify it's you": a prompt on a signed-in device, or a code to the
  recovery phone, before sensitive actions.
  <https://support.google.com/accounts/answer/7162782>
- Microsoft Authenticator passwordless phone sign-in: the account is typed, the
  phone shows a number to match and asks for its own lock, and that counts as
  multi-factor on its own.
  <https://learn.microsoft.com/en-us/entra/identity/authentication/howto-authentication-passwordless-phone>
- Google sign-in prompts: offered for the typed account on a phone already
  signed in to it, with the password one press away.
  <https://support.google.com/accounts/answer/7026266>
- GitHub Mobile (pick the number among three choices) is the model for showing
  choices instead of a keypad; its documentation was not re-read for this work.

## 1. Phone approval completed

- [x] Number matching: server picks a two-digit number per request, browser shows
      it, phone shows three choices; wrong pick = denied and counted.
- [x] Three wrong picks in an hour switch phone approval off for that account
      for the hour (push-bombing guard).
- [x] Attempt details on the prompt: device, IP, approximate place.
- [x] Denied or wrong pick raises an account security notice pointing at
      /account/security (where the account can lock itself down).
- [x] Old phone app (no number support) cannot approve a request that carries a
      number; it is told to update. Deny keeps working.
- [ ] (written; compiled only by the mobile CI, never run on a device) Android: Approve opens a confirm screen; the pick is gated by
      BiometricPrompt (BIOMETRIC_STRONG | DEVICE_CREDENTIAL, API 30+), device
      credential on 28-29, keyguard confirm on 26-27; no screen lock = no approve.
- [ ] iOS parity - blocked: the iOS app has no device key or notice channel yet.

## 2. Passwordless sign-in by phone approval

Design: "Sign in with your phone" is drawn only for a typed account whose phone
can answer (a throttled hint, like the passkey one). Pressing it stores a
`SignInApproval` with `purpose = "sign-in"` under the hash of a random secret
set as an http-only, SameSite=Strict cookie on the asking browser, and shows the
number. The phone approves exactly as for a second factor (number mandatory,
screen lock, three wrong picks rest it). The browser collects with its cookie;
the approval is spent once and the session is issued by the sealed
`/polaris/phone-sign-in` better-auth endpoint (shared with OPAQUE via
`sealed-sign-in.ts`), so the enforced identity provider, the sign-in listeners
and the sign-in record ("Phone approval") apply, and the session guard's
lockdown refusal and new-device grace apply to it like any session. It is not
challenged: device key plus screen lock is already two factors.

- [x] Approval purpose column, migration `20271230000000_sign_in_approval_purpose`.
- [x] Each purpose collected only by its own collector; bound to the browser
      secret; spent once (test/mobile/phone-sign-in.test.ts).
- [x] Rate limits: per address 10/10 min, per identifier 5/10 min, per account
      shared with the second-factor prompt, poll 90/min per browser.
- [x] Refusal notice says "nothing was let in" rather than "change your password".
- [x] Sign-in screen button, waiting view with the number, password always one press away.
- [ ] Not exercised against a running instance or a real phone (no Docker here).
- [ ] Chat end-to-end keys stay locked after a passwordless sign-in, as after a
      passkey without PRF; they open at the next password entry.

## 3. Risk-based extra verification

- [ ] Not started.

## 4. Phone number + password sign-in, SMS second factor off by default

- [x] A verified number typed in international form names its account
      (`emailForPhone`); the password then goes through the same OPAQUE path.
      A number verified on two accounts names neither.
- [ ] No country-less numbers: "600 000 003" without "+34" is not resolved.
- [x] SMS as a second factor: there is no SMS delivery method today
      (email, WhatsApp, Telegram only), so it is off and hidden by construction.
- [ ] An admin switch to add SMS as a method (off by default) - not started.
