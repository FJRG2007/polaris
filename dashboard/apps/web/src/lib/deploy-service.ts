/**
 * Deploy orchestration: projects, environments, applications, and the pipeline
 * that turns an application into a running container. A deployment is a database
 * row plus a log file; the runtime driver streams build/deploy output into that
 * file, which the UI tails. Deployments are serialized per target by a small
 * in-memory queue - no external broker - so two deploys of one app never race.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { serviceName, shortHash, slugify, type AppDeployPlan, type DeployResult, type RuntimeContext, type RuntimeDriver } from "@polaris/deploy";
import { decryptSecret } from "@polaris/storage";
import { getDriver, getPorts, toTargetInfo, type TargetRow } from "./deploy/runtime";
import { autoSubdomainUrl, getPublicIp } from "./domain-service";
import { syncDomainRoute, removeDomainRoute } from "./caddy-service";
import { gitBuildContext, type GitSource } from "./git-build-service";
import { githubCloneAuthHeader } from "./github-service";
import { resolveRegistryLogin } from "./registry-credential-service";

/** Directory the web process writes deploy log files to (tailed by the UI). */
function logDir(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "deploy-logs");
}

export function deployLogPath(deploymentId: string): string {
    return join(logDir(), `${deploymentId}.log`);
}

/** Read a deployment's status and current log, ownership-checked. Returns null if
 *  the deployment does not belong to the owner. */
export async function readDeployment(
    deploymentId: string,
    ownerId: string
): Promise<{ status: string; error: string | null; log: string } | null> {
    const deployment = await prisma.deployment.findFirst({
        where: { id: deploymentId, target: { ownerId } },
        select: { id: true, status: true, error: true }
    });
    if (!deployment) return null;
    const log = await readFile(deployLogPath(deploymentId), "utf8").catch(() => "");
    return { status: deployment.status, error: deployment.error, log };
}

// --- projects / environments / applications --------------------------------

export async function listProjects(ownerId: string) {
    return prisma.project.findMany({
        where: { ownerId },
        orderBy: { createdAt: "asc" },
        include: {
            environments: {
                include: { applications: { include: { domains: true } }, databases: true },
                orderBy: { createdAt: "asc" }
            }
        }
    });
}

export async function getProject(projectId: string, ownerId: string) {
    return prisma.project.findFirst({
        where: { id: projectId, ownerId },
        include: {
            environments: {
                include: { applications: true, databases: true },
                orderBy: { createdAt: "asc" }
            }
        }
    });
}

/** One project with the full environment/service tree the detail view renders. */
export async function getProjectFull(projectId: string, ownerId: string) {
    return prisma.project.findFirst({
        where: { id: projectId, ownerId },
        include: {
            environments: {
                include: { applications: { include: { domains: true } }, databases: true },
                orderBy: { createdAt: "asc" }
            }
        }
    });
}

/** Add an environment (e.g. "Development") to a project the owner owns. */
export async function createEnvironment(projectId: string, ownerId: string, name: string) {
    const project = await prisma.project.findFirst({ where: { id: projectId, ownerId } });
    if (!project) throw new Error("Project not found");
    const slug = slugify(name);
    if (!slug) throw new Error("Environment name must contain letters or digits");
    const existing = await prisma.environment.findFirst({ where: { projectId, slug } });
    if (existing) throw new Error("An environment with that name already exists");
    return prisma.environment.create({ data: { projectId, name, slug, isDefault: false } });
}

/** Persist an environment's canvas layout (node positions + links) as JSON. */
export async function saveEnvironmentLayout(environmentId: string, ownerId: string, layout: string): Promise<void> {
    const environment = await prisma.environment.findFirst({
        where: { id: environmentId, project: { ownerId } }
    });
    if (!environment) throw new Error("Environment not found");
    // Guard against unbounded blobs; a layout is small even for large projects.
    if (layout.length > 100_000) throw new Error("Layout is too large");
    await prisma.environment.update({ where: { id: environmentId }, data: { layout } });
}

/** Delete a non-default environment (and everything in it) the owner owns. */
export async function deleteEnvironment(environmentId: string, ownerId: string) {
    const environment = await prisma.environment.findFirst({
        where: { id: environmentId, project: { ownerId } }
    });
    if (!environment) throw new Error("Environment not found");
    if (environment.isDefault) throw new Error("The default environment cannot be deleted");
    await prisma.environment.delete({ where: { id: environmentId } });
}

