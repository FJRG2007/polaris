/**
 * Where one person's Mail preferences are read and written.
 *
 * One row, one column, one JSON blob - the shape display and notification
 * preferences already use. Memoized per request, because several things on a
 * page want them: the list wants the order, the conversation wants when a
 * message stops being unread, and the composer's server side wants how long a
 * sent message waits. One query for all of it.
 *
 * The blob is never read raw. `parseMailPreferences` answers with the whole
 * shape whatever is in the column, so nothing here has to know what a version of
 * Polaris six months ago stored - see `mail-prefs` in @polaris/core.
 */

import { cache } from "react";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

/** What this person has chosen, with every field decided. */
export const readMailPreferences = cache(async (userId: string): Promise<core.MailPreferences> => {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { mailPrefs: true } });
    return core.parseMailPreferences(row?.mailPrefs);
});

/** Store the whole shape. Written in full rather than merged: what comes back
 *  next time is then what the screen showed, rather than a mixture of a choice
 *  and whatever the defaults happen to be by then. */
export async function saveMailPreferences(
    userId: string,
    preferences: core.MailPreferences
): Promise<void> {
    await prisma.user.update({
        where: { id: userId },
        data: { mailPrefs: core.stringifyMailPreferences(preferences) }
    });
}
