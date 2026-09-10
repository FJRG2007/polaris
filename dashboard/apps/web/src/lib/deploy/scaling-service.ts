/**
 * How many copies of a service run, the range they move in by themselves, and how
 * the edge spreads traffic over them.
 *
 * A new count reaches the running service the way a changed variable does: the
 * live release is started again from its kept image, which recreates nothing that
 * did not change - the first copy is left as it is and the others come or go. So a
 * count moved by hand and one moved by the autoscaler take the same path, and both
 * leave a row in the history saying the service was scaled.
 */

import { prisma } from "@polaris/db";
import { restartFromKeptImage, syncAppRoutes } from "@/lib/deploy-service";
import {
    parseAppEdgeConfig,
    parseAutoscale,
    type Autoscale,
    type EdgeBalancing,
    type ServiceScaling
} from "@polaris/core";

export interface ServiceScalingView {
    readonly replicas: number;
    readonly autoscale: Autoscale | null;
    readonly balancing: EdgeBalancing;
    /** Why this service runs one copy whatever is asked, when it has to. */
    readonly single: string | null;
    readonly engine: "compose" | "swarm";
}

type ScalableApp = {
    replicas: number;
    autoscale: string | null;
    edgeConfig: string | null;
    keepReleases: boolean;
    sourceType: string;
    currentDeploymentId: string | null;
    target: { runtime: string };
    _count: { volumes: number };
};

const SCALABLE_SELECT = {
    replicas: true,
    autoscale: true,
    edgeConfig: true,
    keepReleases: true,
    sourceType: true,
    currentDeploymentId: true,
    target: { select: { runtime: true } },
    _count: { select: { volumes: true } }
} as const;

/** Why a service cannot run more than one copy, or null when it can. */
export function singleCopyReason(app: Pick<ScalableApp, "keepReleases" | "sourceType" | "_count">): string | null {
    if (app._count.volumes > 0) {
        return "A service with a volume runs one copy: two would write the same files at once.";
    }
    if (app.sourceType === "compose") return "A service deployed from a compose file names its own containers.";
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

export async function getServiceScaling(applicationId: string, ownerId: string): Promise<ServiceScalingView> {
    const app = await loadApp(applicationId, ownerId);
    return {
        replicas: app.replicas,
        autoscale: parseAutoscale(app.autoscale),
        balancing: parseAppEdgeConfig(app.edgeConfig).balancing,
        single: singleCopyReason(app),
        engine: app.target.runtime === "swarm" ? "swarm" : "compose"
    };
}

/**
 * Save a service's scaling and balancing, and apply them.
 *
 * The count is started straight away when the service is running; the balancing
 * is the edge's, so it is republished rather than redeployed. Autoscaling starts
 * from wherever the count is and is kept inside its range from the next reading.
 */
export async function setServiceScaling(
    applicationId: string,
    ownerId: string,
    userId: string,
    input: ServiceScaling & { balancing: EdgeBalancing }
): Promise<{ redeployed: boolean }> {
    const app = await loadApp(applicationId, ownerId);
    const single = singleCopyReason(app);
    const wantsMore = input.replicas > 1 || (input.autoscale?.max ?? 1) > 1;
    if (single && wantsMore) throw new Error(single);
    // Autoscaling owns the count, so a count outside its range is brought into it.
    const replicas = input.autoscale
        ? Math.min(input.autoscale.max, Math.max(input.autoscale.min, input.replicas))
        : input.replicas;
    const edge = parseAppEdgeConfig(app.edgeConfig);
    await prisma.application.update({
        where: { id: applicationId },
        data: {
            replicas,
            autoscale: input.autoscale ? JSON.stringify(input.autoscale) : null,
            edgeConfig: JSON.stringify({ ...edge, balancing: input.balancing })
        }
    });
    await syncAppRoutes().catch(() => undefined);
    if (replicas === app.replicas || !app.currentDeploymentId) return { redeployed: false };
    await restartFromKeptImage(applicationId, ownerId, userId, "scale");
    return { redeployed: true };
}

/**
 * Move a running service to `replicas` copies, for the autoscaler: the count is
 * written and the live release started again, with nothing else touched.
 */
export async function scaleService(
    applicationId: string,
    ownerId: string,
    replicas: number
): Promise<void> {
    await prisma.application.update({ where: { id: applicationId }, data: { replicas } });
    await restartFromKeptImage(applicationId, ownerId, ownerId, "scale");
}
