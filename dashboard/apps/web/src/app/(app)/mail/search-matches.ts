/**
 * Which messages of an open conversation the search in the address found.
 *
 * The list's row says, when the conversation was opened from a search's
 * results - the server read every message, bodies included. A conversation
 * opened from a link with a search on it has no row to ask, so it is worked out
 * from what the pane holds: a message matches when every word asked for is in
 * its subject, its preview or the names on it.
 */

import * as core from "@polaris/core";
import type { MailMessageView } from "@/lib/mailbox/views";

export function searchMatchIds(
    listed: readonly MailMessageView[],
    fromRow: readonly string[] | undefined,
    needles: readonly string[]
): string[] {
    if (fromRow) {
        const found = new Set(fromRow);
        return listed.filter((message) => found.has(message.id)).map((message) => message.id);
    }
    if (needles.length === 0) return [];
    return listed
        .filter((message) => {
            const people = [...message.from, ...message.to, ...message.cc]
                .map((entry) => `${entry.name} ${entry.address}`)
                .join(" ");
            const text = `${message.subject}\n${message.snippet}\n${people}`;
            return needles.every((needle) => core.mailSearchHits(text, [needle]).length > 0);
        })
        .map((message) => message.id);
}
