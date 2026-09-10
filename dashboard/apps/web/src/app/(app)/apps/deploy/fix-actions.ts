"use server";

/**
 * A failed deploy's likely cause, and the one-press fix for it.
 *
 * Reading the cause is reading the deploy's log, so it asks for `logs.read`.
 * Applying a fix changes a setting and deploys again: it asks for the right to
 * change the service - or its variables, for a fix that sets one - and to deploy.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import type { Diagnosis } from "@polaris/deploy";
import { requirePermission } from "@/lib/session";
import * as diagnosis from "@/lib/deploy/diagnosis";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { requireDeploymentAccess } from "@/lib/deploy-project-access";

const DEPLOY_PATH = "/apps/deploy";

export async function deploymentDiagnosisAction(deploymentId: string): Promise<{ diagnosis: Diagnosis | null }> {
    const user = await requirePermission("deploy.read");
    try {
        const access = await requireDeploymentAccess(deploymentId, user.id, "logs.read");
        return { diagnosis: await diagnosis.diagnoseDeployment(deploymentId, access.ownerId) };
    } catch {
        return { diagnosis: null };
    }
}

export async function applyDeployFixAction(
    deploymentId: string,
    input: unknown
): Promise<{ error?: string; deploymentId?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = core.deployFixInputSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the fix" };
    try {
        const fix = parsed.data;
        const access = await requireDeploymentAccess(
            deploymentId,
            user.id,
            fix.kind === "add-variable" ? "variables.write" : "service.configure"
        );
        await requireDeploymentAccess(deploymentId, user.id, "deploy.run");
        const next = await diagnosis.applyDeployFix(deploymentId, access.ownerId, user.id, fix);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.fix",
            targetType: "deployment",
            targetId: deploymentId,
            // The kind and the name of what changed, never a variable's value.
            metadata: { kind: fix.kind, ...(fix.kind === "add-variable" ? { variable: fix.name } : {}), deploymentId: next }
        });
        revalidatePath(DEPLOY_PATH);
        return { deploymentId: next };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not apply the fix" };
    }
}
