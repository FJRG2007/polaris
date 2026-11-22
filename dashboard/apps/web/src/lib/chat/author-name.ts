/**
 * Who wrote a message, as a name to show.
 *
 * A person's message is named by their account. A message with no account
 * behind it - Polar answering, an app's agent, something posting through a
 * webhook - is named by the label it was posted under. Reading only the account
 * called every one of those "somebody who has left" wherever the message was
 * shown second-hand: a reply's quote, a link to it, a toast.
 *
 * Null for a person whose account is gone, which the caller words itself.
 * Pure.
 */

export interface AuthoredRow {
    readonly authorId: string | null;
    readonly authorLabel?: string | null;
    readonly webhookId?: string | null;
    readonly agent?: string | null;
    /** Set on a copy an announcement channel published: signed with its origin. */
    readonly publishedFromId?: string | null;
}

export function authorNameOf(row: AuthoredRow, names: ReadonlyMap<string, string>): string | null {
    if (row.authorId) return names.get(row.authorId) ?? null;
    if (row.webhookId || row.agent || row.publishedFromId) return row.authorLabel ?? null;
    return null;
}

/** The columns `authorNameOf` reads, for a query's `select`. */
export const AUTHOR_SELECT = {
    authorId: true,
    authorLabel: true,
    webhookId: true,
    agent: true,
    publishedFromId: true
} as const;
