/**
 * Deploy orchestration: projects, environments, applications, and the pipeline
 * that turns an application into a running container. A deployment is a database
 * row plus a log file; the runtime driver streams build/deploy output into that
 * file, which the UI tails. Deployments are serialized per target by a small
 * in-memory queue - no external broker - so two deploys of one app never race.
 */

import { join } from "node:path";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { createWriteStream } from "node:fs";
import { getPublicIp } from "./domain-service";
import { commitUrl } from "./deploy/commit-url";
import { decryptSecret } from "@polaris/storage";
import { mkdir, readFile } from "node:fs/promises";
import { ensureLocalCa } from "./local-ca-service";
import { getLatestCommit } from "./github-service";
import { wipeVolume } from "./deploy-volume-service";
import { resolveAutoDomain } from "./network-service";
import { resolveMountTarget } from "./storage-service";
import { resolveWaf, resolveWafBatch } from "./waf-service";
import { LocalRouter, type AppRoute } from "./deploy/router";
import { getFlagsForEnvironment } from "./deploy-project-service";
import { resolveRegistryLogin } from "./registry-credential-service";
import { notifyDeployFinished } from "./notifications/deploy-events";
import { deployHostname, type ZoneMintFailure } from "./domain-zones";
import { gitBuildContext, type GitSource } from "./git-build-service";
import { githubCloneAuthHeader, githubTokenForOwner } from "./github-access";
import { applicationDefaultWafPresets, isTunnelHostname } from "@polaris/core";
import { getDriver, getPorts, toTargetInfo, type TargetRow } from "./deploy/runtime";
import { getOrCreateHostTarget, getOrCreateLocalTarget } from "./deploy-target-service";
import { quickTunnelAppIds, tunnelHostForApp, stopQuickTunnel } from "./deploy/quick-tunnel-service";
import { KEPT_RELEASES, currentReleaseRef, keepsReleases, portSubject, releaseMarker, releaseRef, serviceRef } from "./deploy/releases";
import { bucketHttpMetrics, normalizeRoot, normalizeZoneName, parseHttpLogs, parseWatchPaths, releaseDomain, resolveDockerfilePath, shortHash, shouldDeployForPaths, slugify, type AppDeployPlan, type DeployResult, type HttpLogEntry, type HttpMetricPoint, type RuntimeContext, type RuntimeDriver } from "@polaris/deploy";

/** A locally-installed messaging hub (this catalog app) joins a dedicated web<->hub
 *  network and POSTs inbound events to the web by service DNS - the public app URL
 *  does not resolve from inside a deployed container. Both are computed at deploy
 *  time from the install and the current target, never persisted, so an existing hub
 *  adopts them on its next redeploy and a retarget to a remote server drops them
 *  automatically; a remote hub keeps the public URL and no extra network. */
const HUB_CATALOG_ID = "messaging-bridge";
const HUB_NETWORK = "polaris-hub";
const WEB_INTERNAL_INGEST_URL = "http://web:3000/api/inbox/ingest";

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

/**
 * Every project a user may at least read: their own, the ones they were added
 * to, and the ones the instance shares internally. Read paths take this so a
 * member sees the project at all; write paths still resolve a role first (see
 * deploy-project-access) and then act as the owner.
 */
function visibleProjectWhere(userId: string) {
    return { OR: [{ ownerId: userId }, { members: { some: { userId } } }, { visibility: "internal" }] };
}

/**
 * One service, if this user may read it at all. Same rule as the lists above, so a
 * screen never offers a service in its picker and then refuses to show it - which is
 * what happens whenever a read path authorizes more narrowly than the list that fed
 * it.
 */
export async function visibleApplication(
    applicationId: string,
    userId: string
): Promise<{ id: string; name: string; environmentId: string } | null> {
    return prisma.application.findFirst({
        where: { id: applicationId, environment: { project: visibleProjectWhere(userId) } },
        select: { id: true, name: true, environmentId: true }
    });
}

export async function listProjects(ownerId: string) {
    return prisma.project.findMany({
        where: visibleProjectWhere(ownerId),
        orderBy: { createdAt: "asc" },
        include: {
            environments: {
                include: { applications: { include: { domains: true } }, databases: true },
                orderBy: { createdAt: "asc" }
            }
        }
    });
}

/** Project, environment and service names only - what the firewall's scope selector
 *  needs, without dragging every domain, volume and deployment along for a list of
 *  labels. */
export async function listProjectScopes(ownerId: string) {
    return prisma.project.findMany({
        where: visibleProjectWhere(ownerId),
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            name: true,
            environments: {
                select: {
                    id: true,
                    name: true,
                    applications: { select: { id: true, name: true }, orderBy: { createdAt: "asc" } }
                },
                orderBy: { createdAt: "asc" }
            }
        }
    });
}

