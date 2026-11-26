"use client";

/**
 * Opening the search panel from somewhere other than its own button.
 *
 * The panel lives in the app's header, and a screen deeper down - the field
 * above Chat's conversation list - wants the same panel, already pointed at one
 * scope. A window event rather than a context, because the header and the screen
 * are not in one tree that could hold one.
 */

import { SEARCH_SCOPES, type SearchScope } from "@polaris/core";
import { desktopBridge } from "@/lib/desktop-bridge";

export const OPEN_SEARCH_EVENT = "polaris:open-search";

/** Longest text a request may put in the field. */
export const OPEN_SEARCH_QUERY_MAX = 200;

/** Open the panel, on `scope` when one is given, with `query` already typed. */
export function openSearch(scope: SearchScope | null = null, query?: string): void {
    window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT, { detail: { scope, query } }));
}

/** The text an open request asked to search for, on one line and capped, or
 *  null for none or for anything that is not text. */
export function requestedQuery(event: Event): string | null {
    return requestedText((event as CustomEvent<{ query?: unknown }>).detail?.query);
}

/** `query` on one line and capped, or null for none or for anything that is not text. */
export function requestedText(query: unknown): string | null {
    if (typeof query !== "string") return null;
    const line = query
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, OPEN_SEARCH_QUERY_MAX)
        .trim();
    return line.length > 0 ? line : null;
}

/** The scope an open request asked for, or null for none or for anything that is
 *  not one - the event is on the window, where anything could have sent it. */
export function requestedScope(event: Event): SearchScope | null {
    const scope = (event as CustomEvent<{ scope?: unknown }>).detail?.scope;
    return typeof scope === "string" && (SEARCH_SCOPES as readonly string[]).includes(scope)
        ? (scope as SearchScope)
        : null;
}

/**
 * Open the search the reader's key opens. Inside Polaris Desktop that is its
 * launcher window - the one Alt+Space brings up, with this computer's apps,
 * games and commands as well as Polaris - so every way into search from the
 * window lands in the same place. In a browser, in a desktop build that
 * predates the bridge call, or with the launcher switched off, `fallback`
 * opens this page's own panel instead.
 */
export function openDesktopLauncher(query: string | null, fallback: () => void): void {
    const show = desktopBridge()?.showLauncher;
    if (typeof show !== "function") {
        fallback();
        return;
    }
    void show(query ?? "").then(
        (shown) => {
            if (!shown) fallback();
        },
        () => fallback()
    );
}
