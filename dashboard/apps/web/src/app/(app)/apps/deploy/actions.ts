"use server";

/**
 * Deploy app server actions. Project/application management and deploys are gated
 * on deploy.manage and re-validated server-side. Creating an application resolves
 * the owner's local target lazily, so a first deploy works with no server setup.
 */

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { listHosts } from "@/lib/host-service";
import { normalizeRoot } from "@polaris/deploy";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import * as activity from "@/lib/activity/activity";
import * as deployService from "@/lib/deploy-service";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import type { DomainOwner } from "@/lib/owner-domains";
import { getNetworkStatus } from "@/lib/network-service";
import { githubTokenForUser } from "@/lib/github-access";
import { requireOrgPermission } from "@/lib/orgs/org-service";
import { setDomainCertificate } from "@/lib/domain-cert-service";
import { listConnections, getDriver } from "@/lib/storage-service";
import { getFlagsForEnvironment } from "@/lib/deploy-project-service";
import { ensurePublicIp, getDomainConfig } from "@/lib/domain-service";
import { pickerRepoList, pickerRepoSearch } from "@/lib/github-repo-picker";
import { provisionHostnameDns, type HostnameDnsResult } from "@/lib/domain-dns";
import { getDomainZones, listDeployZones, type DeployZoneOption } from "@/lib/domain-zones";
import { getOrCreateLocalTarget, getOrCreateHostTarget } from "@/lib/deploy-target-service";
import { inspectGithubRepo, type GithubRepo, type RepoInspection } from "@/lib/github-service";
import { listVolumes, createVolume, updateVolume, deleteVolume, type VolumeView } from "@/lib/deploy-volume-service";
import {
    getCloudflareAccountStatus,
    type CloudflareAccountStatus
} from "@/lib/integrations/cloudflare-account-service";
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
    deleteRegistryCredential,
    listRegistryCredentials,
    upsertRegistryCredential,
    type RegistryCredentialView
} from "@/lib/registry-credential-service";
import {
    createDatabase,
    databaseConnection,
    deployDatabase,
    listDatabaseInstances,
    type DatabaseConnection,
    type DbEngine
} from "@/lib/database-service";
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
    getNamedTunnelStatus,
    provisionNamedTunnel,
    setNamedTunnelEnabled,
    startNamedTunnel,
    stopNamedTunnel,
    type NamedTunnelStatus
} from "@/lib/deploy/named-tunnel-service";
import {
    canHostMount,
    databaseCreateSchema,
    DB_ENGINES,
    normalizeRelPath,
    type DatabaseCreateInput,
    type DeployVolumeInput,
    type DeployVolumeUpdateInput,
    type StorageProviderKind
} from "@polaris/core";

const DEPLOY_PATH = "/apps/deploy";

/**
 * Record something that happened to a service, in both places it belongs.
 *
 * The audit log and the activity feed look like the same row and are not. The
 * audit log answers "who did this, from what address, on which session", is read
 * by administrators and by the firewall, and is kept and indexed for that. The
 * activity feed answers "what happened to this service", is read by whoever owns
 * it, and carries the before and after of the change. One event, two readers,
 * different retention - so both are written, and they are written here together
 * rather than at thirty call sites where one of them would be forgotten.
 */
async function recordServiceEvent(
    actorId: string,
    applicationId: string,
    audit: string,
    action: string,
    values?: { from?: string | null; to?: string | null }
): Promise<void> {
    await recordAudit({ actorId, action: audit, targetType: "application", targetId: applicationId });
    await activity.record({
        subjectType: "service",
        subjectId: applicationId,
        userId: actorId,
        action,
        fromValue: values?.from ?? null,
        toValue: values?.to ?? null
    });
}

export async function createProjectAction(input: { name: string }): Promise<{ error?: string; id?: string }> {
    const user = await requirePermission("deploy.manage");
    const name = input.name?.trim();
    if (!name) return { error: "A project name is required" };
    try {
        // The project lands on whichever shelf is open. Working from an
        // organization takes being allowed to run its services - being on its
        // roster is not enough to put something on the group's shelf.
        const orgId = await scopeOrgIdFor(user.id);
        if (orgId) await requireOrgPermission({ id: user.id, isAdmin: user.isAdmin }, orgId, "deploy.manage");

        const project = await deployService.createProject(user.id, name, orgId);
        await recordAudit({
            actorId: user.id,
            orgId: orgId ?? undefined,
            action: "deploy.project.create",
            targetType: "project",
            targetId: project.id
        });
        revalidatePath(DEPLOY_PATH);
        return { id: project.id };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the project" };
    }
}