export async function getProject(projectId: string, ownerId: string) {
    return prisma.project.findFirst({
        where: { id: projectId, ...visibleProjectWhere(ownerId) },
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
        where: { id: projectId, ...visibleProjectWhere(ownerId) },
        include: {
            environments: {
                include: {
                    applications: {
                        include: { domains: true, target: true, volumes: { include: { connection: { select: { name: true } } } } }
                    },
                    // The child count comes along so the screen can say, before an
                    // instance is removed, that the databases hosted inside it go
                    // with it - the one thing about this that is not recoverable.
                    databases: { include: { _count: { select: { children: true } } } }
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

/** Rename an environment, keeping its slug in step with the new name. A slug
 *  already taken in this project is left alone rather than blocking the rename;
 *  the name is what the operator asked to change. */
export async function renameEnvironment(environmentId: string, ownerId: string, name: string): Promise<void> {
    const environment = await prisma.environment.findFirst({
        where: { id: environmentId, project: { ownerId } },
        select: { id: true, projectId: true }
    });
    if (!environment) throw new Error("Environment not found");
    const slug = slugify(name);
    if (!slug) throw new Error("Environment name must contain letters or digits");
    const taken = await prisma.environment.findFirst({
        where: { projectId: environment.projectId, slug, id: { not: environmentId } },
        select: { id: true }
    });
    await prisma.environment.update({
        where: { id: environmentId },
        data: { name, slug: taken ? undefined : slug }
    });
}

/** Make one environment the project's default - the one a link with no
 *  environment lands on. Exactly one is default at a time. */
export async function setDefaultEnvironment(environmentId: string, ownerId: string): Promise<void> {
    const environment = await prisma.environment.findFirst({
        where: { id: environmentId, project: { ownerId } },
        select: { id: true, projectId: true }
    });
    if (!environment) throw new Error("Environment not found");
    await prisma.environment.updateMany({
        where: { projectId: environment.projectId },
        data: { isDefault: false }
    });
    await prisma.environment.update({ where: { id: environmentId }, data: { isDefault: true } });
}

/** Just enough of a service to name it in a confirmation or a changeset. */
export async function getApplicationSummary(
    applicationId: string,
    ownerId: string
): Promise<{ id: string; name: string; environmentId: string } | null> {
    return prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { id: true, name: true, environmentId: true }
    });
}

/** The same for a managed database, plus the project it sits in - resolved
 *  without an owner filter because the caller authorizes on the project id it
 *  gets back, rather than assuming who owns it. */
export async function getDatabaseSummary(
    databaseId: string
): Promise<{ id: string; name: string; environmentId: string; projectId: string } | null> {
    const row = await prisma.managedDatabase.findUnique({
        where: { id: databaseId },
        select: { id: true, name: true, environmentId: true, environment: { select: { projectId: true } } }
    });
    return row
        ? { id: row.id, name: row.name, environmentId: row.environmentId, projectId: row.environment.projectId }
        : null;
}

/** Who a volume's resources belong to, and the service it hangs off. The caller
 *  authorizes against that service and then acts as the owner. */
export async function getVolumeOwner(
    volumeId: string
): Promise<{ ownerId: string; applicationId: string | null } | null> {
    const row = await prisma.volume.findUnique({
        where: { id: volumeId },
        select: { applicationId: true, target: { select: { ownerId: true } } }
    });
    return row ? { ownerId: row.target.ownerId, applicationId: row.applicationId } : null;
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

/** Delete a project the caller owns. Being an admin on somebody else's project is
 *  enough to change everything in it and deliberately not enough to remove it, so
 *  a non-owner is told plainly rather than getting a silent no-op. */
export async function deleteProject(projectId: string, ownerId: string) {
    const removed = await prisma.project.deleteMany({ where: { id: projectId, ownerId } });
    if (removed.count === 0) throw new Error("Only the project's owner can delete it");
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
    /** Keep earlier builds running beside the current one, Railway-style. Comes
     *  from the project's flags, so a project can set the house style once. */
    keepReleases?: boolean;
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
    const application = await prisma.application.create({
        data: {
            environmentId: input.environmentId,
            targetId: input.targetId,
            name: input.name,
            slug,
            sourceType: input.sourceType,
            sourceConfig: JSON.stringify(input.sourceConfig),
            autoDeploy: input.autoDeploy ?? false,
            deployBranch: input.deployBranch ?? null,
            keepReleases: input.keepReleases ?? false
        }
    });
    // Stack-specific rule packs are decided here, at the one moment the stack is
    // known. Blocking /wp-login.php is a judgement call in general and an obvious one
    // against a Node service, so the pack goes on where that is true rather than
    // instance-wide, where a PHP app would have no way to be exempted from it.
    const presets = applicationDefaultWafPresets(stackHint(input));
    if (presets.length > 0) {
        await prisma.wafRule
            .create({
                data: { scopeType: "application", scopeId: application.id, presets: JSON.stringify(presets) }
            })
            // A service that deploys without its default packs is worse than one that
            // does not deploy at all only if nobody says so - the packs are visible
            // and re-enablable on the firewall page either way.
            .catch((error: unknown) => {
                console.warn(
                    `polaris: default firewall packs for ${application.id} were not applied:`,
                    error instanceof Error ? error.message : error
                );
            });
    }
    return application;
}

/** What a service is built from, as a free-form hint for pack selection: the image
 *  reference for an image deploy, the builder/provider for a repo one. */
function stackHint(input: CreateApplicationInput): string {
    const config = input.sourceConfig as Record<string, unknown> | undefined;
    const parts = [input.sourceType, config?.imageRef, config?.provider, config?.builder, config?.repoUrl];
    return parts.filter((part): part is string => typeof part === "string").join(" ");
}

/**
 * The random hostname this app already holds directly inside a zone, if any. The
 * match is exact by construction - one label under the zone host - because a suffix
 * test alone would treat `app.plr.example.com` as living in the base-domain zone
 * `example.com` and hand back a hostname from a different zone entirely.
 */
async function findRandomDomain(
    applicationId: string,
    zoneHost: string
): Promise<{ id: string; hostname: string; targetPort: number; certResolver: string } | null> {
    const rows = await prisma.domain.findMany({
        where: { applicationId, kind: "random", hostname: { endsWith: `.${zoneHost}` } },
        select: { id: true, hostname: true, targetPort: true, certResolver: true }
    });
    const depth = zoneHost.split(".").length + 1;
    return rows.find((row) => row.hostname.split(".").length === depth) ?? null;
}

/**
 * The free subdomain this app was already given, if any. "auto" and "lan" are the
 * two shapes the generator produces (public name vs LAN-only name), and an app
 * holds at most one - it is the address the service is known by.
 */
async function findAutoDomain(
    applicationId: string
): Promise<{ id: string; hostname: string; targetPort: number; certResolver: string } | null> {
    return prisma.domain.findFirst({
        where: { applicationId, kind: { in: ["auto", "lan"] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, hostname: true, targetPort: true, certResolver: true }
    });
}

/** Whether a hostname is already routed somewhere - including to this same service,
 *  which holds it just as firmly. A zone subdomain is first come, first served. */
async function hostnameTaken(hostname: string): Promise<boolean> {
    return (await prisma.domain.count({ where: { hostname } })) > 0;
}

export interface ZoneSubdomainCheck {
    /** The label the field should hold: what was asked for, or a free default. */
    subdomain: string;
    /** The hostname it produces, so the operator sees the whole name. */
    hostname: string;
    available: boolean;
    /** Set when what was typed leaves no usable DNS label. */
    invalid?: boolean;
}

/**
 * Resolve the subdomain of a zone hostname before it is created. With nothing typed
 * it proposes the service's own name - the address people would guess - and falls
 * back to a disambiguated one when that is already answering, so the default offered
 * is always free. With something typed it reports whether that name is still
 * available, which is what lets the field say so while the operator types.
 *
 * A release keeps adding its commit to the right of whichever name is chosen here
 * (see `releaseDomain`), so per-build URLs follow the service's address rather than
 * competing with it.
 */
export async function checkZoneSubdomain(
    applicationId: string,
    ownerId: string,
    opts: { zoneLabel?: string; subdomain?: string }
): Promise<ZoneSubdomainCheck | ZoneMintFailure> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { slug: true }
    });
    if (!app) throw new Error("Application not found");
    const typed = opts.subdomain?.trim() ?? "";
    const base = slugify(app.slug) || "app";
    // The id suffix, not a counter: two services can slug to the same thing, and the
    // fallback has to stay the same name every time this is asked.
    const candidates = typed ? [typed] : [base, `${base}-${shortHash(applicationId, 4)}`];
    let result: ZoneSubdomainCheck = { subdomain: base, hostname: "", available: false };
    for (const candidate of candidates) {
        const minted = await deployHostname(app.slug, { zoneLabel: opts.zoneLabel, subdomain: candidate });
        if (minted === "bad-name") return { subdomain: typed, hostname: "", available: false, invalid: true };
        if (typeof minted === "string") return minted;
        const taken = await hostnameTaken(minted.hostname);
        result = { subdomain: normalizeZoneName(candidate), hostname: minted.hostname, available: !taken };
        if (!taken) break;
    }
    return result;
}

/**
 * Attach a domain to an application. With no hostname the app's free auto
 * subdomain is used - minted the first time and reused unchanged after that, so a
 * redeploy never moves the service to a different address (Traefik + Let's Encrypt
 * serves it); the routing labels take effect on the next deploy. Returns the
 * hostname.
 */
export async function addApplicationDomain(
    applicationId: string,
    ownerId: string,
    opts: {
        hostname?: string;
        targetPort: number;
        cert?: "internal" | "le" | "none";
        /** Mint the hostname in this deploy zone instead of the default one. */
        zoneLabel?: string;
        /** Mint an unguessable hostname rather than one derived from the name. */
        random?: boolean;
        /** The subdomain to take in the zone, instead of one derived from the name. */
        subdomain?: string;
    }
): Promise<string> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        include: { target: { include: { host: true } } }
    });
    if (!app) throw new Error("Application not found");
    // A remote-server app's auto domain comes from THAT server - its own wildcard
    // domain, or failing that its IP - and is served by its own edge, never from the
    // Polaris host's, which would point the name at the wrong box.
    const remoteHost = app.target.kind !== "local" ? app.target.host : null;
    const remoteIp = remoteHost?.address?.trim();
    let hostname = opts.hostname?.trim();
    let kind = "custom";
    // Cert/exposure resolution: a caller-chosen mode wins (e.g. "none" for a domain
    // fronted by a tunnel/proxy that terminates TLS). Otherwise a custom domain gets
    // automatic HTTPS from Let's Encrypt, and a free/LAN subdomain (sslip.io on a
    // private IP, where ACME cannot validate) is served with Caddy's internal CA.
    let certResolver: string = opts.cert ?? "le";
    // A zone hostname is only for services on the Polaris host: the zone's wildcard
    // record points at this box, so a remote server's app would get a name that
    // resolves to the wrong machine. Those take their own server's domain below - and
    // are told so, rather than being handed a different hostname than they asked for
    // (a "random" one that is neither random nor in the zone they named).
    if (!hostname && remoteHost && (opts.zoneLabel !== undefined || opts.random)) {
        throw new Error(
            "This service runs on another server, so it takes that server's own wildcard domain rather than a zone hostname. Set one on the server, or enter a custom domain."
        );
    }
    if (!hostname && (opts.zoneLabel !== undefined || opts.random)) {
        const minted = await deployHostname(app.slug, {
            zoneLabel: opts.zoneLabel,
            random: opts.random,
            subdomain: opts.subdomain
        });
        if (minted === "bad-name") {
            throw new Error("Use letters, digits and dashes for the subdomain.");
        }
        if (minted === "no-domain") {
            throw new Error("No domain is configured yet. Run the guided setup under Domains first.");
        }
        if (minted === "unverified") {
            throw new Error(
                "That domain has not been seen working yet. Run the DNS check under Domains, then add the domain."
            );
        }
        if (minted === "unknown-zone") {
            throw new Error("That zone no longer exists. Pick another one, or add it back under Domains.");
        }
        // A random name is meant to be unguessable, not new on every click: minting a
        // fresh one each time would pile up a Domain row, an edge route and a
        // certificate request per press, with nothing saying which is the real URL.
        const existing = opts.random ? await findRandomDomain(applicationId, minted.zoneHost) : null;
        if (existing) {
            // The operator may have changed the port since; the reused name should
            // serve what they just asked for rather than silently keeping the old one.
            if (existing.targetPort !== opts.targetPort || existing.certResolver !== (opts.cert ?? "le")) {
                await prisma.domain.update({
                    where: { id: existing.id },
                    data: { targetPort: opts.targetPort, certResolver: opts.cert ?? "le" }
                });
                await syncAppRoutes().catch(() => undefined);
            }
            return existing.hostname;
        }
        hostname = minted.hostname;
        // Marked distinctly so the next random request finds exactly this row, and
        // never a name derived from the service (which must keep its own hostname).
        kind = opts.random ? "random" : "auto";
        if (!opts.cert) certResolver = "le";
    }
    if (!hostname) {
        // The free subdomain an app already holds is the address people have saved,
        // linked and bookmarked, so it is minted ONCE and reused from then on. The
        // resolution below reads live network state (public IP, mode, whether a zone
        // has been proven), all of which move over an install's life - re-deriving it
        // on a later deploy would hand the same service a second, different name and
        // quietly change what it answers on. Port and certificate still follow what
        // the caller asked for, as when a random name is reused.
        const pinned = await findAutoDomain(applicationId);
        if (pinned) {
            const wantedCert = opts.cert ?? pinned.certResolver;
            if (pinned.targetPort !== opts.targetPort || pinned.certResolver !== wantedCert) {
                await prisma.domain.update({
                    where: { id: pinned.id },
                    data: { targetPort: opts.targetPort, certResolver: wantedCert }
                });
                await syncAppRoutes().catch(() => undefined);
            }
            return pinned.hostname;
        }
        // The network mode decides the auto domain: a wildcard/public setup mints a
        // real internet-reachable name with Let's Encrypt; otherwise a LAN-only
        // sslip.io name (kind "lan") - so the app never gets a subdomain that
        // silently fails off the network; the UI labels it and offers public setup.
        const plan = await resolveAutoDomain(
            app.slug,
            remoteHost ? { ip: remoteIp ?? "", wildcard: remoteHost.wildcardDomain } : undefined
        );
        if (!plan) {
            throw new Error(
                remoteHost
                    ? "This server is reached by name and has no wildcard domain, so there is no subdomain to generate. Set one on the server, or enter a custom domain."
                    : "No public IP is configured for free subdomains. Set one in Domains settings, or enter a custom domain."
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
    // "No-op" is about the row, not its settings, though: re-adding after changing the
    // target port is how an operator re-points a domain, and returning the hostname
    // with the old port still routed reports success for something that did not happen.
    const existing = await prisma.domain.findFirst({
        where: { hostname, applicationId },
        select: { id: true, targetPort: true, certResolver: true }
    });
    if (existing) {
        if (existing.targetPort !== opts.targetPort || existing.certResolver !== certResolver) {
            await prisma.domain.update({
                where: { id: existing.id },
                data: { targetPort: opts.targetPort, certResolver }
            });
        }
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
/**
 * What a hostname's port is derived from. A release hostname keeps pointing at the
 * build it names, for as long as that build is kept. The service's own domains
 * follow whichever release is current - which is how the address stays put while
 * what answers on it moves - and fall back to the service itself for a service
 * that does not keep its releases side by side.
 */
function dialTarget(
    domain: { applicationId: string; deploymentId: string | null; application: { currentDeploymentId: string | null } },
    isolated: ReadonlySet<string>
): string {
    if (domain.deploymentId) return domain.deploymentId;
    const current = domain.application.currentDeploymentId;
    return portSubject(domain.applicationId, current ? { id: current, isolated: isolated.has(current) } : null);
}

export async function syncAppRoutes(): Promise<void> {
    const domains = await prisma.domain.findMany({
        where: { enabled: true },
        select: {
            id: true,
            hostname: true,
            certResolver: true,
            applicationId: true,
            deploymentId: true,
            application: { select: { target: { select: { kind: true } }, currentDeploymentId: true } }
        }
    });
    // Which of the serving releases run in a project of their own, and so publish on
    // a port of their own. One query for the whole edge rather than one per domain.
    const isolated = new Set(
        (
            await prisma.deployment.findMany({
                where: {
                    isolated: true,
                    id: { in: domains.map((domain) => domain.application.currentDeploymentId).filter((id) => id !== null) }
                },
                select: { id: true }
            })
        ).map((deployment) => deployment.id)
    );
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
        const emptyWaf = {
            allowLists: [],
            deny: [],
            requireLogin: false,
            browserIntegrity: false,
            sqlInjectionProtection: true,
            xssProtection: true,
            emailObfuscation: true,
            presets: [],
            rules: []
        };
        for (const domain of localDomains) {
            const rule = waf.get(domain.applicationId) ?? emptyWaf;
            localRoutes.push({
                id: domain.id,
                hostname: domain.hostname,
                certResolver: domain.certResolver,
                dialHost: localIp,
                dialPort: hostPortForApp(dialTarget(domain, isolated)),
                allowLists: rule.allowLists,
                deny: rule.deny,
                presets: rule.presets,
                rules: rule.rules,
                requireLogin: rule.requireLogin,
                browserIntegrity: rule.browserIntegrity,
                sqlInjectionProtection: rule.sqlInjectionProtection,
                xssProtection: rule.xssProtection,
                emailObfuscation: rule.emailObfuscation
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
                presets: rule.presets,
                rules: rule.rules,
                requireLogin: rule.requireLogin,
                browserIntegrity: rule.browserIntegrity,
                sqlInjectionProtection: rule.sqlInjectionProtection,
                xssProtection: rule.xssProtection,
                emailObfuscation: rule.emailObfuscation
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
                // A service with a NAS volume never runs its releases side by side, so
                // its own container name is the one serving it.
                const container = serviceRef(app.environment.project.slug, app.slug, app.id).name;
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

/** Resolve an app to the container ref of the release currently serving it, its
 *  compose project, and its target. */
async function appRuntime(applicationId: string, ownerId: string) {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true, volumes: { select: { id: true } } }
    });
    if (!app) throw new Error("Application not found");
    const ref = await currentReleaseRef(app);
    return { app, container: ref.name, project: ref.project, target: app.target as TargetRow };
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
 * Take a service's containers down on ONE named server, whichever server it now
 * belongs to.
 *
 * Every other teardown works from the app's current target, which is right until
 * the app has just been moved: then the containers still to remove are the ones on
 * the server it came from, and the app is already pointing at the new one. Moving a
 * service without a gap needs exactly that order - up over there, then down over
 * here - so the old server has to be nameable on its own. Deployment rows are left
 * alone: the app's live release is the new server's, and that is the one they
 * describe.
 */
export async function stopApplicationOnTarget(
    applicationId: string,
    ownerId: string,
    targetId: string
): Promise<void> {
    const [app, target] = await Promise.all([
        prisma.application.findFirst({
            where: { id: applicationId, environment: { project: { ownerId } } },
            include: { environment: { include: { project: true } } }
        }),
        prisma.deployTarget.findFirst({ where: { id: targetId, ownerId } })
    ]);
    if (!app || !target) return;
    const ports = await getPorts(target as TargetRow, ownerId);
    try {
        await downAllReleases(app, ports, target.runtime === "swarm");
    } finally {
        await ports.dispose();
    }
}

/**
 * Remove the running deployment entirely: tear the project down (compose down /
 * stack rm) and mark its releases removed, clearing the app's current pointer.
 * The application config stays, so it can be deployed again later.
 */
export async function removeApplicationDeployment(applicationId: string, ownerId: string): Promise<void> {
    const { app, target } = await appRuntime(applicationId, ownerId);
    const ports = await getPorts(target, ownerId);
    try {
        // Every release, not only the current one: a service that keeps its history
        // has a container per kept build, and leaving those up would keep serving a
        // service the operator just removed.
        await downAllReleases(app, ports, target.runtime === "swarm");
    } finally {
        await ports.dispose();
    }
    await prisma.domain.deleteMany({ where: { applicationId, kind: "release" } });
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
        select: { id: true, environmentId: true, volumes: { select: { id: true } } }
    });
    if (!app) throw new Error("Application not found");

    // Destroying the data is opt-in per project. It has to happen while the
    // container is still up - that is the only way in to the volume - so it runs
    // before the deployment comes down, not after.
    const flags = await getFlagsForEnvironment(app.environmentId);
    if (flags.wipeVolumesOnDelete) {
        for (const volume of app.volumes) {
            await wipeVolume(volume.id, ownerId).catch(() => undefined);
        }
    }

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

/**
 * Build the runtime plan for an application from its stored config. Given the
 * release being deployed, a service that keeps its history plans that build into
 * its own project, on its own port, answering on its own hostname - so the release
 * before it keeps running. The service's own domains are deliberately left off it:
 * they follow whichever release is current, and the edge re-points them the moment
 * this one is promoted.
 */
async function buildAppPlan(
    applicationId: string,
    ownerId: string,
    release?: { id: string; commitSha: string | null }
): Promise<{ plan: AppDeployPlan; target: TargetRow; gitSource?: GitSource; keepsHistory: boolean }> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true, volumes: true, domains: true }
    });
    if (!app) throw new Error("Application not found");

    const project = app.environment.project;
    const base = serviceRef(project.slug, app.slug, app.id);
    const kept = release !== undefined && keepsReleases(app);
    const ref = kept ? releaseRef(base, releaseMarker(release)) : base;
    const source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
    const env = await mergedEnv(app.environmentId, app.id);
    // A locally-targeted messaging hub reaches the web's ingest over the dedicated
    // hub network by service DNS; detected from the install + target here (not
    // persisted), so a remote hub keeps the public URL from its stored env.
    const isLocalHub =
        app.target.kind === "local" &&
        Boolean(
            await prisma.installedApp.findFirst({
                where: { catalogId: HUB_CATALOG_ID, applicationId, status: { not: "removed" } },
                select: { id: true }
            })
        );
    if (isLocalHub) env.WEB_INGEST_URL = WEB_INTERNAL_INGEST_URL;
    const healthcheck = app.healthcheck ? (JSON.parse(app.healthcheck) as AppDeployPlan["healthcheck"]) : undefined;
    // Resolved WAF rules for this service, materialized into edge labels on deploy so
    // a remote server's own Traefik enforces them without the control plane.
    const resolvedWaf = await resolveWaf(app.id);
    // Email obfuscation is deliberately absent from this test even though it is on by
    // default: it would be true for every service, so including it would put the guard
    // in front of every route on the instance to deliver a control the forwardAuth
    // path cannot apply anyway. It rides on the proxy wiring instead.
    //
    // The injection checks ARE in it, for the opposite reason: forwardAuth is exactly
    // where they apply, so a service that has nothing else set still needs the guard to
    // get them. It costs no extra hop in practice - the instance-wide packs already put
    // the guard in front of every route on a default instance.
    const waf =
        resolvedWaf.allowLists.length > 0 ||
        resolvedWaf.deny.length > 0 ||
        resolvedWaf.presets.length > 0 ||
        resolvedWaf.rules.length > 0 ||
        resolvedWaf.requireLogin ||
        resolvedWaf.browserIntegrity ||
        resolvedWaf.sqlInjectionProtection ||
        resolvedWaf.xssProtection
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
        ref,
        mounts,
        // A kept release publishes on a port of its own, derived from the deployment
        // rather than the app, so it does not fight the release it stands beside for
        // the service's port.
        expose: { host: hostPortForApp(kept ? release.id : app.id), container: containerPort },
        // When the user has not pinned a container port, the value above is a guess
        // (a domain's target port or a source default); let the runtime refine it from
        // the image's own exposed port so IP:port reaches a live socket, not a dead one.
        autoContainerPort: storedPort === undefined,
        build: {
            method: (app.sourceType as AppDeployPlan["build"]["method"]) ?? "image",
            name: app.slug,
            imageRef: typeof source.imageRef === "string" ? source.imageRef : undefined,
            // Both derived from the root directory: a monorepo's one app is built from a
            // context that stays the whole repository (the lockfile and the shared
            // packages it needs are above it), with the builder pointed at its own
            // directory inside that context.
            dockerfilePath: resolveDockerfilePath(
                typeof source.rootDirectory === "string" ? source.rootDirectory : undefined,
                typeof source.dockerfilePath === "string" ? source.dockerfilePath : undefined
            ),
            rootDirectory: normalizeRoot(typeof source.rootDirectory === "string" ? source.rootDirectory : undefined),
            contextPath: ".",
            composeYaml: typeof source.composeYaml === "string" ? source.composeYaml : undefined
        },
        env,
        replicas: app.replicas,
        // Extra external networks the service joins: a locally-installed messaging
        // hub joins the dedicated web<->hub network to reach the web's ingest by DNS.
        extraNetworks: isLocalHub ? [HUB_NETWORK] : undefined,
        waf,
        // Disabled domains keep their record but are left out of the plan so no route
        // labels are emitted for them until they are turned back on. A kept release
        // carries only its own hostname; the service's own domains are re-pointed at
        // it by the edge on promote, so no two releases ever claim the same address.
        domains: app.domains
            .filter((domain) => domain.enabled && (kept ? domain.deploymentId === release.id : domain.deploymentId === null))
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
        // GitHub-sourced repos clone with the project owner's own account so their
        // private repositories build, falling back to the App installation an
        // administrator put on them; the header is null (public clone) when there
        // is neither.
        if (source.provider === "github") {
            const owner = gitSource.repoUrl.match(/github\.com[/:]([^/]+)\//i)?.[1];
            const authHeader = await githubCloneAuthHeader(ownerId, owner);
            if (authHeader) gitSource.authHeader = authHeader;
        }
    }
    return { plan, target: app.target, gitSource, keepsHistory: keepsReleases(app) };
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
    const { plan, target, gitSource, keepsHistory } = await buildAppPlan(applicationId, ownerId);

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
            const token = await githubTokenForOwner(ownerId, parsed.owner);
            const commit = await getLatestCommit(
                parsed.owner,
                parsed.repo,
                commitSha ?? gitSource.branch ?? "HEAD",
                token
            ).catch(() => null);
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
            authorAvatarUrl,
            isolated: keepsHistory
        }
    });
    // A service that keeps its history needs the release's own hostname and its own
    // project before the plan is handed to the runtime, so the container comes up
    // answering on it. Only that case pays for the second plan.
    let planned = plan;
    if (keepsHistory) {
        const release = { id: deployment.id, commitSha };
        await ensureReleaseDomain(applicationId, release).catch((error) => {
            console.error("polaris: could not name this release:", error);
            return null;
        });
        planned = (await buildAppPlan(applicationId, ownerId, release)).plan;
    }
    // The app keeps pointing at the previous successful release until this one
    // actually succeeds (see executeDeployment) - so history never shows a build
    // as "current" before it finishes, and the old version stays active until the
    // new one is up (zero-downtime cutover, the way Railway does it).
    queue.enqueue(target.id, () => runDeployment(deployment.id, planned, target, ownerId, gitSource));
    return deployment.id;
}

