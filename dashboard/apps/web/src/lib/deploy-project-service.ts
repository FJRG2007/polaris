/**
 * Everything a project has that is not a service: its identity, who is on it,
 * what reports its deploys, what may act on it through the API, and how it
 * behaves.
 *
 * Authorization is not done here - the caller resolves it through
 * deploy-project-access and passes the project owner's id in as `ownerId`, so
 * this module never has to re-derive who is allowed and there is exactly one
 * place that answers that question.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { slugify } from "@polaris/deploy";
import { createApiKey } from "@polaris/auth";
import { contactLines } from "@/lib/privacy-service";
import { sendWebhook } from "./notifications/webhook-sender";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import {
    defaultProjectFlags,
    detectWebhookFormat,
    maskWebhookUrl,
    parseProjectFlags,
    TOKEN_LIFETIME_DAYS,
    type ProjectFlags,
    type ProjectRole,
    type ProjectTokenInput,
    type ProjectVisibility,
    type ProjectWebhookInput,
    type WebhookFormat
} from "@polaris/core";

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

export interface ProjectEnvironmentView {
    id: string;
    name: string;
    slug: string;
    isDefault: boolean;
    serviceCount: number;
    createdAt: string;
}

export interface ProjectSettingsView {
    id: string;
    name: string;
    slug: string;
    description: string;
    visibility: ProjectVisibility;
    flags: ProjectFlags;
    ownerId: string;
    ownerName: string;
    createdAt: string;
    environments: ProjectEnvironmentView[];
    serviceCount: number;
}

export async function getProjectSettings(projectId: string): Promise<ProjectSettingsView> {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
            owner: { select: { name: true } },
            environments: {
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    isDefault: true,
                    createdAt: true,
                    _count: { select: { applications: true, databases: true } }
                }
            }
        }
    });
    if (!project) throw new Error("Project not found");
    const environments = project.environments.map((environment) => ({
        id: environment.id,
        name: environment.name,
        slug: environment.slug,
        isDefault: environment.isDefault,
        serviceCount: environment._count.applications + environment._count.databases,
        createdAt: environment.createdAt.toISOString()
    }));
    return {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description ?? "",
        visibility: project.visibility as ProjectVisibility,
        flags: parseProjectFlags(project.flags),
        ownerId: project.ownerId,
        ownerName: project.owner.name,
        createdAt: project.createdAt.toISOString(),
        environments,
        serviceCount: environments.reduce(
            (total, environment) => total + environment.serviceCount,
            0
        )
    };
}

/**
 * Rename a project and reword its description.
 *
 * The slug follows the name, because it is what a container is named after and
 * a project called something else with the old slug baked into every service is
 * a worse outcome than one rename. A collision keeps the old slug rather than
 * refusing the rename: the name is what the operator asked to change.
 */
export async function updateProjectGeneral(input: {
    projectId: string;
    ownerId: string;
    name: string;
    description: string;
}): Promise<void> {
    const desired = slugify(input.name);
    if (!desired) throw new Error("The name must contain letters or digits");
    const taken = await prisma.project.findFirst({
        where: { ownerId: input.ownerId, slug: desired, id: { not: input.projectId } },
        select: { id: true }
    });
    await prisma.project.update({
        where: { id: input.projectId },
        data: {
            name: input.name,
            slug: taken ? undefined : desired,
            description: input.description.trim() || null
        }
    });
}

export async function setProjectVisibility(
    projectId: string,
    visibility: ProjectVisibility
): Promise<void> {
    await prisma.project.update({ where: { id: projectId }, data: { visibility } });
}

export async function setProjectFlags(projectId: string, flags: ProjectFlags): Promise<void> {
    await prisma.project.update({
        where: { id: projectId },
        data: { flags: JSON.stringify(flags) }
    });
}

/** A project's flags, defaulted, for the code paths that act on them. */
export async function getProjectFlags(projectId: string): Promise<ProjectFlags> {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { flags: true }
    });
    return project ? parseProjectFlags(project.flags) : defaultProjectFlags();
}

