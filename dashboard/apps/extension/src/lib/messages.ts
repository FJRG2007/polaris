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

import type { UpdateNotice } from "@/lib/update";

/** One decrypted login, reduced to what a list needs to draw it. */
export interface ItemSummary {
    readonly id: string;
    readonly name: string;
    readonly username: string | null;
    /** Where it is saved for, to show which of several it is. */
    readonly host: string | null;
    /** Whether it carries a one-time code, so the popup can offer it. */
    readonly totp: boolean;
    /**
     * Which vault it came out of, named as its owner named it, or null for this
     * account's own.
     *
     * Nobody has one vault. A person has their own and a share from every
     * organization they are in, and the same login - a shared account, the same
     * address, often the same name - exists in more than one of them. Without
     * this the list showed two identical rows and no way to tell which was which,
     * so the only way to find out was to copy one and try it.
     *
     * Plain text, because it is: the vault's own name travels unencrypted in the
     * sync profile and is never something decrypted here.
     */
    readonly vault: string | null;
}

/**
 * Where a request to be let in by Polaris stands.
 *
 * `none` is nothing in flight. The rest are the answers the worker's own poll
 * arrived at, held in session storage so a popup that was torn down and reopened
 * reads the same one rather than starting again.
 */
export type AuthorizationWait = "none" | "pending" | "approved" | "denied" | "expired";

/** The state the popup draws itself from. */
export interface VaultStatus {
    readonly server: string | null;
    /**
     * Whether this browser is connected to the Polaris account.
     *
     * The first step and the one everything else hangs off: the vault is
     * something a connected extension may then be let into, not the way in. False
     * on a fresh install, and false on one whose connection was ended from the
     * account's Sessions screen - which is the same screen every other device is
     * ended from.
     */
    readonly linked: boolean;
    /** Who it is connected as, when it is. */
    readonly linkedAccount: ExtensionAccount | null;
    /** Whether that account may use a vault at all, so the popup offers one only
     *  where there is one to offer rather than leading somebody to a refusal. */
    readonly canVault: boolean;
    readonly email: string | null;
    /** Signed in, in the sense that there is a token: the vault may still be locked. */
    readonly connected: boolean;
    /**
     * Whether this session also carries a Polaris account credential.
     *
     * One approval on the dashboard leaves both behind - the vault's key and the
     * account's - so a session that came that way is signed in to Polaris as well
     * as to the vault. A vault opened by typing the master password has only the
     * first, and the extension has no idea whose account it is sitting on.
     */
    readonly polarisSession: boolean;
    readonly unlocked: boolean;
    /** When the items last came down, for the line that says so. */
    readonly syncedAt: number | null;
    /**
     * How long an unlocked vault may sit unused before it locks itself, in the
     * stored form of `lib/lock.ts` - where zero means the browser session.
     */
    readonly timeoutMs: number;
    /**
     * Every account signed in here, the active one included.
     *
     * Empty until something has been signed into, and one entry long for the
     * person who only ever has one - which is why the popup draws nothing for it
     * rather than an empty list with a heading.
     */
    readonly accounts: readonly AccountRef[];
    /** Which of them is in front, or null while none is. */
    readonly activeId: string | null;
    /**
     * Whether a request to be let in is out there waiting on somebody.
     *
     * Read from the worker rather than remembered by the popup, because the
     * popup does not outlive the press that started it: asking opens a tab, and
     * opening a tab is what closes the popup. Without this, reopening it lands
     * on the master password again while an approval nobody can see is still in
     * flight - which is how somebody ends up starting a second request and
     * orphaning the one they were in the middle of approving.
     */
    readonly awaitingApproval: boolean;
    /** The organizations the connected account can switch to, as the dashboard's
     *  header offers them. Empty for an account in none. */
    readonly organizations: readonly ShelfChoice[];
    /** The organization whose shelf is open, or null for the account's own. */
    readonly shelf: string | null;
    /** The connected account's face as an image address, or null to draw its
     *  initials. */
    readonly face: string | null;
}

