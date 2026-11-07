/**
 * The services Polaris runs for one of its apps, as that app's settings show them.
 *
 * These used to be reached from Deploy, inside the Marketplace project. Deploy no
 * longer lists them, so the app that owns them is where an administrator sees
 * whether they are up, what they use, what they print, and restarts one.
 *
 * Everything here reads; the only thing it does to a container is the restart
 * Deploy always offered - an in-place restart of the one container, which keeps
 * it, its volumes, its labels and its routes exactly as they are.
 */

import { prisma } from "@polaris/db";
import type { ContainerSummary } from "@polaris/docker";
import { projectSubject, subjectHash } from "@/lib/consumption";
import { localDockerDriver, LOCAL_DOCKER_CONNECTION_ID } from "@/lib/docker-service";
import { MAIL_SERVER_APP_ID, ownedCatalogIds } from "@/lib/deploy/managed-projects";
import { getApplicationDeployStatuses, readAppRuntimeLog, restartApplication } from "@/lib/deploy-service";
import { cachedSamples, oldestSampleAt, refreshSamples, STATS_TTL_MS } from "@/lib/container-stats-cache";

/** One service of an app, as its settings list it. */
export interface AppService {
    readonly applicationId: string;
    readonly name: string;
    /** The install it backs, named the way its owner named it. Null for the mail server. */
    readonly installName: string | null;
    /** What its last release is doing: "running", "failed", "deploying" and so on. */
    readonly status: string;
    /**
     * Whether a container of it is up right now, read from the engine rather than
     * from its last release. Null when the engine could not be read.
     */
    readonly running: boolean | null;
    readonly cpuPercent: number | null;
    readonly memUsedBytes: number | null;
}

/** What a service is, before anything about its container is read. */
interface ServiceRef {
    readonly applicationId: string;
    readonly installName: string | null;
}

/** Where this app's installs and mail servers are looked up, narrowed to its own. */
function serviceSources(appId: string) {
    return {
        installs: {
            applicationId: { not: null },
            status: { not: "removed" },
            catalogId: { in: ownedCatalogIds(appId) }
        },
        mail: appId === MAIL_SERVER_APP_ID ? { applicationId: { not: null } } : null
    };
}

/** The services backing this app's installs, plus the mail server's for that app. */
async function serviceRefs(appId: string): Promise<ServiceRef[]> {
    const sources = serviceSources(appId);
    const [installs, mail] = await Promise.all([
        prisma.installedApp.findMany({
            where: sources.installs,
            select: { name: true, applicationId: true },
            orderBy: { createdAt: "asc" }
        }),
        sources.mail
            ? prisma.mailServer.findMany({ where: sources.mail, select: { applicationId: true } })
            : Promise.resolve([])
    ]);
    return [
        ...installs.map((install) => ({
            applicationId: install.applicationId as string,
            installName: install.name
        })),
        ...mail.map((row) => ({
            applicationId: row.applicationId as string,
            installName: null
        }))
    ];
}

/** Whether this app runs any service at all - what decides its Settings link. */
export async function appHasServices(appId: string): Promise<boolean> {
    const sources = serviceSources(appId);
    const [install, mail] = await Promise.all([
        prisma.installedApp.findFirst({ where: sources.installs, select: { id: true } }),
        sources.mail
            ? prisma.mailServer.findFirst({ where: sources.mail, select: { id: true } })
            : Promise.resolve(null)
    ]);
    return install !== null || mail !== null;
}

/** What the engine says about one service's containers. */
interface ServiceRuntime {
    readonly running: boolean;
    readonly cpuPercent: number | null;
    readonly memUsedBytes: number | null;
}

/**
 * The engine's word on these services only: one listing, matched to each service
 * by the compose project its containers are named after, with the figures the
 * sampler already holds. Null when the engine cannot be read.
 */
