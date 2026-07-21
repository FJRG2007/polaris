"use server";

/**
 * Deploy app server actions. Project/application management and deploys are gated
 * on deploy.manage and re-validated server-side. Creating an application resolves
 * the owner's local target lazily, so a first deploy works with no server setup.
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requirePermission } from "@/lib/session";
import { ensurePublicIp } from "@/lib/domain-service";
import { recordAudit } from "@/lib/audit-service";
import { getOrCreateLocalTarget, getOrCreateHostTarget } from "@/lib/deploy-target-service";
import { listHosts } from "@/lib/host-service";
import {
    addApplicationDomain,
    createApplication,
    createEnvironment,
    createProject,
    deleteEnvironment,
    deleteProject,
    deployApplication,
    ensureApplicationDomain,
    listDeployments,
    removeApplicationDeployment,
    removeApplicationDomain,
    restartApplication,
    setApplicationPort,
    setApplicationRunning,
    saveEnvironmentLayout,
    updateAutoDeploy,
    type DeploymentSummary
} from "@/lib/deploy-service";
import { createDatabase, deployDatabase, type DbEngine } from "@/lib/database-service";
import {
    deleteEnvVar,
    listEnvVars,
    parseDotEnv,
    setEnvVar,
    setEnvVars,
    type EnvScope,
    type EnvVarView
} from "@/lib/env-var-service";
import {
    getGithubStatus,
    inspectGithubRepo,
    listGithubRepos,
    type GithubRepo,
    type RepoInspection
} from "@/lib/github-service";
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

/**
 * Servers a service can deploy to: the local host (where Polaris runs) plus any
 * connected SSH hosts. The local option is always present and first, so a
 * single-server setup has an obvious default.
 */
export async function listDeployServersAction(): Promise<{ id: string; name: string; kind: "local" | "host" }[]> {
    const user = await requirePermission("deploy.manage");
    const hosts = await listHosts(user.id);
    return [
        { id: "local", name: "Local (this server)", kind: "local" },
        ...hosts.map((host) => ({ id: host.id, name: host.name, kind: "host" as const }))
    ];
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
    port?: number;
    serverId?: string;
}): Promise<{ error?: string; deploymentId?: string }> {
    const user = await requirePermission("deploy.manage");
    const name = input.name?.trim();
    if (!name) return { error: "An application name is required" };
    const isNixpacks = input.sourceType === "nixpacks";
    const isGit = input.sourceType === "dockerfile" || input.sourceType === "git" || isNixpacks;
    // The port the container listens on. Stored on the app so the IP:port link and
    // every domain route target it; defaults by source, user-overridable.
    const port = Number.isInteger(input.port) ? Number(input.port) : isGit ? 3000 : 80;
    let sourceType = "image";
    let sourceConfig: Record<string, unknown>;
    if (isGit) {
        const repoUrl = input.repoUrl?.trim();
        if (!repoUrl) return { error: "A git repository URL is required" };
        // "nixpacks" auto-builds from source (no Dockerfile); "dockerfile" uses one.
        sourceType = isNixpacks ? "nixpacks" : "dockerfile";
        sourceConfig = {
            repoUrl,
            branch: input.branch?.trim() || undefined,
            dockerfilePath: isNixpacks ? undefined : input.dockerfilePath?.trim() || "Dockerfile",
            // Mark GitHub-sourced repos so the build authenticates its clone with the
            // connected token (private repos), transparently for public ones too.
            provider: input.provider === "github" ? "github" : undefined,
            port
        };
    } else {
        const imageRef = input.imageRef?.trim();
        if (!imageRef) return { error: "An image reference is required (e.g. nginx:latest)" };
        sourceConfig = { imageRef, port };
    }
    try {
        // Resolve the chosen server: the local host by default, or a connected SSH
        // host adopted as a deploy target on first use.
        let target;
        if (input.serverId && input.serverId !== "local") {
            const host = (await listHosts(user.id)).find((item) => item.id === input.serverId);
            if (!host) return { error: "The selected server was not found" };
            target = await getOrCreateHostTarget(host.id, user.id, host.name);
        } else {
            target = await getOrCreateLocalTarget(user.id);
        }
        const app = await createApplication(user.id, {
            environmentId: input.environmentId,
            targetId: target.id,
            name,
            sourceType,
            sourceConfig
        });
        await recordAudit({ actorId: user.id, action: "deploy.app.create", targetType: "application", targetId: app.id });
        // Give it a free testing subdomain and kick off the first deploy right away,
        // like Railway/Dokploy. Auto-detect the server IP (Caddy's X-Server-Ip) so the
        // free sslip.io subdomain works with no setup even on a LAN.
        const requestHeaders = await headers();
        await ensurePublicIp(requestHeaders.get("x-server-ip") ?? requestHeaders.get("host"));
        const targetPort = Number.isInteger(input.port) ? Number(input.port) : isGit ? 3000 : 80;
        try {
            await addApplicationDomain(app.id, user.id, { targetPort });
        } catch {
            // No public IP / free-subdomain base configured; the user can add a domain.
        }
        let deploymentId: string | undefined;
        try {
            deploymentId = await deployApplication(app.id, user.id, user.id);
            await recordAudit({ actorId: user.id, action: "deploy.app.deploy", targetType: "application", targetId: app.id });
        } catch {
            // Surfaced on the app's next manual deploy; creation still succeeds.
        }
        revalidatePath(DEPLOY_PATH);
        return { deploymentId };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the application" };
    }
}

