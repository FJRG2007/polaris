/**
 * The sign-in step that comes after the password: the authenticator's code.
 *
 * A login that carries a one-time code is filled, submitted, and then the site
 * asks for the six digits - on the next page, or on the same one a moment later.
 * The worker remembers which login was just filled into which tab, and the first
 * code box that appears on that tab, on the same site, is filled with that
 * login's code. What is remembered is an item id, never a secret or a code: the
 * code is computed at the moment the box asks for it, so it is never one that
 * has already turned over.
 *
 * Pure, so the rules about which page may have it can be asserted without a
 * browser.
 */

import { baseDomain, hostOf } from "@polaris/core";

/** A login just filled into a tab, waiting for that tab to ask for its code. */
export interface SecondStep {
    readonly tabId: number;
    /** The item whose code goes in, named by id and nothing else. */
    readonly itemId: string;
    /** The page the login was filled on. */
    readonly url: string;
    /** When it stops being offered, whatever happens. */
    readonly until: number;
}

/** Long enough for a slow sign-in and the page that asks for the code, short
 *  enough that a code box met later that day is not filled on its own. */
export const SECOND_STEP_FOR_MS = 3 * 60 * 1000;

/** Whether two pages belong to the same site, as the vault's own matching reads
 *  one - `@polaris/core`'s base domain, so a subdomain counts. */
export function sameSite(left: string, right: string): boolean {
    const here = baseDomain(hostOf(left) ?? "");
    return here !== "" && here === baseDomain(hostOf(right) ?? "");
}

/**
 * The step still waiting for this page, or null.
 *
 * Tied to the tab and to the site: the code step is often on another host of the
 * same site (`login.example.com` hands over to `auth.example.com`), and a tab
 * that has gone somewhere else entirely is not handed a code for where it has
 * been. Whether the item is saved for the page is the worker's check on top of
 * this, the same one every fill is held to.
 */
export function stepFor(
    held: SecondStep | null,
    page: { readonly tabId: number; readonly url: string },
    now: number
): SecondStep | null {
    if (!held || held.until <= now) return null;
    if (held.tabId !== page.tabId) return null;
    return sameSite(held.url, page.url) ? held : null;
}