/** The same, reached from an environment - which is what a service knows about. */
export async function getFlagsForEnvironment(environmentId: string): Promise<ProjectFlags> {
    const environment = await prisma.environment.findUnique({
        where: { id: environmentId },
        select: { project: { select: { flags: true } } }
    });
    return parseProjectFlags(environment?.project.flags);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface ProjectMemberView {
    id: string;
    userId: string;
    name: string;
    /** Their address if they show it to whoever is looking, their handle
     *  otherwise - a project's member list is other people's screen. */
    contact: string;
    role: ProjectRole;
    createdAt: string;
    /** True for the synthetic row standing in for the project's owner. */
    isOwner: boolean;
}

/**
 * Everyone on the project, owner first. The owner is not a membership row, but
 * a members list that does not show who owns the thing is a list that reads as
 * if nobody does - so they are rendered in, marked, and not removable.
 */
export async function listProjectMembers(
    projectId: string,
    viewer: { id: string; isAdmin: boolean }
): Promise<ProjectMemberView[]> {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
            ownerId: true,
            createdAt: true,
            owner: { select: { id: true, name: true, email: true, username: true } },
            members: {
                orderBy: { createdAt: "asc" },
                include: { user: { select: { id: true, name: true, email: true, username: true } } }
            }
        }
    });
    if (!project) throw new Error("Project not found");
    const contacts = await contactLines(viewer, [
        project.owner,
        ...project.members.map((member) => member.user)
    ]);
    return [
        {
            id: `owner:${project.ownerId}`,
            userId: project.ownerId,
            name: project.owner.name,
            contact: contacts.get(project.ownerId) ?? "",
            role: "admin",
            createdAt: project.createdAt.toISOString(),
            isOwner: true
        },
        ...project.members.map((member) => ({
            id: member.id,
            userId: member.userId,
            name: member.user.name,
            contact: contacts.get(member.userId) ?? "",
            role: member.role as ProjectRole,
            createdAt: member.createdAt.toISOString(),
            isOwner: false
        }))
    ];
}

/**
 * Add somebody by email or username. Adding a person who is already on the
 * project changes their role instead of failing - which is what an operator
 * typing a name they have already added almost always meant.
 */
export async function addProjectMember(input: {
    projectId: string;
    identifier: string;
    role: ProjectRole;
    invitedBy: string;
}): Promise<void> {
    const identifier = input.identifier.trim();
    const user = await prisma.user.findFirst({
        where: {
            OR: [
                { email: { equals: identifier.toLowerCase() } },
                { username: { equals: identifier } },
                { emails: { some: { email: identifier.toLowerCase() } } }
            ]
        },
        select: { id: true }
    });
    if (!user) throw new Error("No account here matches that email or username");

    const project = await prisma.project.findUnique({
        where: { id: input.projectId },
        select: { ownerId: true }
    });
    if (!project) throw new Error("Project not found");
    if (project.ownerId === user.id) throw new Error("That account already owns this project");

    await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: input.projectId, userId: user.id } },
        create: {
            projectId: input.projectId,
            userId: user.id,
            role: input.role,
            invitedBy: input.invitedBy
        },
        update: { role: input.role }
    });
}

export async function setProjectMemberRole(
    projectId: string,
    memberId: string,
    role: ProjectRole
): Promise<void> {
    await prisma.projectMember.updateMany({ where: { id: memberId, projectId }, data: { role } });
}

export async function removeProjectMember(projectId: string, memberId: string): Promise<void> {
    await prisma.projectMember.deleteMany({ where: { id: memberId, projectId } });
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface ProjectTokenView {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    expiresAt: string | null;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
}

export async function listProjectTokens(projectId: string): Promise<ProjectTokenView[]> {
    const rows = await prisma.apiKey.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            name: true,
            prefix: true,
            scopes: true,
            expiresAt: true,
            lastUsedAt: true,
            revokedAt: true,
            createdAt: true
        }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        scopes: safeList(row.scopes),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString()
    }));
}

