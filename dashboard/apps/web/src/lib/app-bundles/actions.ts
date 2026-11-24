"use server";

/**
 * What the screen of an installed app whose code is not here can do about it,
 * and what the updates screen does to each installed app.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { retryApp } from "./lifecycle";
import { readBundleState } from "./store";
import { findApp } from "@/lib/apps/catalog";
import { requireAdmin, requireUser } from "@/lib/session";
import { appReleaseStatuses, rollbackApp, updateApp, type UpdateRefusal } from "./releases";
import { readerWords } from "@/lib/i18n/reader-words";
import {
    acceptAppRelease,
    appUpdateDecisions,
    holdAppRelease,
    autoFor,
    readAppUpdatePolicy,
    writeAppUpdatePolicy,
    type AppUpdateDecision
} from "./auto-update";

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
    /** Whether it takes its releases by itself. */
    readonly auto: boolean;
    /** Whether that is its own setting rather than the one for every app. */
    readonly autoOwn: boolean;
    /** What happens to its newest release. */
    readonly decision: AppUpdateDecision;
    /** What that release asks to reach that was never accepted. */
    readonly newPermissions: readonly string[];
};

async function rows(check: boolean): Promise<AppUpdateRow[]> {
    const statuses = await appReleaseStatuses({ check });
    const [policy, decisions] = await Promise.all([
        readAppUpdatePolicy(),
        appUpdateDecisions(statuses)
    ]);
    return statuses.map((status) => ({
        ...status,
        name: findApp(status.id)?.name ?? status.id,
        auto: autoFor(policy, status.id),
        autoOwn: policy.apps[status.id] !== undefined,
        decision: decisions[status.id]?.decision ?? "current",
        newPermissions: decisions[status.id]?.newPermissions ?? []
    }));
}

/** Whether apps update by themselves, for all of them. Admin-only. */
export async function appAutoUpdateAction(): Promise<{ auto: boolean }> {
    await requireAdmin();
    return { auto: (await readAppUpdatePolicy()).auto };
}

/**
 * Turn automatic updates on or off for every app (`id` null), or for one app,
 * where `auto` null puts it back on the setting for every app.
 */
export async function setAppAutoUpdateAction(
    id: unknown,
    auto: unknown
): Promise<{ rows: AppUpdateRow[]; auto: boolean } | { error: string }> {
    await requireAdmin();
    const parsed = z
        .object({ id: AppId.nullable(), auto: z.boolean().nullable() })
        .safeParse({ id, auto });
    if (!parsed.success || (parsed.data.id === null && parsed.data.auto === null))
        return { error: (await readerWords("api"))("refusals.apps.notAnApp") };
    const policy = await readAppUpdatePolicy();
    const apps = { ...policy.apps };
    if (parsed.data.id === null) policy.auto = parsed.data.auto!;
    else if (parsed.data.auto === null) delete apps[parsed.data.id];
    else apps[parsed.data.id] = parsed.data.auto;
    await writeAppUpdatePolicy({ auto: policy.auto, apps });
    return { rows: await rows(false), auto: policy.auto };
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
    const leaving =
        parsed.data.change === "rollback"
            ? ((await readBundleState(parsed.data.id))?.current.digest ?? null)
            : null;
    const outcome =
        parsed.data.change === "update"
            ? await updateApp(parsed.data.id)
            : await rollbackApp(parsed.data.id);
    // Updating from the screen is the administrator's review: what the release
    // asks to reach is accepted, and one that failed before is theirs to retry.
    if (outcome.ok && parsed.data.change === "update")
        await acceptAppRelease(parsed.data.id).catch(() => undefined);
    if (outcome.ok && outcome.changed && leaving)
        await holdAppRelease(parsed.data.id, leaving).catch(() => undefined);
    if (outcome.ok && outcome.changed) revalidatePath("/", "layout");
    return { rows: await rows(false), ...(outcome.ok ? {} : { refused: outcome.code }) };
}
