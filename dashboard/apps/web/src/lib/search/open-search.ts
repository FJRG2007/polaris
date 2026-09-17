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

export const OPEN_SEARCH_EVENT = "polaris:open-search";

/** Open the panel, on `scope` when one is given. */
export function openSearch(scope: SearchScope | null = null): void {
    window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT, { detail: { scope } }));
}

/** The scope an open request asked for, or null for none or for anything that is
 *  not one - the event is on the window, where anything could have sent it. */
export function requestedScope(event: Event): SearchScope | null {
    const scope = (event as CustomEvent<{ scope?: unknown }>).detail?.scope;
    return typeof scope === "string" && (SEARCH_SCOPES as readonly string[]).includes(scope)
        ? (scope as SearchScope)
        : null;
}
