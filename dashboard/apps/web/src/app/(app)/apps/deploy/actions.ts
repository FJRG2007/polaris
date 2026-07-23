"use server";

/**
 * Deploy app server actions. Project/application management and deploys are gated
 * on deploy.manage and re-validated server-side. Creating an application resolves
 * the owner's local target lazily, so a first deploy works with no server setup.
 */

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requirePermission } from "@/lib/session";
import { ensurePublicIp, getDomainConfig } from "@/lib/domain-service";
import { getNetworkStatus } from "@/lib/network-service";
import { recordAudit } from "@/lib/audit-service";
import { getOrCreateLocalTarget, getOrCreateHostTarget } from "@/lib/deploy-target-service";
import { listHosts } from "@/lib/host-service";
import {
    addApplicationDomain,
    createApplication,
    createEnvironment,
    createProject,
    deleteApplication,
    deleteEnvironment,
    deleteProject,
    deployApplication,
    duplicateApplication,
    ensureApplicationDomain,
    listDeployments,
    redeployForEnvScope,
    removeApplicationDeployment,
    removeApplicationDomain,
    restartApplication,
    setApplicationDomainEnabled,
    setApplicationPort,
    setApplicationServer,
    setApplicationRunning,
    saveEnvironmentLayout,
    syncAppRoutes,
    updateAutoDeploy,
    type DeploymentSummary
} from "@/lib/deploy-service";
import { getWafRule, setWafRule, type WafRuleView } from "@/lib/waf-service";
import type { WafScopeType } from "@polaris/core";
import { createDatabase, deployDatabase, type DbEngine } from "@/lib/database-service";
import { listVolumes, createVolume, updateVolume, deleteVolume, type VolumeView } from "@/lib/deploy-volume-service";
import { listConnections, getDriver } from "@/lib/storage-service";
import {
    canHostMount,
    normalizeRelPath,
    type DeployVolumeInput,
    type DeployVolumeUpdateInput,
    type StorageProviderKind
} from "@polaris/core";
import {
    getQuickTunnelStatus,
    startQuickTunnel,
    stopQuickTunnel,
    type QuickTunnelStatus
} from "@/lib/deploy/quick-tunnel-service";
import {
    getNgrokTunnelStatus,
    startNgrokTunnel,
    stopNgrokTunnel,
    type NgrokTunnelStatus
} from "@/lib/deploy/ngrok-tunnel-service";
import {
    getNamedTunnelStatus,
    provisionNamedTunnel,
    setNamedTunnelEnabled,
    startNamedTunnel,
    stopNamedTunnel,
    type NamedTunnelStatus
} from "@/lib/deploy/named-tunnel-service";
import {
    getCloudflareAccountStatus,
    type CloudflareAccountStatus
} from "@/lib/integrations/cloudflare-account-service";
import {
    deleteEnvVar,
    listEnvVars,
    parseDotEnv,
    revealEnvVar,
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
    // The container port is stored only when the user pins it, so an image deploy
    // can otherwise default it to the image's own exposed port (see buildAppPlan) -
    // storing a guess here would suppress that detection.
    const port = Number.isInteger(input.port) ? Number(input.port) : undefined;
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
            ...(port !== undefined ? { port } : {})
        };
    } else {
        const imageRef = input.imageRef?.trim();
        if (!imageRef) return { error: "An image reference is required (e.g. nginx:latest)" };
        sourceConfig = { imageRef, ...(port !== undefined ? { port } : {}) };
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
        // Git sources track their branch and auto-deploy on new commits by default,
        // Vercel-style (a poller picks them up even without a public webhook).
        const branch = input.branch?.trim() || undefined;
        const app = await createApplication(user.id, {
            environmentId: input.environmentId,
            targetId: target.id,
            name,
            sourceType,
            sourceConfig,
            autoDeploy: isGit && Boolean(branch),
            deployBranch: isGit ? (branch ?? null) : null
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
        void redeployForEnvScope(input.scope, input.scopeId, user.id).catch(() => undefined);
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
        void redeployForEnvScope(input.scope, input.scopeId, user.id).catch(() => undefined);
        revalidatePath(DEPLOY_PATH);
        return { count };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not import variables" };
    }
}

export async function revealEnvVarAction(id: string): Promise<{ value?: string | null; error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        return { value: await revealEnvVar(id, user.id) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not reveal the variable" };
    }
}

export async function deleteEnvVarAction(id: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const scope = await deleteEnvVar(id, user.id);
    if (scope) void redeployForEnvScope(scope.scope, scope.scopeId, user.id).catch(() => undefined);
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

export async function setAppServerAction(applicationId: string, serverId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await setApplicationServer(applicationId, user.id, serverId);
        await recordAudit({ actorId: user.id, action: "deploy.app.move", targetType: "application", targetId: applicationId, metadata: { serverId } });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not change the server" };
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

export async function deleteApplicationAction(applicationId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deleteApplication(applicationId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.app.delete", targetType: "application", targetId: applicationId });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete the service" };
    }
}

export async function duplicateApplicationAction(applicationId: string): Promise<{ error?: string; id?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const id = await duplicateApplication(applicationId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.app.duplicate", targetType: "application", targetId: applicationId });
        revalidatePath(DEPLOY_PATH);
        return { id };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not duplicate the service" };
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

/**
 * The "Free subdomain (auto)" flow, made always-reachable: create the auto domain
 * (a `<app>.plr.local` LAN name on a NATed box, or a public sslip.io name on a
 * reachable one), and when the box is behind NAT also bring up a free Cloudflare
 * quick tunnel so there is a working public URL - until the operator connects a
 * Cloudflare account or a custom domain for a stable one. The tunnel is best-effort:
 * the domain is still created if it cannot start.
 */
export async function autoExposeAction(input: {
    applicationId: string;
    targetPort: number;
}): Promise<{ error?: string; hostname?: string; lanOnly?: boolean; tunnelUrl?: string | null; tunnelError?: string }> {
    const user = await requirePermission("deploy.manage");
    const port = Number(input.targetPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "A valid target port is required" };
    const requestHeaders = await headers();
    await ensurePublicIp(requestHeaders.get("x-server-ip") ?? requestHeaders.get("host"));
    try {
        const hostname = await addApplicationDomain(input.applicationId, user.id, { targetPort: port });
        await recordAudit({ actorId: user.id, action: "deploy.domain.add", targetType: "application", targetId: input.applicationId });
        const status = await getNetworkStatus();
        if (status.autoSubdomainsPublic) {
            revalidatePath(DEPLOY_PATH);
            return { hostname, lanOnly: false };
        }
        // Behind NAT: the LAN name only resolves on the local network, so start a free
        // Cloudflare quick tunnel for public reachability.
        try {
            const tunnel = await startQuickTunnel(input.applicationId, user.id);
            revalidatePath(DEPLOY_PATH);
            return { hostname, lanOnly: true, tunnelUrl: tunnel.url };
        } catch (caught) {
            revalidatePath(DEPLOY_PATH);
            return { hostname, lanOnly: true, tunnelError: caught instanceof Error ? caught.message : "Could not start a public tunnel" };
        }
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the subdomain" };
    }
}

/** The configured DuckDNS subdomain, so the domain form can ask for only the label
 *  (the `.<sub>.duckdns.org` base is already known) instead of a full hostname. */
export async function duckdnsSubdomainAction(): Promise<{ subdomain: string | null }> {
    await requirePermission("deploy.manage");
    const config = await getDomainConfig();
    return { subdomain: config.duckdnsSubdomain || null };
}

export async function removeDomainAction(domainId: string): Promise<void> {
    const user = await requirePermission("deploy.manage");
    await removeApplicationDomain(domainId, user.id);
    revalidatePath(DEPLOY_PATH);
}

/** Turn a domain on or off without deleting it (drops or restores its route). */
export async function setDomainEnabledAction(domainId: string, enabled: boolean): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await setApplicationDomainEnabled(domainId, user.id, enabled);
        await recordAudit({ actorId: user.id, action: "deploy.domain.toggle", targetType: "domain", targetId: domainId });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the domain" };
    }
}

/** Current public URL / state of an app's Cloudflare Quick Tunnel (no account). */
export async function quickTunnelStatusAction(applicationId: string): Promise<QuickTunnelStatus> {
    const user = await requirePermission("deploy.manage");
    try {
        return await getQuickTunnelStatus(applicationId, user.id);
    } catch {
        return { running: false, url: null };
    }
}

/** Start (or refresh) an app's Cloudflare Quick Tunnel and return its public URL. */
export async function startQuickTunnelAction(applicationId: string): Promise<{ error?: string; url?: string | null }> {
    const user = await requirePermission("deploy.manage");
    try {
        const status = await startQuickTunnel(applicationId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.tunnel.start", targetType: "application", targetId: applicationId });
        return { url: status.url };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not start the tunnel" };
    }
}

/** Stop an app's Cloudflare Quick Tunnel. */
export async function stopQuickTunnelAction(applicationId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await stopQuickTunnel(applicationId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.tunnel.stop", targetType: "application", targetId: applicationId });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not stop the tunnel" };
    }
}

export async function ngrokTunnelStatusAction(applicationId: string): Promise<NgrokTunnelStatus> {
    const user = await requirePermission("deploy.manage");
    try {
        return await getNgrokTunnelStatus(applicationId, user.id);
    } catch {
        return { running: false, url: null, configured: false };
    }
}

/** Start (or refresh) an app's ngrok tunnel and return its public URL. */
export async function startNgrokTunnelAction(applicationId: string): Promise<{ error?: string; url?: string | null }> {
    const user = await requirePermission("deploy.manage");
    try {
        const status = await startNgrokTunnel(applicationId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.tunnel.start", targetType: "application", targetId: applicationId });
        return { url: status.url };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not start the tunnel" };
    }
}

/** Stop an app's ngrok tunnel. */
export async function stopNgrokTunnelAction(applicationId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await stopNgrokTunnel(applicationId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.tunnel.stop", targetType: "application", targetId: applicationId });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not stop the tunnel" };
    }
}

/** State of an app's Cloudflare named tunnel (stable custom hostname). */
export async function namedTunnelStatusAction(applicationId: string): Promise<NamedTunnelStatus> {
    const user = await requirePermission("deploy.manage");
    try {
        return await getNamedTunnelStatus(applicationId, user.id);
    } catch {
        return { running: false, hostname: null, configured: false, managed: false, enabled: true };
    }
}

/** Enable or disable an app's named tunnel while keeping its hostname reserved. */
export async function setNamedTunnelEnabledAction(input: {
    applicationId: string;
    enabled: boolean;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await setNamedTunnelEnabled(input.applicationId, user.id, input.enabled);
        await recordAudit({
            actorId: user.id,
            action: input.enabled ? "deploy.named-tunnel.start" : "deploy.named-tunnel.stop",
            targetType: "application",
            targetId: input.applicationId
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the tunnel" };
    }
}

/** Whether a Cloudflare API token is connected, so the panel can offer the automatic
 *  (pick-a-hostname) path instead of the manual connector-token flow. */
export async function cloudflareAccountStatusAction(): Promise<CloudflareAccountStatus> {
    await requirePermission("deploy.manage");
    try {
        return await getCloudflareAccountStatus();
    } catch {
        return { connected: false, accountId: null, accountName: null };
    }
}

/** Automatically create the tunnel + DNS for a hostname using the connected Cloudflare
 *  token; the operator only supplies the hostname. */
export async function provisionNamedTunnelAction(input: {
    applicationId: string;
    hostname: string;
}): Promise<{ error?: string; hostname?: string | null }> {
    const user = await requirePermission("deploy.manage");
    try {
        const status = await provisionNamedTunnel(input.applicationId, user.id, { hostname: input.hostname });
        await recordAudit({
            actorId: user.id,
            action: "deploy.named-tunnel.provision",
            targetType: "application",
            targetId: input.applicationId
        });
        return { hostname: status.hostname };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not set up the tunnel" };
    }
}

/** Save the connector token + hostname and start the named-tunnel sidecar. */
export async function startNamedTunnelAction(input: {
    applicationId: string;
    token: string;
    hostname: string;
}): Promise<{ error?: string; hostname?: string | null }> {
    const user = await requirePermission("deploy.manage");
    try {
        const status = await startNamedTunnel(input.applicationId, user.id, { token: input.token, hostname: input.hostname });
        await recordAudit({ actorId: user.id, action: "deploy.named-tunnel.start", targetType: "application", targetId: input.applicationId });
        return { hostname: status.hostname };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not start the tunnel" };
    }
}

/** Stop an app's named tunnel and forget its token. */
export async function stopNamedTunnelAction(applicationId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await stopNamedTunnel(applicationId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.named-tunnel.stop", targetType: "application", targetId: applicationId });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not stop the tunnel" };
    }
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

export async function listVolumesAction(applicationId: string): Promise<VolumeView[]> {
    const user = await requirePermission("deploy.manage");
    return listVolumes(applicationId, user.id);
}

/** Host-mountable storage connections that can back a NAS volume, for the picker.
 *  Only kinds Polaris kernel-mounts at `/mnt/polaris/<id>` (nfs, smb, unifi-unas)
 *  expose a host path a bind can target. */
export async function listNasConnectionsAction(): Promise<{ id: string; name: string; active: boolean }[]> {
    const user = await requirePermission("deploy.manage");
    const rows = await listConnections(user.id);
    return rows
        .filter((row) => canHostMount(row.kind as StorageProviderKind))
        .map((row) => ({ id: row.id, name: row.name, active: row.status === "active" }));
}

/** List sub-folders of a path on a host-mountable connection, for the volume
 *  folder picker. Ownership is enforced by getDriver (owner-scoped). */
export async function listNasFoldersAction(
    connectionId: string,
    path: string
): Promise<{ folders: string[]; error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const driver = await getDriver(connectionId, user.id);
        const result = await driver.list(normalizeRelPath(path));
        const folders = result.entries.filter((entry) => entry.kind === "dir").map((entry) => entry.name).sort();
        return { folders };
    } catch (caught) {
        return { folders: [], error: caught instanceof Error ? caught.message : "Could not list folders" };
    }
}

export async function getWafRuleAction(input: {
    scopeType: WafScopeType;
    scopeId: string;
}): Promise<{ rule?: WafRuleView; error?: string }> {
    const user = await requirePermission("deploy.manage");
    // The global rule is instance-wide and applies to every owner's services, so it
    // is an operator control - deploy.manage alone (which the default member holds)
    // must not read or write it, only system.manage / admin.
    if (input.scopeType === "global") await requirePermission("system.manage");
    try {
        return { rule: await getWafRule(user.id, input.scopeType, input.scopeId) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not load the firewall rule" };
    }
}

export async function setWafRuleAction(input: {
    scopeType: WafScopeType;
    scopeId: string;
    ipAllowlist: string[];
    ipDenylist: string[];
    requireLogin: boolean;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    if (input.scopeType === "global") await requirePermission("system.manage");
    try {
        const { scopeType, scopeId, ...rule } = input;
        await setWafRule(user.id, scopeType, scopeId, rule);
        await recordAudit({ actorId: user.id, action: "deploy.waf.set", targetType: scopeType, targetId: scopeId || "global" });
        // The local edge applies instantly via the file provider; remote-server apps
        // pick up the change on their next deploy (their rules ride on container labels).
        await syncAppRoutes().catch(() => undefined);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the firewall rule" };
    }
}

export async function createVolumeAction(input: DeployVolumeInput): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await createVolume(user.id, input);
        await recordAudit({ actorId: user.id, action: "deploy.volume.add", targetType: "application", targetId: input.applicationId });
        // Apply on the running service (a volume takes effect on container recreate),
        // only if it is currently deployed - same Vercel-style flow as env vars.
        void redeployForEnvScope("application", input.applicationId, user.id).catch(() => undefined);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not add the volume" };
    }
}

export async function updateVolumeAction(
    input: DeployVolumeUpdateInput & { applicationId: string }
): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const { applicationId, ...patch } = input;
        await updateVolume(user.id, patch);
        await recordAudit({ actorId: user.id, action: "deploy.volume.update", targetType: "application", targetId: applicationId });
        void redeployForEnvScope("application", applicationId, user.id).catch(() => undefined);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the volume" };
    }
}

export async function deleteVolumeAction(input: { id: string; applicationId: string }): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deleteVolume(input.id, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.volume.remove", targetType: "application", targetId: input.applicationId });
        void redeployForEnvScope("application", input.applicationId, user.id).catch(() => undefined);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove the volume" };
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