export async function deleteProjectAction(projectId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        // Only the owner may delete a project. Being an admin *on* one is enough to
        // change everything inside it, and deliberately not enough to remove the
        // thing itself.
        await deployService.deleteProject(projectId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.project.delete", targetType: "project", targetId: projectId });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete the project" };
    }
}

export async function createEnvironmentAction(input: { projectId: string; name: string }): Promise<{ error?: string; id?: string }> {
    const user = await requirePermission("deploy.manage");
    const name = input.name?.trim();
    if (!name) return { error: "An environment name is required" };
    try {
        const environment = await deployService.createEnvironment(input.projectId, user.id, name);
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
        await deployService.saveEnvironmentLayout(input.environmentId, user.id, input.layout);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the layout" };
    }
}

export async function deleteEnvironmentAction(input: { environmentId: string; projectId: string }): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deployService.deleteEnvironment(input.environmentId, user.id);
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
    rootDirectory?: string;
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
            // The service's own directory in a repository that holds several. Normalized
            // on the way in so what is stored is already confined to the build context.
            rootDirectory: normalizeRoot(input.rootDirectory),
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
        // Vercel-style (a poller picks them up even without a public webhook) -
        // unless the project has turned that default off in its flags.
        const flags = await getFlagsForEnvironment(input.environmentId);
        const branch = input.branch?.trim() || undefined;
        const app = await deployService.createApplication(user.id, {
            environmentId: input.environmentId,
            targetId: target.id,
            name,
            sourceType,
            sourceConfig,
            autoDeploy: flags.autoDeployNewServices && isGit && Boolean(branch),
            deployBranch: isGit ? (branch ?? null) : null,
            keepReleases: flags.keepReleasesByDefault
        });
        await recordAudit({ actorId: user.id, action: "deploy.app.create", targetType: "application", targetId: app.id });
        // Give it a free testing subdomain and kick off the first deploy right away,
        // like Railway/Dokploy. Auto-detect the server IP (Caddy's X-Server-Ip) so the
        // free sslip.io subdomain works with no setup even on a LAN.
        const requestHeaders = await headers();
        await ensurePublicIp(requestHeaders.get("x-server-ip") ?? requestHeaders.get("host"));
        const targetPort = Number.isInteger(input.port) ? Number(input.port) : isGit ? 3000 : 80;
        if (flags.autoSubdomain) {
            try {
                await deployService.addApplicationDomain(app.id, user.id, { targetPort });
            } catch {
                // No public IP / free-subdomain base configured; the user can add a domain.
            }
        }
        let deploymentId: string | undefined;
        try {
            deploymentId = await deployService.deployApplication(app.id, user.id, user.id);
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
    watchPaths?: string;
    keepReleases?: boolean;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deployService.updateAutoDeploy(input.applicationId, user.id, {
            autoDeploy: input.autoDeploy,
            deployBranch: input.deployBranch,
            commitFilter: input.commitFilter,
            watchPaths: input.watchPaths,
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
        if (input.scope === "application") {
            await activity.record({
                subjectType: "service",
                subjectId: input.scopeId,
                userId: user.id,
                action: "variable",
                toValue: input.key
            });
        }
        void deployService.redeployForEnvScope(input.scope, input.scopeId, user.id).catch(() => undefined);
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
        if (input.scope === "application") {
            await activity.record({
                subjectType: "service",
                subjectId: input.scopeId,
                userId: user.id,
                action: "variables-imported",
                toValue: String(count)
            });
        }
        void deployService.redeployForEnvScope(input.scope, input.scopeId, user.id).catch(() => undefined);
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
    if (scope) void deployService.redeployForEnvScope(scope.scope, scope.scopeId, user.id).catch(() => undefined);
    if (scope?.scope === "application") {
        await activity.record({
            subjectType: "service",
            subjectId: scope.scopeId,
            userId: user.id,
            action: "variable-removed"
        });
    }
    revalidatePath(DEPLOY_PATH);
    return {};
}

/** An application's deployment history. */
export async function listDeploymentsAction(applicationId: string): Promise<deployService.DeploymentSummary[]> {
    const user = await requirePermission("deploy.manage");
    return deployService.listDeployments(applicationId, user.id);
}

/** What has happened to this service, releases aside. */
export async function serviceHistoryAction(applicationId: string): Promise<activity.ActivityLine[]> {
    const user = await requirePermission("deploy.manage");
    try {
        return await deployService.serviceHistory(applicationId, user.id);
    } catch {
        return [];
    }
}

export async function deployApplicationAction(applicationId: string): Promise<{ error?: string; deploymentId?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        // Backfill a free subdomain for apps that never got one (e.g. created before
        // a public IP was known), so redeploying is enough to make it reachable.
        const requestHeaders = await headers();
        await ensurePublicIp(requestHeaders.get("x-server-ip") ?? requestHeaders.get("host"));
        try {
            await deployService.ensureApplicationDomain(applicationId, user.id);
        } catch {
            // No public IP / free-subdomain base; the app can still deploy without one.
        }
        const deploymentId = await deployService.deployApplication(applicationId, user.id, user.id);
        await recordServiceEvent(user.id, applicationId, "deploy.app.deploy", "deployed");
        revalidatePath(DEPLOY_PATH);
        return { deploymentId };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not start the deployment" };
    }
}

/** Stop a deploy that is still queued or building. Also the way out of one whose
 *  runner died with an earlier process - see `cancelDeployment`. */
export async function cancelDeploymentAction(deploymentId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deployService.cancelDeployment(deploymentId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.app.cancel", targetType: "deployment", targetId: deploymentId });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not stop the deployment" };
    }
}

