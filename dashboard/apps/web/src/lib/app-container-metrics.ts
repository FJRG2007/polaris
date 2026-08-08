/**
 * What a deployed app's container is using right now: its state, plus one CPU and
 * memory sample. Reads through the host daemon's read-only docker proxy, which is
 * the only path the web container has to the local engine.
 *
 * Extracted so the Deploy metrics endpoint and anything else that shows the same
 * numbers (a game server's own page) read them the same way instead of each
 * sampling the engine differently.
 */

import { HostdClient } from "@polaris/hostd-client";
import { parseContainerState } from "@polaris/deploy";
import { localDockerDriver } from "@/lib/docker-service";
import { resolveLocalContainer } from "@/lib/container-files-service";

export interface AppContainerMetrics {
    readonly state: string;
    readonly health: string | null;
    readonly cpuPercent: number | null;
    readonly memPercent: number | null;
    readonly memUsedBytes: number | null;
    readonly memTotalBytes: number | null;
}

/**
 * What one app's container is doing, without sampling it.
 *
 * The inspect is one call and returns at once; the stats sample beside it takes
 * about a second, because the engine has to watch the container over an interval
 * to have a CPU figure at all. Anything that only needs to know whether the thing
 * is up - and that is most callers - should ask for this and not pay for that.
 *
 * Null when it cannot be answered: a remote target, whose daemon proxy this does
 * not reach, or a container that is gone.
 */
export async function readAppContainerState(applicationId: string, ownerId: string): Promise<string | null> {
    return inspectContainer(applicationId, ownerId)
        .then((state) => state.status)
        .catch(() => null);
}

async function inspectContainer(
    applicationId: string,
    ownerId: string
): Promise<{ status: string; health?: string | null }> {
    const container = await resolveLocalContainer(applicationId, ownerId);
    const inspect = await new HostdClient().dockerRequest("GET", `/containers/${encodeURIComponent(container)}/json`);
    return parseContainerState(inspect.status === 200 ? JSON.parse(inspect.body) : null);
}

/** Sample one app's container. Throws for an app that is not the owner's, and for
 *  a remote target - the daemon proxy only reaches the local engine. */
export async function readAppContainerMetrics(applicationId: string, ownerId: string): Promise<AppContainerMetrics> {
    const container = await resolveLocalContainer(applicationId, ownerId);
    const state = await inspectContainer(applicationId, ownerId);
    if (state.status !== "running") {
        return {
            state: state.status,
            health: state.health ?? null,
            cpuPercent: null,
            memPercent: null,
            memUsedBytes: null,
            memTotalBytes: null
        };
    }
    const driver = localDockerDriver();
    const stats = await driver.stats(container).catch(() => null);
    await driver.dispose();
    return {
        state: state.status,
        health: state.health ?? null,
        cpuPercent: stats?.cpuPercent ?? null,
        memPercent: stats?.memPercent ?? null,
        memUsedBytes: stats?.memUsage ?? null,
        memTotalBytes: stats?.memLimit ?? null
    };
}

/** The same sample, or null when it cannot be taken (a remote target, a container
 *  that is gone). For a screen where the numbers are one panel among many and a
 *  missing sample is not an error worth failing the page over. */
export async function readAppContainerMetricsOrNull(
    applicationId: string,
    ownerId: string
): Promise<AppContainerMetrics | null> {
    return readAppContainerMetrics(applicationId, ownerId).catch(() => null);
}
