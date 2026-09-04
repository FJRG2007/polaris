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
 * being told their account had been stolen, and signed out of it. The two
 * headers are not one reading either: a request can carry the brands and not the
 * platform, so which header each half of the client was read from is tracked on
 * its own and only ever compared against the same header.
 *
 * And the system is not the browser. A browser rewrites the system it claims
 * whenever it is asked to - the device toolbar in a set of developer tools puts
 * an iPhone's user-agent on a laptop, "request desktop site" puts a desktop
 * Linux one on a phone - and it does that without moving an inch. A browser does
 * not become another browser that way. So a changed browser is refused wherever
 * it happens, and a changed system is refused only when the address changed with
 * it: two machines are in two places, and one machine describing itself
 * differently is not.
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
 * its own, and the two `Hinted` flags say which of them each half came from.
 *
 * Six fields where two would do, because the two would be wrong. The hinted
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
     * Whether this side named its browser in `sec-ch-ua`.
     *
     * Absent more often than it sounds. Hints are only sent to a secure origin,
     * so every request over plain http on a home network arrives without them,
     * as do several a browser makes rather than the page, and a browser told to
     * present itself as another device may drop them altogether.
     */
    readonly brandHinted?: boolean;
    /**
     * Whether this side named its system in `sec-ch-ua-platform`.
     *
     * Tracked apart from the brands because a request can carry one header and
     * not the other, and a reading taken from a hint compared against one taken
     * from a user-agent is the single mistake this module exists to not make.
     */
    readonly platformHinted?: boolean;
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
 * Whether the browser that turned up is a different browser from the one the
 * session was opened in.
 *
 * Compared like with like, and that is the whole of it. Where both sides named
 * themselves in `sec-ch-ua`, the hinted names are compared: they are the better
 * reading, and the only one that can tell a Brave from a Chrome at all. Where
 * either side sent no brands there is no shared vocabulary but the user-agent,
 * so the user-agent's own reading is what is compared - the same string on both
 * sides for the same browser, whatever it calls itself elsewhere.
 *
 * A cookie that really has moved into another browser still fails: that browser
 * sends its own brands, and where it sends none its user-agent names it.
 */
function movedBrowser(session: SessionOrigin, request: RequestOrigin): boolean {
    if (session.brandHinted === true && request.brandHinted === true) {
        return differs(session.browser, request.browser);
    }
    return differs(session.claimedBrowser ?? session.browser, request.claimedBrowser ?? request.browser);
}

/**
 * Whether the system that turned up is a different system from the one the
 * session was opened on.
 *
 * The same like-for-like rule against the other header: the platform hint where
 * both sides sent one, the user-agent's own claim where they did not.
 *
 * On its own this settles nothing, and the caller is what makes it safe to use -
 * a browser claims whatever system it is told to claim.
 */
function movedSystem(session: SessionOrigin, request: RequestOrigin): boolean {
    if (session.platformHinted === true && request.platformHinted === true) {
        return differs(session.os, request.os);
    }
    return differs(session.claimedOs ?? session.os, request.claimedOs ?? request.os);
}

/** Whether the request came from somewhere other than where the session was last
 *  seen. Not knowing at either end is not a move. */
function movedAddress(session: SessionOrigin, request: RequestOrigin): boolean {
    return session.ip !== null && request.ip !== null && session.ip !== request.ip;
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
    // A browser does not turn into another browser without the cookie moving,
    // so this half stands on its own.
    if (rules.bindClient && movedBrowser(session, request)) {
        return "client";
    }
    // The system does turn into another system with nothing moving at all,
    // because a browser will claim any system it is asked to. What it will not
    // do is claim it from somewhere else at the same moment, so the address is
    // what separates a laptop pretending to be a phone from a cookie on a second
    // machine. Compared against where the session was last seen rather than
    // where it was opened: the same thing for a machine that has not moved, and
    // the right thing for one that has.
    if (rules.bindClient && movedSystem(session, request) && movedAddress(session, request)) {
        return "client";
    }
    // Only against an address the session actually recorded. A session opened
    // before Polaris kept one has nothing to be compared with, and refusing it
    // would sign out every session that predates the setting being turned on.
    if (addressPinned(rules, session) && movedAddress(session, request)) {
        return "address";
    }
    return null;
}

/** What the owner is told this was, in one line. */
export const BREACH_REASONS: Record<BindingBreach, string> = {
    client: "It was used from a different browser and system than the one it was opened in.",
    address: "It was used from a different network address than the one it was opened at."
};
