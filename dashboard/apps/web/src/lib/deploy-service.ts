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
import { isTunnelHostname } from "@polaris/core";
import { prisma } from "@polaris/db";
import { bucketHttpMetrics, parseHttpLogs, serviceName, shortHash, slugify, type AppDeployPlan, type DeployResult, type HttpLogEntry, type HttpMetricPoint, type RuntimeContext, type RuntimeDriver } from "@polaris/deploy";
import { decryptSecret } from "@polaris/storage";
import { resolveMountTarget } from "./storage-service";
import { getDriver, getPorts, toTargetInfo, type TargetRow } from "./deploy/runtime";
import { LocalRouter, type AppRoute } from "./deploy/router";
import { getOrCreateHostTarget, getOrCreateLocalTarget } from "./deploy-target-service";
import { getPublicIp } from "./domain-service";
import { resolveAutoDomain } from "./network-service";
import { ensureLocalCa } from "./local-ca-service";
import { gitBuildContext, type GitSource } from "./git-build-service";
import { getLatestCommit, githubCloneAuthHeader } from "./github-service";
import { resolveRegistryLogin } from "./registry-credential-service";
import { quickTunnelAppIds, tunnelHostForApp, stopQuickTunnel } from "./deploy/quick-tunnel-service";
import { resolveWaf, resolveWafBatch } from "./waf-service";

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
                include: {
                    applications: {
                        include: { domains: true, target: true, volumes: { include: { connection: { select: { name: true } } } } }
                    },
                    databases: true
                },
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
    /** Track the branch and redeploy on new commits (default for git sources). */
    autoDeploy?: boolean;
    deployBranch?: string | null;
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
            sourceConfig: JSON.stringify(input.sourceConfig),
            autoDeploy: input.autoDeploy ?? false,
            deployBranch: input.deployBranch ?? null
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
    opts: { hostname?: string; targetPort: number; cert?: "internal" | "le" | "none" }
): Promise<string> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        include: { target: { include: { host: true } } }
    });
    if (!app) throw new Error("Application not found");
    // A remote-server app's auto domain must embed that server's IP (served by its
    // own edge), not the Polaris host's - otherwise it points at the wrong box.
    const remoteIp = app.target.kind !== "local" ? app.target.host?.address?.trim() : undefined;
    let hostname = opts.hostname?.trim();
    let kind = "custom";
    // Cert/exposure resolution: a caller-chosen mode wins (e.g. "none" for a domain
    // fronted by a tunnel/proxy that terminates TLS). Otherwise a custom domain gets
    // automatic HTTPS from Let's Encrypt, and a free/LAN subdomain (sslip.io on a
    // private IP, where ACME cannot validate) is served with Caddy's internal CA.
    let certResolver: string = opts.cert ?? "le";
    if (!hostname) {
        // The network mode decides the auto domain: a wildcard/public setup mints a
        // real internet-reachable name with Let's Encrypt; otherwise a LAN-only
        // sslip.io name (kind "lan") - so the app never gets a subdomain that
        // silently fails off the network; the UI labels it and offers public setup.
        const plan = await resolveAutoDomain(app.slug, remoteIp ? { ip: remoteIp } : undefined);
        if (!plan) {
            throw new Error(
                "No public IP is configured for free subdomains. Set one in Domains settings, or enter a custom domain."
            );
        }
        hostname = plan.hostname;
        kind = plan.kind;
        if (!opts.cert) certResolver = plan.cert;
    }
    // A tunnel URL (Cloudflare quick tunnel, ngrok) is already exposed by its own
    // tunnel; adding it as a domain only creates an inert edge route (inbound traffic
    // reaches the tunnel provider, not this edge) and, with Let's Encrypt, a failing
    // ACME loop - and it shows up as a duplicate of the live tunnel link. Reject it.
    if (isTunnelHostname(hostname)) {
        throw new Error(
            "That is a tunnel URL - it is already exposed by its tunnel, so it can't be added as a domain."
        );
    }
    // Idempotent: re-adding the same domain to the same app is a no-op, not an error
    // (the auto free subdomain is deterministic, so "Add domain" would hit this).
    const existing = await prisma.domain.findFirst({ where: { hostname, applicationId }, select: { id: true } });
    if (existing) {
        await syncAppRoutes().catch(() => undefined);
        return hostname;
    }
    try {
        await prisma.domain.create({
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
    await syncAppRoutes().catch(() => undefined);
    // A LAN name served by the internal CA needs the leaf to cover it, so reissue the
    // cert to include the new hostname (best-effort; ACME/public domains are unaffected).
    if (certResolver === "internal") void ensureLocalCa().catch(() => undefined);
    return hostname;
}

/**
 * Regenerate every edge's dynamic routing config from the enabled application
 * domains, grouped by the server each app runs on (its own edge). The Polaris
 * host's local edge is written through LocalRouter; each hostname routes to the
 * app's published host port, so the edge needs no per-container labels and
 * reflects a domain being added, removed, enabled, or disabled the instant this
 * runs (Traefik watches the file). HTTPS is automatic: Let's Encrypt for a custom
 * domain, the edge's default cert for a free/LAN subdomain, plain HTTP for a
 * domain fronted by a tunnel. Best-effort - no public IP just leaves routing
 * unchanged.
 *
 * A remote-server app is served by that server's OWN edge (so the control plane is
 * never in its request path); pushing config to a remote edge over SSH is the
 * next phase, so those domains are not routed through the local edge here - they
 * are logged instead of being silently funnelled through Polaris (a SPOF).
 */
export async function syncAppRoutes(): Promise<void> {
    const domains = await prisma.domain.findMany({
        where: { enabled: true },
        select: {
            id: true,
            hostname: true,
            certResolver: true,
            applicationId: true,
            application: { select: { target: { select: { kind: true } } } }
        }
    });
    const localIp = await getPublicIp();
    const localDomains = domains.filter((domain) => domain.application.target.kind === "local");
    // Served by the remote server's own edge (per-server edge, phase 2).
    const remotePending = domains
        .filter((domain) => domain.application.target.kind !== "local")
        .map((domain) => domain.hostname);
    const localRoutes: AppRoute[] = [];
    if (localIp) {
        // Quick-tunnel traffic must traverse the edge too, or its requests never reach
        // the access log the HTTP Logs view reads. Route each live tunnel's internal host
        // to the app over plain HTTP (TLS is terminated at Cloudflare's edge, ahead of the
        // tunnel).
        const tunnelAppIds = await quickTunnelAppIds();
        const localTunnelApps =
            tunnelAppIds.length > 0
                ? await prisma.application.findMany({
                      where: { id: { in: tunnelAppIds }, target: { kind: "local" } },
                      select: { id: true }
                  })
                : [];
        // Resolve every route's WAF decision in one batched pair of queries, not a serial
        // round-trip per domain and per tunnel.
        const waf = await resolveWafBatch([
            ...localDomains.map((domain) => domain.applicationId),
            ...localTunnelApps.map((app) => app.id)
        ]);
        const emptyWaf = { allowLists: [], deny: [], requireLogin: false };
        for (const domain of localDomains) {
            const rule = waf.get(domain.applicationId) ?? emptyWaf;
            localRoutes.push({
                id: domain.id,
                hostname: domain.hostname,
                certResolver: domain.certResolver,
                dialHost: localIp,
                dialPort: hostPortForApp(domain.applicationId),
                allowLists: rule.allowLists,
                deny: rule.deny,
                requireLogin: rule.requireLogin
            });
        }
        for (const app of localTunnelApps) {
            const rule = waf.get(app.id) ?? emptyWaf;
            localRoutes.push({
                id: `qtunnel-${shortHash(app.id, 8)}`,
                hostname: tunnelHostForApp(app.id),
                certResolver: "none",
                dialHost: localIp,
                dialPort: hostPortForApp(app.id),
                allowLists: rule.allowLists,
                deny: rule.deny,
                requireLogin: rule.requireLogin
            });
        }
    }
    await new LocalRouter().sync(localRoutes);
    if (remotePending.length > 0) {
        console.warn(
            `polaris: ${remotePending.length} remote-server domain(s) await a per-server edge and are not routed by the local edge: ${remotePending.join(", ")}`
        );
    }
}

/**
 * Whether a hostname is one this instance actually routes: an enabled domain or a
 * live quick-tunnel host. The edge login handoff mints a host-bound token, so the
 * authorize endpoint checks this before signing and redirecting - a redirect target
 * that is not a managed deploy host is refused, so the endpoint can never be turned
 * into an open redirector or a token oracle for an arbitrary site.
 */
export async function isManagedDeployHost(host: string): Promise<boolean> {
    const trimmed = host.trim();
    if (!trimmed) return false;
    const domain = await prisma.domain.findFirst({
        where: { enabled: true, hostname: { in: [trimmed, trimmed.toLowerCase()] } },
        select: { id: true }
    });
    if (domain) return true;
    const needle = trimmed.toLowerCase();
    const tunnelAppIds = await quickTunnelAppIds();
    return tunnelAppIds.some((appId) => tunnelHostForApp(appId).toLowerCase() === needle);
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
    await syncAppRoutes().catch(() => undefined);
}

/**
 * Enable or disable a domain without deleting it: flip the flag and either
 * (re)register its route so the hostname serves the app, or drop the route so it
 * stops. The record and its settings survive, so it can be toggled back on.
 */
export async function setApplicationDomainEnabled(
    domainId: string,
    ownerId: string,
    enabled: boolean
): Promise<void> {
    const result = await prisma.domain.updateMany({
        where: { id: domainId, application: { environment: { project: { ownerId } } } },
        data: { enabled }
    });
    if (result.count === 0) throw new Error("Domain not found");
    await syncAppRoutes().catch(() => undefined);
}

/**
 * Re-establish NAS volume mounts on server startup, so a NAS-backed volume keeps
 * behaving like a real docker volume across a host reboot. A nas volume binds onto
 * a kernel CIFS/NFS mount the deploy pipeline sets up at `<mount_root>/<connId>`;
 * that mount is lost on a host reboot, and the app container then comes back bound
 * to an empty local dir. This runs at boot (like `syncAppRoutes`): for every running
 * app with a nas volume it re-ensures the mount and - only when the mount was
 * actually absent (`created`, i.e. after a reboot; a routine restart keeps the mount
 * alive via rshared propagation, so nothing is disturbed) - restarts the app so its
 * bind resolves back onto the NAS. Best-effort: failures are logged, never fatal.
 */
export async function reconcileNasMounts(): Promise<void> {
    const apps = await prisma.application.findMany({
        where: {
            desiredState: "running",
            currentDeploymentId: { not: null },
            volumes: { some: { kind: "nas", connectionId: { not: null } } }
        },
        include: {
            environment: { include: { project: { select: { ownerId: true, slug: true } } } },
            target: true,
            volumes: { where: { kind: "nas", connectionId: { not: null } }, select: { connectionId: true } }
        }
    });
    for (const app of apps) {
        const ownerId = app.environment.project.ownerId;
        const connectionIds = [...new Set(app.volumes.map((volume) => volume.connectionId as string))];
        let ports;
        try {
            ports = await getPorts(app.target as TargetRow, ownerId);
        } catch (error) {
            console.error(`polaris: NAS reconcile could not reach ${app.slug}'s target:`, error);
            continue;
        }
        try {
            let recreated = false;
            for (const id of connectionIds) {
                const mount = await resolveMountTarget(id, ownerId).catch(() => null);
                if (!mount) continue;
                if (await ports.ensureMount(mount)) recreated = true;
            }
            // Only after a mount had to be re-created (a reboot) does the running
            // container hold a stale bind; restart it so the bind re-resolves.
            if (recreated) {
                const container = serviceName(app.environment.project.slug, app.slug, app.id);
                await ports.container(container, "restart");
                console.log(`polaris: re-established NAS mount for ${app.slug} and restarted it`);
            }
        } catch (error) {
            console.error(`polaris: NAS mount reconcile failed for ${app.slug}:`, error);
        } finally {
            await ports.dispose().catch(() => undefined);
        }
    }
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

/**
 * HTTP access logs for an app, parsed from its container's stdout. Most web
 * servers (nginx, Apache, and framework loggers) already emit one access line per
 * request there, so this needs no proxy or extra wiring; an app that does not log
 * access simply yields an empty list. Newest first, capped to `limit`.
 */
export async function readAppHttpLogs(
    applicationId: string,
    ownerId: string,
    limit = 500
): Promise<HttpLogEntry[]> {
    // Access lines are a subset of stdout, so over-fetch raw lines to land close to
    // `limit` parsed requests without following.
    const entries = await readAppHttpEntries(applicationId, ownerId, Math.min(limit * 5, 5000));
    return entries.reverse().slice(0, limit);
}

/**
 * HTTP traffic metrics for an app, bucketed into a time series over [from, to):
 * request volume, 5xx error rate, response time, and egress throughput. Derived
 * from the same access-log stream, so it needs no separate collector; the window
 * is bounded by what the container's log buffer still holds.
 */
export async function readAppHttpMetrics(
    applicationId: string,
    ownerId: string,
    from: number,
    to: number
): Promise<HttpMetricPoint[]> {
    const entries = await readAppHttpEntries(applicationId, ownerId, 5000);
    return bucketHttpMetrics(entries, from, to);
}

/**
 * Raw stdout/stderr tail of an app's running container - the Deploy Logs view,
 * i.e. what the app itself prints at runtime (distinct from the build/pipeline
 * log stored on the Deployment). Empty if the container is not running.
 */
export async function readAppRuntimeLog(applicationId: string, ownerId: string, tail = 500): Promise<string> {
    const { container, target } = await appRuntime(applicationId, ownerId);
    const ports = await getPorts(target, ownerId);
    const chunks: Buffer[] = [];
    try {
        await ports.logs(container, (chunk) => chunks.push(chunk), { tail });
    } finally {
        await ports.dispose();
    }
    return sortLogByTimestamp(Buffer.concat(chunks).toString("utf8"));
}

/** The RFC3339 timestamp docker prepends to each log line with `--timestamps`. */
const LOG_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/;

/**
 * Order docker log lines by their own timestamp. Docker merges stdout and stderr
 * as two streams, so a plain read can interleave them differently on each poll -
 * which made the Deploy Logs view visibly reshuffle. A stable sort by the leading
 * timestamp gives one deterministic order; lines without a timestamp keep their
 * position. Same timestamp -> original order (stable).
 */
function sortLogByTimestamp(raw: string): string {
    const lines = raw.split("\n");
    const tagged = lines.map((line, index) => ({ line, index, ts: LOG_TS_RE.exec(line)?.[1] ?? null }));
    if (!tagged.some((entry) => entry.ts)) return raw;
    tagged.sort((a, b) => {
        if (a.ts && b.ts) return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.index - b.index;
        return a.index - b.index;
    });
    return tagged.map((entry) => entry.line).join("\n");
}

/** The edge's per-request access log (JSON), written by Traefik to a shared volume. */
const ACCESS_LOG_FILE = process.env.POLARIS_TRAEFIK_ACCESSLOG ?? "/traefik-log/access.log";

/**
 * HTTP access entries for an app. Primary source is the edge's own access log,
 * which records every proxied request regardless of what the app logs - so it
 * works for a Next.js server or any framework, not just nginx/Apache. Filtered to
 * the app's hostnames. Falls back to the container's own stdout for an app that
 * logs its requests directly or is reached by IP:port off the proxy.
 */
async function readAppHttpEntries(applicationId: string, ownerId: string, tail: number): Promise<HttpLogEntry[]> {
    const { container, target } = await appRuntime(applicationId, ownerId);
    const domains = await prisma.domain.findMany({ where: { applicationId }, select: { hostname: true } });
    const hosts = new Set(domains.map((domain) => domain.hostname.toLowerCase()));
    // The quick tunnel routes through the edge under this internal host, so its requests
    // are logged there under it - include it so tunnel traffic shows in the HTTP Logs.
    hosts.add(tunnelHostForApp(applicationId).toLowerCase());

    const fromEdge = await readProxyAccessEntries(hosts, tail);
    if (fromEdge.length > 0) return fromEdge;

    const ports = await getPorts(target, ownerId);
    const chunks: Buffer[] = [];
    try {
        await ports.logs(container, (chunk) => chunks.push(chunk), { tail });
    } finally {
        await ports.dispose();
    }
    return parseHttpLogs(Buffer.concat(chunks).toString("utf8"));
}

/** Parse the edge access log, keeping only requests for the given hostnames. */
async function readProxyAccessEntries(hosts: Set<string>, tail: number): Promise<HttpLogEntry[]> {
    if (hosts.size === 0) return [];
    let raw: string;
    try {
        raw = await readFile(ACCESS_LOG_FILE, "utf8");
    } catch {
        return [];
    }
    // Bound the work on a busy proxy: only parse the tail of the file.
    const lines = raw.split("\n");
    const recent = lines.length > tail * 20 ? lines.slice(-tail * 20).join("\n") : raw;
    return parseHttpLogs(recent)
        .filter((entry) => entry.host !== null && hosts.has(entry.host.toLowerCase()))
        .slice(-tail);
}

/**
 * Restart the app by recreating it from its current spec, so it always comes back
 * up with the latest environment variables and settings. A plain docker restart
 * would keep the container's original env; a redeploy re-renders the spec (with an
 * image-layer cache making an unchanged build fast).
 */
export async function restartApplication(applicationId: string, ownerId: string): Promise<void> {
    // A restart bounces the running container in place - it must NOT rebuild or
    // create a new deployment (which would mislabel a manual restart as a fresh
    // git build and leave the card stuck "deploying").
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
    // Starting recreates from the current spec so it comes up with the latest env;
    // stopping just halts the container while keeping the deployment record.
    if (running) {
        await deployApplication(applicationId, ownerId, ownerId);
        return;
    }
    const { app, container, target } = await appRuntime(applicationId, ownerId);
    const ports = await getPorts(target, ownerId);
    try {
        await ports.container(container, "stop");
    } finally {
        await ports.dispose();
    }
    if (app.currentDeploymentId) {
        await prisma.deployment.update({
            where: { id: app.currentDeploymentId },
            data: { status: "stopped" }
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
    // Tear down the app's quick tunnel alongside its deployment: the cloudflared sidecar
    // now forwards to a container that is gone, so leaving it up leaks a live public URL
    // and an orphan liveness record the boot reconcile keeps revisiting. Only apps with a
    // tunnel carry a liveness record, so this is a no-op for the rest.
    if ((await quickTunnelAppIds()).includes(applicationId)) {
        await stopQuickTunnel(applicationId, ownerId).catch(() => undefined);
    }
    await prisma.deployment.updateMany({
        where: { deployableType: "application", deployableId: applicationId, status: { in: ["running", "stopped"] } },
        data: { status: "removed", finishedAt: new Date() }
    });
    await prisma.application.update({ where: { id: applicationId }, data: { currentDeploymentId: null } });
}

/**
 * Delete an application entirely: tear its container down, then remove the record
 * and everything scoped to it. Domains and volumes cascade on the row delete;
 * deployments and env vars are polymorphic (no FK), so they are removed by hand.
 */
export async function deleteApplication(applicationId: string, ownerId: string): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { id: true }
    });
    if (!app) throw new Error("Application not found");
    await removeApplicationDeployment(applicationId, ownerId).catch(() => undefined);
    await prisma.deployment.deleteMany({ where: { deployableType: "application", deployableId: applicationId } });
    await prisma.envVar.deleteMany({ where: { scopeType: "application", scopeId: applicationId } });
    await prisma.application.delete({ where: { id: applicationId } });
}

/**
 * Duplicate an application within its environment: a fresh service with the same
 * source, build, and variables, but its own name/slug and no domains or history.
 * It is not deployed automatically - the copy is created ready to deploy.
 */
export async function duplicateApplication(applicationId: string, ownerId: string): Promise<string> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } }
    });
    if (!app) throw new Error("Application not found");
    const base = slugify(`${app.name}-copy`) || `${app.slug}-copy`;
    let slug = base;
    let suffix = 1;
    while (await prisma.application.findFirst({ where: { environmentId: app.environmentId, slug }, select: { id: true } })) {
        suffix += 1;
        slug = `${base}-${suffix}`;
    }
    const created = await prisma.application.create({
        data: {
            environmentId: app.environmentId,
            targetId: app.targetId,
            name: `${app.name}-copy`,
            slug,
            sourceType: app.sourceType,
            sourceConfig: app.sourceConfig,
            buildConfig: app.buildConfig,
            healthcheck: app.healthcheck,
            replicas: app.replicas,
            deployBranch: app.deployBranch,
            commitFilter: app.commitFilter,
            keepReleases: app.keepReleases
        }
    });
    const vars = await prisma.envVar.findMany({ where: { scopeType: "application", scopeId: app.id } });
    for (const variable of vars) {
        await prisma.envVar.create({
            data: {
                scopeType: "application",
                scopeId: created.id,
                key: variable.key,
                value: variable.value,
                isSecret: variable.isSecret
            }
        });
    }
    return created.id;
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
    // Resolved WAF rules for this service, materialized into edge labels on deploy so
    // a remote server's own Traefik enforces them without the control plane.
    const resolvedWaf = await resolveWaf(app.id);
    const waf =
        resolvedWaf.allowLists.length > 0 || resolvedWaf.deny.length > 0 || resolvedWaf.requireLogin
            ? resolvedWaf
            : undefined;

    // Publish the app on a stable host port so it is reachable over the host's IP
    // (intranet) with no proxy. The container port is the app's stored listening
    // port (set at create, editable), falling back to a domain's target port or a
    // source default; the host port is derived from the app id so it stays
    // consistent across redeploys without a schema column.
    const storedPort = typeof source.port === "number" ? source.port : undefined;
    const containerPort = storedPort ?? app.domains[0]?.targetPort ?? (app.sourceType === "image" ? 80 : 3000);

    // NAS mounts the volumes bind onto: one per distinct storage connection a nas
    // volume uses, so the deploy kernel-mounts each at `<mount_root>/<id>` before the
    // container comes up - the bind `<mount_root>/<id>/<subpath>` then lands on the NAS.
    const nasConnectionIds = [
        ...new Set(app.volumes.filter((volume) => volume.kind === "nas" && volume.connectionId).map((volume) => volume.connectionId as string))
    ];
    const mounts = (await Promise.all(nasConnectionIds.map((id) => resolveMountTarget(id, ownerId).catch(() => null)))).filter(
        (mount): mount is NonNullable<typeof mount> => mount !== null
    );

    const plan: AppDeployPlan = {
        ref: { name: serviceName(project.slug, app.slug, app.id), project: composeProject },
        mounts,
        expose: { host: hostPortForApp(app.id), container: containerPort },
        // When the user has not pinned a container port, the value above is a guess
        // (a domain's target port or a source default); let the runtime refine it from
        // the image's own exposed port so IP:port reaches a live socket, not a dead one.
        autoContainerPort: storedPort === undefined,
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
        waf,
        // Disabled domains keep their record but are left out of the plan so no route
        // labels are emitted for them until they are turned back on.
        domains: app.domains
            .filter((domain) => domain.enabled)
            .map((domain) => ({
                hostname: domain.hostname,
                targetPort: domain.targetPort,
                pathPrefix: domain.pathPrefix ?? undefined,
                certResolver: domain.certResolver as "le" | "internal" | "none"
            })),
        // A nas volume's source is confined under the mount root as
        // `<connectionId>/<subpath>`, so it resolves onto that connection's host
        // mount (`/mnt/polaris/<connectionId>/...`). bind/volume pass through.
        volumes: app.volumes.map((volume) => {
            const kind = volume.kind === "bind" ? "bind" : volume.kind === "nas" ? "nas" : "volume";
            const stored = volume.source ?? volume.name;
            const source = kind === "nas" && volume.connectionId ? `${volume.connectionId}/${stored}` : stored;
            return { mountPath: volume.mountPath, source, kind };
        }),
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
/**
 * Redeploy the currently-deployed app(s) a variable change affects, so new values
 * take effect without a manual redeploy (Vercel-style). Application scope hits the
 * one service; environment scope hits every deployed service that shares it.
 * Best-effort and only for already-deployed apps - a change on an undeployed app
 * simply applies on its first deploy.
 */
export async function redeployForEnvScope(
    scope: "application" | "environment",
    scopeId: string,
    ownerId: string
): Promise<void> {
    const where =
        scope === "application"
            ? { id: scopeId, environment: { project: { ownerId } }, currentDeploymentId: { not: null } }
            : { environmentId: scopeId, environment: { project: { ownerId } }, currentDeploymentId: { not: null } };
    const apps = await prisma.application.findMany({ where, select: { id: true } });
    for (const app of apps) {
        await deployApplication(app.id, ownerId, ownerId).catch(() => undefined);
    }
}

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
/** Extract owner/repo from a GitHub URL (https or scp-like, with or without .git). */
function parseGithubRepo(repoUrl: string): { owner: string; repo: string } | null {
    const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    return match ? { owner: match[1]!, repo: match[2]! } : null;
}

export async function deployApplication(
    applicationId: string,
    ownerId: string,
    userId: string,
    meta?: { commitMessage?: string; commitSha?: string; authorName?: string; authorAvatarUrl?: string }
): Promise<string> {
    const { plan, target, gitSource } = await buildAppPlan(applicationId, ownerId);

    // Resolve the commit + author so the deployment shows who shipped it, Railway-
    // style. The provided meta (webhook / poller) wins; otherwise resolve the branch
    // head from GitHub. Best-effort - a private repo without a token just has none.
    let commitMessage = meta?.commitMessage?.trim() || null;
    let commitSha = meta?.commitSha || null;
    let authorName = meta?.authorName ?? null;
    let authorAvatarUrl = meta?.authorAvatarUrl ?? null;
    if (gitSource && !authorAvatarUrl) {
        const parsed = parseGithubRepo(gitSource.repoUrl);
        if (parsed) {
            const commit = await getLatestCommit(parsed.owner, parsed.repo, commitSha ?? gitSource.branch ?? "HEAD").catch(
                () => null
            );
            if (commit) {
                commitSha = commitSha ?? commit.sha;
                commitMessage = commitMessage ?? (commit.message.split("\n")[0]?.trim() || null);
                authorName = authorName ?? commit.authorName;
                authorAvatarUrl = commit.authorAvatarUrl;
            }
        }
    }

    const deployment = await prisma.deployment.create({
        data: {
            targetId: target.id,
            deployableType: "application",
            deployableId: applicationId,
            status: "queued",
            triggeredById: userId,
            commitMessage,
            commitSha,
            authorName,
            authorAvatarUrl
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
    authorName: string | null;
    authorAvatarUrl: string | null;
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
        select: {
            id: true,
            status: true,
            error: true,
            createdAt: true,
            commitMessage: true,
            commitSha: true,
            authorName: true,
            authorAvatarUrl: true
        }
    });
    return rows.map((row) => ({
        id: row.id,
        status: row.status,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
        isCurrent: row.id === app.currentDeploymentId,
        commitMessage: row.commitMessage,
        commitSha: row.commitSha,
        authorName: row.authorName,
        authorAvatarUrl: row.authorAvatarUrl
    }));
}

/** Map deployment ids to their current status (for showing running/failed/…). */
export async function getDeploymentStatuses(ids: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return {};
    const rows = await prisma.deployment.findMany({ where: { id: { in: unique } }, select: { id: true, status: true } });
    return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

/** Set the container port an application listens on (stored in its source config).
 *  Takes effect on the next deploy: the IP:port link and domain routes retarget. */
export async function setApplicationPort(applicationId: string, ownerId: string, port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("A valid port is required");
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { id: true, sourceConfig: true }
    });
    if (!app) throw new Error("Application not found");
    const source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
    source.port = port;
    await prisma.application.update({ where: { id: app.id }, data: { sourceConfig: JSON.stringify(source) } });
}

/**
 * Move an application to a different server (deploy target): the local host or a
 * connected SSH Host. The current deployment is torn down on the OLD server first
 * so it does not keep running orphaned, then the app is retargeted; it redeploys
 * on the new server on the next deploy. No-op when the server is unchanged.
 */
export async function setApplicationServer(applicationId: string, ownerId: string, serverId: string): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true }
    });
    if (!app) throw new Error("Application not found");

    let newTarget;
    if (!serverId || serverId === "local") {
        newTarget = await getOrCreateLocalTarget(ownerId);
    } else {
        const host = await prisma.host.findFirst({ where: { id: serverId, ownerId }, select: { id: true, name: true } });
        if (!host) throw new Error("The selected server was not found");
        newTarget = await getOrCreateHostTarget(host.id, ownerId, host.name);
    }
    if (newTarget.id === app.targetId) return;

    if (app.currentDeploymentId) {
        const composeProject = `polaris-${shortHash(app.id, 8)}`;
        const oldTarget = app.target as TargetRow;
        const ports = await getPorts(oldTarget, ownerId);
        try {
            if (oldTarget.runtime === "swarm") await ports.stackDown(composeProject);
            else await ports.composeDown(composeProject);
        } catch {
            // The old server may be unreachable; retarget anyway rather than trap
            // the app on a dead target.
        } finally {
            await ports.dispose();
        }
        await prisma.deployment.updateMany({
            where: { deployableType: "application", deployableId: applicationId, status: { in: ["running", "stopped"] } },
            data: { status: "removed", finishedAt: new Date() }
        });
    }
    await prisma.application.update({
        where: { id: applicationId },
        data: { targetId: newTarget.id, currentDeploymentId: null }
    });
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
    // Refresh the edge routes so a domain whose first deploy just came up starts
    // serving, and any host-port change is reflected.
    await syncAppRoutes().catch(() => undefined);
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
