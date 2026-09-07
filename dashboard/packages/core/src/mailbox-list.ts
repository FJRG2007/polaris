/**
 * How a list of mail is narrowed and ordered.
 *
 * Two small vocabularies, kept here rather than in the screen that draws them,
 * because three places have to agree on the same words: the buttons above the
 * list, the address they write, and the query the server builds from that
 * address. A fourth would be a fifth spelling of "attachments".
 *
 * Deliberately separate from the search grammar next door. `from:ana` is a
 * question about the mail; these are a question about the list - which of it to
 * show, and in what order - and they survive a search being typed, cleared and
 * typed again. Keeping them apart is also what stops "unread" being answered by
 * reading two thousand messages and matching them: a filter is a column with an
 * index on it, and a search is not.
 */

/** The one narrowing a list can have on it, past whatever was searched for. One
 *  at a time on purpose: they are the four ways somebody triages a full inbox,
 *  and combining them is what the search box is for. */
export const MAIL_FILTERS = ["unread", "read", "starred", "attachments"] as const;

export type MailFilter = (typeof MAIL_FILTERS)[number];

export const MAIL_FILTER_LABELS: Readonly<Record<MailFilter, string>> = {
    unread: "Unread",
    read: "Read",
    starred: "Starred",
    attachments: "With attachments"
};

/** The orders a list can be read in. Newest first is what mail is, and the other
 *  three are what somebody is doing when they have stopped reading it and
 *  started clearing it out. */
export const MAIL_SORTS = ["newest", "oldest", "largest", "smallest"] as const;

export type MailSort = (typeof MAIL_SORTS)[number];

export const MAIL_SORT_LABELS: Readonly<Record<MailSort, string>> = {
    newest: "Newest first",
    oldest: "Oldest first",
    largest: "Largest first",
    smallest: "Smallest first"
};

/** What the list is ordered by unless somebody says otherwise. */
export const DEFAULT_MAIL_SORT: MailSort = "newest";

export function isMailFilter(value: string | undefined | null): value is MailFilter {
    return Boolean(value) && (MAIL_FILTERS as readonly string[]).includes(value ?? "");
}

export function isMailSort(value: string | undefined | null): value is MailSort {
    return Boolean(value) && (MAIL_SORTS as readonly string[]).includes(value ?? "");
}

/** The filter an address asks for, or "" for the whole list. Anything else is
 *  somebody editing a URL, and the answer to that is everything rather than an
 *  error page. */
export function readMailFilter(value: string | undefined | null): MailFilter | "" {
    return isMailFilter(value) ? value : "";
}

/** The order an address asks for, falling back to the one a mailbox is read in.
 *  Same reasoning: a sort nobody defined is not worth refusing over. */
export function readMailSort(value: string | undefined | null): MailSort {
    return isMailSort(value) ? value : DEFAULT_MAIL_SORT;
}

/** Whether the list is showing something other than all of it, in its ordinary
 *  order - which is the question the button that clears both answers. */
export function mailListIsNarrowed(filter: MailFilter | "", sort: MailSort): boolean {
    return filter !== "" || sort !== DEFAULT_MAIL_SORT;
}
