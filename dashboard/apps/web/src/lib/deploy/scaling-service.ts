/**
 * How many copies of a service run, the range they move in by themselves, and how
 * the edge spreads traffic over them.
 *
 * A new count reaches the running service from the live release's kept image, as a
 * scale step: the copies are added or removed where the serving release runs - its
 * own project, for a service whose deploys change over - and nothing that did not
 * change is recreated. It never starts a second set beside the first, which on a
 * busy service would be twice its containers at the moment it most needs room. New
 * copies are dialled once every one is serving, and copies going away stop being
 * dialled before they go. So a count moved by hand and one moved by the autoscaler
 * take the same path, and both leave a row in the history saying the service was
 * scaled.
 */

import { prisma } from "@polaris/db";
import type { ActivityLine } from "@/lib/activity/activity";
import { restartFromKeptImage, syncAppRoutes } from "@/lib/deploy-service";
import {
    AUTOSCALED_ACTION_PREFIX,
    parseAppEdgeConfig,
    parseAutoscale,
    sleepRefusal,
    trafficRefusal,
    type Autoscale,
    type EdgeBalancing,
    type ResourceLimitsInput,
    type ServiceScaling
} from "@polaris/core";

export interface ServiceScalingView {
    readonly replicas: number;
    readonly autoscale: Autoscale | null;
    /** Why its requests cannot be counted, so it scales on CPU alone, when they
     *  cannot. */
    readonly trafficBlocked: string | null;
    /** The last change the autoscaler made, as its history line; null when it
     *  never has. */
    readonly lastAutoscale: ActivityLine | null;
    readonly balancing: EdgeBalancing;
    /** The most CPU and memory each copy may use. */
    readonly limits: ResourceLimitsInput;
    /** Minutes without a visit before it sleeps; null is never. */
    readonly sleepAfterMinutes: number | null;
    /** Whether it is asleep right now. */
    readonly asleep: boolean;
    /** Why it cannot sleep as it is set now, when it cannot. */
    readonly sleepBlocked: string | null;
    /** Why this service runs one copy whatever is asked, when it has to. */
    readonly single: string | null;
    readonly engine: "compose" | "swarm";
}

type ScalableApp = {
    replicas: number;
    autoscale: string | null;
    cpuLimit: number | null;
    memoryLimitMb: number | null;
    sleepAfterMinutes: number | null;
    asleepSince: Date | null;
    edgeConfig: string | null;
    keepReleases: boolean;
    sourceType: string;
    currentDeploymentId: string | null;
    target: { runtime: string; kind: string };
    _count: { volumes: number };
};

const SCALABLE_SELECT = {
    replicas: true,
    autoscale: true,
    cpuLimit: true,
    memoryLimitMb: true,
    sleepAfterMinutes: true,
    asleepSince: true,
    edgeConfig: true,
    keepReleases: true,
    sourceType: true,
    currentDeploymentId: true,
    target: { select: { runtime: true, kind: true } },
    _count: { select: { volumes: true } }
} as const;

/** Why a service cannot run more than one copy, or null when it can. */
export function singleCopyReason(
    app: Pick<ScalableApp, "keepReleases" | "sourceType" | "_count">
): string | null {
    if (app._count.volumes > 0) {
        return "A service with a volume runs one copy: two would write the same files at once.";
    }
    if (app.sourceType === "compose")
        return "A service deployed from a compose file names its own containers.";
    if (app.keepReleases) {
        return "A service that keeps its previous deployments runs one copy of each. Turn that off to run more.";
    }
    return null;
}

async function loadApp(applicationId: string, ownerId: string): Promise<ScalableApp> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: SCALABLE_SELECT
    });
    if (!app) throw new Error("Application not found");
    return app;
}

/** The autoscaler's latest line in a service's history. Nobody wrote it, so there
 *  is no author to resolve. */
