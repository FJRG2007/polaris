"use server";

/**
 * Whether a service is handed its server's NVIDIA cards. Reading it asks for
 * what the rest of the service's settings ask for, and changing it is changing
 * how the service runs, so it asks for `service.configure` like its scaling.
 */

import { z } from "zod";
import { reply } from "./reply";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as gpu from "@/lib/deploy/gpu-service";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

const DEPLOY_PATH = "/apps/deploy";

const enabledSchema = z.boolean();

export async function serviceGpuAction(
    applicationId: string
): Promise<{ error?: string; gpu?: gpu.ServiceGpuView }> {
    const user = await requirePermission("deploy.read");
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "project.read");
        return { gpu: await gpu.getServiceGpu(applicationId, access.ownerId) };
    } catch {
        return { error: await reply("gpu.loadFailed") };
    }
}

export async function saveServiceGpuAction(
    applicationId: string,
    enabled: boolean
): Promise<{ error?: string; redeployed?: boolean; restartError?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = enabledSchema.safeParse(enabled);
    if (!parsed.success) return { error: await reply("gpu.saveFailed") };
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "service.configure");
        const outcome = await gpu.setServiceGpu(applicationId, access.ownerId, user.id, parsed.data);
        if (outcome.refusal) return { error: await reply(`gpu.${outcome.refusal}`) };
        if (!outcome.saved) return { redeployed: false };
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.gpu",
            targetType: "application",
            targetId: applicationId,
            metadata: { useGpu: parsed.data }
        });
        revalidatePath(DEPLOY_PATH);
        if (outcome.restartFailed) return { redeployed: false, restartError: await reply("gpu.restartFailed") };
        return { redeployed: outcome.redeployed };
    } catch {
        return { error: await reply("gpu.saveFailed") };
    }
}
