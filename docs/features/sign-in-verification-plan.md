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

- [x] Dropped by the owner (2026-11-23): the phone approves a sign-in as a second
      factor after the password and never replaces it. The passwordless flow
      that was briefly on main was removed; the `purpose` column it added stays
      (always "second-factor", only that value is ever collected).

## 3. Risk-based extra verification

- [ ] Not started.

## 4. Phone number + password sign-in, SMS second factor off by default

- [x] A verified number typed in international form names its account
      (`emailForPhone`); the password then goes through the same OPAQUE path.
      A number verified on two accounts names neither.
- [x] A number without its country code is read in the request's country
      (edge header or address), else the reader's language; an all-digit
      username still resolves when no verified number matches.
- [x] SMS as a second factor: there is no SMS delivery method today
      (email, WhatsApp, Telegram only), so it is off and hidden by construction.
- [ ] An admin switch to add SMS as a method (off by default) - not started.
