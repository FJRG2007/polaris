/**
 * Deploy, driven by something other than the dashboard.
 *
 * The CLI, the REST API and the MCP tools all do what the Deploy screens do, and
 * this is the one place they do it. Every operation takes a caller resolved from
 * an API key and goes through the same two gates the server actions do - the
 * key's own scope (`deploy.read` or `deploy.manage`, already intersected with
 * what its owner holds today) and the project capability the dashboard asks for
 * (`deploy.run`, `variables.write`, ...) via `deploy-project-access` - and then
 * calls the same service functions with the project owner's id. There is no
 * second code path into a project, so a key reaches exactly what its owner could
 * reach by clicking, and never more.
 *
 * Two narrowings apply on top, both of which can only take reach away:
 *
 * - A token minted from a project's settings is confined to that project. It is
 *   listed and revoked there, and handing a CI system the token for one project
 *   should not hand it every other project its owner can open.
 * - Secret values are never in a listing. Reading one is its own call, it needs
 *   the write scope as well as the capability to read variables, and it is
 *   written to the audit log with the key that asked.
 */

import { linesSince } from "./text";
import { prisma } from "@polaris/db";
import { open } from "node:fs/promises";
import { DeployApiRefusal } from "./refusal";
import type { Permission } from "@polaris/core";
import * as activity from "@/lib/activity/activity";
import * as deployService from "@/lib/deploy-service";
import type { ProjectCapability } from "@polaris/core";
import { provisionHostnameDns } from "@/lib/domain-dns";
import { TERMINAL_DEPLOY_STATUSES } from "@/lib/deploy/status";
import { deployTargetOrgId, recordDeployAudit } from "@/lib/deploy-audit";
import type { AddDomainInput, ImportVariablesInput, SetVariableInput } from "./schemas";
import {
    deleteEnvVar,
    envVarScope,
    listEnvVars,
    parseDotEnv,
    revealEnvVar,
    setEnvVar,
    setEnvVars,
    type EnvScope,
    type EnvVarView
} from "@/lib/env-var-service";
import {
    accessInEnvironment,
    projectAccess,
    requireApplicationAccess,
    requireDeploymentAccess,
    requireDomainAccess,
    requireEnvironmentAccess,
    visibleProjectIds,
    type ProjectAccess
} from "@/lib/deploy-project-access";

/** Who is calling, resolved from their credential before anything runs. */
export interface DeployCaller {
    readonly userId: string;
    /** The key's scopes, already intersected with what its owner holds. */
    readonly scopes: readonly Permission[];
    /** The key that is calling, for the audit trail. Null for a caller that is
     *  not a key (none today, but the audit row must not claim one). */
    readonly keyId: string | null;
    /** Set on a project token: everything outside this project is refused. */
    readonly projectId: string | null;
    /** Which surface the call came through, recorded beside every change. */
    readonly via: "api" | "mcp";
}

/** The most projects one listing walks. A list is for finding the one you want,
 *  and past this many the answer is to name it. */
const MAX_PROJECTS = 200;

/** The most of a build log one read hands back, so a poller on a huge log
 *  catches up in steps rather than in one response the size of the file. */
const MAX_LOG_SLICE = 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Refuse unless the key carries this scope. Said with the scope's name, because
 *  the fix is on the key and whoever made it needs to know which box to tick. */
export function requireScope(caller: DeployCaller, scope: "deploy.read" | "deploy.manage"): void {
    if (!caller.scopes.includes(scope)) {
        throw new DeployApiRefusal(403, `This key needs the ${scope} scope for that.`);
    }
}

/** Refuse anything outside the project a project token was minted from. The same
 *  "not found" the access checks give, so a confined key learns nothing about
 *  the projects it cannot reach. */
function confine(caller: DeployCaller, access: ProjectAccess): void {
    if (caller.projectId && caller.projectId !== access.projectId) {
        throw new DeployApiRefusal(404, "Not found");
    }
}

/** The access checks throw "X not found" for both "no such thing" and "not
 *  allowed"; both become the one 404 here. */
async function guarded<T>(check: () => Promise<T>): Promise<T> {
    try {
        return await check();
    } catch {
        throw new DeployApiRefusal(404, "Not found");
    }
}

interface ResolvedService {
    readonly access: ProjectAccess & { environmentId: string };
    readonly applicationId: string;
}

