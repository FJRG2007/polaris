/**
 * How a stored session reads, for every screen that reads one.
 *
 * Two do, from opposite ends - the account's own device list and the firewall
 * asking who an address has been seen on - and a session has to say the same
 * thing on both. Each of these answers is a judgement rather than a column: an
 * approval this build cannot place must not pass for one of the three it knows,
 * the browser a session was opened with lives in two columns and only one of
 * them is kept current, and a sign-in that predates the record must read as
 * unknown rather than as one that skipped a step.
 */

import { parseSecondFactor, parseSignInMethod, type SignInRecord } from "@polaris/core";

/** Whether a session may be used: let in, waiting on the account, or refused. */
export type SessionApproval = "approved" | "pending" | "denied";

const APPROVALS: ReadonlySet<string> = new Set(["approved", "pending", "denied"]);

/** Stored as a plain string, so it is parsed on the way out. Anything this build
 *  cannot place reads as approved, which is what a session carrying no state row
 *  is - nothing was ever held against it. */
export function sessionApproval(value: string | null | undefined): SessionApproval {
    return value !== null && value !== undefined && APPROVALS.has(value)
        ? (value as SessionApproval)
        : "approved";
}

/** The browser a session was opened with, preferring Polaris's own copy:
 *  better-auth's column is written once and never followed. */
export function sessionUserAgent(row: {
    userAgent: string | null;
    state?: { userAgent: string | null } | null;
}): string | null {
    return withAppMarker(row.userAgent, row.state?.userAgent ?? null) ?? row.userAgent ?? null;
}

/** The phone app's word about itself on the end of the WebView's user-agent
 *  (`mobile/android` AppAgent, `mobile/ios` WebViewController). */
const APP_MARKER = / PolarisMobile\/[\d.]+(?: \([^)]*\))?/;

/**
 * The app's own user-agent where a request of the app's went out without it.
 *
 * Android does not carry the app's user-agent onto every request its WebView
 * makes - a service worker's fetches go out with the bare WebView's - and the
 * session's record is taken from whichever request reached the server first.
 * When that was one of those, the phone app read as "Android WebView" on the
 * list of signed-in devices. A recorded agent that is exactly the marked one
 * with the marker taken off is that same app, so the marked one is what it is.
 * Anything else is left as it was: this only puts back what the app said.
 */
export function withAppMarker(marked: string | null, recorded: string | null): string | null {
    if (!marked || !recorded || marked === recorded || APP_MARKER.test(recorded)) return recorded;
    if (!APP_MARKER.test(marked)) return recorded;
    return marked.replace(APP_MARKER, "") === recorded ? marked : recorded;
}

/** How a session proved who it was, as its state row holds it. Both halves are
 *  null on a session opened before Polaris recorded any of this. */
export function sessionSignIn(
    state: { signInMethod: string | null; secondFactor: string | null } | null | undefined
): SignInRecord {
    return {
        method: parseSignInMethod(state?.signInMethod),
        secondFactor: parseSecondFactor(state?.secondFactor)
    };
}