/** Create a project with a default "production" environment. */
export async function createProject(ownerId: string, name: string) {
    const slug = slugify(name);
    if (!slug) throw new Error("Project name must contain letters or digits");
    return prisma.project.create({
        data: {
            ownerId,
            name,
            slug,
            environments: { create: { name: "Production", slug: "production", isDefault: true } }
        },
        include: { environments: true }
    });
}

export async function deleteProject(projectId: string, ownerId: string) {
    await prisma.project.deleteMany({ where: { id: projectId, ownerId } });
}

export interface CreateApplicationInput {
    environmentId: string;
    targetId: string;
    name: string;
    sourceType: string;
    sourceConfig: Record<string, unknown>;
}

export async function createApplication(ownerId: string, input: CreateApplicationInput) {
    // Confirm the environment and target belong to the owner before creating.
    const environment = await prisma.environment.findFirst({
        where: { id: input.environmentId, project: { ownerId } }
    });
    if (!environment) throw new Error("Environment not found");
    const target = await prisma.deployTarget.findFirst({ where: { id: input.targetId, ownerId } });
    if (!target) throw new Error("Deploy target not found");
    const slug = slugify(input.name);
    if (!slug) throw new Error("Application name must contain letters or digits");
    return prisma.application.create({
        data: {
            environmentId: input.environmentId,
            targetId: input.targetId,
            name: input.name,
            slug,
            sourceType: input.sourceType,
            sourceConfig: JSON.stringify(input.sourceConfig)
        }
    });
}

/**
 * Attach a domain to an application. With no hostname a free auto subdomain is
 * generated (Traefik + Let's Encrypt serves it); the routing labels take effect
 * on the next deploy. Returns the hostname.
 */
export async function addApplicationDomain(
    applicationId: string,
    ownerId: string,
    opts: { hostname?: string; targetPort: number }
): Promise<string> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } }
    });
    if (!app) throw new Error("Application not found");
    let hostname = opts.hostname?.trim();
    let kind = "custom";
    // A custom (usually public) domain gets automatic HTTPS from Let's Encrypt; a
    // free/LAN subdomain (sslip.io on a private IP, where ACME cannot validate) is
    // served with Caddy's internal CA instead.
    let certResolver = "le";
    if (!hostname) {
        const auto = await autoSubdomainUrl(app.slug);
        if (!auto) {
            throw new Error(
                "No public IP is configured for free subdomains. Set one in domain settings, or enter a custom domain."
            );
        }
        hostname = new URL(auto).host;
        kind = "auto";
        certResolver = "internal";
    }
    let domain;
    try {
        domain = await prisma.domain.create({
            data: { applicationId, hostname, kind, targetPort: opts.targetPort, certResolver }
        });
    } catch (caught) {
        // Never surface a raw Prisma error to the UI. The only expected failure is a
        // duplicate hostname (the unique constraint), which gets a plain message.
        if (caught && typeof caught === "object" && "code" in caught && caught.code === "P2002") {
            throw new Error(`${hostname} is already in use by another service.`);
        }
        throw new Error("Could not add the domain.");
    }
    await syncAppDomainRoute(domain.id).catch(() => undefined);
    return hostname;
}

/**
 * (Re)register a domain's route on Caddy so its hostname serves the app over its
 * published host port. Best-effort: routing failures never block a deploy - the
 * app stays reachable directly over its host IP:port.
 */
async function syncAppDomainRoute(domainId: string): Promise<void> {
    const domain = await prisma.domain.findUnique({
        where: { id: domainId },
        select: { id: true, hostname: true, certResolver: true, applicationId: true }
    });
    if (!domain?.applicationId) return;
    const ip = await getPublicIp();
    if (!ip) return;
    const cert = domain.certResolver === "none" ? "none" : domain.certResolver === "le" ? "le" : "internal";
    await syncDomainRoute({
        domainId: domain.id,
        hostname: domain.hostname,
        dial: `${ip}:${hostPortForApp(domain.applicationId)}`,
        cert
    });
}

/** Re-register every domain of an app on Caddy (called after a successful deploy). */
async function syncAppDomains(applicationId: string): Promise<void> {
    const domains = await prisma.domain.findMany({ where: { applicationId }, select: { id: true } });
    for (const domain of domains) await syncAppDomainRoute(domain.id).catch(() => undefined);
}

/**
 * Give an application a free subdomain if it has none yet - so a service created
 * before a public IP was known (or one that simply never got a domain) picks one
 * up on its next deploy, the way Dokploy backfills. Best-effort: no public IP or
 * base configured just leaves the app domainless. The target port is inferred
 * from the source (built apps listen on 3000, prebuilt images on 80).
 */