function safeList(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((entry): entry is string => typeof entry === "string")
            : [];
    } catch {
        return [];
    }
}

/**
 * Mint a token that may only act on this project. It is issued against the
 * project owner's account, so it can never do more than they can - and it is
 * further narrowed to `deploy.read`, or `deploy.manage` when the operator asked
 * for a token that can change things.
 *
 * The secret is returned once. There is no second chance to read it, which is
 * the point.
 */
export async function createProjectToken(
    input: ProjectTokenInput & { ownerId: string }
): Promise<{ secret: string; prefix: string }> {
    const days = TOKEN_LIFETIME_DAYS[input.lifetime];
    const key = await createApiKey(input.ownerId, {
        name: input.name,
        // A deploy token is wired into something that runs on its own, which is
        // what "production" means on the key list whatever it is deploying to.
        environment: "production",
        scopes: input.canManage ? ["deploy.read", "deploy.manage"] : ["deploy.read"],
        allowedCidrs: [],
        allowedCountries: [],
        allowedContinents: [],
        // Unrestricted on both counts: a deploy token is presented by whatever CI
        // runs the deploy, from wherever it happens to run, and neither is known
        // when the token is minted.
        allowedUserAgents: [],
        deniedUserAgents: [],
        groupIds: [],
        expiresInDays: days ?? 0
    });
    await prisma.apiKey.update({ where: { id: key.id }, data: { projectId: input.projectId } });
    return { secret: key.secret, prefix: key.prefix };
}

/** Stop a token working, keeping the row so the trail of what it did survives. */
export async function revokeProjectToken(projectId: string, tokenId: string): Promise<void> {
    await prisma.apiKey.updateMany({
        where: { id: tokenId, projectId, revokedAt: null },
        data: { revokedAt: new Date() }
    });
}