/**
 * Find the service a reference names and authorize the capability on it.
 *
 * An id goes straight to the access check. A name path is matched against the
 * projects this key can see - slug or name, any case - and `project/service`
 * means the project's default environment, because that is the one the
 * dashboard opens on and the one "deploy api" means to anybody who did not say
 * otherwise. More than one match is refused with every candidate named rather
 * than guessed at: deploying the wrong one of two services called `api` is the
 * kind of mistake that is not undone by the next command.
 */
export async function resolveService(
    caller: DeployCaller,
    ref: string,
    capability: ProjectCapability
): Promise<ResolvedService> {
    const trimmed = ref.trim();
    if (UUID.test(trimmed)) {
        const access = await guarded(() => requireApplicationAccess(trimmed, caller.userId, capability));
        confine(caller, access);
        return { access, applicationId: trimmed };
    }

    const parts = trimmed.split("/").map((part) => part.trim().toLowerCase());
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !part)) {
        throw new DeployApiRefusal(
            400,
            "Name a service by its id, or as project/service or project/environment/service."
        );
    }
    const [projectName, environmentName, serviceName] =
        parts.length === 3 ? parts : [parts[0], null, parts[1]];

    const visible = (await visibleProjectIds(caller.userId)).filter(
        (id) => !caller.projectId || id === caller.projectId
    );
    const named = (value: { name: string; slug: string }, wanted: string | null | undefined) =>
        wanted !== null &&
        wanted !== undefined &&
        (value.slug.toLowerCase() === wanted || value.name.toLowerCase() === wanted);
    const candidates = await prisma.application.findMany({
        where: { environment: { projectId: { in: visible } } },
        select: {
            id: true,
            name: true,
            slug: true,
            environment: {
                select: {
                    name: true,
                    slug: true,
                    isDefault: true,
                    project: { select: { name: true, slug: true } }
                }
            }
        },
        take: 5000
    });
    const matches = candidates.filter(
        (app) =>
            named(app, serviceName) &&
            named(app.environment.project, projectName) &&
            (environmentName === null ? app.environment.isDefault : named(app.environment, environmentName))
    );
    if (matches.length === 0) {
        throw new DeployApiRefusal(404, `No service called ${trimmed} that this key can reach.`);
    }
    if (matches.length > 1) {
        const listed = matches
            .map((app) => `${app.environment.project.slug}/${app.environment.slug}/${app.slug} (${app.id})`)
            .join(", ");
        throw new DeployApiRefusal(409, `${trimmed} names more than one service: ${listed}. Use one of those.`);
    }
    const id = matches[0]!.id;
    const access = await guarded(() => requireApplicationAccess(id, caller.userId, capability));
    confine(caller, access);
    return { access, applicationId: id };
}

/** Record a change made through this surface, in both places the dashboard
 *  records one: the audit log (who, with which key, from where) and the service's
 *  own activity feed when there is a service. */
async function recordChange(
    caller: DeployCaller,
    event: {
        action: string;
        targetType: string;
        targetId: string;
        activity?: { applicationId: string; action: string; to?: string | null };
        metadata?: Record<string, unknown>;
        /** The organization, when the target is gone by the time this runs. */
        orgId?: string | null;
    }
): Promise<void> {
    // Through the Deploy writer, so a change made with a key lands in the
    // organization's history exactly as the same change made on the screen does.
    await recordDeployAudit({
        actorId: caller.userId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        ...(event.orgId ? { orgId: event.orgId } : {}),
        metadata: { via: caller.via, keyId: caller.keyId, ...event.metadata }
    });
    if (event.activity) {
        await activity.record({
            subjectType: "app",
            subjectId: event.activity.applicationId,
            userId: caller.userId,
            action: event.activity.action,
            fromValue: null,
            toValue: event.activity.to ?? null
        });
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ServiceLine {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    /** What it is doing: a build in flight, the release it serves, or "idle"
     *  for a service that has never been deployed. */
    readonly status: string;
}

export interface EnvironmentLine {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly isDefault: boolean;
    readonly services: readonly ServiceLine[];
}

export interface ProjectLine {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly role: string;
    readonly environments: readonly EnvironmentLine[];
}

/** Every project this key can open, with the environments and services it can
 *  reach in each - an environment the access is limited away from is left out. */
export async function listProjects(caller: DeployCaller): Promise<ProjectLine[]> {
    requireScope(caller, "deploy.read");
    const ids = (await visibleProjectIds(caller.userId))
        .filter((id) => !caller.projectId || id === caller.projectId)
        .slice(0, MAX_PROJECTS);
    if (ids.length === 0) return [];

    const projects = await prisma.project.findMany({
        where: { id: { in: ids } },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            name: true,
            slug: true,
            environments: {
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    isDefault: true,
                    applications: {
                        orderBy: { createdAt: "asc" },
                        select: { id: true, name: true, slug: true, currentDeploymentId: true }
                    }
                }
            }
        }
    });
    const statuses = await deployService.getApplicationDeployStatuses(
        projects.flatMap((project) =>
            project.environments.flatMap((environment) => environment.applications)
        )
    );

    const lines: ProjectLine[] = [];
    for (const project of projects) {
        const access = await projectAccess(project.id, caller.userId);
        if (!access) continue;
        lines.push({
            id: project.id,
            name: project.name,
            slug: project.slug,
            role: access.role,
            environments: project.environments
                .filter((environment) => accessInEnvironment(access, environment.id))
                .map((environment) => ({
                    id: environment.id,
                    name: environment.name,
                    slug: environment.slug,
                    isDefault: environment.isDefault,
                    services: environment.applications.map((app) => ({
                        id: app.id,
                        name: app.name,
                        slug: app.slug,
                        status: statuses[app.id] ?? "idle"
                    }))
                }))
        });
    }
    return lines;
}

