/**
 * What the popup and the page may ask the background worker for.
 *
 * The shape of this file is the extension's security boundary, so it is a closed
 * list rather than a channel. The background holds the keys and the token; the
 * popup and the content script hold neither and cannot be made to - the most a
 * page can get back is the two strings it was going to be typed anyway, for the
 * item somebody chose, on the site that was already in front of them.
 *
 * In particular there is no message that answers with the vault key, the master
 * password hash, or a decrypted item the caller did not ask for by id. A page is
 * hostile by default: anything a content script holds, the page can read.
 */

/** One decrypted login, reduced to what a list needs to draw it. */
export interface ItemSummary {
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
    /** Where it is saved for, to show which of several it is. */
    readonly host: string | null;
    /** Whether it carries a one-time code, so the popup can offer it. */
    readonly totp: boolean;
}

/** The state the popup draws itself from. */
export interface VaultStatus {
    readonly server: string | null;
    readonly email: string | null;
    /** Signed in, in the sense that there is a token: the vault may still be locked. */
    readonly connected: boolean;
    readonly unlocked: boolean;
    /** When the items last came down, for the line that says so. */
    readonly syncedAt: number | null;
    /**
     * How long an unlocked vault may sit unused before it locks itself, in the
     * stored form of `lib/lock.ts` - where zero means the browser session.
     */
    readonly timeoutMs: number;
}

export type Request =
    | { readonly kind: "status" }
    | { readonly kind: "connect"; readonly typed: string }
    | {
          readonly kind: "signIn";
          readonly email: string;
          readonly password: string;
          readonly code?: string;
      }
    /**
     * Ask the server to let this extension in, and open the page that decides.
     *
     * The way in that does not involve typing a master password into a popup: the
     * dashboard is already open, already unlocked, already holds the key. What
     * comes back is the code to show while somebody approves it.
     */
    | { readonly kind: "authorize" }
    /** Ask once whether the request has been answered. The popup does the waiting;
     *  the worker does the asking, because only it may hold the credential. */
    | { readonly kind: "authorizeCheck" }
    | { readonly kind: "unlock"; readonly password: string }
    | { readonly kind: "lock" }
    | { readonly kind: "signOut" }
    | { readonly kind: "sync" }
    /** The logins saved for one page, best match first. */
    | { readonly kind: "itemsFor"; readonly url: string }
    /** Everything, for the search box, still only as summaries. */
    | { readonly kind: "items"; readonly query: string }
    | { readonly kind: "fill"; readonly id: string }
    | {
          readonly kind: "copy";
          readonly id: string;
          readonly field: "username" | "password" | "totp";
      }
    /** The current one-time code for an item, and how long it has left. */
    | { readonly kind: "totpNow"; readonly id: string }
    /** Whether the tab in front of somebody is one they have shut this out of. */
    | { readonly kind: "blocked" }
    /** Shut this extension out of the current site, or let it back in. */
    | { readonly kind: "setBlocked"; readonly blocked: boolean }
    /** Change how long an unlocked vault may sit unused before it locks itself. */
    | { readonly kind: "setTimeout"; readonly timeoutMs: number }
    /**
     * Save a new login into the account's own vault.
     *
     * The fields arrive as they were typed; the worker normalizes and checks them
     * again with the same function the popup used, and does the encrypting. A
     * caller cannot choose which vault it lands in - see `save` in the worker.
     */
    | {
          readonly kind: "save";
          readonly name: string;
          readonly username: string;
          readonly password: string;
          readonly uri: string;
      }
    /**
     * Replace one login's password, leaving every other field exactly as it is.
     *
     * The id is the only way to name an item across this boundary, and nothing
     * here carries the old password: the worker reads it from what it already
     * holds, so the popup never needs to have seen it to replace it.
     */
    | { readonly kind: "changePassword"; readonly id: string; readonly password: string };

export type Reply =
    | { readonly ok: true; readonly status: VaultStatus }
    | { readonly ok: true; readonly items: readonly ItemSummary[] }
    | { readonly ok: true; readonly value: string }
    /** The site in front of somebody, and whether they have shut this out of it. */
    | { readonly ok: true; readonly host: string | null; readonly blocked: boolean }
    /** Six digits and the seconds before they turn over. */
    | { readonly ok: true; readonly code: string; readonly remaining: number }
    /** A request waiting to be approved in the dashboard: what to show, and how
     *  long it is good for. */
    | {
          readonly ok: true;
          readonly userCode: string;
          readonly expiresAt: string;
          readonly pollMs: number;
      }
    /** Where that request stands. `approved` arrives with the vault already open,
     *  so the popup only has to ask for the status again. */
    | {
          readonly ok: true;
          readonly waiting: "pending" | "approved" | "denied" | "expired";
      }
    | { readonly ok: true }
    | { readonly ok: false; readonly error: string; readonly needsCode?: boolean };

/** Ask the background worker something, from the popup. */
export async function askBackground(request: Request): Promise<Reply> {
    return (await browser.runtime.sendMessage(request)) as Reply;
}
