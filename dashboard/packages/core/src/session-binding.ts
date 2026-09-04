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
 * And compared like with like. A request describes its client twice, in a
 * user-agent and in the client-hints headers, and the two do not use the same
 * names: every Chromium that rebadges Chrome - Brave, Vivaldi, Arc - writes
 * Chrome into its user-agent on purpose and says who it really is only in the
 * hints. Hints are not always sent; they go to secure origins and not to plain
 * http, and to the page's own requests and not to every one the browser makes.
 * So a session opened in Brave and used from the same Brave, on a request that
 * carried no hints, reads as Brave against Chrome - which was an honest person
 * being told their account had been stolen, and signed out of it.
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

/**
 * What a request said about the client it came from, in both of the ways a
 * request can say it.
 *
 * `os` and `browser` are the reading - hints preferred, because they are the
 * better one. `claimedOs` and `claimedBrowser` are what the user-agent said on
 * its own, and `hinted` is whether there were any hints at all.
 *
 * Three fields where one would do, because the one would be wrong. The hinted
 * reading and the user-agent reading are not the same vocabulary: Brave, Vivaldi
 * and Arc all write Chrome into their user-agent on purpose and name themselves
 * only in the hints, so a session opened by Brave records "Brave" and the SAME
 * Brave on a request that carried no hints reads "Chrome". Comparing those two
 * is comparing a browser against the name it uses in public, and it ends with an
 * honest person signed out of their own account.
 */
interface ClientClaim {
    /** The system, as `describeClient` read it. "Unknown OS" when it read none. */
    readonly os: string;
    /** The browser, likewise. */
    readonly browser: string;
    /** What the user-agent alone said the system was. */
    readonly claimedOs?: string;
    /** What it alone said the browser was. */
    readonly claimedBrowser?: string;
    /**
     * Whether this side described itself with client hints.
     *
     * Absent more often than it sounds. They are only sent to a secure origin,
     * so every request over plain http on a home network arrives without them,
     * as do several a browser makes rather than the page.
     */
    readonly hinted?: boolean;
}

/** What a session recorded about itself when it was opened. */
export interface SessionOrigin extends ClientClaim {
    /** The address, or null for a session opened before one was recorded. */
    readonly ip: string | null;
    /** Whether the device is a phone or a tablet, which is what the scope is
     *  about. */
    readonly handheld: boolean;
}

/** The same facts about whoever is asking now. */
export interface RequestOrigin extends ClientClaim {
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
 * Whether the client that turned up is a different one from the client the
 * session was opened in.
 *
 * Compared like with like, and that is the whole of it. Where both sides
 * described themselves with hints, the hinted reading is compared: it is the
 * better one, and it is the only one that can tell a Brave from a Chrome at all.
 * Where either side sent none there is no shared vocabulary but the user-agent,
 * so the user-agent's own reading is what is compared - which is the same string
 * on both sides for the same browser, whatever it calls itself elsewhere.
 *
 * A cookie that really has moved to another browser still fails: that browser
 * sends its own hints, and the moment the machine is different the user-agent
 * names a different system too.
 */
function movedClient(session: SessionOrigin, request: RequestOrigin): boolean {
    if (session.hinted === true && request.hinted === true) {
        return differs(session.os, request.os) || differs(session.browser, request.browser);
    }
    return (
        differs(session.claimedOs ?? session.os, request.claimedOs ?? request.os) ||
        differs(session.claimedBrowser ?? session.browser, request.claimedBrowser ?? request.browser)
    );
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
    if (rules.bindClient && movedClient(session, request)) {
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