export interface ServiceDetail {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly project: { readonly id: string; readonly name: string; readonly slug: string };
    readonly environment: { readonly id: string; readonly name: string; readonly slug: string };
    readonly status: string;
    readonly currentDeploymentId: string | null;
    readonly source: {
        readonly kind: string;
        readonly image: string | null;
        readonly repository: string | null;
        readonly branch: string | null;
        readonly port: number | null;
    };
    readonly autoDeploy: boolean;
    readonly domains: readonly DomainLine[];
}

export interface DomainLine {
    readonly id: string;
    readonly hostname: string;
    readonly enabled: boolean;
    readonly certificate: string;
    readonly targetPort: number;
    readonly kind: string;
    readonly health: string;
}

/** Only the source fields a caller needs to recognise the service by. The stored
 *  config is read field by field rather than passed through, so nothing that is
 *  ever added to it reaches a key by default. */
function sourceOf(sourceType: string, raw: string): ServiceDetail["source"] {
    let source: Record<string, unknown> = {};
    try {
        source = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        // An unreadable config is shown as having none of these, not as an error.
    }
    const text = (key: string) => (typeof source[key] === "string" ? (source[key] as string) : null);
    const port = typeof source.port === "number" ? source.port : null;
    return {
        kind: sourceType,
        image: text("imageRef"),
        repository: text("repoUrl"),
        branch: text("branch"),
        port
    };
}

function domainLine(domain: {
    id: string;
    hostname: string;
    enabled: boolean;
    certResolver: string;
    targetPort: number;
    kind: string;
    healthStatus: string;
}): DomainLine {
    return {
        id: domain.id,
        hostname: domain.hostname,
        enabled: domain.enabled,
        certificate: domain.certResolver,
        targetPort: domain.targetPort,
        kind: domain.kind,
        health: domain.healthStatus
    };
}

const DOMAIN_COLUMNS = {
    id: true,
    hostname: true,
    enabled: true,
    certResolver: true,
    targetPort: true,
    kind: true,
    healthStatus: true
} as const;

export async function getService(caller: DeployCaller, ref: string): Promise<ServiceDetail> {
    requireScope(caller, "deploy.read");
    const { applicationId } = await resolveService(caller, ref, "project.read");
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: {
            id: true,
            name: true,
            slug: true,
            sourceType: true,
            sourceConfig: true,
            autoDeploy: true,
            currentDeploymentId: true,
            environment: {
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    project: { select: { id: true, name: true, slug: true } }
                }
            },
            domains: {
                where: { kind: { not: "release" } },
                orderBy: { createdAt: "asc" },
                select: DOMAIN_COLUMNS
            }
        }
    });
    if (!app) throw new DeployApiRefusal(404, "Not found");
    const statuses = await deployService.getApplicationDeployStatuses([app]);
    return {
        id: app.id,
        name: app.name,
        slug: app.slug,
        project: app.environment.project,
        environment: { id: app.environment.id, name: app.environment.name, slug: app.environment.slug },
        status: statuses[app.id] ?? "idle",
        currentDeploymentId: app.currentDeploymentId,
        source: sourceOf(app.sourceType, app.sourceConfig),
        autoDeploy: app.autoDeploy,
        domains: app.domains.map(domainLine)
    };
}

