/**
 * The internal rollout flag for chat end-to-end encryption.
 *
 * Off everywhere, and deliberately not a setting: no screen offers it and no
 * install writes it. Phases 1 to 13 of docs/chat-e2ee-proposal.md land behind
 * it and are switched on together in phase 14, in a release that flips this
 * default rather than asking anybody to set a variable. Until then every route
 * behind it answers 404 and the password sign-in is exactly what it was.
 *
 * Read on every call rather than once, so a test can switch it per case.
 */
export function chatE2eeEnabled(): boolean {
    return process.env.POLARIS_INTERNAL_CHAT_E2EE === "1";
}

/**
 * The password lock: OPAQUE password sign-in, moving an account onto it at its
 * next password sign-in, and the account key it seals (docs/chat-e2ee-phase1.md,
 * "Switched on"). On by default, with nothing to configure: an install that never
 * received a new `.env` key has it on too. `POLARIS_INTERNAL_PASSWORD_LOCK=0` is a
 * kill switch for an incident, not a setting - with it the sign-in form runs the
 * old password route only and every OPAQUE route answers 404. Accounts already
 * moved keep signing in, because adoption never removes their password hash -
 * except an account whose password was changed over OPAQUE, which has no hash
 * and signs in again after a reset (docs/chat-e2ee-phase1.md, "Password flows
 * over OPAQUE").
 *
 * Passkey PRF locks and the QR key hand-over stay behind `chatE2eeEnabled()`.
 * Read on every call rather than once, so a test can switch it per case.
 */
export function passwordLockEnabled(): boolean {
    return process.env.POLARIS_INTERNAL_PASSWORD_LOCK !== "0";
}
