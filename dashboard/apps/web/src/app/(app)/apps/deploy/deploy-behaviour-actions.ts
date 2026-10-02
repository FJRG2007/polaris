"use server";

/**
 * What a deploy does to the running version of a service, and the two settings
 * that change it: sharing volumes for the change-over, and the networks of the
 * operator's own it joins. Both change how it runs, so they ask for
 * `service.configure`; reading them asks for nothing more than seeing the project.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { firstIssue, reply } from "./reply";
import { requirePermission } from "@/lib/session";
import type { NamespaceKey } from "@/lib/i18n/types";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { setExternalNetworks } from "@/lib/deploy/external-networks";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import { externalNetworksSchema } from "@/lib/deploy/external-networks-schema";
import { deployBehaviour, setOverlapVolumes, type DeployBehaviourView } from "@/lib/deploy/deploy-behaviour";

const DEPLOY_PATH = "/apps/deploy";

async function failure(caught: unknown, fallback: NamespaceKey<"deployServer">): Promise<{ error: string }> {
    return { error: caught instanceof Error ? caught.message : await reply(fallback) };
}

export async function deployBehaviourAction(
    applicationId: string
): Promise<{ error?: string; view?: DeployBehaviourView }> {
    const user = await requirePermission("deploy.read");
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "project.read");
        return { view: await deployBehaviour(applicationId, access.ownerId) };
    } catch (caught) {
        return failure(caught, "behaviour.loadFailed");
    }
}

export async function setOverlapVolumesAction(applicationId: string, value: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = z.boolean().safeParse(value);
    if (!parsed.success) return { error: await reply("behaviour.saveFailed") };
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "service.configure");
        if (!(await setOverlapVolumes(applicationId, access.ownerId, parsed.data))) return {};
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.overlapVolumes",
            targetType: "application",
            targetId: applicationId,
            metadata: { overlapVolumes: parsed.data }
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "behaviour.saveFailed");
    }
}

export async function setExternalNetworksAction(applicationId: string, value: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = externalNetworksSchema.safeParse(value);
    if (!parsed.success) return { error: await firstIssue(parsed.error, "behaviour.saveFailed") };
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "service.configure");
        if (!(await setExternalNetworks(applicationId, access.ownerId, parsed.data))) return {};
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.externalNetworks",
            targetType: "application",
            targetId: applicationId,
            metadata: { networks: parsed.data.map((entry) => entry.name) }
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "behaviour.saveFailed");
    }
}
