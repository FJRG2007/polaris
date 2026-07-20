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
    addApplicationDomain,
    createApplication,
    createEnvironment,
    createProject,
    deleteEnvironment,
    deleteProject,
    deployApplication,
    removeApplicationDomain,
    saveEnvironmentLayout
} from "@/lib/deploy-service";
import { createDatabase, deployDatabase, type DbEngine } from "@/lib/database-service";
import { getGithubStatus, listGithubRepos, type GithubRepo } from "@/lib/github-service";
import {
    deleteRegistryCredential,
    listRegistryCredentials,
    upsertRegistryCredential,
    type RegistryCredentialView
} from "@/lib/registry-credential-service";

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

export async function createEnvironmentAction(input: { projectId: string; name: string }): Promise<{ error?: string; id?: string }> {
    const user = await requirePermission("deploy.manage");
    const name = input.name?.trim();
    if (!name) return { error: "An environment name is required" };
    try {
        const environment = await createEnvironment(input.projectId, user.id, name);
        await recordAudit({ actorId: user.id, action: "deploy.env.create", targetType: "environment", targetId: environment.id });
        revalidatePath(`${DEPLOY_PATH}/${input.projectId}`);
        return { id: environment.id };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the environment" };
    }
}

export async function saveLayoutAction(input: { environmentId: string; layout: string }): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await saveEnvironmentLayout(input.environmentId, user.id, input.layout);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the layout" };
    }
}

export async function deleteEnvironmentAction(input: { environmentId: string; projectId: string }): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deleteEnvironment(input.environmentId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.env.delete", targetType: "environment", targetId: input.environmentId });
        revalidatePath(`${DEPLOY_PATH}/${input.projectId}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete the environment" };
    }
}

export async function createApplicationAction(input: {
    environmentId: string;
    name: string;
    sourceType?: string;
    imageRef?: string;
    repoUrl?: string;
    branch?: string;
    dockerfilePath?: string;
    provider?: string;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const name = input.name?.trim();
    if (!name) return { error: "An application name is required" };
    const isGit = input.sourceType === "dockerfile" || input.sourceType === "git";
    let sourceType = "image";
    let sourceConfig: Record<string, unknown>;
    if (isGit) {
        const repoUrl = input.repoUrl?.trim();
        if (!repoUrl) return { error: "A git repository URL is required" };
        sourceType = "dockerfile";
        sourceConfig = {
            repoUrl,
            branch: input.branch?.trim() || undefined,
            dockerfilePath: input.dockerfilePath?.trim() || "Dockerfile",
            // Mark GitHub-sourced repos so the build authenticates its clone with the
            // connected token (private repos), transparently for public ones too.
            provider: input.provider === "github" ? "github" : undefined
        };
    } else {
        const imageRef = input.imageRef?.trim();
        if (!imageRef) return { error: "An image reference is required (e.g. nginx:latest)" };
        sourceConfig = { imageRef };
    }
    try {
        const target = await getOrCreateLocalTarget(user.id);
        const app = await createApplication(user.id, {
            environmentId: input.environmentId,
            targetId: target.id,
            name,
            sourceType,
            sourceConfig
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

export async function addDomainAction(input: {
    applicationId: string;
    hostname?: string;
    targetPort: number;
}): Promise<{ error?: string; hostname?: string }> {
    const user = await requirePermission("deploy.manage");
    const port = Number(input.targetPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "A valid target port is required" };
    try {
        const hostname = await addApplicationDomain(input.applicationId, user.id, {
            hostname: input.hostname,
            targetPort: port
        });
        await recordAudit({ actorId: user.id, action: "deploy.domain.add", targetType: "application", targetId: input.applicationId });
        revalidatePath(DEPLOY_PATH);
        return { hostname };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not add the domain" };
    }
}

export async function removeDomainAction(domainId: string): Promise<void> {
    const user = await requirePermission("deploy.manage");
    await removeApplicationDomain(domainId, user.id);
    revalidatePath(DEPLOY_PATH);
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

/** List the owner's private-registry logins (password-free). Gated on deploy.manage. */
export async function listRegistryCredentialsAction(): Promise<RegistryCredentialView[]> {
    const user = await requirePermission("deploy.manage");
    return listRegistryCredentials(user.id);
}

/** Add or replace a private-registry login. Gated on deploy.manage. */
export async function saveRegistryCredentialAction(input: {
    registry: string;
    username: string;
    password: string;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await upsertRegistryCredential(user.id, input);
        await recordAudit({ actorId: user.id, action: "deploy.registry.save", targetType: "registry", targetId: input.registry });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the registry login" };
    }
}

/** Remove a private-registry login. Gated on deploy.manage. */
export async function deleteRegistryCredentialAction(id: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    await deleteRegistryCredential(id, user.id);
    await recordAudit({ actorId: user.id, action: "deploy.registry.delete", targetType: "registry", targetId: id });
    return {};
}

/** The connected GitHub account (if any) and the repositories it can deploy, for the
 *  Deploy "GitHub Repository" picker. Gated on deploy.manage. */
export async function githubReposAction(): Promise<{ connected: boolean; login: string | null; repos: GithubRepo[] }> {
    await requirePermission("deploy.manage");
    const status = await getGithubStatus();
    if (!status.connected) return { connected: false, login: null, repos: [] };
    try {
        const repos = await listGithubRepos();
        return { connected: true, login: status.login, repos };
    } catch {
        return { connected: true, login: status.login, repos: [] };
    }
}