/** A deploy that has not finished in this long is reported as failed to whoever is
 *  waiting on it, so one wedged build cannot hold an operation open forever. */
const DEPLOY_WAIT_TIMEOUT_MS = 20 * 60_000;
const DEPLOY_WAIT_POLL_MS = 2_000;

/**
 * Deploy and wait for the verdict: null when it is up, or why it is not.
 *
 * Deploys are normally fire-and-forget - the UI follows the log - but a migration
 * cannot be: whether the new one came up is what decides if the old one may be
 * taken down, and getting that order wrong is what turns a move into an outage.
 */
export async function deployAndWait(
    applicationId: string,
    ownerId: string,
    userId: string
): Promise<string | null> {
    let deploymentId: string;
    try {
        deploymentId = await deployApplication(applicationId, ownerId, userId);
    } catch (caught) {
        return caught instanceof Error ? caught.message : "the deploy could not be started";
    }
    const deadline = Date.now() + DEPLOY_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, DEPLOY_WAIT_POLL_MS));
        const row = await prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { status: true, error: true }
        });
        if (!row) return "the deploy disappeared";
        if (row.status === "running") return null;
        if (row.status === "failed") return row.error ?? "the deploy failed";
        if (row.status === "removed") return "the deploy was removed";
    }
    return "the deploy did not finish in time";
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
    /** Where to read this commit on the forge, when the source is one we can place. */
    commitUrl: string | null;
    /** The hostname this release answers on while it is kept, if it has one. */
    hostname: string | null;
}

