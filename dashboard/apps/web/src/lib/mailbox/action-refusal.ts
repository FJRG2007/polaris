/**
 * Why a mail server said no to moving or deleting something, in words a reader
 * can act on.
 *
 * imapflow answers a refused MOVE or EXPUNGE with `false` and hands the reason
 * to its logger alone. `imap.ts` gives every connection a logger that also keeps
 * the last reason here, keyed by the connection, so the action that got `false`
 * can say which of a handful of things went wrong rather than "the server did
 * not accept that". The reasons are the response codes of RFC 5530, which every
 * server sends in English whatever its folders are called, with a few words of
 * the text as the fallback for a server that sends none.
 *
 * The sentences are English, like every refusal under `lib/mailbox`, and are
 * translated through `refusal-text.ts` where a screen shows them.
 */

/** What kind of no it was. */
export type MailRefusalCode = "quota" | "folderGone" | "readOnly" | "limit" | "server";

/** One sentence per kind, each listed in `MAIL_REFUSALS`. */
export const ACTION_REFUSALS: Readonly<Record<MailRefusalCode, string>> = {
    quota: "The mail server refused: this mailbox is full. Nothing was moved.",
    folderGone: "The mail server refused: that folder is not there any more. Nothing was moved.",
    readOnly: "The mail server refused: this mailbox does not allow changes. Nothing was moved.",
    limit: "The mail server refused: too many at once. Try fewer messages.",
    server: "The mail server refused to do that. Nothing was moved."
};

/** Said for an action on a mailbox Polaris is no longer signed in to. */
export const SIGNED_OUT_REFUSAL =
    "This mailbox is not signed in, so its mail cannot be changed. Reconnect it from its notice.";

/** Thrown to a person who pressed the button when the server refused. */
export class MailActionRefused extends Error {
    public readonly code: MailRefusalCode;

    public constructor(code: MailRefusalCode) {
        super(ACTION_REFUSALS[code]);
        this.name = "MailActionRefused";
        this.code = code;
    }
}

/**
 * Thrown before any connection is opened for a mailbox whose sign-in was
 * refused. Trying again on every click is a known-bad login sent to a provider
 * that locks accounts for exactly that, and the answer would be the same.
 */
export class MailAccountSignedOut extends Error {
    public constructor() {
        super(SIGNED_OUT_REFUSAL);
        this.name = "MailAccountSignedOut";
    }
}

/** Refuse an action on a mailbox whose sign-in is refused. */
export function refuseWhileSignedOut(account: { readonly state?: string | null }): void {
    if (account.state === "auth") throw new MailAccountSignedOut();
}

const CODES: Readonly<Record<string, MailRefusalCode>> = {
    OVERQUOTA: "quota",
    NONEXISTENT: "folderGone",
    TRYCREATE: "folderGone",
    NOPERM: "readOnly",
    "READ-ONLY": "readOnly",
    LIMIT: "limit"
};

/** The kind of refusal a server's response code and text describe. */
export function refusalCode(responseCode: string, text: string): MailRefusalCode {
    const known = CODES[responseCode.trim().toUpperCase()];
    if (known) return known;
    if (/quota|over.?limit|mailbox (is )?full/i.test(text)) return "quota";
    if (/no such (mail)?box|does ?n[o']t exist|unknown (mail)?box|not found/i.test(text))
        return "folderGone";
    if (/read.?only|permission|not allowed/i.test(text)) return "readOnly";
    if (/too many|rate limit|throttl/i.test(text)) return "limit";
    return "server";
}

/** What a connection's logger last heard about a failed command. */
interface Heard {
    code: string;
    text: string;
}

const HEARD = new WeakMap<object, Heard>();

/** The response code of an imapflow error, `[OVERQUOTA]` read as `OVERQUOTA`.
 *  imapflow keeps it as the section of the response's first attribute. */
function responseCodeOf(err: unknown): string {
    const attributes = (err as { response?: { attributes?: unknown } } | undefined)?.response
        ?.attributes;
    if (!Array.isArray(attributes)) return "";
    for (const attribute of attributes) {
        const section = (attribute as { section?: unknown } | null)?.section;
        if (!Array.isArray(section)) continue;
        const value = (section[0] as { value?: unknown } | undefined)?.value;
        if (typeof value === "string") return value;
    }
    return "";
}

/** Keep what a logger entry says about a failed command, for `lastRefusal`. */
export function hearRefusal(client: object, entry: unknown): void {
    const err = (entry as { err?: unknown } | null)?.err;
    if (!err || typeof err !== "object") return;
    const text = (err as { responseText?: unknown }).responseText;
    HEARD.set(client, {
        code: responseCodeOf(err),
        text: typeof text === "string" ? text : ""
    });
}

/** Forget what was heard, before a command whose refusal is about to matter. */
export function forgetRefusal(client: object): void {
    HEARD.delete(client);
}

/** What kind of refusal the connection last heard, or `server` when it heard
 *  nothing it could read. */
export function lastRefusal(client: object): MailRefusalCode {
    const heard = HEARD.get(client);
    return heard ? refusalCode(heard.code, heard.text) : "server";
}