export async function setAutoDeployAction(input: {
    applicationId: string;
    autoDeploy: boolean;
    deployBranch?: string;
    commitFilter?: string;
    keepReleases?: boolean;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await updateAutoDeploy(input.applicationId, user.id, {
            autoDeploy: input.autoDeploy,
            deployBranch: input.deployBranch,
            commitFilter: input.commitFilter,
            keepReleases: input.keepReleases
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save settings" };
    }
}

/** Env vars for a scope (application service or shared environment); secrets masked. */
export async function listEnvVarsAction(scope: EnvScope, scopeId: string): Promise<EnvVarView[]> {
    const user = await requirePermission("deploy.manage");
    return listEnvVars(scope, scopeId, user.id);
}

export async function saveEnvVarAction(input: {
    scope: EnvScope;
    scopeId: string;
    key: string;
    value: string;
    isSecret: boolean;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await setEnvVar(input.scope, input.scopeId, user.id, { key: input.key, value: input.value, isSecret: input.isSecret });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the variable" };
    }
}

/** Import a pasted .env blob as variables (quotes/spaces/export handled). */
export async function importEnvVarsAction(input: {
    scope: EnvScope;
    scopeId: string;
    text: string;
    isSecret: boolean;
}): Promise<{ error?: string; count?: number }> {
    const user = await requirePermission("deploy.manage");
    try {
        const parsed = parseDotEnv(input.text).map((item) => ({ ...item, isSecret: input.isSecret }));
        if (parsed.length === 0) return { error: "No KEY=value lines found" };
        const count = await setEnvVars(input.scope, input.scopeId, user.id, parsed);
        revalidatePath(DEPLOY_PATH);
        return { count };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not import variables" };
    }
}

export async function deleteEnvVarAction(id: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    await deleteEnvVar(id, user.id);
    revalidatePath(DEPLOY_PATH);
    return {};
}

/** An application's deployment history. */
export async function listDeploymentsAction(applicationId: string): Promise<DeploymentSummary[]> {
    const user = await requirePermission("deploy.manage");
    return listDeployments(applicationId, user.id);
}

export async function deployApplicationAction(applicationId: string): Promise<{ error?: string; deploymentId?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        // Backfill a free subdomain for apps that never got one (e.g. created before
        // a public IP was known), so redeploying is enough to make it reachable.
        const requestHeaders = await headers();
        await ensurePublicIp(requestHeaders.get("x-server-ip") ?? requestHeaders.get("host"));
        try {
            await ensureApplicationDomain(applicationId, user.id);
        } catch {
            // No public IP / free-subdomain base; the app can still deploy without one.
        }
        const deploymentId = await deployApplication(applicationId, user.id, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.app.deploy", targetType: "application", targetId: applicationId });
        revalidatePath(DEPLOY_PATH);
        return { deploymentId };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not start the deployment" };
    }
}

export async function setAppPortAction(applicationId: string, port: number): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await setApplicationPort(applicationId, user.id, port);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the port" };
    }
}

export async function restartApplicationAction(applicationId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await restartApplication(applicationId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.app.restart", targetType: "application", targetId: applicationId });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not restart the deployment" };
    }
}

export async function setApplicationRunningAction(applicationId: string, running: boolean): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await setApplicationRunning(applicationId, user.id, running);
        await recordAudit({
            actorId: user.id,
            action: running ? "deploy.app.start" : "deploy.app.stop",
            targetType: "application",
            targetId: applicationId
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the deployment" };
    }
}

export async function removeApplicationDeploymentAction(applicationId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await removeApplicationDeployment(applicationId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.app.remove", targetType: "application", targetId: applicationId });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove the deployment" };
    }
}

export async function addDomainAction(input: {
    applicationId: string;
    hostname?: string;
    targetPort: number;
    cert?: "internal" | "le" | "none";
}): Promise<{ error?: string; hostname?: string }> {
    const user = await requirePermission("deploy.manage");
    const port = Number(input.targetPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "A valid target port is required" };
    const requestHeaders = await headers();
    await ensurePublicIp(requestHeaders.get("x-server-ip") ?? requestHeaders.get("host"));
    try {
        const hostname = await addApplicationDomain(input.applicationId, user.id, {
            hostname: input.hostname,
            targetPort: port,
            cert: input.cert
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
    serverId?: string;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const name = input.name?.trim();
    if (!name) return { error: "A database name is required" };
    if (!DB_ENGINES.includes(input.engine as DbEngine)) return { error: "Unsupported database engine" };
    try {
        let target;
        if (input.serverId && input.serverId !== "local") {
            const host = (await listHosts(user.id)).find((item) => item.id === input.serverId);
            if (!host) return { error: "The selected server was not found" };
            target = await getOrCreateHostTarget(host.id, user.id, host.name);
        } else {
            target = await getOrCreateLocalTarget(user.id);
        }
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

/** Inspect a repo to auto-configure a deploy (find a Dockerfile, detect the
 *  framework). Gated on deploy.manage. */
export async function inspectRepoAction(input: {
    owner: string;
    repo: string;
    branch: string;
}): Promise<RepoInspection> {
    await requirePermission("deploy.manage");
    try {
        return await inspectGithubRepo(input.owner, input.repo, input.branch);
    } catch {
        return { dockerfile: null, framework: null, builder: "nixpacks" };
    }
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