export async function deleteProjectToken(projectId: string, tokenId: string): Promise<void> {
    await prisma.apiKey.deleteMany({ where: { id: tokenId, projectId } });
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface ProjectWebhookView {
    id: string;
    name: string;
    format: WebhookFormat;
    targetHint: string;
    events: string[];
    enabled: boolean;
    status: string;
    lastError: string | null;
    lastUsedAt: string | null;
    createdAt: string;
}

const WEBHOOK_FIELDS = {
    id: true,
    name: true,
    format: true,
    targetHint: true,
    events: true,
    enabled: true,
    status: true,
    lastError: true,
    lastUsedAt: true,
    createdAt: true
} as const;

function toWebhookView(row: {
    id: string;
    name: string;
    format: string;
    targetHint: string;
    events: string;
    enabled: boolean;
    status: string;
    lastError: string | null;
    lastUsedAt: Date | null;
    createdAt: Date;
}): ProjectWebhookView {
    return {
        id: row.id,
        name: row.name,
        format: row.format as WebhookFormat,
        targetHint: row.targetHint,
        events: safeList(row.events),
        enabled: row.enabled,
        status: row.status,
        lastError: row.lastError,
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString()
    };
}

export async function listProjectWebhooks(projectId: string): Promise<ProjectWebhookView[]> {
    const rows = await prisma.projectWebhook.findMany({
        where: { projectId },
        orderBy: { createdAt: "asc" },
        select: WEBHOOK_FIELDS
    });
    return rows.map(toWebhookView);
}

export async function createProjectWebhook(
    input: ProjectWebhookInput
): Promise<ProjectWebhookView> {
    // Discord and Slack want their own JSON; guessing from the URL means the
    // common case needs no choice at all, and an explicit pick still wins.
    const format = input.format ?? detectWebhookFormat(input.url);
    const blob = encryptSecret(input.url, loadEnv().POLARIS_MASTER_KEY);
    const row = await prisma.projectWebhook.create({
        data: {
            projectId: input.projectId,
            name: input.name,
            format,
            targetHint: maskWebhookUrl(input.url),
            encryptedUrl: blob.ciphertext,
            urlNonce: blob.nonce,
            urlKeyId: blob.keyId,
            events: JSON.stringify(input.events)
        },
        select: WEBHOOK_FIELDS
    });
    return toWebhookView(row);
}

export async function setProjectWebhookEnabled(
    projectId: string,
    id: string,
    enabled: boolean
): Promise<void> {
    await prisma.projectWebhook.updateMany({ where: { id, projectId }, data: { enabled } });
}

export async function deleteProjectWebhook(projectId: string, id: string): Promise<void> {
    await prisma.projectWebhook.deleteMany({ where: { id, projectId } });
}

/** The URL behind a webhook. Server-side only - it is the credential, and is
 *  never handed back to a client. */
async function webhookUrl(id: string): Promise<{ url: string; format: WebhookFormat } | null> {
    const row = await prisma.projectWebhook.findUnique({ where: { id } });
    if (!row) return null;
    try {
        const url = decryptSecret(
            {
                ciphertext: Buffer.from(row.encryptedUrl),
                nonce: Buffer.from(row.urlNonce),
                keyId: row.urlKeyId ?? ""
            },
            loadEnv().POLARIS_MASTER_KEY
        );
        return { url, format: row.format as WebhookFormat };
    } catch {
        return null;
    }
}

async function recordWebhookResult(id: string, error: string | null): Promise<void> {
    await prisma.projectWebhook.updateMany({
        where: { id },
        data: { status: error ? "error" : "ok", lastError: error, lastUsedAt: new Date() }
    });
}

/** Send a sample event, so the operator finds out the endpoint is wrong now
 *  rather than during the deploy they needed to hear about. */
export async function testProjectWebhook(
    projectId: string,
    id: string
): Promise<{ error?: string }> {
    const owned = await prisma.projectWebhook.findFirst({
        where: { id, projectId },
        select: { id: true }
    });
    if (!owned) return { error: "Webhook not found" };
    const resolved = await webhookUrl(id);
    if (!resolved)
        return { error: "The stored URL could not be read. Remove the webhook and add it again." };
    const result = await sendWebhook(resolved.url, resolved.format, {
        event: "deploy.succeeded",
        level: "info",
        title: "Polaris test event",
        body: "This is what a deploy notification from this project will look like.",
        url: null,
        at: new Date().toISOString()
    });
    await recordWebhookResult(id, result.error ?? null);
    return result;
}

/**
 * Report a deploy to every endpoint on the project that asked for this event.
 * Never throws: it runs inside the deploy's own completion path, and a webhook
 * nobody maintains any more must not take a deploy's reporting down with it.
 */
export async function dispatchProjectWebhooks(input: {
    projectId: string;
    event: string;
    title: string;
    body: string | null;
    url: string | null;
    level: "info" | "success" | "warning" | "danger";
}): Promise<void> {
    try {
        const hooks = await prisma.projectWebhook.findMany({
            where: { projectId: input.projectId, enabled: true },
            select: { id: true, events: true }
        });
        const at = new Date().toISOString();
        for (const hook of hooks) {
            const wanted = safeList(hook.events);
            // No selection means every deploy event, so a webhook added without a
            // choice still reports something.
            if (wanted.length > 0 && !wanted.includes(input.event)) continue;
            const resolved = await webhookUrl(hook.id);
            if (!resolved) {
                await recordWebhookResult(hook.id, "The stored URL could not be read.");
                continue;
            }
            const result = await sendWebhook(resolved.url, resolved.format, {
                event: input.event,
                level: input.level,
                title: input.title,
                body: input.body,
                url: input.url,
                at
            });
            await recordWebhookResult(hook.id, result.error ?? null);
        }
    } catch (error) {
        console.error("polaris: could not deliver the project webhooks:", error);
    }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface ServiceUsage {
    id: string;
    name: string;
    kind: "application" | "database";
    environmentName: string;
    running: boolean;
    cpuPercent: number | null;
    memUsedBytes: number | null;
    /** Bytes across every volume attached to it, when any could be measured. */
    volumeBytes: number | null;
    volumeCount: number;
}

export interface ProjectUsage {
    services: ServiceUsage[];
    totals: {
        services: number;
        running: number;
        cpuPercent: number | null;
        memUsedBytes: number | null;
        volumeBytes: number | null;
        volumes: number;
    };
    /** When the newest sample behind these figures was taken. */
    sampledAt: string | null;
}

/**
 * What the project is consuming, from the most recent sample of each subject.
 * This reads the collected history rather than probing every container live: the
 * screen is a summary of the project, and making it a fan-out of Docker calls
 * would make opening it the most expensive thing in the app.
 */
export async function getProjectUsage(projectId: string): Promise<ProjectUsage> {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
            environments: {
                orderBy: { createdAt: "asc" },
                include: {
                    applications: {
                        select: {
                            id: true,
                            name: true,
                            currentDeploymentId: true,
                            volumes: { select: { id: true } }
                        }
                    },
                    databases: { select: { id: true, name: true, status: true } }
                }
            }
        }
    });
    if (!project) throw new Error("Project not found");

    const appIds = project.environments.flatMap((environment) =>
        environment.applications.map((app) => app.id)
    );
    const volumeIds = project.environments.flatMap((environment) =>
        environment.applications.flatMap((app) => app.volumes.map((volume) => volume.id))
    );
    const [appSamples, volumeSamples] = await Promise.all([
        latestSamples("app", appIds),
        latestSamples("volume", volumeIds)
    ]);

    const services: ServiceUsage[] = [];
    let newest: Date | null = null;
    for (const sample of [...appSamples.values(), ...volumeSamples.values()]) {
        if (!newest || sample.ts > newest) newest = sample.ts;
    }

    for (const environment of project.environments) {
        for (const app of environment.applications) {
            const sample = appSamples.get(app.id);
            const bytes = app.volumes
                .map((volume) => volumeSamples.get(volume.id)?.diskUsedBytes)
                .filter((value): value is bigint => value != null);
            services.push({
                id: app.id,
                name: app.name,
                kind: "application",
                environmentName: environment.name,
                running: Boolean(app.currentDeploymentId),
                cpuPercent: sample?.cpuPercent ?? null,
                memUsedBytes: sample?.memUsedBytes != null ? Number(sample.memUsedBytes) : null,
                volumeBytes:
                    bytes.length > 0 ? bytes.reduce((sum, value) => sum + Number(value), 0) : null,
                volumeCount: app.volumes.length
            });
        }
        for (const database of environment.databases) {
            // A managed database is a container Polaris did not attach a Volume
            // row to, so it has no measurable volume of its own here - its state
            // is what the screen can honestly report.
            services.push({
                id: database.id,
                name: database.name,
                kind: "database",
                environmentName: environment.name,
                running: ["running", "active", "healthy", "ready"].includes(
                    database.status.toLowerCase()
                ),
                cpuPercent: null,
                memUsedBytes: null,
                volumeBytes: null,
                volumeCount: 0
            });
        }
    }

    const measured = services.filter(
        (service) => service.cpuPercent != null || service.memUsedBytes != null
    );
    return {
        services,
        totals: {
            services: services.length,
            running: services.filter((service) => service.running).length,
            cpuPercent:
                measured.length > 0
                    ? Math.round(
                          measured.reduce((sum, service) => sum + (service.cpuPercent ?? 0), 0) * 10
                      ) / 10
                    : null,
            memUsedBytes:
                measured.length > 0
                    ? measured.reduce((sum, service) => sum + (service.memUsedBytes ?? 0), 0)
                    : null,
            volumeBytes:
                volumeSamples.size > 0
                    ? [...volumeSamples.values()].reduce(
                          (sum, sample) => sum + Number(sample.diskUsedBytes ?? 0n),
                          0
                      )
                    : null,
            volumes: volumeIds.length
        },
        sampledAt: newest?.toISOString() ?? null
    };
}

