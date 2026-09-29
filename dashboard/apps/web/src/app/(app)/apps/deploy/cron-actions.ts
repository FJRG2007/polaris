"use server";

/**
 * Scheduled jobs on a service: the actions behind its Cron tab.
 *
 * Seeing the jobs and what they printed is reading logs, so it asks for
 * `logs.read`. Creating, changing, removing or running one is running a command
 * inside the service's container - the same reach as its console - so it asks
 * for `console.use` rather than for the right to redeploy.
 */

import * as core from "@polaris/core";
import { firstIssue, reply } from "./reply";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import type { NamespaceKey } from "@/lib/i18n/types";
import * as crons from "@/lib/deploy/service-cron";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

const DEPLOY_PATH = "/apps/deploy";

async function failure(caught: unknown, fallback: NamespaceKey<"deployServer">): Promise<{ error: string }> {
    return { error: caught instanceof Error ? caught.message : await reply(fallback) };
}

export async function listServiceCronsAction(
    applicationId: string
): Promise<{ error?: string; crons?: crons.ServiceCronView[] }> {
    const user = await requirePermission("deploy.read");
    try {
        await requireApplicationAccess(applicationId, user.id, "logs.read");
        return { crons: await crons.listServiceCrons(applicationId) };
    } catch (caught) {
        return failure(caught, "crons.loadFailed");
    }
}

export async function saveServiceCronAction(
    applicationId: string,
    input: unknown
): Promise<{ error?: string; cron?: crons.ServiceCronView }> {
    const user = await requirePermission("deploy.manage");
    const parsed = core.serviceCronInputSchema.safeParse(input);
    if (!parsed.success) return { error: await firstIssue(parsed.error, "crons.checkDetails") };
    try {
        await requireApplicationAccess(applicationId, user.id, "console.use");
        const cron = await crons.saveServiceCron(applicationId, parsed.data, user.id);
        await recordDeployAudit({
            actorId: user.id,
            action: parsed.data.id ? "deploy.cron.update" : "deploy.cron.create",
            targetType: "application",
            targetId: applicationId
        });
        revalidatePath(DEPLOY_PATH);
        return { cron };
    } catch (caught) {
        return failure(caught, "crons.saveFailed");
    }
}

export async function deleteServiceCronAction(
    applicationId: string,
    cronId: string
): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await requireApplicationAccess(applicationId, user.id, "console.use");
        await crons.deleteServiceCron(applicationId, cronId);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.cron.delete",
            targetType: "application",
            targetId: applicationId
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "crons.removeFailed");
    }
}

export async function runServiceCronAction(
    applicationId: string,
    cronId: string
): Promise<{ error?: string; runId?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await requireApplicationAccess(applicationId, user.id, "console.use");
        const runId = await crons.runServiceCronNow(applicationId, cronId);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.cron.run",
            targetType: "application",
            targetId: applicationId
        });
        return { runId };
    } catch (caught) {
        return failure(caught, "crons.runFailed");
    }
}

export async function listServiceCronRunsAction(
    applicationId: string,
    cronId: string
): Promise<{ error?: string; runs?: crons.ServiceCronRunView[] }> {
    const user = await requirePermission("deploy.read");
    try {
        await requireApplicationAccess(applicationId, user.id, "logs.read");
        return { runs: await crons.listServiceCronRuns(applicationId, cronId) };
    } catch (caught) {
        return failure(caught, "crons.runsFailed");
    }
}
