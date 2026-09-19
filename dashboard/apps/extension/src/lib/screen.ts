/**
 * Which screen the popup shows, from what the worker says it holds.
 *
 * The order is the product's, with no way round it: which Polaris, then this
 * browser connected to the account, then a vault if the account has one. The
 * connection is what makes this extension somebody's - it is listed on their
 * Sessions screen and ended from there - and the vault is one thing it may then
 * be used for.
 *
 * That holds for a browser that was signed in to a vault before connections
 * existed as well. It used to carry on with a line above its list asking it to
 * connect, which left a vault in the toolbar that the account could neither see
 * nor end. Its vault is not lost: connecting adopts it, and the worker hands it
 * back the moment the connection exists.
 *
 * Pure, and apart from the popup, so the order can be checked without a browser.
 */

import type { VaultStatus } from "./messages";

export type Screen = "server" | "link" | "signIn" | "unlock" | "items";

export function screenFor(
    status: Pick<VaultStatus, "server" | "linked" | "connected" | "polarisSession" | "unlocked">
): Screen {
    if (!status.server) return "server";
    if (!status.linked) return "link";
    // A vault token with no account credential is one opened by typing the
    // master password before the approval was required; it goes back through the
    // approval rather than carrying on, because the extension has no idea whose
    // account it is sitting on until it does.
    if (!status.connected || !status.polarisSession) return "signIn";
    if (!status.unlocked) return "unlock";
    return "items";
}