/** An application's deployment history, most recent first (owner-checked). */
export async function listDeployments(applicationId: string, ownerId: string): Promise<DeploymentSummary[]> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { id: true, currentDeploymentId: true, sourceConfig: true }
    });
    if (!app) throw new Error("Application not found");
    const repoUrl = (() => {
        try {
            const source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
            return typeof source.repoUrl === "string" ? source.repoUrl : "";
        } catch {
            return "";
        }
    })();
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
    // The hostname a kept release answers on. Only releases that are still up have
    // one, so the rest of the history simply shows none rather than a dead link.
    const hostnames = new Map(
        (
            await prisma.domain.findMany({
                where: { applicationId, kind: "release", enabled: true, deploymentId: { in: rows.map((row) => row.id) } },
                select: { hostname: true, deploymentId: true }
            })
        ).map((domain) => [domain.deploymentId, domain.hostname])
    );
    return rows.map((row) => ({
        id: row.id,
        status: row.status,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
        isCurrent: row.id === app.currentDeploymentId,
        commitMessage: row.commitMessage,
        commitSha: row.commitSha,
        authorName: row.authorName,
        authorAvatarUrl: row.authorAvatarUrl,
        commitUrl: repoUrl && row.commitSha ? commitUrl(repoUrl, row.commitSha) : null,
        hostname: hostnames.get(row.id) ?? null
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
 * Set where in its repository an application lives, and which Dockerfile it builds.
 *
 * Editable after creation because a repository grows a second service long after the
 * first one was added, and the alternative - delete the service and make it again -
 * loses its domains, its variables and its history to change one string.
 *
 * The root directory is normalized here as well as on create: this is the other door
 * into the same stored value, and one that validates and one that does not is not a
 * validated value. Takes effect on the next deploy.
 */
export async function setApplicationSourcePaths(
    applicationId: string,
    ownerId: string,
    paths: { rootDirectory?: string | null; dockerfilePath?: string | null }
): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { id: true, sourceConfig: true }
    });
    if (!app) throw new Error("Application not found");
    const source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
    source.rootDirectory = normalizeRoot(paths.rootDirectory ?? undefined);
    const dockerfile = paths.dockerfilePath?.trim();
    if (dockerfile !== undefined) source.dockerfilePath = dockerfile || undefined;
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
        const oldTarget = app.target as TargetRow;
        const ports = await getPorts(oldTarget, ownerId);
        try {
            await downAllReleases(app, ports, oldTarget.runtime === "swarm");
        } catch {
            // The old server may be unreachable; retarget anyway rather than trap
            // the app on a dead target.
        } finally {
            await ports.dispose();
        }
        await prisma.domain.deleteMany({ where: { applicationId, kind: "release" } });
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
    settings: {
        autoDeploy: boolean;
        deployBranch?: string | null;
        commitFilter?: string | null;
        watchPaths?: string | null;
        keepReleases?: boolean;
    }
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
            // Stored as typed (one glob per line); parsed where it is matched, so the
            // field reads back exactly as it was written.
            watchPaths: settings.watchPaths?.trim() || null,
            ...(settings.keepReleases !== undefined ? { keepReleases: settings.keepReleases } : {})
        }
    });
    // Giving up the history leaves the older versions running with nothing pointing
    // at them, so they come down and their hostnames go with them. The service's own
    // address is untouched - the current release keeps serving it, and takes back the
    // service's own container name on its next deploy.
    if (settings.keepReleases === false && app.keepReleases) {
        await releaseCurrentOnly(applicationId, ownerId).catch((error) => {
            console.error("polaris: could not take the superseded releases down:", error);
        });
        await syncAppRoutes().catch(() => undefined);
    }
}

