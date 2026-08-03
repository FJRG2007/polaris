/**
 * How a session proved who it was.
 *
 * Two facts, kept apart because they answer different questions. The method is
 * what identified the account - a password, a passkey, an emailed link, a code
 * scanned from a screen that was already signed in. The second factor is what was
 * asked for on top of it, and that includes the two answers that are not a code
 * at all: a browser the account remembered, which is a challenge that was
 * deliberately skipped, and a backup code, which is the spare key being spent.
 *
 * A session's sessions list is the screen somebody opens when they think their
 * account is being used by somebody else, and "signed in with a password, no
 * second step" and "signed in with a password and an authenticator code" are the
 * difference between an alarm and a shrug. Recording only the second one - or
 * only that the factor is armed - answers neither question.
 *
 * Both are stored as plain strings, so both are parsed on the way out: a value
 * this build no longer knows reads as unrecorded rather than as a label nobody
 * can place.
 */

/** How the account was identified. */
export const SIGN_IN_METHODS = ["password", "passkey", "email-link", "qr-code"] as const;

export type SignInMethod = (typeof SIGN_IN_METHODS)[number];

/**
 * What answered the second-factor step, when there was one.
 *
 * `trusted-device` is the challenge that never happened: the browser had been
 * remembered, so the password alone was enough. It is recorded as a second factor
 * because that is the question it answers, and because a sign-in that skipped the
 * step is exactly the one worth being able to find.
 */
export const SECOND_FACTORS = [
    "totp",
    "email-code",
    "whatsapp-code",
    "code",
    "backup-code",
    "trusted-device"
] as const;

export type SecondFactor = (typeof SECOND_FACTORS)[number];

/** How each one reads on a screen. Short: these sit as badges next to a device
 *  name, beside "This device" and "Locked". */
export const SIGN_IN_METHOD_LABELS: Record<SignInMethod, string> = {
    password: "Password",
    passkey: "Passkey",
    "email-link": "Email link",
    "qr-code": "QR code"
};

export const SECOND_FACTOR_LABELS: Record<SecondFactor, string> = {
    totp: "Authenticator app",
    "email-code": "Emailed code",
    "whatsapp-code": "WhatsApp code",
    code: "Sent code",
    "backup-code": "Backup code",
    "trusted-device": "Remembered device"
};

/**
 * The second factor a delivered code amounts to, by the channel it went out on.
 * The channel is settled server-side when the code is sent, which is a different
 * request from the one that checks it, so this is where the two meet.
 */
export const SECOND_FACTOR_BY_DELIVERY: Record<string, SecondFactor> = {
    email: "email-code",
    whatsapp: "whatsapp-code"
};

/** How one sign-in proved itself, as stored. Either half can be absent: an old
 *  session predates the record, and most accounts have no second factor. */
export interface SignInRecord {
    method: SignInMethod | null;
    secondFactor: SecondFactor | null;
}

export function parseSignInMethod(value: string | null | undefined): SignInMethod | null {
    const known: readonly string[] = SIGN_IN_METHODS;
    return value !== null && value !== undefined && known.includes(value) ? (value as SignInMethod) : null;
}

export function parseSecondFactor(value: string | null | undefined): SecondFactor | null {
    const known: readonly string[] = SECOND_FACTORS;
    return value !== null && value !== undefined && known.includes(value) ? (value as SecondFactor) : null;
}

/**
 * The labels for one sign-in, in the order they happened: what identified the
 * account, then what was asked for on top.
 *
 * Empty for a session recorded before any of this existed, which the caller says
 * in its own words rather than being handed a label that claims more than is
 * known.
 */
export function describeSignIn(record: SignInRecord): string[] {
    return [
        record.method ? SIGN_IN_METHOD_LABELS[record.method] : null,
        record.secondFactor ? SECOND_FACTOR_LABELS[record.secondFactor] : null
    ].filter((label): label is string => label !== null);
}

/**
 * The same as one line, which is how every screen shows it.
 *
 * Says so when there is nothing to say. A session opened before this was recorded
 * would otherwise read as one that was let in with nothing on top of a password,
 * and on this screen that is the difference between a shrug and an alarm.
 */
export function signInSummary(record: SignInRecord): string {
    const labels = describeSignIn(record);
    return labels.length === 0 ? "Sign-in not recorded" : labels.join(" + ");
}
