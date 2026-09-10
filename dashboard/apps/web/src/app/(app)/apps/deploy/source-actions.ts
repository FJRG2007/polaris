"use server";

/**
 * Where a service's image is built, and the folder it was uploaded from: the
 * actions behind those two settings. Both change how the service is built, so
 * they ask for `service.configure`.
 */

import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as buildMachine from "@/lib/deploy/build-machine";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import { uploadedSourceOf, type UploadedSource } from "@/lib/deploy/source-upload";

const DEPLOY_PATH = "/apps/deploy";

function failure(caught: unknown, fallback: string): { error: string } {
    return { error: caught instanceof Error ? caught.message : fallback };
}

export async function buildMachineAction(
    applicationId: string
): Promise<{ error?: string; view?: buildMachine.BuildMachineView }> {
    const user = await requirePermission("deploy.read");
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "project.read");
        return { view: await buildMachine.buildMachineOptions(applicationId, access.ownerId) };
    } catch (caught) {
        return failure(caught, "Could not read where this service builds");
    }
}

export async function setBuildMachineAction(applicationId: string, value: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = buildMachine.buildOnSchema.safeParse(value);
    if (!parsed.success) return { error: "Choose a machine from the list" };
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "service.configure");
        await buildMachine.setBuildMachine(applicationId, access.ownerId, parsed.data);
        await recordDeployAudit({
            actorId: user.id,
            action: "deploy.app.buildOn",
            targetType: "application",
            targetId: applicationId,
            metadata: { buildOn: parsed.data || "runs-on" }
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change where this service builds");
    }
}

/**
 * The folder a service was last built from, when it is built from an upload;
 * `uploadable` says whether it can take one at all - not a service that runs an
 * image or builds from a repository.
 */
export async function uploadedSourceAction(
    applicationId: string
): Promise<{ error?: string; upload?: UploadedSource | null; uploadable?: boolean }> {
    const user = await requirePermission("deploy.read");
    try {
        const access = await requireApplicationAccess(applicationId, user.id, "project.read");
        const app = await prisma.application.findFirst({
            where: { id: applicationId, environment: { project: { ownerId: access.ownerId } } },
            select: { sourceType: true, sourceConfig: true }
        });
        if (!app) return { error: "Service not found" };
        const source = JSON.parse(app.sourceConfig || "{}") as Record<string, unknown>;
        const fromRepository = typeof source.repoUrl === "string" && source.repoUrl.length > 0;
        const uploadable = !fromRepository && (app.sourceType === "dockerfile" || app.sourceType === "nixpacks");
        return { upload: uploadedSourceOf(source), uploadable };
    } catch (caught) {
        return failure(caught, "Could not read this service's source");
    }
}