export async function ensureApplicationDomain(applicationId: string, ownerId: string): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { sourceType: true, _count: { select: { domains: true } } }
    });
    if (!app || app._count.domains > 0) return;
    const targetPort = app.sourceType === "image" ? 80 : 3000;
    await addApplicationDomain(applicationId, ownerId, { targetPort });
}

export async function removeApplicationDomain(domainId: string, ownerId: string): Promise<void> {
    await prisma.domain.deleteMany({
        where: { id: domainId, application: { environment: { project: { ownerId } } } }
    });
    await removeDomainRoute(domainId).catch(() => undefined);
}

// --- deployment lifecycle (restart / disable / remove) ----------------------

/** Resolve an app to its runtime container ref, compose project, and target. */
async function appRuntime(applicationId: string, ownerId: string) {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true }
    });
    if (!app) throw new Error("Application not found");
    const container = serviceName(app.environment.project.slug, app.slug, app.id);
    const project = `polaris-${shortHash(app.id, 8)}`;
    return { app, container, project, target: app.target as TargetRow };
}

/** Restart the app's running container in place (no rebuild). */
export async function restartApplication(applicationId: string, ownerId: string): Promise<void> {
    const { container, target } = await appRuntime(applicationId, ownerId);
    const ports = await getPorts(target, ownerId);
    try {
        await ports.container(container, "restart");
    } finally {
        await ports.dispose();
    }
}

/**
 * Disable or enable a deployment without removing it: stop or start the container
 * while keeping the deployment record and its release history intact. The current
 * deployment's status tracks it (running <-> stopped) so the UI can reflect state.
 */
export async function setApplicationRunning(
    applicationId: string,
    ownerId: string,
    running: boolean
): Promise<void> {
    const { app, container, target } = await appRuntime(applicationId, ownerId);
    const ports = await getPorts(target, ownerId);
    try {
        await ports.container(container, running ? "start" : "stop");
    } finally {
        await ports.dispose();
    }
    if (app.currentDeploymentId) {
        await prisma.deployment.update({
            where: { id: app.currentDeploymentId },
            data: { status: running ? "running" : "stopped" }
        });
    }
}

/**
 * Remove the running deployment entirely: tear the project down (compose down /
 * stack rm) and mark its releases removed, clearing the app's current pointer.
 * The application config stays, so it can be deployed again later.
 */
export async function removeApplicationDeployment(applicationId: string, ownerId: string): Promise<void> {
    const { project, target } = await appRuntime(applicationId, ownerId);
    const ports = await getPorts(target, ownerId);
    try {
        if (target.runtime === "swarm") await ports.stackDown(project);
        else await ports.composeDown(project);
    } finally {
        await ports.dispose();
    }
    await prisma.deployment.updateMany({
        where: { deployableType: "application", deployableId: applicationId, status: { in: ["running", "stopped"] } },
        data: { status: "removed", finishedAt: new Date() }
    });
    await prisma.application.update({ where: { id: applicationId }, data: { currentDeploymentId: null } });
}

// --- deployment pipeline ----------------------------------------------------

/** A stable host port (20000-39999) for an app, derived from its id so it is
 *  collision-resistant and consistent across redeploys without a schema column. */
export function hostPortForApp(id: string): number {
    return 20000 + (parseInt(shortHash(id, 4), 16) % 20000);
}