export async function setAppPortAction(applicationId: string, port: number): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deployService.setApplicationPort(applicationId, user.id, port);
        await activity.record({
            subjectType: "service",
            subjectId: applicationId,
            userId: user.id,
            action: "port",
            toValue: String(port)
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the port" };
    }
}

export async function setAppSourcePathsAction(input: {
    applicationId: string;
    rootDirectory?: string;
    dockerfilePath?: string;
    installCommand?: string;
    buildCommand?: string;
    startCommand?: string;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deployService.setApplicationSourcePaths(input.applicationId, user.id, {
            rootDirectory: input.rootDirectory,
            dockerfilePath: input.dockerfilePath,
            installCommand: input.installCommand,
            buildCommand: input.buildCommand,
            startCommand: input.startCommand
        });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the source paths" };
    }
}

export async function setAppServerAction(applicationId: string, serverId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deployService.setApplicationServer(applicationId, user.id, serverId);
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
        await deployService.restartApplication(applicationId, user.id);
        await recordServiceEvent(user.id, applicationId, "deploy.app.restart", "restarted");
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not restart the deployment" };
    }
}

export async function setApplicationRunningAction(applicationId: string, running: boolean): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deployService.setApplicationRunning(applicationId, user.id, running);
        await recordServiceEvent(
            user.id,
            applicationId,
            running ? "deploy.app.start" : "deploy.app.stop",
            running ? "started" : "stopped"
        );
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the deployment" };
    }
}

export async function removeApplicationDeploymentAction(applicationId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deployService.removeApplicationDeployment(applicationId, user.id);
        await recordServiceEvent(user.id, applicationId, "deploy.app.remove", "torn down");
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove the deployment" };
    }
}

export async function deleteApplicationAction(applicationId: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deployService.deleteApplication(applicationId, user.id);
        await recordAudit({ actorId: user.id, action: "deploy.app.delete", targetType: "application", targetId: applicationId });
        // The audit row stays - it is the record that somebody deleted this - but
        // the feed was about a service that no longer exists, so it goes with it.
        await activity.forget("service", applicationId);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete the service" };
    }
}

