/**
 * Which list a screen is showing, written down once.
 *
 * Seven routes end up at the same list - the merged views, one mailbox, one
 * folder, one label - and the list itself is fetched by the browser rather than
 * rendered into the page, so the narrowing has to survive the trip. That is what
 * this is: the shape the client holds, the query string it travels as, and the
 * reading of that query string on the way in.
 *
 * Both directions live here on purpose. A writer and a reader of the same
 * wire format in two files is how a boolean ends up meaning "false" on one side
 * and "the string false is truthy" on the other, and the screen that shows is a
 * mailbox that quietly forgot it was filtered.
 *
 * The values themselves are still validated by `core.mailPageSchema` after this
 * has read them. Nothing here decides anything is allowed; it only decides what
 * was meant.
 */

import type * as core from "@polaris/core";

/** What list this is. The shape the page schema validates on the way in. */
export interface MailPageNarrow {
    readonly accountId: string | null;
    readonly folderId: string | null;
    readonly role: string | null;
    readonly labelId: string | null;
    readonly unreadOnly: boolean;
    readonly readOnly: boolean;
    readonly starredOnly: boolean;
    readonly importantOnly: boolean;
    readonly snoozedOnly: boolean;
    readonly withAttachments: boolean;
    readonly category: string;
    readonly sort: core.MailSort;
    readonly query: string;
}

/** The switches, which travel as their own presence rather than as a word: a
 *  query string is read by hand at both ends, and `unreadOnly=false` parsed as a
 *  string is true. */
const FLAGS = [
    "unreadOnly",
    "readOnly",
    "starredOnly",
    "importantOnly",
    "snoozedOnly",
    "withAttachments"
] as const satisfies readonly (keyof MailPageNarrow)[];

/** The rest, which travel as themselves and are left out when they are empty. */
const VALUES = [
    "accountId",
    "folderId",
    "role",
    "labelId",
    "category",
    "sort",
    "query"
] as const satisfies readonly (keyof MailPageNarrow)[];

/**
 * The list as a query string, in a settled order.
 *
 * Settled because this is also a cache key: two identical lists that spell
 * themselves differently are two entries, one of which is always stale.
 */
export function mailPageParams(page: MailPageNarrow, cursor = ""): URLSearchParams {
    const params = new URLSearchParams();
    for (const key of VALUES) {
        const value = page[key];
        if (value) params.set(key, String(value));
    }
    for (const key of FLAGS) {
        if (page[key]) params.set(key, "1");
    }
    if (cursor) params.set("cursor", cursor);
    return params;
}

/**
 * What a query string was asking for, in the shape the schema checks.
 *
 * Deliberately permissive about what is missing and strict about nothing: this
 * is a reading, and `core.mailPageSchema` is the decision. Anything absent comes
 * back as the empty form that schema defaults over.
 */
export function readMailPageParams(params: URLSearchParams): Record<string, unknown> {
    const read: Record<string, unknown> = { cursor: params.get("cursor") ?? "" };
    for (const key of VALUES) {
        const value = params.get(key);
        // Null rather than "" for the four that name a row: the schema types
        // them as nullable, and an empty string is not a missing one.
        read[key] =
            key === "category" || key === "query" || key === "sort" ? (value ?? undefined) : value;
    }
    for (const key of FLAGS) read[key] = params.has(key);
    return read;
}