/** Build the runtime plan for an application from its stored config. */
async function buildAppPlan(
    applicationId: string,
    ownerId: string
): Promise<{ plan: AppDeployPlan; target: TargetRow; gitSource?: GitSource }> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true, volumes: true, domains: true }
    });
    if (!app) throw new Error("Application not found");

    const project = app.environment.project;
    const composeProject = `polaris-${shortHash(app.id, 8)}`;
    const source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
    const env = await mergedEnv(app.environmentId, app.id);
    const healthcheck = app.healthcheck ? (JSON.parse(app.healthcheck) as AppDeployPlan["healthcheck"]) : undefined;

    // Publish the app on a stable host port so it is reachable over the host's IP
    // (intranet) with no proxy. The container port follows the domain's target
    // port (configurable), defaulting by source; the host port is derived from the
    // app id so it stays consistent across redeploys without a schema column.
    const containerPort = app.domains[0]?.targetPort ?? (app.sourceType === "image" ? 80 : 3000);

    const plan: AppDeployPlan = {
        ref: { name: serviceName(project.slug, app.slug, app.id), project: composeProject },
        expose: { host: hostPortForApp(app.id), container: containerPort },
        build: {
            method: (app.sourceType as AppDeployPlan["build"]["method"]) ?? "image",
            name: app.slug,
            imageRef: typeof source.imageRef === "string" ? source.imageRef : undefined,
            dockerfilePath: typeof source.dockerfilePath === "string" ? source.dockerfilePath : undefined,
            contextPath: ".",
            composeYaml: typeof source.composeYaml === "string" ? source.composeYaml : undefined
        },
        env,
        replicas: app.replicas,
        domains: app.domains.map((domain) => ({
            hostname: domain.hostname,
            targetPort: domain.targetPort,
            pathPrefix: domain.pathPrefix ?? undefined,
            certResolver: domain.certResolver as "le" | "internal" | "none"
        })),
        volumes: app.volumes.map((volume) => ({
            mountPath: volume.mountPath,
            source: volume.source ?? volume.name,
            kind: volume.kind === "bind" ? "bind" : "volume"
        })),
        healthcheck
    };
    let gitSource: GitSource | undefined;
    if (typeof source.repoUrl === "string" && source.repoUrl) {
        gitSource = { repoUrl: source.repoUrl, branch: typeof source.branch === "string" ? source.branch : undefined };
        // GitHub-sourced repos clone with the connected account's token so private
        // repositories build; the header is null (public clone) when not connected.
        if (source.provider === "github") {
            const owner = gitSource.repoUrl.match(/github\.com[/:]([^/]+)\//i)?.[1];
            const authHeader = await githubCloneAuthHeader(owner);
            if (authHeader) gitSource.authHeader = authHeader;
        }
    }
    return { plan, target: app.target, gitSource };
}

/** Merge environment-scoped and application-scoped env vars (app wins), decrypting
 *  any secret values. */
async function mergedEnv(environmentId: string, applicationId: string): Promise<Record<string, string>> {
    const rows = await prisma.envVar.findMany({
        where: {
            OR: [
                { scopeType: "environment", scopeId: environmentId },
                { scopeType: "application", scopeId: applicationId }
            ]
        }
    });
    // Environment scope first, then application scope overrides it.
    rows.sort((a, b) => (a.scopeType === "environment" ? -1 : 1) - (b.scopeType === "environment" ? -1 : 1));
    const masterKey = loadEnv().POLARIS_MASTER_KEY;
    const env: Record<string, string> = {};
    for (const row of rows) {
        if (row.isSecret && row.encryptedValue && row.valueNonce) {
            env[row.key] = decryptSecret(
                {
                    ciphertext: Buffer.from(row.encryptedValue),
                    nonce: Buffer.from(row.valueNonce),
                    keyId: row.valueKeyId ?? ""
                },
                masterKey
            );
        } else if (row.value !== null) {
            env[row.key] = row.value;
        }
    }
    return env;
}

/**
 * Deploy an application: create a queued Deployment row and run it through the
 * per-target queue. Returns the deployment id immediately; the run streams its
 * output to the deployment's log file and updates the row's status.
 */
export async function deployApplication(
    applicationId: string,
    ownerId: string,
    userId: string,
    meta?: { commitMessage?: string; commitSha?: string }
): Promise<string> {
    const { plan, target, gitSource } = await buildAppPlan(applicationId, ownerId);
    const deployment = await prisma.deployment.create({
        data: {
            targetId: target.id,
            deployableType: "application",
            deployableId: applicationId,
            status: "queued",
            triggeredById: userId,
            commitMessage: meta?.commitMessage?.trim() || null,
            commitSha: meta?.commitSha || null
        }
    });
    // The app keeps pointing at the previous successful release until this one
    // actually succeeds (see executeDeployment) - so history never shows a build
    // as "current" before it finishes, and the old version stays active until the
    // new one is up (zero-downtime cutover, the way Railway does it).
    queue.enqueue(target.id, () => runDeployment(deployment.id, plan, target, ownerId, gitSource));
    return deployment.id;
}

export interface DeploymentSummary {
    id: string;
    status: string;
    error: string | null;
    createdAt: string;
    isCurrent: boolean;
    commitMessage: string | null;
    commitSha: string | null;
}