export async function listDeployments(
    caller: DeployCaller,
    ref: string
): Promise<deployService.DeploymentSummary[]> {
    requireScope(caller, "deploy.read");
    const { access, applicationId } = await resolveService(caller, ref, "logs.read");
    return deployService.listDeployments(applicationId, access.ownerId);
}

export interface DeploymentLog {
    readonly id: string;
    readonly status: string;
    readonly error: string | null;
    /** Whether the deployment has finished, so a poller knows to stop. */
    readonly done: boolean;
    readonly log: string;
    /** Where the next read should start to get only what is new. */
    readonly nextOffset: number;
}

/** Authorize reading one deployment's build log, and resolve whose it is. */
async function deploymentAccess(
    caller: DeployCaller,
    deploymentId: string,
    capability: ProjectCapability
): Promise<ProjectAccess & { environmentId: string }> {
    const access = await guarded(() => requireDeploymentAccess(deploymentId, caller.userId, capability));
    confine(caller, access);
    return access;
}

/** Read bytes of a log file from an offset, at most `MAX_LOG_SLICE` of them. A
 *  file that does not exist yet (a queued deploy) reads as empty. */
async function readLogSlice(path: string, offset: number): Promise<{ text: string; end: number }> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(path, "r");
        const { size } = await handle.stat();
        const start = Math.min(offset, size);
        const length = Math.min(size - start, MAX_LOG_SLICE);
        if (length <= 0) return { text: "", end: start };
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        return { text: buffer.toString("utf8"), end: start + length };
    } catch {
        return { text: "", end: offset };
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/**
 * A deployment's status and its build log.
 *
 * `offset` reads from a byte position - what a poller passes back from
 * `nextOffset` - and `tail` instead keeps only the last lines of the whole log,
 * which is what somebody asking "why did it fail" wants.
 */
export async function deploymentLog(
    caller: DeployCaller,
    deploymentId: string,
    options: { offset?: number; tail?: number }
): Promise<DeploymentLog> {
    requireScope(caller, "deploy.read");
    const access = await deploymentAccess(caller, deploymentId, "logs.read");
    const row = await deployService.readDeployment(deploymentId, access.ownerId);
    if (!row) throw new DeployApiRefusal(404, "Not found");
    const path = deployService.deployLogPath(deploymentId);
    const done = TERMINAL_DEPLOY_STATUSES.has(row.status);

    if (options.tail !== undefined) {
        const lines = row.log.split("\n");
        const kept = lines.slice(Math.max(0, lines.length - options.tail)).join("\n");
        return {
            id: deploymentId,
            status: row.status,
            error: row.error,
            done,
            log: kept,
            nextOffset: Buffer.byteLength(row.log, "utf8")
        };
    }
    const slice = await readLogSlice(path, options.offset ?? 0);
    return { id: deploymentId, status: row.status, error: row.error, done, log: slice.text, nextOffset: slice.end };
}

/** How long one follow may run. A build that outlives this is still running;
 *  the caller reconnects with the offset it reached. */
const FOLLOW_MAX_MS = 30 * 60 * 1000;
const FOLLOW_POLL_MS = 1000;

/**
 * A deployment's build log as it is written, until the deployment finishes.
 *
 * Authorized once, up front, like every other read here; the stream itself only
 * reads the file and the row's status. Plain text rather than events, so `curl
 * -N` prints it as it arrives with nothing to strip.
 */
export async function followDeploymentLog(
    caller: DeployCaller,
    deploymentId: string,
    offset: number,
    signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
    requireScope(caller, "deploy.read");
    const access = await deploymentAccess(caller, deploymentId, "logs.read");
    const path = deployService.deployLogPath(deploymentId);
    const started = Date.now();
    let position = offset;

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            for (;;) {
                if (signal.aborted || Date.now() - started > FOLLOW_MAX_MS) {
                    controller.close();
                    return;
                }
                const slice = await readLogSlice(path, position);
                if (slice.text) {
                    position = slice.end;
                    controller.enqueue(new TextEncoder().encode(slice.text));
                    return;
                }
                const row = await deployService.readDeployment(deploymentId, access.ownerId);
                if (!row || TERMINAL_DEPLOY_STATUSES.has(row.status)) {
                    // One last read: the final lines are written just before the
                    // status flips, and a follow that stopped on the flip would
                    // drop the line that says why it failed.
                    const last = await readLogSlice(path, position);
                    if (last.text) controller.enqueue(new TextEncoder().encode(last.text));
                    controller.enqueue(
                        new TextEncoder().encode(`\n[polaris] deployment ${row?.status ?? "gone"}\n`)
                    );
                    controller.close();
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
            }
        }
    });
}