/** Take down every release except the one currently serving, and forget their
 *  hostnames. Used when a service stops keeping its history. */
async function releaseCurrentOnly(applicationId: string, ownerId: string): Promise<void> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true }
    });
    if (!app) return;
    const superseded = (
        await prisma.deployment.findMany({
            where: {
                deployableType: "application",
                deployableId: applicationId,
                status: { in: ["running", "stopped"] },
                isolated: true
            },
            select: { id: true, commitSha: true }
        })
    ).filter((release) => release.id !== app.currentDeploymentId);
    if (superseded.length === 0) return;
    const base = serviceRef(app.environment.project.slug, app.slug, app.id);
    const ports = await getPorts(app.target as TargetRow, ownerId);
    try {
        for (const release of superseded) {
            await ports.composeDown(releaseRef(base, releaseMarker(release)).project).catch(() => undefined);
        }
    } finally {
        await ports.dispose().catch(() => undefined);
    }
    await prisma.domain.deleteMany({
        where: { applicationId, kind: "release", deploymentId: { in: superseded.map((release) => release.id) } }
    });
    await prisma.deployment.updateMany({
        where: { id: { in: superseded.map((release) => release.id) } },
        data: { status: "removed", finishedAt: new Date() }
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
    /** Repository-relative paths the push touched, for the per-service watch paths.
     *  Empty means they could not be determined, and every matching service deploys. */
    changedPaths?: readonly string[];
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
        // Several services can track the same repository. Without this every one of
        // them redeploys on every push, which is what makes a monorepo unusable here.
        const watch = parseWatchPaths(app.watchPaths);
        if (!shouldDeployForPaths(input.changedPaths ?? [], watch)) {
            // Said out loud: a service that stops deploying reads as a broken webhook
            // unless something states it was a deliberate skip.
            console.info(
                `polaris: skipping auto-deploy of ${app.slug}; the push touched nothing it watches (${watch.join(", ")})`
            );
            continue;
        }
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
 * Forget the hostname a release was given when its deploy does not come up. The
 * name is created before the build so the container can answer on it; a build that
 * failed has nothing behind it, and leaving the record would list a dead link and
 * keep the edge asking for a certificate nothing serves.
 */
async function dropReleaseDomain(deploymentId: string): Promise<void> {
    const removed = await prisma.domain.deleteMany({ where: { deploymentId, kind: "release" } });
    if (removed.count > 0) await syncAppRoutes().catch(() => undefined);
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
        else await dropReleaseDomain(deploymentId);
        await notifyDeployFinished({ deploymentId, ownerId, ok: result.ok });
    } catch (error) {
        log(Buffer.from(`\n[error] ${error instanceof Error ? error.message : String(error)}\n`));
        await prisma.deployment.update({
            where: { id: deploymentId },
            data: { status: "failed", error: error instanceof Error ? error.message : "deploy failed", finishedAt: new Date() }
        });
        await dropReleaseDomain(deploymentId);
        await notifyDeployFinished({ deploymentId, ownerId, ok: false });
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
 *
 * Promoting is what moves the service's address: `syncAppRoutes` re-points the
 * service's own domains at whichever release is current, so the address never
 * changes even though what answers on it does.
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
    await retireOldReleases(dep.deployableId).catch((error) => {
        console.error("polaris: could not retire superseded releases:", error);
    });
    // Refresh the edge routes so a domain whose first deploy just came up starts
    // serving, and any host-port change is reflected.
    await syncAppRoutes().catch(() => undefined);
}

/**
 * Give this deployment the hostname it will answer on for as long as it is kept:
 * the service's own address with the release marker added to it. Derived from the
 * stored address rather than resolved afresh, so the release lands on the same
 * base and the same certificate as the service itself.
 *
 * Returns null when there is nothing to derive from (no address yet) or the name
 * would not fit - the deploy carries on, it simply has no release URL.
 */
async function ensureReleaseDomain(
    applicationId: string,
    release: { id: string; commitSha: string | null }
): Promise<string | null> {
    const stable = await prisma.domain.findFirst({
        where: { applicationId, deploymentId: null, kind: { in: ["auto", "lan"] } },
        orderBy: { createdAt: "asc" },
        select: { hostname: true, targetPort: true, certResolver: true, pathPrefix: true }
    });
    if (!stable) return null;
    const hostname = releaseDomain(stable.hostname, releaseMarker(release));
    if (!hostname) return null;
    // Re-deploying the same commit lands on the same hostname; point the existing
    // record at the new build rather than failing on the unique hostname.
    const existing = await prisma.domain.findUnique({ where: { hostname }, select: { id: true, applicationId: true } });
    if (existing) {
        if (existing.applicationId !== applicationId) return null;
        await prisma.domain.update({
            where: { id: existing.id },
            data: { deploymentId: release.id, targetPort: stable.targetPort, certResolver: stable.certResolver }
        });
        return hostname;
    }
    await prisma.domain.create({
        data: {
            applicationId,
            hostname,
            kind: "release",
            deploymentId: release.id,
            targetPort: stable.targetPort,
            certResolver: stable.certResolver,
            pathPrefix: stable.pathPrefix
        }
    });
    return hostname;
}

/**
 * Tear down the releases that have fallen out of the kept window: their container
 * goes, their hostname goes with it, and the row is marked removed. Without this a
 * service that keeps history would accumulate a container and a certificate per
 * commit until the host ran out of room. The current release is never a candidate.
 */
async function retireOldReleases(applicationId: string): Promise<void> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        include: { environment: { include: { project: true } }, target: true }
    });
    const current = app?.currentDeploymentId
        ? await prisma.deployment.findUnique({ where: { id: app.currentDeploymentId }, select: { isolated: true } })
        : null;
    if (!app || !current?.isolated) return;
    const kept = await prisma.deployment.findMany({
        where: { deployableType: "application", deployableId: applicationId, status: "running", isolated: true },
        orderBy: { createdAt: "desc" },
        select: { id: true, commitSha: true }
    });
    const retiring = kept.slice(KEPT_RELEASES).filter((release) => release.id !== app.currentDeploymentId);

    const base = serviceRef(app.environment.project.slug, app.slug, app.id);
    const ports = await getPorts(app.target as TargetRow, app.environment.project.ownerId);
    try {
        // The service's own project, left behind the first time it started keeping its
        // releases apart. Nothing points at it any more, and it still holds the
        // service's port; downing it is a no-op once it is empty.
        await ports.composeDown(base.project).catch(() => undefined);
        for (const release of retiring) {
            await ports.composeDown(releaseRef(base, releaseMarker(release)).project).catch(() => undefined);
            await prisma.domain.deleteMany({ where: { applicationId, deploymentId: release.id } });
            await prisma.deployment.update({
                where: { id: release.id },
                data: { status: "removed", finishedAt: new Date() }
            });
        }
    } finally {
        await ports.dispose().catch(() => undefined);
    }
}

/**
 * Take every release of a service down, whichever project each one runs under.
 * Used when the service itself is going away, moving server, or giving up its
 * history - anything that leaves a container behind with nothing pointing at it.
 */
async function downAllReleases(
    app: { id: string; slug: string; environment: { project: { slug: string } } },
    ports: Awaited<ReturnType<typeof getPorts>>,
    swarm: boolean
): Promise<void> {
    const base = serviceRef(app.environment.project.slug, app.slug, app.id);
    const releases = await prisma.deployment.findMany({
        where: { deployableType: "application", deployableId: app.id, status: { in: ["running", "stopped"] } },
        select: { id: true, commitSha: true }
    });
    const projects = [base.project, ...releases.map((release) => releaseRef(base, releaseMarker(release)).project)];
    for (const project of [...new Set(projects)]) {
        if (swarm) await ports.stackDown(project).catch(() => undefined);
        else await ports.composeDown(project).catch(() => undefined);
    }
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
