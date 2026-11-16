/**
 * The one thing a page is showing, when its path alone does not say.
 *
 * Presence matches an alert to an open tab by path (see `presence`), which is
 * right for most screens and wrong for Polar: every agent session is drawn on
 * `/polar`, the address goes back to plain `/polar` once a session is opened,
 * and the session can also be open in the side panel on any other page. So a
 * tab showing a session reports it as a subject - the same in-app link the
 * session's alerts point at - and an alert whose link names a subject is
 * matched on that alone.
 *
 * Shared by the tab that reports and the server that matches, so the two can
 * never disagree about how a session is named.
 */

/** Paths whose screens are told apart by one query value, and which value. */
const SUBJECT_PARAMS: Readonly<Record<string, string>> = { "/polar": "session" };

/** The subject of an agent session open in Polar's Code side. */
export function sessionViewSubject(sessionId: string): string {
    return `/polar?session=${encodeURIComponent(sessionId)}`;
}

/** The query value that asks a session's page to put the cursor in its reply box. */
export const REPLY_PARAM = "reply";

/** The session opened with its reply box focused: what a notification's Reply
 *  opens. Its subject is still the session's, so presence matches it. */
export function sessionReplyHref(sessionId: string): string {
    return `${sessionViewSubject(sessionId)}&${REPLY_PARAM}=1`;
}

/**
 * The subject an in-app link names, in its one canonical form, or null when it
 * names none: an external link, a path with no subjects, or one without the
 * value (`new` is a session not started yet, so nothing can be about it).
 */
export function viewSubject(href: string | null | undefined): string | null {
    if (!href || !href.startsWith("/") || href.startsWith("//")) return null;
    const hash = href.indexOf("#");
    const bare = hash === -1 ? href : href.slice(0, hash);
    const mark = bare.indexOf("?");
    if (mark === -1) return null;
    const path = bare.slice(0, mark).replace(/\/+$/, "") || "/";
    const param = SUBJECT_PARAMS[path];
    if (!param) return null;
    const value = new URLSearchParams(bare.slice(mark + 1)).get(param)?.trim();
    if (!value || value === "new" || value.length > 128) return null;
    return `${path}?${param}=${encodeURIComponent(value)}`;
}
