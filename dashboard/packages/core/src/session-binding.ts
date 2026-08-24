/**
 * Whether a session may still be used by whoever has just turned up with it.
 *
 * A session cookie is a bearer token: it is the account, in whoever's hands it
 * lands. Everything else an account can arm - a password, a second factor, a
 * passkey - guards the moment of signing in and says nothing at all about the
 * hours afterwards, which is precisely the window a stolen cookie is worth
 * something in.
 *
 * So a session records what it was opened in and where from, and this is the
 * comparison against what turned up. Pure, and here rather than beside the guard,
 * because every one of its judgement calls is a false positive waiting to happen
 * and each of them is worth being able to state and check on its own.
 *
 * The two bindings are deliberately not the same strength.
 *
 * **The client.** The browser and the operating system, by name and never by
 * version: an update moves a version several times a year and moves neither name
 * ever. Compared only where both readings actually name something - a browser
 * that sends no hints and an unparsed user-agent both read as "Unknown", and
 * treating unknown as a mismatch would sign people out for using Safari.
 *
 * **The address.** Off unless asked for, and scoped by what the session is
 * running on, because this is the one that can be wrong about an honest person: a
 * phone changes address several times an hour walking between cell and wifi. A
 * desktop at a fixed line does not, which is why "desktop" is the setting that is
 * nearly always the right one.
 */

/** Which of an account's sessions are tied to the address they were opened at. */
export const ADDRESS_PIN_SCOPES = ["off", "all", "desktop", "mobile"] as const;

export type AddressPinScope = (typeof ADDRESS_PIN_SCOPES)[number];

export const ADDRESS_PIN_LABELS: Record<AddressPinScope, string> = {
    off: "No devices",
    all: "Every device",
    desktop: "Computers only",
    mobile: "Phones and tablets only"
};

export const ADDRESS_PIN_NOTES: Record<AddressPinScope, string> = {
    off: "A session keeps working wherever it is used from.",
    all: "Strongest, and the one to expect sign-outs from: a phone changes address whenever it moves between mobile data and wifi.",
    desktop: "What most people want. A computer on a fixed connection is protected, and the phone in your pocket is left alone.",
    mobile: "Only for a phone that never leaves one network."
};

/** What a session recorded about itself when it was opened. */
export interface SessionOrigin {
    /** The system, as `describeClient` read it. "Unknown OS" when it read none. */
    readonly os: string;
    /** The browser, likewise. */
    readonly browser: string;
    /** The address, or null for a session opened before one was recorded. */
    readonly ip: string | null;
    /** Whether the device is a phone or a tablet, which is what the scope is
     *  about. */
    readonly handheld: boolean;
}

/** The same three facts about whoever is asking now. */
export interface RequestOrigin {
    readonly os: string;
    readonly browser: string;
    readonly ip: string | null;
}

/** What an account has asked for. */
export interface BindingRules {
    readonly bindClient: boolean;
    readonly pinScope: AddressPinScope;
    /** This one session's own answer, when it gave one. Null follows the scope. */
    readonly pinThisSession: boolean | null;
}

/** Why a session was refused, or null when it was not. */
export type BindingBreach = "client" | "address";

/** A reading that names nothing. Compared against, never with. */
function unknown(value: string): boolean {
    const said = value.trim().toLowerCase();
    return said === "" || said.startsWith("unknown");
}

/** Whether two readings of the same fact disagree, given that one of them not
 *  knowing is not a disagreement. */
function differs(was: string, now: string): boolean {
    if (unknown(was) || unknown(now)) return false;
    return was.trim().toLowerCase() !== now.trim().toLowerCase();
}

/**
 * Whether this session is tied to its address.
 *
 * The session's own answer wins where it gave one: it is a statement about this
 * device, and the account-wide rule is a statement about devices in general.
 */
export function addressPinned(rules: BindingRules, session: SessionOrigin): boolean {
    if (rules.pinThisSession !== null) return rules.pinThisSession;
    if (rules.pinScope === "all") return true;
    if (rules.pinScope === "desktop") return !session.handheld;
    if (rules.pinScope === "mobile") return session.handheld;
    return false;
}

/**
 * Why this session may not be used from here, or null when it may.
 *
 * The client is checked first because it is the one that is on for everybody and
 * the one that cannot be wrong about an honest person - so when both would fire,
 * the reason reported is the one worth saying.
 */
export function bindingBreach(
    rules: BindingRules,
    session: SessionOrigin,
    request: RequestOrigin
): BindingBreach | null {
    if (rules.bindClient && (differs(session.os, request.os) || differs(session.browser, request.browser))) {
        return "client";
    }
    // Only against an address the session actually recorded. A session opened
    // before Polaris kept one has nothing to be compared with, and refusing it
    // would sign out every session that predates the setting being turned on.
    if (addressPinned(rules, session) && session.ip && request.ip && session.ip !== request.ip) {
        return "address";
    }
    return null;
}

/** What the owner is told this was, in one line. */
export const BREACH_REASONS: Record<BindingBreach, string> = {
    client: "It was used from a different browser and system than the one it was opened in.",
    address: "It was used from a different network address than the one it was opened at."
};
