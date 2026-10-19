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

import { z } from "zod";
import { cache } from "react";
import { PERSONAL_SHELF } from "@/lib/shelf";
import { readMailPreferences } from "@/lib/mailbox/prefs";
import { recipientShelf, scopeOrgIdFor } from "@/lib/workspace-scope";

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

/** What a tab may say it is showing: the personal shelf, every shelf, or an
 *  organization's id. Anything else is read as saying nothing. */
const askedShelfSchema = z.union([
    z.literal(PERSONAL_SHELF),
    z.literal(EVERY_SHELF),
    z.string().uuid()
]);

/**
 * The shelf one tab of Mail is showing, for what that tab asks for after it was
 * drawn - its rail, its list, the contacts its composer suggests.
 *
 * The header's switch is a cookie, and a cookie is shared by every tab: switching
 * shelf in one tab used to move the next rail refresh of every other tab onto
 * that shelf, and a composer open on an organization's mailbox then started on
 * a personal one. So a tab says which shelf it drew, and this checks it - an
 * organization only while this person is still on its roster, and their own
 * shelf otherwise, exactly as the cookie is checked. A tab that says nothing,
 * or something that is not a shelf, gets the header's.
 *
 * Listing only: every mailbox listed is still one of this person's own rows.
 */
export async function mailShelfOfTab(userId: string, asked: unknown): Promise<MailShelf> {
    const parsed = askedShelfSchema.safeParse(typeof asked === "string" ? asked.trim() : asked);
    if (!parsed.success) return mailShelfFor(userId);
    if (parsed.data === EVERY_SHELF) return EVERY_SHELF;
    if (parsed.data === PERSONAL_SHELF) return null;
    return recipientShelf(userId, { orgId: parsed.data });
}