/** An application's deployment history, most recent first (owner-checked). */
export async function listDeployments(applicationId: string, ownerId: string): Promise<DeploymentSummary[]> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { id: true, currentDeploymentId: true }
    });
    if (!app) throw new Error("Application not found");
    const rows = await prisma.deployment.findMany({
        where: { deployableType: "application", deployableId: applicationId },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, status: true, error: true, createdAt: true, commitMessage: true, commitSha: true }
    });
    return rows.map((row) => ({
        id: row.id,
        status: row.status,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
        isCurrent: row.id === app.currentDeploymentId,
        commitMessage: row.commitMessage,
        commitSha: row.commitSha
    }));
}

/** Map deployment ids to their current status (for showing running/failed/…). */
export async function getDeploymentStatuses(ids: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return {};
    const rows = await prisma.deployment.findMany({ where: { id: { in: unique } }, select: { id: true, status: true } });
    return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

/** Update an application's auto-deploy settings (owner-checked). */
export async function updateAutoDeploy(
    applicationId: string,
    ownerId: string,
    settings: { autoDeploy: boolean; deployBranch?: string | null; commitFilter?: string | null; keepReleases?: boolean }
): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } }
    });
    if (!app) throw new Error("Application not found");
    await prisma.application.update({
        where: { id: applicationId },
        data: {
            autoDeploy: settings.autoDeploy,
            deployBranch: settings.deployBranch?.trim() || null,
            commitFilter: settings.commitFilter?.trim() || null,
            ...(settings.keepReleases !== undefined ? { keepReleases: settings.keepReleases } : {})
        }
    });
}

/** "refs/heads/main" -> "main". */
export function branchFromRef(ref: string): string {
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/** Whether a commit message satisfies an auto-deploy filter. Empty = any commit;
 *  "regex:<pattern>" is matched as a regex, otherwise a case-insensitive substring
 *  (e.g. "build:" fires only on commits mentioning build: anywhere). */
export function commitPassesFilter(message: string, filter: string | null | undefined): boolean {
    const trimmed = filter?.trim();
    if (!trimmed) return true;
    if (trimmed.startsWith("regex:")) {
        try {
            return new RegExp(trimmed.slice("regex:".length)).test(message);
        } catch {
            return false;
        }
    }
    return message.toLowerCase().includes(trimmed.toLowerCase());
}

/**
 * Trigger auto-deploys for a git push: find applications tracking this repo with
 * auto-deploy enabled whose branch and commit-message filters pass, and deploy
 * each. Returns the number of deployments started. Not owner-scoped - a webhook
 * fans out to every matching app on the instance.
 */
export async function triggerAutoDeploysForPush(input: {
    repoFullName: string;
    branch: string;
    commitMessage: string;
    commitSha: string;
}): Promise<number> {
    const apps = await prisma.application.findMany({
        where: { autoDeploy: true, sourceType: { in: ["dockerfile", "nixpacks"] } },
        include: { environment: { include: { project: true } } }
    });
    const wanted = input.repoFullName.toLowerCase();
    let started = 0;
    for (const app of apps) {
        let source: Record<string, unknown>;
        try {
            source = JSON.parse(app.sourceConfig);
        } catch {
            continue;
        }
        const repoUrl = typeof source.repoUrl === "string" ? source.repoUrl.toLowerCase() : "";
        const matchesRepo =
            repoUrl.includes(`github.com/${wanted}`) ||
            repoUrl.endsWith(`/${wanted}`) ||
            repoUrl.endsWith(`/${wanted}.git`);
        if (!matchesRepo) continue;
        const configuredBranch = (app.deployBranch?.trim() || (typeof source.branch === "string" ? source.branch : "")).trim();
        if (configuredBranch && configuredBranch !== input.branch) continue;
        if (!commitPassesFilter(input.commitMessage, app.commitFilter)) continue;
        const ownerId = app.environment.project.ownerId;
        try {
            await deployApplication(app.id, ownerId, ownerId, {
                commitMessage: input.commitMessage,
                commitSha: input.commitSha
            });
            await prisma.application.update({ where: { id: app.id }, data: { lastDeployedSha: input.commitSha } });
            started += 1;
        } catch {
            // Skip this app; the others still deploy.
        }
    }
    return started;
}

function runDeployment(
    deploymentId: string,
    plan: AppDeployPlan,
    target: TargetRow,
    ownerId: string,
    gitSource?: GitSource
): Promise<void> {
    // Only an image source pulls a registry image that may need a login.
    const pullImages = plan.build.method === "image" && plan.build.imageRef ? [plan.build.imageRef] : [];
    return executeDeployment(
        deploymentId,
        target,
        ownerId,
        (ctx, driver) => driver.deployApplication(plan, ctx),
        gitSource,
        pullImages
    );
}

/**
 * The shared deploy runner used by application and database deploys: open the log
 * file, resolve the ports and driver for the target, run the caller's work with a
 * RuntimeContext streaming into that log, and record the final status. Exported so
 * database-service reuses the exact same lifecycle.
 */
export async function executeDeployment(
    deploymentId: string,
    target: TargetRow,
    ownerId: string,
    run: (ctx: RuntimeContext, driver: RuntimeDriver) => Promise<DeployResult>,
    buildSource?: GitSource,
    pullImages: string[] = []
): Promise<void> {
    await mkdir(logDir(), { recursive: true });
    const logStream = createWriteStream(deployLogPath(deploymentId), { flags: "a" });
    const log = (chunk: Buffer): void => {
        logStream.write(chunk);
    };

    await prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: "deploying", startedAt: new Date(), logPath: `${deploymentId}.log` }
    });

    const ports = await getPorts(target, ownerId);
    const driver = getDriver(target);
    const buildContext = buildSource ? gitBuildContext(buildSource, log) : undefined;
    try {
        // Authenticate to any private registry whose image this deploy pulls, so the
        // pull below (inside the driver) is authorized. A login failure is logged but
        // not fatal - the pull surfaces the real error if the image is truly private.
        for (const image of pullImages) {
            const auth = await resolveRegistryLogin(ownerId, image);
            if (!auth) continue;
            log(Buffer.from(`Authenticating to ${auth.registry || "Docker Hub"}...\n`));
            try {
                await ports.login(auth.registry, auth.username, auth.password);
            } catch {
                log(Buffer.from("[warn] registry login failed; the pull may be unauthorized\n"));
            }
        }
        const result = await run({ ports, target: toTargetInfo(target), log, buildContext }, driver);
        await prisma.deployment.update({
            where: { id: deploymentId },
            data: {
                status: result.ok ? "running" : "failed",
                imageTag: result.imageTag,
                error: result.error,
                finishedAt: new Date()
            }
        });
        if (result.ok) await promoteDeployment(deploymentId);
    } catch (error) {
        log(Buffer.from(`\n[error] ${error instanceof Error ? error.message : String(error)}\n`));
        await prisma.deployment.update({
            where: { id: deploymentId },
            data: { status: "failed", error: error instanceof Error ? error.message : "deploy failed", finishedAt: new Date() }
        });
    } finally {
        await ports.dispose();
        logStream.end();
    }
}