/** One organization in the switcher, with its mark when it has one. */
export interface ShelfChoice {
    readonly id: string;
    readonly name: string;
    readonly face: string | null;
}

/** The person this extension is signed in as, as little of them as the popup
 *  needs to say so. */
export interface ExtensionAccount {
    /** The account's id, which is what its initials are coloured by - the same
     *  colour the dashboard gives it. Absent until the server has been asked. */
    readonly id?: string | null;
    readonly name: string | null;
    readonly email: string | null;
}

/**
 * One account in the switcher.
 *
 * No credential of any kind: this crosses to the popup, and what the popup needs
 * is enough to name a row and to say which row was pressed. The token that makes
 * the switch possible stays in the worker, and the id is what connects the two.
 */
export interface AccountRef {
    readonly id: string;
    readonly name: string | null;
    readonly email: string | null;
    /** Shown when there is no name and no email, and to tell two servers apart. */
    readonly origin: string;
}

/**
 * A login the worker is holding for a tab, as much of it as a page may know.
 *
 * Deliberately not the password, and not the item id on the save side: the bar
 * that draws this is running inside somebody else's page, and what it needs is a
 * sentence and two buttons. The values it is about stay in the worker, and
 * `saveCaptured` names none of them.
 */
export interface OfferedCapture {
    /** What saving it would do: add a login, replace a password, or nothing. */
    readonly kind: "none" | "save" | "update";
    /** The name of the item about to change, for an update, or the site's host
     *  for a save. Null when there is nothing to offer. */
    readonly name: string | null;
    /** The username it would be saved under, so the bar can show whose login it
     *  is about to become. */
    readonly username: string | null;
}