/**
 * What the service's running container is printing.
 *
 * `since` is the timestamp of the last line a poller already has; only lines
 * after it come back, which is how the CLI's follow prints each line once.
 */
export async function runtimeLog(
    caller: DeployCaller,
    ref: string,
    options: { tail: number; since?: string }
): Promise<{ log: string }> {
    requireScope(caller, "deploy.read");
    const { access, applicationId } = await resolveService(caller, ref, "logs.read");
    const log = await deployService.readAppRuntimeLog(applicationId, access.ownerId, options.tail);
    return { log: options.since ? linesSince(log, options.since) : log };
}

// ---------------------------------------------------------------------------
// Deploying and running
// ---------------------------------------------------------------------------

/** Start a deploy of the service's configured source. Answers the deployment id
 *  at once; the build runs in the background and is read with `deploymentLog`. */
export async function deploy(caller: DeployCaller, ref: string): Promise<{ deploymentId: string }> {
    requireScope(caller, "deploy.manage");
    const { access, applicationId } = await resolveService(caller, ref, "deploy.run");
    try {
        await deployService.ensureApplicationDomain(applicationId, access.ownerId);
    } catch {
        // No free-subdomain base yet; the service still deploys without one,
        // exactly as it does from the dashboard.
    }
    const deploymentId = await deployService.deployApplication(applicationId, access.ownerId, caller.userId);
    await recordChange(caller, {
        action: "deploy.app.deploy",
        targetType: "application",
        targetId: applicationId,
        activity: { applicationId, action: "deployed" },
        metadata: { deploymentId }
    });
    return { deploymentId };
}

export async function cancelDeployment(caller: DeployCaller, deploymentId: string): Promise<void> {
    requireScope(caller, "deploy.manage");
    const access = await deploymentAccess(caller, deploymentId, "deploy.run");
    await deployService.cancelDeployment(deploymentId, access.ownerId);
    await recordChange(caller, {
        action: "deploy.app.cancel",
        targetType: "deployment",
        targetId: deploymentId
    });
}

export type PowerAction = "restart" | "stop" | "start";

/**
 * Restart, stop or start a service.
 *
 * A restart and a start recreate the container from the service's current
 * configuration, so a variable changed since the last deploy is in it afterwards
 * - which is what somebody restarting after changing one expects.
 */
export async function power(caller: DeployCaller, ref: string, action: PowerAction): Promise<void> {
    requireScope(caller, "deploy.manage");
    const { access, applicationId } = await resolveService(caller, ref, "deploy.run");
    if (action === "restart") {
        await deployService.restartApplication(applicationId, access.ownerId);
    } else {
        await deployService.setApplicationRunning(applicationId, access.ownerId, action === "start");
    }
    const past = action === "restart" ? "restarted" : action === "start" ? "started" : "stopped";
    await recordChange(caller, {
        action: `deploy.app.${action}`,
        targetType: "application",
        targetId: applicationId,
        activity: { applicationId, action: past }
    });
}

/**
 * Put an earlier release back in front of traffic, from its kept image.
 *
 * Authorized exactly like a deploy, because it is one: a different version goes
 * in front of the same traffic. Nothing is rebuilt - a release whose image is no
 * longer kept is refused with the sentence that says to deploy its commit again,
 * rather than quietly rebuilding the branch head and calling that a rollback.
 * Answers the id of the new deployment the rollback runs as.
 */
