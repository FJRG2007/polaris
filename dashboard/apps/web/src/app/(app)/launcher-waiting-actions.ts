"use server";

/**
 * Marking what the app menu lists as read: one entry, or every entry of one app.
 *
 * Each app's own "read" - see `launcher-waiting` - behind the gate its badge
 * uses, so the menu can never mark something its reader could not have opened.
 */

import { z } from "zod";
import { requireUser, sessionCan } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { markLauncherReadSchema } from "@/lib/launcher-waiting";
import { markLauncherRead } from "@/lib/launcher-waiting-service";

const rowId = z.string().uuid();

export async function markLauncherReadAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("nav");
    const parsed = markLauncherReadSchema.safeParse(input);
    if (!parsed.success) return { error: t("waitingList.errors.notMarked") };
    const { app } = parsed.data;
    const id = parsed.data.scope === "item" ? parsed.data.id : null;
    // A conversation and a mail thread are rows; anything else is not one of
    // theirs, and the database would refuse it less politely than this.
    if (id && app !== "admin" && !rowId.safeParse(id).success)
        return { error: t("waitingList.errors.notMarked") };
    const allowed =
        app === "admin"
            ? user.isAdmin
            : await sessionCan(user, app === "chat" ? "chat.use" : "mail.use");
    if (!allowed) return { error: t("waitingList.errors.notMarked") };
    try {
        await markLauncherRead(user.id, app, id);
        return {};
    } catch (caught) {
        console.error("[launcher] mark read failed", caught);
        return { error: t("waitingList.errors.notMarked") };
    }
}
