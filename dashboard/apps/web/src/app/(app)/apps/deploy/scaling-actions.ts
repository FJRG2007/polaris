"use server";

/**
 * How many copies of a service run and how traffic is spread over them: the
 * actions behind its Scaling settings. Changing either is changing how the service
 * runs, so it asks for `service.configure`, like the rest of its settings.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { firstIssue, reply } from "./reply";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import type { NamespaceKey } from "@/lib/i18n/types";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as scaling from "@/lib/deploy/scaling-service";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

const DEPLOY_PATH = "/apps/deploy";

const scalingInputSchema = core.serviceScalingSchema.extend({
    balancing: core.edgeBalancingSchema,
    limits: core.resourceLimitsSchema,
    sleepAfterMinutes: core.serviceSleepSchema
});

async function failure(caught: unknown, fallback: NamespaceKey<"deployServer">): Promise<{ error: string }> {
    return { error: caught instanceof Error ? caught.message : await reply(fallback) };
}

export async function serviceScalingAction(
    applicationId: string
): Promise<{ error?: string; scaling?: scaling.ServiceScalingView }> {
    const user = await requirePermission("deploy.read");
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "project.read");
        return { scaling: await scaling.getServiceScaling(applicationId, access.ownerId) };
    } catch (caught) {
        return failure(caught, "scaling.loadFailed");
    }
}

export async function saveServiceScalingAction(
    applicationId: string,
    input: z.input<typeof scalingInputSchema>
): Promise<{ error?: string; redeployed?: boolean }> {
    const user = await requirePermission("deploy.manage");
    const parsed = scalingInputSchema.safeParse(input);
    if (!parsed.success) return { error: await firstIssue(parsed.error, "scaling.check") };
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "service.configure");
        const outcome = await scaling.setServiceScaling(applicationId, access.ownerId, user.id, parsed.data);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.scaling",
            targetType: "application",
            targetId: applicationId,
            metadata: {
                replicas: parsed.data.replicas,
                autoscale: parsed.data.autoscale,
                sticky: parsed.data.balancing.sticky,
                healthPath: parsed.data.balancing.healthPath,
                cpus: parsed.data.limits.cpus,
                memoryMb: parsed.data.limits.memoryMb,
                sleepAfterMinutes: parsed.data.sleepAfterMinutes
            }
        });
        revalidatePath(DEPLOY_PATH);
        return { redeployed: outcome.redeployed };
    } catch (caught) {
        return failure(caught, "scaling.saveFailed");
    }
}