export async function rollback(
    caller: DeployCaller,
    deploymentId: string
): Promise<{ deploymentId: string; commitSha: string | null }> {
    requireScope(caller, "deploy.manage");
    const access = await deploymentAccess(caller, deploymentId, "deploy.run");
    const started = await deployService.rollbackToDeployment(deploymentId, access.ownerId, caller.userId);
    await recordChange(caller, {
        action: "deploy.app.rollback",
        targetType: "application",
        targetId: started.applicationId,
        activity: {
            applicationId: started.applicationId,
            action: "rolled back",
            to: started.commitSha?.slice(0, 7) ?? deploymentId
        },
        metadata: { from: deploymentId, deploymentId: started.deploymentId }
    });
    return { deploymentId: started.deploymentId, commitSha: started.commitSha };
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/** Where a set of variables lives: one service, or an environment every service
 *  in it shares. */
export type VariableScope =
    | { readonly kind: "service"; readonly ref: string }
    | { readonly kind: "environment"; readonly environmentId: string };

async function variableScopeAccess(
    caller: DeployCaller,
    scope: VariableScope,
    capability: ProjectCapability
): Promise<{ access: ProjectAccess; envScope: EnvScope; scopeId: string }> {
    if (scope.kind === "service") {
        const { access, applicationId } = await resolveService(caller, scope.ref, capability);
        return { access, envScope: "application", scopeId: applicationId };
    }
    const access = await guarded(() =>
        requireEnvironmentAccess(scope.environmentId, caller.userId, capability)
    );
    confine(caller, access);
    return { access, envScope: "environment", scopeId: scope.environmentId };
}

/** A scope's variables with every secret value withheld. */
export async function listVariables(caller: DeployCaller, scope: VariableScope): Promise<EnvVarView[]> {
    requireScope(caller, "deploy.read");
    const { access, envScope, scopeId } = await variableScopeAccess(caller, scope, "variables.read");
    return listEnvVars(envScope, scopeId, access.ownerId);
}

/** After a change, the services it applies to pick it up the same way they do
 *  from the dashboard: those already deployed redeploy in the background. */
function applyVariables(envScope: EnvScope, scopeId: string, ownerId: string): void {
    void deployService.redeployForEnvScope(envScope, scopeId, ownerId).catch(() => undefined);
}

export async function setVariable(
    caller: DeployCaller,
    scope: VariableScope,
    input: SetVariableInput
): Promise<void> {
    requireScope(caller, "deploy.manage");
    const { access, envScope, scopeId } = await variableScopeAccess(caller, scope, "variables.write");
    await setEnvVar(envScope, scopeId, access.ownerId, {
        key: input.key,
        value: input.value,
        isSecret: input.secret
    });
    await recordChange(caller, {
        action: "deploy.variable.set",
        targetType: envScope,
        targetId: scopeId,
        // The name, never the value: an audit log is read by more people than
        // may read a secret.
        metadata: { key: input.key, secret: input.secret },
        ...(envScope === "application"
            ? { activity: { applicationId: scopeId, action: "variable", to: input.key } }
            : {})
    });
    applyVariables(envScope, scopeId, access.ownerId);
}

export async function importVariables(
    caller: DeployCaller,
    scope: VariableScope,
    input: ImportVariablesInput
): Promise<{ count: number }> {
    requireScope(caller, "deploy.manage");
    const { access, envScope, scopeId } = await variableScopeAccess(caller, scope, "variables.write");
    const parsed = parseDotEnv(input.text).map((item) => ({ ...item, isSecret: input.secret }));
    if (parsed.length === 0) throw new DeployApiRefusal(422, "No KEY=value lines were found in that text.");
    const count = await setEnvVars(envScope, scopeId, access.ownerId, parsed);
    await recordChange(caller, {
        action: "deploy.variable.import",
        targetType: envScope,
        targetId: scopeId,
        metadata: { count, keys: parsed.map((item) => item.key).slice(0, 100) },
        ...(envScope === "application"
            ? { activity: { applicationId: scopeId, action: "variables-imported", to: String(count) } }
            : {})
    });
    applyVariables(envScope, scopeId, access.ownerId);
    return { count };
}

/** Resolve the scope a variable id belongs to and authorize it. */
async function variableAccess(
    caller: DeployCaller,
    variableId: string,
    capability: ProjectCapability
): Promise<{ access: ProjectAccess; envScope: EnvScope; scopeId: string }> {
    const located = await envVarScope(variableId);
    if (!located) throw new DeployApiRefusal(404, "Not found");
    return variableScopeAccess(
        caller,
        located.scope === "application"
            ? { kind: "service", ref: located.scopeId }
            : { kind: "environment", environmentId: located.scopeId },
        capability
    );
}

export async function deleteVariable(caller: DeployCaller, variableId: string): Promise<void> {
    requireScope(caller, "deploy.manage");
    const { access } = await variableAccess(caller, variableId, "variables.write");
    const removed = await deleteEnvVar(variableId, access.ownerId);
    if (!removed) throw new DeployApiRefusal(404, "Not found");
    await recordChange(caller, {
        action: "deploy.variable.delete",
        targetType: removed.scope,
        targetId: removed.scopeId,
        metadata: { variableId },
        ...(removed.scope === "application"
            ? { activity: { applicationId: removed.scopeId, action: "variable-removed" } }
            : {})
    });
    applyVariables(removed.scope, removed.scopeId, access.ownerId);
}

/**
 * One variable's value, secrets included.
 *
 * Deliberately harder to reach than a listing: it needs `deploy.manage` on the
 * key as well as the capability to read variables on the project, so a key made
 * to watch deploys cannot pull the secrets out of them. Every reveal is audited
 * with the key that asked, whether or not the value turned out to be secret.
 */
export async function revealVariable(
    caller: DeployCaller,
    variableId: string
): Promise<{ key: string; value: string | null }> {
    requireScope(caller, "deploy.manage");
    const { access, envScope, scopeId } = await variableAccess(caller, variableId, "variables.read");
    const row = await prisma.envVar.findUnique({ where: { id: variableId }, select: { key: true } });
    const value = await revealEnvVar(variableId, access.ownerId);
    await recordChange(caller, {
        action: "deploy.variable.reveal",
        targetType: envScope,
        targetId: scopeId,
        metadata: { variableId, key: row?.key ?? null }
    });
    return { key: row?.key ?? "", value };
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export async function listDomains(caller: DeployCaller, ref: string): Promise<DomainLine[]> {
    requireScope(caller, "deploy.read");
    const { applicationId } = await resolveService(caller, ref, "project.read");
    const domains = await prisma.domain.findMany({
        where: { applicationId, kind: { not: "release" } },
        orderBy: { createdAt: "asc" },
        select: DOMAIN_COLUMNS
    });
    return domains.map(domainLine);
}

/** The port a service declares, or the one its existing domains dial - so adding
 *  a hostname does not make the caller look up a number the service already has. */
async function declaredPort(applicationId: string): Promise<number | null> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: {
            sourceConfig: true,
            domains: { select: { targetPort: true }, orderBy: { createdAt: "asc" }, take: 1 }
        }
    });
    if (!app) return null;
    const source = sourceOf("", app.sourceConfig);
    return source.port ?? app.domains[0]?.targetPort ?? null;
}

