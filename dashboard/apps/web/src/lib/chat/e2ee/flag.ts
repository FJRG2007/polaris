/**
 * What sealed chat is with `POLARIS_INTERNAL_CHAT_E2EE` unset - which is every
 * install, since existing ones never receive a new `.env` key (repo CLAUDE.md).
 * Phase 14 of docs/chat-e2ee-proposal.md turns it on by changing this one
 * constant in a release; nothing else has to move, and nobody sets a variable.
 */
export const CHAT_E2EE_DEFAULT_ON = false;

/**
 * The internal rollout flag for chat end-to-end encryption.
 *
 * Deliberately not a setting: no screen offers it and no install writes it.
 * Unset, it is `CHAT_E2EE_DEFAULT_ON` (off until phase 14); `1` turns it on
 * and `0` off whatever the default, so once the default is on, `0` is the
 * kill switch for an incident, as `POLARIS_INTERNAL_PASSWORD_LOCK=0` is - not
 * a setting, and never a lockout: `0` holds sealed chat (`chatE2eeState()`),
 * it does not switch it off. Any other value is the default, so a typo never
 * flips it. With it unset and the default off, every route behind it answers
 * 404 and the password sign-in is exactly what it was.
 *
 * Read on every call rather than once, so a test can switch it per case.
 */
export function chatE2eeEnabled(): boolean {
    return chatE2eeFrom(process.env.POLARIS_INTERNAL_CHAT_E2EE, CHAT_E2EE_DEFAULT_ON);
}

/** The flag's rule, apart from the environment, so the default-on shape is tested before it is shipped. */
export function chatE2eeFrom(value: string | undefined, defaultOn: boolean): boolean {
    return chatE2eeStateFrom(value, defaultOn) === "on";
}

/**
 * Sealed chat's three states (docs/chat-e2ee-mls.md, "The kill switch"):
 * `on`; `held`, the kill switch (`0` set) - nothing new becomes sealed, and
 * every conversation already sealed keeps opening and sending sealed, since it
 * has no plain copy to fall back to; `off`, unset with the default off, where
 * nothing was ever sealed and nothing behind the flag answers.
 */
export type ChatE2eeState = "on" | "held" | "off";

export function chatE2eeState(): ChatE2eeState {
    return chatE2eeStateFrom(process.env.POLARIS_INTERNAL_CHAT_E2EE, CHAT_E2EE_DEFAULT_ON);
}

export function chatE2eeStateFrom(value: string | undefined, defaultOn: boolean): ChatE2eeState {
    const set = value?.trim();
    if (set === "1") return "on";
    if (set === "0") return "held";
    return defaultOn ? "on" : "off";
}

/**
 * Whether what is already sealed is served: `on` or `held`. Reading history,
 * sending into a sealed conversation, refusing plain writes into one, account
 * keys and the QR hand-over all sit behind this; starting something new
 * (a group, a migration pass, a sealed member) sits behind `chatE2eeEnabled()`.
 */
export function sealedChatServed(): boolean {
    return chatE2eeState() !== "off";
}

/**
 * The password lock: OPAQUE password sign-in, moving an account onto it at its
 * next password sign-in, and the account key it seals (docs/chat-e2ee-phase1.md,
 * "Switched on"). On by default, with nothing to configure: an install that never
 * received a new `.env` key has it on too. `POLARIS_INTERNAL_PASSWORD_LOCK=0` is a
 * kill switch for an incident, not a setting, and it never locks anybody out:
 * it stops moving accounts onto OPAQUE (no adoption, no OPAQUE flows for an
 * account not on it yet, the sign-in form runs the old password route first),
 * but an account already on OPAQUE keeps signing in and proving or setting its
 * password over it - one whose password was set over OPAQUE has no usable hash
 * (docs/chat-e2ee-phase1.md, "Password flows over OPAQUE"). Every other OPAQUE
 * route answers 404.
 *
 * Passkey PRF locks and the QR key hand-over stay behind `chatE2eeEnabled()`.
 * Read on every call rather than once, so a test can switch it per case.
 */
export function passwordLockEnabled(): boolean {
    return process.env.POLARIS_INTERNAL_PASSWORD_LOCK !== "0";
}
