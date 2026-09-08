/**
 * Whether an address somebody is typing can be added, answered while they type.
 *
 * Two forms in Mail ask for an address that must not already be there - the
 * mailbox being connected, and an address a mailbox may send as - and both had
 * the same hole in the same place. The browser already holds the list it would
 * be a duplicate of: it drew that list on the screen behind the dialog. It
 * checked the shape of what was typed and never once looked at it.
 *
 * So somebody typed an address they already had, waited while Polaris went and
 * looked up its servers, typed a password, pressed Connect, and was told then -
 * or, for a send-as address, was told nothing at all until a unique index in the
 * database refused it and the screen said something could not be saved.
 *
 * The server still decides, and it says the same words: this runs on a list that
 * was true when the page was drawn, and another tab, another device or another
 * second can make it stale. What it buys is that the ordinary case is answered
 * before anything is typed after it - which is the only place a duplicate is
 * cheap to fix.
 *
 * Pure, so both screens ask the same question and it can be checked without one.
 */

import * as core from "@polaris/core";

/**
 * What an address is, as far as a form is concerned.
 *
 * `empty` is not a fault: nothing has been typed yet, and a field that turns red
 * before it has been filled in is a field that shouts at somebody for starting.
 */
export type AddressState = "empty" | "invalid" | "taken" | "ok";

/**
 * Read an address against the ones already spoken for.
 *
 * Compared with `sameAddress` rather than by lowercasing here, so the answer is
 * the same one the server will give: the two must not disagree about whether
 * `Ana@Example.com` is the `ana@example.com` already in the list.
 */
export function addressState(value: string, taken: readonly string[]): AddressState {
    const typed = value.trim();
    if (typed === "") return "empty";
    if (!core.mailAddress.safeParse(typed).success) return "invalid";
    if (taken.some((one) => core.sameAddress(one, typed))) return "taken";
    return "ok";
}