/** The newest sample per subject, keyed by subject id. */
async function latestSamples(subjectType: string, ids: string[]) {
    const map = new Map<
        string,
        {
            ts: Date;
            cpuPercent: number | null;
            memUsedBytes: bigint | null;
            diskUsedBytes: bigint | null;
        }
    >();
    if (ids.length === 0) return map;
    // A window rather than the whole table: a sample older than this describes a
    // container that is no longer reporting, and showing it as current would be
    // worse than showing nothing.
    const since = new Date(Date.now() - 30 * 60 * 1000);
    const rows = await prisma.metricSample.findMany({
        where: { subjectType, subjectId: { in: ids }, ts: { gte: since } },
        orderBy: { ts: "asc" },
        select: {
            subjectId: true,
            ts: true,
            cpuPercent: true,
            memUsedBytes: true,
            diskUsedBytes: true
        }
    });
    for (const row of rows) {
        map.set(row.subjectId, {
            ts: row.ts,
            cpuPercent: row.cpuPercent,
            memUsedBytes: row.memUsedBytes,
            diskUsedBytes: row.diskUsedBytes
        });
    }
    return map;
}

// ---------------------------------------------------------------------------
// Template export
// ---------------------------------------------------------------------------

/**
 * The project written out as a portable description of itself: environments,
 * services, their sources and ports, volumes, and the *names* of the variables
 * each service needs.
 *
 * Values are deliberately absent. A template is a thing people pass around, and
 * a template that carries a database password is a leak with a share button on
 * it - so the reader gets the shape and fills in the secrets themselves.
 */
