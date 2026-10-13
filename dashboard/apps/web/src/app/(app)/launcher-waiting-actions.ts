"use server";

/**
 * Marking what an app has waiting as read from the app menu: one entry, every
 * entry of one app, or everything in every app this reader can reach.
 *
 * Each app's own "read" - see `launcher-waiting` - behind the gate its badge
 * uses, so the menu can never mark something its reader could not have opened.
 */

import { z } from "zod";
import { requireUser, sessionCan, type SessionUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import {
    LAUNCHER_WAITING_APPS,
    markLauncherReadSchema,
    type LauncherWaitingApp
} from "@/lib/launcher-waiting";
import { markLauncherRead } from "@/lib/launcher-waiting-service";

const rowId = z.string().uuid();

/** Whether this reader may mark this app's entries: the gate its badge uses. */
async function mayMark(user: SessionUser, app: LauncherWaitingApp): Promise<boolean> {
    if (app === "admin") return user.isAdmin;
    return sessionCan(user, app === "chat" ? "chat.use" : "mail.use");
}

export async function markLauncherReadAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const t = await getTranslations("nav");
    const parsed = markLauncherReadSchema.safeParse(input);
    if (!parsed.success) return { error: t("waitingList.errors.notMarked") };

    if (parsed.data.scope === "all") {
        // Every app this reader can reach, and quietly none they cannot: "all"
        // means everything they were shown, not everything there is.
        const allowed: LauncherWaitingApp[] = [];
        for (const app of LAUNCHER_WAITING_APPS) {
            if (await mayMark(user, app)) allowed.push(app);
        }
        const results = await Promise.allSettled(
            allowed.map((app) => markLauncherRead(user.id, app, null))
        );
        const failed = results.filter((result) => result.status === "rejected");
        if (failed.length === 0) return {};
        for (const result of failed)
            console.error("[launcher] mark all read failed", result.reason);
        return { error: t("waitingList.errors.notMarked") };
    }

    const { app } = parsed.data;
    const id = parsed.data.scope === "item" ? parsed.data.id : null;
    // A conversation and a mail thread are rows; anything else is not one of
    // theirs, and the database would refuse it less politely than this.
    if (id && app !== "admin" && !rowId.safeParse(id).success)
        return { error: t("waitingList.errors.notMarked") };
    if (!(await mayMark(user, app))) return { error: t("waitingList.errors.notMarked") };
    try {
        await markLauncherRead(user.id, app, id);
        return {};
    } catch (caught) {
        console.error("[launcher] mark read failed", caught);
        return { error: t("waitingList.errors.notMarked") };
    }
}
