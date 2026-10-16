/**
 * Whether a service is handed the NVIDIA cards of the machine it runs on, and
 * what it holds on them.
 *
 * Offered only where the machine has a card, as the metrics collector last read
 * it: a container asking for a device the machine does not have is refused by
 * the engine and never starts. Only NVIDIA is read or handed over.
 */

import { prisma } from "@polaris/db";
import { machineGpus } from "@/lib/gpu/gpu-live";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { restartFromKeptImage } from "@/lib/deploy-service";

/** How far back a service's own GPU reading still counts as now. */
const USAGE_MAX_AGE_MS = 5 * 60_000;

/** Why the setting cannot be turned on, as a key the screen words. */
export type GpuRefusal = "noGpu" | "swarm";

export interface ServiceGpuView {
    readonly enabled: boolean;
    /** Null where it may be turned on. */
    readonly refusal: GpuRefusal | null;
    /** The machine's cards, by number and name. */
    readonly cards: readonly { index: number; name: string; memoryTotalBytes: number | null }[];
    /** GPU memory the service's container held at its last reading, or null. */
    readonly memoryUsedBytes: number | null;
}

type GpuApp = {
    useGpu: boolean;
    currentDeploymentId: string | null;
    target: { kind: string; hostId: string | null; runtime: string };
};

/** The metric subject of the machine a service runs on. */
export function machineSubjectOf(target: GpuApp["target"]): string {
    return target.kind === "local" || !target.hostId ? LOCAL_HOST_SUBJECT : target.hostId;
}

/** Pure: why a service on this machine cannot be given a card, if it cannot. */
export function gpuRefusal(target: GpuApp["target"], hasCards: boolean): GpuRefusal | null {
    // A stack deploy has no device requests: swarm hands out devices only as
    // generic resources the node itself advertises.
    if (target.runtime === "swarm") return "swarm";
    return hasCards ? null : "noGpu";
}

async function loadApp(applicationId: string, ownerId: string): Promise<GpuApp> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: {
            useGpu: true,
            currentDeploymentId: true,
            target: { select: { kind: true, hostId: true, runtime: true } }
        }
    });
    if (!app) throw new Error("Application not found");
    return app;
}

export async function getServiceGpu(applicationId: string, ownerId: string): Promise<ServiceGpuView> {
    const app = await loadApp(applicationId, ownerId);
    const machine = machineGpus(machineSubjectOf(app.target));
    const latest = app.useGpu
        ? await prisma.metricSample.findFirst({
              where: {
                  subjectType: "app",
                  subjectId: applicationId,
                  ts: { gte: new Date(Date.now() - USAGE_MAX_AGE_MS) }
              },
              orderBy: { ts: "desc" },
              select: { gpuMemUsedBytes: true }
          })
        : null;
    return {
        enabled: app.useGpu,
        refusal: gpuRefusal(app.target, machine !== null),
        cards: (machine?.gpus ?? []).map((gpu) => ({
            index: gpu.index,
            name: gpu.name,
            memoryTotalBytes: gpu.memoryTotalBytes
        })),
        memoryUsedBytes: latest?.gpuMemUsedBytes == null ? null : Number(latest.gpuMemUsedBytes)
    };
}

/**
 * Turn the cards on or off for a service, and start its running release again
 * so the container is created with (or without) them. Turning it off is always
 * allowed, so a service moved to a machine without a card can be repaired.
 * Returns the refusal instead of saving when it cannot be turned on. A restart
 * that fails leaves the setting saved and says so with `restartFailed`, so the
 * screen keeps showing what is stored.
 */
export async function setServiceGpu(
    applicationId: string,
    ownerId: string,
    userId: string,
    enabled: boolean
): Promise<{ refusal: GpuRefusal | null; saved: boolean; redeployed: boolean; restartFailed: boolean }> {
    const app = await loadApp(applicationId, ownerId);
    const unchanged = { refusal: null, saved: false, redeployed: false, restartFailed: false };
    if (app.useGpu === enabled) return unchanged;
    if (enabled) {
        const refusal = gpuRefusal(app.target, machineGpus(machineSubjectOf(app.target)) !== null);
        if (refusal) return { ...unchanged, refusal };
    }
    await prisma.application.update({ where: { id: applicationId }, data: { useGpu: enabled } });
    const saved = { ...unchanged, saved: true };
    if (!app.currentDeploymentId) return saved;
    try {
        await restartFromKeptImage(applicationId, ownerId, userId, "settings");
    } catch (error) {
        console.error("polaris: a service could not be restarted after its GPU setting changed:", error);
        return { ...saved, restartFailed: true };
    }
    return { ...saved, redeployed: true };
}
