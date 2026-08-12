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
import { localDockerDriver } from "@/lib/docker-service";
import { resolveLocalContainer } from "@/lib/container-files-service";
import { parseContainerState, type ContainerState } from "@polaris/deploy";

export interface AppContainerMetrics {
    readonly state: string;
    readonly health: string | null;
    readonly cpuPercent: number | null;
    readonly memPercent: number | null;
    readonly memUsedBytes: number | null;
    readonly memTotalBytes: number | null;
    /** How many times the engine has restarted it, and when the current run
     *  began. Together they are what says a container is looping. */
    readonly restartCount: number;
    readonly startedAt: string | null;
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
    return readAppContainerRuntime(applicationId, ownerId).then((state) => state?.status ?? null);
}

/**
 * The whole of that inspect rather than the one word of it.
 *
 * Same call and same cost - the restart count and the start time were always in
 * the body and were simply being dropped on the way out. What they buy is the
 * only cheap way to tell a container that is restarting in a loop from one that
 * is taking its time on a first boot, which from outside look identical for as
 * long as anybody is willing to wait.
 */
export async function readAppContainerRuntime(
    applicationId: string,
    ownerId: string
): Promise<ContainerState | null> {
    return inspectContainer(applicationId, ownerId).catch(() => null);
}

async function inspectContainer(applicationId: string, ownerId: string): Promise<ContainerState> {
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
            memTotalBytes: null,
            restartCount: state.restartCount,
            startedAt: state.startedAt ?? null
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
        memTotalBytes: stats?.memLimit ?? null,
        restartCount: state.restartCount,
        startedAt: state.startedAt ?? null
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