export type Request =
    | { readonly kind: "status" }
    | { readonly kind: "connect"; readonly typed: string }
    /**
     * Ask Polaris to connect this browser, and open the page that decides.
     *
     * The extension's first step. What comes back is the code somebody approves;
     * the waiting itself happens in the worker, for the same reason the vault's
     * does - opening the tab tears the popup down.
     */
    | { readonly kind: "link" }
    /** Ask where that request stands. Reading only; the worker polls. */
    | { readonly kind: "linkCheck" }
    /** Drop the request in flight, so the worker stops collecting it. */
    | { readonly kind: "linkCancel" }
    /** End this browser's connection, from this side. Whatever it was let into
     *  goes with it, the same as ending it from Polaris would. */
    | { readonly kind: "unlink" }
    /**
     * Ask the server to let this extension in, and open the page that decides.
     *
     * The way in that does not involve typing a master password into a popup: the
     * dashboard is already open, already unlocked, already holds the key. What
     * comes back is the code to show while somebody approves it.
     */
    | { readonly kind: "authorize" }
    /**
     * Ask where that request stands.
     *
     * Reading only: the worker polls the server on its own, because the tab it
     * opens tears the popup down and a wait that lived here would die with it.
     * This is also how a reopened popup finds the request it left in flight.
     */
    | { readonly kind: "authorizeCheck" }
    /** Drop the request in flight, so the worker stops collecting it. */
    | { readonly kind: "authorizeCancel" }
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
    /**
     * The code for the login just filled into this tab, asked by the box that
     * wants it - see `lib/second-step.ts`. Names no item: the worker answers from
     * what it remembered for the sender's tab and site, once.
     */
    | { readonly kind: "secondStepCode" }
    /**
     * The signed-in person's own name and email, to type into a sign-up on a site
     * with nothing saved for it. Asked when the menu opens there, so a page is
     * never handed them unless somebody is about to choose them.
     */
    | { readonly kind: "myDetails" }
    /** Whether the tab in front of somebody is one they have shut this out of. */
    | { readonly kind: "blocked" }
    /**
     * Whether a password somebody is inventing is already in a breach corpus.
     *
     * The password crosses to the worker and no further: what leaves the browser
     * is five characters of its hash, to the deployment's own server. The answer
     * is a count, or null for a question that could not be asked - see
     * `lib/breach.ts`, which fails open on purpose.
     */
    | { readonly kind: "breach"; readonly password: string }
    /**
     * A login that has just been submitted on a page, offered to the vault.
     *
     * Sent by the inline script the moment a form goes, because the page it was
     * typed on is usually gone a second later. The worker decides what it is
     * worth - a new item, a password to replace, or nothing at all - and holds it
     * for the tab until somebody answers the bar, so a submission that navigates
     * is still offerable on the page that lands.
     */
    | { readonly kind: "captured"; readonly username: string; readonly password: string }
    /** What is still waiting to be offered for this tab, if anything. Asked on
     *  every load, because that is how an offer survives the navigation that
     *  submitting the form caused. */
    | { readonly kind: "pendingCapture" }
    /** Save what was captured, as the worker decided it: a new login, or the new
     *  password on the one it belongs to. The values are the worker's - nothing
     *  crosses back into a page to do this. */
    | { readonly kind: "saveCaptured" }
    /** Drop it. `never` also shuts this extension out of the site, which is what
     *  the third button on the bar is for. */
    | { readonly kind: "dismissCapture"; readonly never: boolean }
    /**
     * Whether a newer extension has been published, and what to do about it.
     *
     * Read-only: it answers from what the worker's own slow check last left, so
     * opening the popup is never what makes a request. A browser that opens it
     * twenty times a day would otherwise ask twenty times for an answer that
     * changes a few times a year.
     */
    | { readonly kind: "updateStatus" }
    /** Shut this extension out of the current site, or let it back in. */
    | { readonly kind: "setBlocked"; readonly blocked: boolean }
    /**
     * Start offering Polaris inside the page in front of somebody.
     *
     * Sent after the popup has asked the browser for that site - which only the
     * popup can do, since a permission request has to come from a gesture and the
     * worker has none. What this does is the half the popup cannot: register the
     * inline script for the origins now granted, and run it in the tab that is
     * already open, so the marks appear without a reload.
     */
    | { readonly kind: "startInline" }
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
    | { readonly kind: "changePassword"; readonly id: string; readonly password: string }
    /**
     * Put another account in front, out of the ones already signed in here.
     *
     * The id names it; nothing else crosses. What the worker does with it is a
     * swap - the account in front is set aside with its keys, and this one takes
     * its place - so this is the only message that changes whose vault every other
     * message in this file is about.
     */
    | { readonly kind: "switchAccount"; readonly id: string }
    /**
     * Set the account in front aside and start signing into another one.
     *
     * Not a sign-out: what is wanted is a second account, and the first stays in
     * the switcher to go back to. The address is kept, because the second account
     * is usually on the same Polaris and clearing it would spend a permission
     * prompt on a server the browser has already granted.
     */
    | { readonly kind: "addAccount" }
    /**
     * Forget which Polaris this is, so another address can be typed.
     *
     * Refused while an account is signed in, since that would leave a session with
     * no address to reach its own server at.
     */
    | { readonly kind: "forgetServer" }
    /** Open an organization's shelf, or the account's own with null. */
    | { readonly kind: "setShelf"; readonly orgId: string | null };