export async function duplicateApplicationAction(applicationId: string): Promise<{ error?: string; id?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const id = await deployService.duplicateApplication(applicationId, user.id);
        await recordServiceEvent(user.id, applicationId, "deploy.app.duplicate", "duplicated");
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
    zoneLabel?: string;
    random?: boolean;
    subdomain?: string;
}): Promise<{ error?: string; hostname?: string; dns?: HostnameDnsResult }> {
    const user = await requirePermission("deploy.manage");
    const port = Number(input.targetPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "A valid target port is required" };
    const requestHeaders = await headers();
    await ensurePublicIp(requestHeaders.get("x-server-ip") ?? requestHeaders.get("host"));
    try {
        const hostname = await deployService.addApplicationDomain(input.applicationId, user.id, {
            hostname: input.hostname,
            targetPort: port,
            cert: input.cert,
            zoneLabel: input.zoneLabel,
            random: input.random,
            subdomain: input.subdomain
        });
        await recordAudit({ actorId: user.id, action: "deploy.domain.add", targetType: "application", targetId: input.applicationId });
        revalidatePath(DEPLOY_PATH);
        // A hostname the operator typed is the only one whose DNS is not already
        // handled: a zone name rides its wildcard, and a LAN or proxied name is not
        // Polaris's to point. Best-effort, and reported rather than thrown - the
        // domain is added either way, and missing DNS only delays the certificate.
        const dns =
            input.hostname && (input.cert ?? "le") === "le" ? await provisionHostnameDns(hostname) : undefined;
        return { hostname, dns };
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
        const hostname = await deployService.addApplicationDomain(input.applicationId, user.id, { targetPort: port });
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

/**
 * What the exposure picker offers: the deploy zones a service can get a hostname in -
 * empty when no domain is configured, so the form falls back to the free-subdomain
 * path - plus the base domain on its own. The base domain comes back even when no zone
 * is proven, because it is what the custom-domain field suggests a name on, and that
 * path writes the record for the exact hostname rather than riding a wildcard.
 */
export async function deployZonesAction(): Promise<{
    baseDomain: string;
    zones: DeployZoneOption[];
}> {
    const user = await requirePermission("deploy.manage");
    // The shelf that is open decides whose brought domains are offered: an
    // organization's names belong to its projects, and somebody's own names must
    // not be on the list while they are deploying for a client.
    const orgId = await scopeOrgIdFor(user.id);
    const owner: DomainOwner = orgId ? { kind: "org", id: orgId } : { kind: "user", id: user.id };
    const [config, zones] = await Promise.all([getDomainZones(), listDeployZones(owner)]);
    return { baseDomain: config.baseDomain, zones };
}

const zoneSubdomainSchema = z.object({
    applicationId: z.string().uuid(),
    zoneLabel: z.string().max(63).optional(),
    subdomain: z.string().max(120).optional()
});

/**
 * The subdomain a zone hostname would take, and whether it is still free. Called as
 * the operator types, so it answers with what to show rather than throwing: an
 * unusable name and a taken one are both a normal state of the field. A zone that
 * cannot mint at all reports the reason, which is what the picker already handles.
 */
export async function zoneSubdomainAction(input: {
    applicationId: string;
    zoneLabel?: string;
    subdomain?: string;
}): Promise<{ subdomain: string; hostname: string; available: boolean; invalid?: boolean; error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = zoneSubdomainSchema.safeParse(input);
    if (!parsed.success) return { subdomain: "", hostname: "", available: false, error: "Invalid request" };
    try {
        const result = await deployService.checkZoneSubdomain(parsed.data.applicationId, user.id, {
            zoneLabel: parsed.data.zoneLabel,
            subdomain: parsed.data.subdomain
        });
        if (typeof result === "string") {
            return { subdomain: "", hostname: "", available: false, error: result };
        }
        return result;
    } catch {
        return { subdomain: "", hostname: "", available: false, error: "Could not check that subdomain" };
    }
}

/**
 * Put an operator's own certificate on a domain, or clear it with a null.
 *
 * Refuses one that would not be served - wrong name, expired, key that does not match
 * - rather than storing it and silently falling back to the managed certificate, which
 * would leave the panel claiming a certificate is in use that is not.
 */
export async function setDomainCertificateAction(
    domainId: string,
    input: { certPem: string; keyPem: string } | null
): Promise<{ error?: string; warning?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const result = await setDomainCertificate(domainId, user.id, input);
        if (result.error) return result;
        await recordAudit({
            actorId: user.id,
            action: input ? "deploy.domain.cert.set" : "deploy.domain.cert.clear",
            targetType: "domain",
            targetId: domainId
        });
        revalidatePath(DEPLOY_PATH);
        return result;
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the certificate" };
    }
}

/** The current probe result for a service's domains, so the panel can settle its own
 *  status dots rather than leaving them grey until the page is reloaded. */
export async function domainHealthAction(
    applicationId: string
): Promise<{ id: string; healthStatus: string | null; healthCode: number | null; healthDetail: string | null }[]> {
    const user = await requirePermission("deploy.read");
    return deployService.applicationDomainHealth(applicationId, user.id);
}

export async function removeDomainAction(domainId: string): Promise<void> {
    const user = await requirePermission("deploy.manage");
    await deployService.removeApplicationDomain(domainId, user.id);
    revalidatePath(DEPLOY_PATH);
}

/** Turn a domain on or off without deleting it (drops or restores its route). */
export async function setDomainEnabledAction(domainId: string, enabled: boolean): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await deployService.setApplicationDomainEnabled(domainId, user.id, enabled);
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
        return { running: false, url: null, reachable: false };
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
        return { connected: false, dnsReady: false, slots: { dns: false, tunnel: false }, accountId: null, accountName: null };
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

export async function createDatabaseAction(input: DatabaseCreateInput): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = databaseCreateSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That database configuration is not valid" };
    const { serverId, ...settings } = parsed.data;
    try {
        let target;
        if (serverId && serverId !== "local") {
            const host = (await listHosts(user.id)).find((item) => item.id === serverId);
            if (!host) return { error: "The selected server was not found" };
            target = await getOrCreateHostTarget(host.id, user.id, host.name);
        } else {
            target = await getOrCreateLocalTarget(user.id);
        }
        const database = await createDatabase(user.id, { ...settings, targetId: target.id });
        await recordAudit({ actorId: user.id, action: "deploy.db.create", targetType: "database", targetId: database.id });
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the database" };
    }
}

