"use client";

/**
 * Changing what the address says without asking the server for the page again.
 *
 * Mail fetches its own conversations. The list, the tabs, the filter, the order
 * and the conversation open beside them are all drawn from data this tab already
 * holds or goes and gets itself - the server route reads the address and nothing
 * else. So a press that only re-narrows that list has no business being a
 * navigation: `router.push("?open=...")` asked the server to render the page
 * again, and every one of those was a round trip standing between a click and
 * anything happening.
 *
 * When that round trip was slow the screen sat there; when it failed - a
 * connection ceiling, a dropped request - the click did nothing at all and the
 * only way out was reloading the page. That is the bug this exists to remove: a
 * conversation opens now because the address changed, and the address changes
 * here.
 *
 * `window.history` rather than the router on purpose. Next watches both methods
 * and feeds `usePathname` and `useSearchParams` from them, so everything reading
 * the address still updates - what does not happen is the request.
 *
 * Only ever for state the client can already answer for. Anything the server has
 * to decide - a search, whose title and empty state it writes - stays an
 * ordinary navigation.
 */

/** Where the address should point, built from the one on screen. */
export function mailAddress(change: Readonly<Record<string, string | null>>): string {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(change)) {
        if (value === null || value === "") url.searchParams.delete(key);
        else url.searchParams.set(key, value);
    }
    return `${url.pathname}${url.search}`;
}

/**
 * Point the address somewhere else, with no request.
 *
 * `replace` for a step nobody would want to walk back through - closing a
 * conversation that has just been filed, or putting one back after the server
 * refused to move it. A push for the rest, so Back closes what was opened.
 */
export function goShallow(to: string, options?: { readonly replace?: boolean }): void {
    if (options?.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
}

/** Whether a click on a link is the plain one - not a new tab, a new window, or
 *  a download. Anything else is left to the browser, which is what makes
 *  middle-clicking a conversation still open it in a tab. */
export function plainClick(event: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    defaultPrevented: boolean;
}): boolean {
    return (
        !event.defaultPrevented &&
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey
    );
}
