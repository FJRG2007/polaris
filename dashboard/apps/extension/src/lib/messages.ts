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

/** What filling one item needs, and nothing besides. */
export interface FillPayload {
    readonly username: string | null;
    readonly password: string | null;
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
    | { readonly kind: "unlock"; readonly password: string }
    | { readonly kind: "lock" }
    | { readonly kind: "signOut" }
    | { readonly kind: "sync" }
    /** The logins saved for one page, best match first. */
    | { readonly kind: "itemsFor"; readonly url: string }
    /** Everything, for the search box, still only as summaries. */
    | { readonly kind: "items"; readonly query: string }
    | { readonly kind: "fill"; readonly id: string }
    | { readonly kind: "copy"; readonly id: string; readonly field: "username" | "password" | "totp" };

export type Reply =
    | { readonly ok: true; readonly status: VaultStatus }
    | { readonly ok: true; readonly items: readonly ItemSummary[] }
    | { readonly ok: true; readonly value: string }
    | { readonly ok: true }
    | { readonly ok: false; readonly error: string; readonly needsCode?: boolean };

/** Ask the background worker something, from the popup. */
export async function askBackground(request: Request): Promise<Reply> {
    return (await browser.runtime.sendMessage(request)) as Reply;
}
