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
import { createDatabase, deployDatabase, type DbEngine } from "@/lib/database-service";

const DB_ENGINES: DbEngine[] = ["postgres", "mysql", "mariadb", "mongo", "redis"];

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

export async function createDatabaseAction(input: {
    environmentId: string;
    engine: string;
    name: string;
    version?: string;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const name = input.name?.trim();
    if (!name) return { error: "A database name is required" };
    if (!DB_ENGINES.includes(input.engine as DbEngine)) return { error: "Unsupported database engine" };
    try {
        const target = await getOrCreateLocalTarget(user.id);
        const database = await createDatabase(user.id, {
            environmentId: input.environmentId,
            targetId: target.id,
            engine: input.engine as DbEngine,
            name,
            version: input.version
        });
        await recordAudit({ actorId: user.id, action: "deploy.db.create", targetType: "database", targetId: database.id });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the database" };
    }
}

export async function deployDatabaseAction(databaseId: string): Promise<{ error?: string; deploymentId?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const deploymentId = await deployDatabase(databaseId, user.id, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.db.deploy", targetType: "database", targetId: databaseId });
        revalidatePath(DEPLOY_PATH);
        return { deploymentId };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not provision the database" };
    }
}
