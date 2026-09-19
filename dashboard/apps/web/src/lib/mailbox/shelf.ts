/**
 * Which mailboxes Mail is looking at.
 *
 * Every other app draws one shelf at a time: your own things on your own shelf,
 * a company's on its. Mail can do that too, and by default does - but a person
 * with one personal address and one work address usually wants both in front of
 * them, which is what every other mail client gives them. So this is a choice,
 * kept with the rest of the Mail preferences, and this is the one place that
 * answers "which mailboxes, right now".
 *
 * The answer is either an organization's id, null for the personal shelf, or
 * `EVERY_SHELF` - a value no organization can have, so a listing cannot confuse
 * the two. Only listings take it. Opening a named mailbox, folder or message is
 * never narrowed, because the shelf decides what is listed and never what may be
 * reached, and creating a mailbox still belongs to the shelf that is open rather
 * than to all of them.
 */

import { cache } from "react";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { readMailPreferences } from "@/lib/mailbox/prefs";

/** Every mailbox, whichever shelf it is on. */
export const EVERY_SHELF = "*";

/** An organization's id, null for the personal shelf, or every shelf at once. */
export type MailShelf = string | null;

/** Whether a listing was asked for every shelf. */
export function isEveryShelf(shelf: MailShelf): boolean {
    return shelf === EVERY_SHELF;
}

/** What Mail's lists, counts and arrival notices are drawn from for this
 *  person: the shelf in the header, or every mailbox when they asked for that. */
export const mailShelfFor = cache(async (userId: string): Promise<MailShelf> => {
    const preferences = await readMailPreferences(userId);
    if (preferences.mailboxes === "all") return EVERY_SHELF;
    return scopeOrgIdFor(userId);
});