async function readRuntimes(
    applicationIds: readonly string[],
    viewerId: string
): Promise<Map<string, ServiceRuntime> | null> {
    const byHash = new Map(applicationIds.map((id) => [subjectHash(id), id]));
    const driver = localDockerDriver();
    let containers: ContainerSummary[];
    try {
        containers = await driver.listContainers(true);
    } catch {
        return null;
    } finally {
        await driver.dispose().catch(() => undefined);
    }
    const samples = cachedSamples(LOCAL_DOCKER_CONNECTION_ID);
    const totals = new Map<string, { running: boolean; cpu: number | null; mem: number | null }>();
    const running: ContainerSummary[] = [];
    for (const container of containers) {
        const subject = projectSubject(container.composeProject);
        const applicationId = subject?.kind === "application" ? byHash.get(subject.hash) : undefined;
        if (!subject || !applicationId) continue;
        const entry = totals.get(applicationId) ?? { running: false, cpu: null, mem: null };
        totals.set(applicationId, entry);
        if (container.state !== "running") continue;
        running.push(container);
        if (subject.role === "self") entry.running = true;
        const sample = samples.get(container.id);
        if (!sample) continue;
        entry.cpu = (entry.cpu ?? 0) + sample.stats.cpuPercent;
        entry.mem = (entry.mem ?? 0) + sample.stats.memUsage;
    }
    const sampledAt = oldestSampleAt(
        samples,
        running.map((container) => container.id)
    );
    if (running.length > 0 && (sampledAt === null || Date.now() - sampledAt > STATS_TTL_MS)) {
        refreshSamples(
            LOCAL_DOCKER_CONNECTION_ID,
            viewerId,
            running.map((container) => ({ id: container.id, name: container.name }))
        );
    }
    return new Map(
        [...totals].map(([id, entry]) => [
            id,
            {
                running: entry.running,
                cpuPercent: entry.cpu === null ? null : Math.round(entry.cpu * 10) / 10,
                memUsedBytes: entry.mem
            }
        ])
    );
}

/** This app's services with their state and what they use right now. */
export async function listAppServices(appId: string, viewerId: string): Promise<AppService[]> {
    const refs = await serviceRefs(appId);
    if (refs.length === 0) return [];
    const applications = await prisma.application.findMany({
        where: { id: { in: refs.map((ref) => ref.applicationId) }, binnedAt: null },
        select: { id: true, name: true, currentDeploymentId: true }
    });
    const [statuses, runtimes] = await Promise.all([
        getApplicationDeployStatuses(applications),
        // The engine is a nicety: a machine whose engine cannot be read still lists
        // its services and their last release.
        readRuntimes(
            applications.map((application) => application.id),
            viewerId
        ).catch(() => null)
    ]);
    const byId = new Map(applications.map((application) => [application.id, application]));
    return refs.flatMap((ref) => {
        const application = byId.get(ref.applicationId);
        if (!application) return [];
        const runtime = runtimes?.get(application.id);
        return [
            {
                applicationId: application.id,
                name: application.name,
                installName: ref.installName,
                status: statuses[application.id] ?? "unknown",
                running: runtimes ? (runtime?.running ?? false) : null,
                cpuPercent: runtime?.cpuPercent ?? null,
                memUsedBytes: runtime?.memUsedBytes ?? null
            }
        ];
    });
}

/**
 * Who owns this service, when it is one of this app's - what every runtime call
 * for it is made as. Null for a service that is not this app's, so the settings
 * of one app cannot reach another's, or a service somebody deployed.
 */
async function serviceOwner(appId: string, applicationId: string): Promise<string | null> {
    const sources = serviceSources(appId);
    const [install, mail] = await Promise.all([
        prisma.installedApp.findFirst({
            where: { ...sources.installs, applicationId },
            select: { id: true }
        }),
        sources.mail
            ? prisma.mailServer.findFirst({ where: { applicationId }, select: { id: true } })
            : Promise.resolve(null)
    ]);
    if (!install && !mail) return null;
    const application = await prisma.application.findFirst({
        where: { id: applicationId, binnedAt: null },
        select: { environment: { select: { project: { select: { ownerId: true } } } } }
    });
    return application?.environment.project.ownerId ?? null;
}

/** Restart one of this app's services, the way Deploy restarted it. False when it is not this app's. */
export async function restartAppService(appId: string, applicationId: string): Promise<boolean> {
    const ownerId = await serviceOwner(appId, applicationId);
    if (!ownerId) return false;
    await restartApplication(applicationId, ownerId);
    return true;
}

/**
 * What one of this app's services printed last. Read as the project's owner, so
 * any administrator sees it, not only the one who installed the app. Null when
 * it is not this app's.
 */
export async function readAppServiceLog(
    appId: string,
    applicationId: string,
    tail: number
): Promise<string | null> {
    const ownerId = await serviceOwner(appId, applicationId);
    if (!ownerId) return null;
    return readAppRuntimeLog(applicationId, ownerId, tail);
}
