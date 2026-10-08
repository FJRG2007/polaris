/**
 * Where the keyboard shortcuts an account moved are kept.
 *
 * On the account, so they follow somebody to the next machine they sign in on -
 * the way Gmail keeps its custom shortcuts and VS Code syncs its keybindings. A
 * device that wants its own keys keeps those in its own browser, laid over
 * these (see `shortcuts` in @polaris/ui).
 *
 * Mail kept its moved keys in its own preferences before every app shared one
 * table. Until an account saves here, those are carried over as they were, so
 * nobody's Mail keyboard changed under them; the first save here takes over
 * from them, and Mail's own copy is emptied so a key put back on its default
 * cannot come back from there.
 */

import { cache } from "react";
import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { readMailPreferences, saveMailPreferences } from "@/lib/mailbox/prefs";

/** Read a stored set back. Anything that does not parse is no changes. */
export function parseShortcutOverrides(
    raw: string | null | undefined
): core.ShortcutOverrides | null {
    if (raw === null || raw === undefined) return null;
    try {
        return core.cleanShortcutOverrides(JSON.parse(raw));
    } catch {
        return core.NO_SHORTCUT_OVERRIDES;
    }
}

export const getShortcutOverrides = cache(
    async (userId: string): Promise<core.ShortcutOverrides> => {
        const row = await prisma.user.findUnique({
            where: { id: userId },
            select: { shortcuts: true }
        });
        const stored = parseShortcutOverrides(row?.shortcuts);
        if (stored) return stored;
        // Never saved here: Mail's keys, as Mail kept them.
        const mail = await readMailPreferences(userId).catch(() => null);
        return core.cleanShortcutOverrides(core.overridesFromMailKeymap(mail?.keys ?? {}));
    }
);

/** Keep an account's changes. Cleaned on the way in, so what is stored is what
 *  `getShortcutOverrides` would read back. */
export async function saveShortcutOverrides(
    userId: string,
    overrides: core.ShortcutOverrides
): Promise<core.ShortcutOverrides> {
    const clean = core.cleanShortcutOverrides(overrides);
    await prisma.user.update({
        where: { id: userId },
        data: { shortcuts: JSON.stringify(clean) }
    });
    const mail = await readMailPreferences(userId).catch(() => null);
    if (mail && Object.keys(mail.keys ?? {}).length > 0)
        await saveMailPreferences(userId, { ...mail, keys: {} }).catch(() => undefined);
    return clean;
}