/**
 * Promote a just-succeeded deployment to be its application's current release.
 * Unless the app keeps release history (`keepReleases`), any prior release still
 * marked "running" is superseded to "removed" - so the Deployments tab shows one
 * ACTIVE release over a REMOVED history, the way Railway does, instead of several
 * stale "running" rows. No-op for non-application deployables.
 */
async function promoteDeployment(deploymentId: string): Promise<void> {
    const dep = await prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { deployableType: true, deployableId: true }
    });
    if (dep?.deployableType !== "application") return;
    const app = await prisma.application.findUnique({
        where: { id: dep.deployableId },
        select: { keepReleases: true }
    });
    if (!app?.keepReleases) {
        await prisma.deployment.updateMany({
            where: {
                deployableType: "application",
                deployableId: dep.deployableId,
                status: "running",
                id: { not: deploymentId }
            },
            data: { status: "removed", finishedAt: new Date() }
        });
    }
    await prisma.application.update({
        where: { id: dep.deployableId },
        data: { currentDeploymentId: deploymentId }
    });
    // Re-register the app's domain routes on Caddy - self-heals routes lost to a
    // proxy reload, and registers a domain whose first deploy just came up.
    await syncAppDomains(dep.deployableId).catch(() => undefined);
}

/** Enqueue a job serialized behind any prior job for the same target. */
export function enqueueOnTarget(targetId: string, job: () => Promise<void>): void {
    queue.enqueue(targetId, job);
}

// --- per-target FIFO queue (no external broker) -----------------------------

class InMemoryQueue {
    private readonly chains = new Map<string, Promise<void>>();

    /** Run `job` after any prior job for the same partition finishes. */
    public enqueue(partition: string, job: () => Promise<void>): void {
        const prior = this.chains.get(partition) ?? Promise.resolve();
        const next = prior.then(job).catch(() => undefined);
        this.chains.set(partition, next);
        // Drop the chain entry once it settles and nothing newer replaced it.
        void next.finally(() => {
            if (this.chains.get(partition) === next) this.chains.delete(partition);
        });
    }
}

const queue = new InMemoryQueue();