export type Reply =
    | { readonly ok: true; readonly status: VaultStatus }
    /** A build newer than this one, or null when this one is current. */
    | { readonly ok: true; readonly update: UpdateNotice | null }
    | { readonly ok: true; readonly items: readonly ItemSummary[] }
    | { readonly ok: true; readonly value: string }
    /** The site in front of somebody, and whether they have shut this out of it. */
    | { readonly ok: true; readonly host: string | null; readonly blocked: boolean }
    /** Six digits and the seconds before they turn over. */
    | { readonly ok: true; readonly code: string; readonly remaining: number }
    /** How many times a password appears in the corpus, or null for a question
     *  that could not be asked. Null is unknown, never "none". */
    | { readonly ok: true; readonly count: number | null }
    /** What the worker is holding for this tab, and what to say about it. */
    | { readonly ok: true; readonly offer: OfferedCapture }
    /** The person this extension is signed in as, for a sign-up form. */
    | { readonly ok: true; readonly details: ExtensionAccount }
    /**
     * A request to be let in by Polaris: where it stands, and what to show while
     * it is in flight.
     *
     * One shape for opening one and for asking after it, because the popup draws
     * the same screen from either and a reopened popup cannot tell which it is
     * doing. `none` is nothing in flight, which is the ordinary answer on the way
     * in and must not read as a request that ran out. `approved` arrives with the
     * vault already open, so the popup only has to ask for the status again.
     */
    | {
          readonly ok: true;
          readonly waiting: AuthorizationWait;
          /** The code somebody approves, or null when nothing is in flight. */
          readonly userCode: string | null;
          /** How often to ask, already held to something this client will wait. */
          readonly pollMs: number;
      }
    | { readonly ok: true }
    | { readonly ok: false; readonly error: string };

/**
 * The only things a script running inside a page may ask for.
 *
 * Everything else in this file is the popup's, and the popup is one of the
 * extension's own pages: it holds a window nobody else scripts. The inline
 * script does not. It runs in an isolated world on somebody else's site, and the
 * right way to read this list is as what would be lost if that isolation ever
 * failed - so it is the narrowest set the page can offer anything with.
 *
 * What is on it, and why each one is worth it:
 *
 * - `blocked`, `itemsFor` and `pendingCapture` are reads about the page in front
 *   of the person, and the worker answers them for the SENDER's tab rather than
 *   for whatever address the caller names. A page that could ask which logins
 *   exist for another site would be a page reading the vault's index.
 * - `fill` and `totpNow` put a credential into that page, which is the whole
 *   feature - and both are checked against the sender's own address first, so
 *   neither can be turned into a fill on a site the item was never saved for.
 * - `breach`, `captured`, `saveCaptured` and `dismissCapture` carry values the
 *   page already has, because somebody typed them into it.
 *
 * What is deliberately absent: `items` (the whole vault), `copy` (any field of
 * any item, including a password, as a string), `status`, `unlock`, `save`,
 * `changePassword`, and everything to do with accounts. None of them is about
 * the page, and each of them would hand a page something it cannot get any other
 * way.
 */
export const FROM_PAGE: ReadonlySet<Request["kind"]> = new Set([
    "blocked",
    "itemsFor",
    "fill",
    "totpNow",
    "secondStepCode",
    "myDetails",
    "breach",
    "captured",
    "pendingCapture",
    "saveCaptured",
    "dismissCapture"
] satisfies Request["kind"][]);

/**
 * Ask the background worker something, from the popup.
 *
 * Never rejects, and that is the point. Under manifest v3 the worker is recycled
 * whenever the browser feels like it, and `sendMessage` to one that is gone -
 * or that dies part way through answering - rejects rather than returning
 * anything. Every screen here presses a button, awaits this, and then turns its
 * own "busy" back off; a rejection skipped that line, so the button sat on
 * "Asking the browser" or "Opening" for as long as the popup stayed open and
 * nothing ever said why. It looked exactly like a button that does nothing.
 *
 * So a worker that cannot be reached is an answer like any other, in the shape
 * every caller already handles. Re-opening the popup starts it again, which is
 * what the sentence asks for.
 */
export async function askBackground(request: Request): Promise<Reply> {
    const unreachable = { ok: false, error: "Polaris did not answer. Open this again." } as const;
    try {
        const reply = (await browser.runtime.sendMessage(request)) as Reply | undefined;
        // A worker torn down mid-question can also answer with nothing at all,
        // which is not a rejection and would otherwise be read as a Reply whose
        // every field is undefined - a screen waiting on `ok` that never comes.
        if (typeof reply !== "object" || reply === null || !("ok" in reply)) return unreachable;
        return reply;
    } catch {
        return unreachable;
    }
}