async function lastAutoscale(applicationId: string): Promise<ActivityLine | null> {
    const line = await prisma.activity.findFirst({
        where: {
            subjectType: "app",
            subjectId: applicationId,
            action: { startsWith: AUTOSCALED_ACTION_PREFIX }
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, action: true, fromValue: true, toValue: true, createdAt: true }
    });
    return line ? { ...line, authorName: null, createdAt: line.createdAt.toISOString() } : null;
}

export async function getServiceScaling(
    applicationId: string,
    ownerId: string
): Promise<ServiceScalingView> {
    const app = await loadApp(applicationId, ownerId);
    return {
        replicas: app.replicas,
        autoscale: parseAutoscale(app.autoscale),
        trafficBlocked: trafficRefusal(app),
        lastAutoscale: await lastAutoscale(applicationId),
        balancing: parseAppEdgeConfig(app.edgeConfig).balancing,
        limits: { cpus: app.cpuLimit, memoryMb: app.memoryLimitMb },
        sleepAfterMinutes: app.sleepAfterMinutes,
        asleep: app.asleepSince !== null,
        sleepBlocked: sleepRefusal(app),
        single: singleCopyReason(app),
        engine: app.target.runtime === "swarm" ? "swarm" : "compose"
    };
}

/**
 * Save a service's scaling, balancing and resource limits, and apply them.
 *
 * A new count or new limits start the running release again straight away; the balancing
 * is the edge's, so it is republished rather than redeployed. Autoscaling starts
 * from wherever the count is and is kept inside its range from the next reading.
 */
export async function setServiceScaling(
    applicationId: string,
    ownerId: string,
    userId: string,
    input: ServiceScaling & {
        balancing: EdgeBalancing;
        limits: ResourceLimitsInput;
        sleepAfterMinutes: number | null;
    }
): Promise<{ redeployed: boolean }> {
    const app = await loadApp(applicationId, ownerId);
    const single = singleCopyReason(app);
    const wantsMore = input.replicas > 1 || (input.autoscale?.max ?? 1) > 1;
    if (single && wantsMore) throw new Error(single);
    // A traffic target nothing could ever count would read as working and never act.
    const trafficBlocked =
        (input.autoscale?.requestsPerCopy ?? null) === null ? null : trafficRefusal(app);
    if (trafficBlocked) throw new Error(trafficBlocked);
    // Autoscaling owns the count, so a count outside its range is brought into it.
    const replicas = input.autoscale
        ? Math.min(input.autoscale.max, Math.max(input.autoscale.min, input.replicas))
        : input.replicas;
    // Sleeping is for one copy on this machine, judged as the service will be set.
    const sleepBlocked =
        input.sleepAfterMinutes === null
            ? null
            : sleepRefusal({ ...app, replicas, autoscale: input.autoscale ? "on" : null });
    if (sleepBlocked) throw new Error(sleepBlocked);
    const edge = parseAppEdgeConfig(app.edgeConfig);
    await prisma.application.update({
        where: { id: applicationId },
        data: {
            replicas,
            autoscale: input.autoscale ? JSON.stringify(input.autoscale) : null,
            cpuLimit: input.limits.cpus,
            memoryLimitMb: input.limits.memoryMb,
            sleepAfterMinutes: input.sleepAfterMinutes,
            edgeConfig: JSON.stringify({ ...edge, balancing: input.balancing })
        }
    });
    await syncAppRoutes().catch(() => undefined);
    const limitsChanged =
        input.limits.cpus !== app.cpuLimit || input.limits.memoryMb !== app.memoryLimitMb;
    if ((replicas === app.replicas && !limitsChanged) || !app.currentDeploymentId)
        return { redeployed: false };
    await restartFromKeptImage(
        applicationId,
        ownerId,
        userId,
        limitsChanged ? "settings" : "scale"
    );
    return { redeployed: true };
}

/**
 * Move a running service to `replicas` copies, for the autoscaler: the count is
 * written and the live release scaled to it, with nothing else touched.
 */
export async function scaleService(
    applicationId: string,
    ownerId: string,
    replicas: number
): Promise<void> {
    await prisma.application.update({ where: { id: applicationId }, data: { replicas } });
    await restartFromKeptImage(applicationId, ownerId, null, "scale");
}
