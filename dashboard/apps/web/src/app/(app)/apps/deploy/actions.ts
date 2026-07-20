"use server";

/**
 * Deploy app server actions. Project/application management and deploys are gated
 * on deploy.manage and re-validated server-side. Creating an application resolves
 * the owner's local target lazily, so a first deploy works with no server setup.
 */

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getOrCreateLocalTarget } from "@/lib/deploy-target-service";
import {
    createApplication,
    createProject,
    deleteProject,
    deployApplication
} from "@/lib/deploy-service";

const DEPLOY_PATH = "/apps/deploy";

export async function createProjectAction(input: { name: string }): Promise<{ error?: string; id?: string }> {
    const user = await requirePermission("deploy.manage");
    const name = input.name?.trim();
    if (!name) return { error: "A project name is required" };
    try {
        const project = await createProject(user.id, name);
        await recordAudit({ actorId: user.id, action: "deploy.project.create", targetType: "project", targetId: project.id });
        revalidatePath(DEPLOY_PATH);
        return { id: project.id };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the project" };
    }
}

export async function deleteProjectAction(projectId: string): Promise<void> {
    const user = await requirePermission("deploy.manage");
    await deleteProject(projectId, user.id);
    await recordAudit({ actorId: user.id, action: "deploy.project.delete", targetType: "project", targetId: projectId });
    revalidatePath(DEPLOY_PATH);
}

export async function createApplicationAction(input: {
    environmentId: string;
    name: string;
    imageRef: string;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const name = input.name?.trim();
    const imageRef = input.imageRef?.trim();
    if (!name) return { error: "An application name is required" };
    if (!imageRef) return { error: "An image reference is required (e.g. nginx:latest)" };
    try {
        const target = await getOrCreateLocalTarget(user.id);
        const app = await createApplication(user.id, {
            environmentId: input.environmentId,
            targetId: target.id,
            name,
            sourceType: "image",
            sourceConfig: { imageRef }
        });
        await recordAudit({ actorId: user.id, action: "deploy.app.create", targetType: "application", targetId: app.id });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the application" };
    }
}

export async function deployApplicationAction(applicationId: string): Promise<{ error?: string; deploymentId?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const deploymentId = await deployApplication(applicationId, user.id, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.app.deploy", targetType: "application", targetId: applicationId });
        revalidatePath(DEPLOY_PATH);
        return { deploymentId };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not start the deployment" };
    }
}