/**
 * Attach a hostname, or the service's free subdomain when none is given.
 *
 * For a hostname of the caller's own on Let's Encrypt, the DNS record is
 * provisioned the same best-effort way the dashboard does it, and what happened
 * is reported back rather than thrown: the domain is added either way, and a
 * missing record only delays the certificate.
 */
export async function addDomain(
    caller: DeployCaller,
    ref: string,
    input: AddDomainInput
): Promise<{ hostname: string; dns: unknown }> {
    requireScope(caller, "deploy.manage");
    const { access, applicationId } = await resolveService(caller, ref, "domains.manage");
    const targetPort = input.targetPort ?? (await declaredPort(applicationId));
    if (!targetPort) {
        throw new DeployApiRefusal(
            422,
            "This service does not declare a port yet. Pass targetPort: the port the service listens on inside its container."
        );
    }
    const hostname = await deployService.addApplicationDomain(applicationId, access.ownerId, {
        hostname: input.hostname,
        targetPort,
        cert: input.certificate
    });
    await recordChange(caller, {
        action: "deploy.domain.add",
        targetType: "application",
        targetId: applicationId,
        metadata: { hostname }
    });
    const needsRecord = Boolean(input.hostname) && (input.certificate ?? "le") === "le";
    const dns = needsRecord ? await provisionHostnameDns(hostname).catch(() => null) : null;
    return { hostname, dns };
}

export async function removeDomain(caller: DeployCaller, domainId: string): Promise<void> {
    requireScope(caller, "deploy.manage");
    const access = await guarded(() => requireDomainAccess(domainId, caller.userId, "domains.manage"));
    confine(caller, access);
    // Read before the row goes: afterwards nothing names the organization.
    const orgId = await deployTargetOrgId("domain", domainId).catch(() => null);
    await deployService.removeApplicationDomain(domainId, access.ownerId);
    await recordChange(caller, {
        action: "deploy.domain.remove",
        targetType: "domain",
        targetId: domainId,
        orgId
    });
}
