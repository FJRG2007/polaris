"use server";

/**
 * What the screen of an installed app whose code is not here can do about it,
 * and what the updates screen does to each installed app.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { retryApp } from "./lifecycle";
import { findApp } from "@/lib/apps/catalog";
import { requireAdmin, requireUser } from "@/lib/session";
import { appReleaseStatuses, rollbackApp, updateApp, type UpdateRefusal } from "./releases";
import { readerWords } from "@/lib/i18n/reader-words";

const AppId = z.string().regex(/^[a-z0-9-]{1,64}$/);

/** Fetch and load the app's bundle again. */
export async function retryAppAction(id: string): Promise<{ error?: string }> {
    await requireUser();
    const parsed = AppId.safeParse(id);
    if (!parsed.success) return { error: (await readerWords("api"))("refusals.apps.notAnApp") };
    return retryApp(parsed.data);
}

/** What the updates screen is told about one installed app. */
export type AppUpdateRow = Awaited<ReturnType<typeof appReleaseStatuses>>[number] & {
    readonly name: string;
};

async function rows(check: boolean): Promise<AppUpdateRow[]> {
    const statuses = await appReleaseStatuses({ check });
    return statuses.map((status) => ({ ...status, name: findApp(status.id)?.name ?? status.id }));
}

/** Every installed app's build and the newest one published for it. Admin-only. */
export async function appUpdatesAction(check: unknown): Promise<AppUpdateRow[]> {
    await requireAdmin();
    return rows(z.boolean().catch(false).parse(check));
}

/**
 * Update one app, or put back the build it ran before, without restarting
 * Polaris. Answers the screen's rows as they are afterwards, and the reason
 * as a code when nothing changed.
 */
export async function changeAppBuildAction(
    id: unknown,
    change: unknown
): Promise<{ rows: AppUpdateRow[]; refused?: UpdateRefusal }> {
    await requireAdmin();
    const parsed = z
        .object({ id: AppId, change: z.enum(["update", "rollback"]) })
        .safeParse({ id, change });
    if (!parsed.success) return { rows: await rows(false), refused: "unknown" };
    const outcome =
        parsed.data.change === "update"
            ? await updateApp(parsed.data.id)
            : await rollbackApp(parsed.data.id);
    if (outcome.ok && outcome.changed) revalidatePath("/", "layout");
    return { rows: await rows(false), ...(outcome.ok ? {} : { refused: outcome.code }) };
}