export async function exportProjectTemplate(projectId: string): Promise<Record<string, unknown>> {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
            environments: {
                orderBy: { createdAt: "asc" },
                include: {
                    applications: {
                        orderBy: { createdAt: "asc" },
                        include: {
                            volumes: true,
                            domains: { select: { kind: true, targetPort: true } }
                        }
                    },
                    databases: { orderBy: { createdAt: "asc" } }
                }
            }
        }
    });
    if (!project) throw new Error("Project not found");

    const scopeIds = [
        ...project.environments.map((environment) => environment.id),
        ...project.environments.flatMap((environment) =>
            environment.applications.map((app) => app.id)
        )
    ];
    const variables = await prisma.envVar.findMany({
        where: { scopeId: { in: scopeIds } },
        select: { scopeType: true, scopeId: true, key: true, isSecret: true }
    });
    const keysFor = (scopeType: string, scopeId: string) =>
        variables
            .filter((entry) => entry.scopeType === scopeType && entry.scopeId === scopeId)
            .map((entry) => ({ key: entry.key, secret: entry.isSecret }));

    return {
        polarisTemplate: 1,
        name: project.name,
        description: project.description ?? "",
        exportedAt: new Date().toISOString(),
        environments: project.environments.map((environment) => ({
            name: environment.name,
            isDefault: environment.isDefault,
            variables: keysFor("environment", environment.id),
            services: environment.applications.map((app) => ({
                name: app.name,
                sourceType: app.sourceType,
                source: redactSource(app.sourceConfig),
                autoDeploy: app.autoDeploy,
                deployBranch: app.deployBranch,
                keepReleases: app.keepReleases,
                replicas: app.replicas,
                ports: [...new Set(app.domains.map((domain) => domain.targetPort))],
                variables: keysFor("application", app.id),
                volumes: app.volumes.map((volume) => ({
                    name: volume.name,
                    mountPath: volume.mountPath,
                    kind: volume.kind,
                    sizeLimit: volume.sizeLimit
                }))
            })),
            databases: environment.databases.map((database) => ({
                name: database.name,
                engine: database.engine,
                version: database.version
            }))
        }))
    };
}

/** A service's source with anything credential-shaped taken out. A repo URL can
 *  carry a token in its userinfo, and that must not travel with the template. */
function redactSource(raw: string): Record<string, unknown> {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return {};
    }
    const repoUrl = parsed.repoUrl;
    if (typeof repoUrl === "string") {
        try {
            const url = new URL(repoUrl);
            url.username = "";
            url.password = "";
            parsed.repoUrl = url.toString();
        } catch {
            // Not a URL (an SSH remote); nothing to strip from it.
        }
    }
    return parsed;
}
