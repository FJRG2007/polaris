"use server";

/**
 * How many copies of a service run and how traffic is spread over them: the
 * actions behind its Scaling settings. Changing either is changing how the service
 * runs, so it asks for `service.configure`, like the rest of its settings.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as scaling from "@/lib/deploy/scaling-service";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

const DEPLOY_PATH = "/apps/deploy";

const scalingInputSchema = core.serviceScalingSchema.extend({
    balancing: core.edgeBalancingSchema,
    limits: core.resourceLimitsSchema,
    sleepAfterMinutes: core.serviceSleepSchema
});

function failure(caught: unknown, fallback: string): { error: string } {
    return { error: caught instanceof Error ? caught.message : fallback };
}

export async function serviceScalingAction(
    applicationId: string
): Promise<{ error?: string; scaling?: scaling.ServiceScalingView }> {
    const user = await requirePermission("deploy.read");
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "project.read");
        return { scaling: await scaling.getServiceScaling(applicationId, access.ownerId) };
    } catch (caught) {
        return failure(caught, "Could not read how this service is scaled");
    }
}

export async function saveServiceScalingAction(
    applicationId: string,
    input: z.input<typeof scalingInputSchema>
): Promise<{ error?: string; redeployed?: boolean }> {
    const user = await requirePermission("deploy.manage");
    const parsed = scalingInputSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the scaling settings" };
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
        return failure(caught, "Could not save the scaling settings");
    }
}
