"use server";

/**
 * What an app's settings do to the services Polaris runs for it. Administrator
 * only, by the same check the settings page itself makes.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import * as activity from "@/lib/activity/activity";
import { readerWords } from "@/lib/i18n/reader-words";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { appSettingsPath } from "@/lib/apps/app-settings";
import { readAppServiceLog, restartAppService } from "@/lib/apps/app-services";

const ServiceInput = z.object({
    appId: z.string().trim().min(1).max(100),
    applicationId: z.string().trim().uuid()
});

/** How many lines a log view shows - the same as Deploy's. */
const LOG_TAIL = 500;

/** Restart one of this app's services in place. */
export async function restartAppServiceAction(
    appId: string,
    applicationId: string
): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const t = await readerWords("marketplace");
    const input = ServiceInput.safeParse({ appId, applicationId });
    if (!input.success) return { error: t("services.notFound") };
    try {
        const restarted = await restartAppService(input.data.appId, input.data.applicationId);
        if (!restarted) return { error: t("services.notFound") };
    } catch (caught) {
        console.error("[app-services] restart failed", caught);
        return { error: t("services.restartFailed") };
    }
    // The same two records Deploy wrote for a restart, so the service's history
    // reads the same whichever screen it was pressed on.
    await recordDeployAudit({
        actorId: user.id,
        action: "deploy.app.restart",
        targetType: "application",
        targetId: input.data.applicationId
    });
    await activity.record({
        subjectType: "app",
        subjectId: input.data.applicationId,
        userId: user.id,
        action: "restarted",
        fromValue: null,
        toValue: null
    });
    revalidatePath(appSettingsPath(input.data.appId));
    return {};
}

/** The last lines one of this app's services printed. */
export async function readAppServiceLogAction(
    appId: string,
    applicationId: string
): Promise<{ log?: string; error?: string }> {
    await requireAdmin();
    const t = await readerWords("marketplace");
    const input = ServiceInput.safeParse({ appId, applicationId });
    if (!input.success) return { error: t("services.notFound") };
    try {
        const log = await readAppServiceLog(input.data.appId, input.data.applicationId, LOG_TAIL);
        return log === null ? { error: t("services.notFound") } : { log };
    } catch (caught) {
        console.error("[app-services] log read failed", caught);
        return { error: t("services.logsFailed") };
    }
}