/** Instances in this environment a new database of `engine` could be created
 *  inside, so the form can offer sharing one instead of starting another. */
export async function listDatabaseInstancesAction(
    environmentId: string,
    engine: string
): Promise<{ id: string; name: string; version: string; status: string; databases: number }[]> {
    const user = await requirePermission("deploy.read");
    if (!DB_ENGINES.includes(engine as DbEngine)) return [];
    return listDatabaseInstances(environmentId, engine as DbEngine, user.id);
}

/** A database's address and credentials. Gated on deploy.manage rather than
 *  deploy.read: this hands out the password, not a description of it. */
export async function databaseConnectionAction(
    databaseId: string
): Promise<{ error?: string; connection?: DatabaseConnection }> {
    const user = await requirePermission("deploy.manage");
    try {
        return { connection: await databaseConnection(databaseId, user.id) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not read the connection details" };
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
    const user = await requirePermission("deploy.manage");
    try {
        const token = await githubTokenForUser(user.id, input.owner);
        return await inspectGithubRepo(input.owner, input.repo, input.branch, token);
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
    let driver;
    try {
        driver = await getDriver(connectionId, user.id);
        const result = await driver.list(normalizeRelPath(path));
        const folders = result.entries.filter((entry) => entry.kind === "dir").map((entry) => entry.name).sort();
        return { folders };
    } catch (caught) {
        return { folders: [], error: caught instanceof Error ? caught.message : "Could not list folders" };
    } finally {
        // A driver is a live session to the storage; the picker opens one per
        // keystroke-driven browse, so leaving them open exhausts the NAS.
        await driver?.dispose().catch(() => undefined);
    }
}

export async function createVolumeAction(input: DeployVolumeInput): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await createVolume(user.id, input);
        await recordAudit({ actorId: user.id, action: "deploy.volume.add", targetType: "application", targetId: input.applicationId });
        // Apply on the running service (a volume takes effect on container recreate),
        // only if it is currently deployed - same Vercel-style flow as env vars.
        void deployService.redeployForEnvScope("application", input.applicationId, user.id).catch(() => undefined);
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
        void deployService.redeployForEnvScope("application", applicationId, user.id).catch(() => undefined);
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
        void deployService.redeployForEnvScope("application", input.applicationId, user.id).catch(() => undefined);
        revalidatePath(DEPLOY_PATH);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove the volume" };
    }
}

/**
 * The caller's own GitHub accounts and the repositories they reach, for the
 * Deploy "GitHub Repository" picker.
 *
 * Their accounts, not the instance's: the picker used to list whatever the
 * operator's token could see, which showed one person's private repositories to
 * everybody with deploy.manage. Somebody who has linked nothing gets an empty
 * list and the card sends them to their connections. Gated on deploy.manage.
 */
export async function githubReposAction(): Promise<{ connected: boolean; login: string | null; repos: GithubRepo[] }> {
    const user = await requirePermission("deploy.manage");
    return pickerRepoList(user.id);
}

/**
 * Repositories matching what was typed in the Deploy picker, beyond the connected
 * account's own list: the exact repository when the input names one (a pasted URL,
 * an SSH remote, `owner/repo`), and GitHub's public search otherwise.
 *
 * Called as the operator types, so a query GitHub will not answer - too short,
 * rate limited, no such repository - is an empty list rather than an error; the
 * field keeps showing whatever the local list already matched. Gated on
 * deploy.manage.
 */
export async function searchGithubReposAction(query: string): Promise<{ repos: GithubRepo[] }> {
    const user = await requirePermission("deploy.manage");
    return { repos: await pickerRepoSearch(user.id, query) };
}
