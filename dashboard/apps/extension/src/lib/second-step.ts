/**
 * The sign-in steps that come after the login was chosen.
 *
 * Two of them, and both are the same promise: somebody picked a login once, and
 * the pages the site puts after that are filled with it without asking again.
 *
 * - `password`: a sign-in that asks for the name alone and the password on the
 *   next page (or on the same page a moment later). The name was filled; the
 *   first password box that appears on that tab, on the same site, gets the
 *   password of the login that was picked.
 * - `code`: a login that carries a one-time code is filled, submitted, and then
 *   the site asks for the six digits. The first code box that appears gets that
 *   login's code.
 *
 * What is remembered is an item id, never a secret or a code: the code is
 * computed at the moment the box asks for it, so it is never one that has
 * already turned over.
 *
 * Pure, so the rules about which page may have it can be asserted without a
 * browser.
 */

import { baseDomain, hostOf } from "@polaris/core";

/** Which box the step is waiting for. */
export type StepStage = "password" | "code";

/** A login just filled into a tab, waiting for that tab to ask for the rest. */
export interface SecondStep {
    readonly stage: StepStage;
    readonly tabId: number;
    /** The item whose password or code goes in, named by id and nothing else. */
    readonly itemId: string;
    /** The page the login was filled on. */
    readonly url: string;
    /** When it stops being offered, whatever happens. */
    readonly until: number;
}

/** Long enough for a slow sign-in and the page that asks for the rest, short
 *  enough that a box met later that day is not filled on its own. */
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
 * Only the stage the box that asked is for: a password box is never handed a
 * code, and a code box is never handed a password.
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
    now: number,
    stage: StepStage
): SecondStep | null {
    if (!held || held.until <= now || held.stage !== stage) return null;
    if (held.tabId !== page.tabId) return null;
    return sameSite(held.url, page.url) ? held : null;
}
