/**
 * One pass over a machine's containers, read by everything that needs it.
 *
 * Polaris asked three different times for the same numbers. The metrics collector
 * read every container on every server once a minute to add its server up and
 * threw the parts away; the Containers listing sampled them again for its table;
 * Watch sampled them a third time on every request, uncached. Each of those holds
 * the daemon open for about a second per container, so the machine being monitored
 * paid for the monitoring three times over - and the screens still opened blank,
 * because none of the three had anything to show until its own pass finished.
 *
 * These pin the arrangement that replaced it: the collector's pass leaves what it
 * read where the screens look, and a screen serves that instead of asking again.
 *
 * They also pin the id the local machine is addressed by. Its samples are filed
 * under a reserved uuid because the column is one, and that id used to reach a URL
 * - which is how a reserved value becomes a public one that can never be changed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface HostRow extends Record<string, unknown> {
    id: string;
    name: string;
    ownerId: string;
    address: string;
    username: string;
    dockerId: string | null;
}

let hosts: HostRow[] = [];
let localDockerIdValue: string | null = null;
/** Every set of ids the engine was asked to sample, in order. */
let statsCalls: string[][] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        host: {
            findMany: async () => hosts,
            updateMany: async () => ({ count: 0 })
        },
        setting: {
            findUnique: async () => (localDockerIdValue ? { value: localDockerIdValue } : null),
            upsert: async ({ create }: { create: { value: string } }) => {
                localDockerIdValue = create.value;
                return create;
            }
        },
        application: { findMany: async () => [] },
        alarm: { findMany: async () => [] },
        metricSample: { findMany: async () => [], createMany: async () => ({ count: 0 }) }
    }
}));

/** An engine with one running container and one that has stopped, recording every
 *  stats read so a second pass over the same machine is visible. */
function engine(dockerId: string) {
    const containers = [
        { id: `${dockerId}-c1`, name: "web", image: "nginx", state: "running", status: "Up 2 hours" },
        { id: `${dockerId}-c2`, name: "old", image: "redis", state: "exited", status: "Exited (0)" }
    ];
    return {
        info: async () => ({
            id: dockerId,
            name: "box",
            serverVersion: "27",
            containers: 2,
            containersRunning: 1,
            containersStopped: 1,
            images: 1,
            ncpu: 4,
            memTotal: 8_000_000_000
        }),
        listContainers: async (all = true) => (all ? containers : containers.filter((c) => c.state === "running")),
        statsMany: async (ids: string[]) => {
            statsCalls.push(ids);
            return new Map(
                ids.map((id) => [id, { cpuPercent: 40, memUsage: 1_000_000, memLimit: 8_000_000_000, memPercent: 12.5 }])
            );
        },
        stats: async () => ({ cpuPercent: 40, memUsage: 1_000_000, memLimit: 8_000_000_000, memPercent: 12.5 }),
        dispose: async () => undefined
    };
}

const LOCAL_ENGINE = "AAAA:LOCAL";

vi.mock("@/lib/docker-service", () => ({
    LOCAL_DOCKER_CONNECTION_ID: "local",
    HOST_DOCKER_PREFIX: "host:",
    localDockerDriver: () => engine(LOCAL_ENGINE),
    hostDockerDriver: async () => engine("BBBB:REMOTE")
}));
vi.mock("@/lib/storage-service", () => ({
    getDriverForConnection: async () => {
        throw new Error("not used");
    },
    getUnasMetrics: async () => {
        throw new Error("not used");
    }
}));

const { collectMetricsOnce } = await import("@/lib/metrics-collector-service");
const { getWatchContainers } = await import("@/lib/watch-overview-service");
const { cachedSamples } = await import("@/lib/container-stats-cache");
const { hostRouteId, hostSubject, LOCAL_HOST_SUBJECT } = await import("@/lib/metrics-shared");

beforeEach(() => {
    hosts = [];
    localDockerIdValue = null;
    statsCalls = [];
});

describe("the collector's pass over a machine", () => {
    it("leaves every container it read where the Containers screen looks", async () => {
        await collectMetricsOnce({ storage: false });

        const samples = cachedSamples("local");
        // Under the id AND the name: a listing knows the id, a container's own page
        // is addressed by name, and both have to hit the same sample.
        expect(samples.get(`${LOCAL_ENGINE}-c1`)?.stats.cpuPercent).toBe(40);
        expect(samples.get("web")?.stats.cpuPercent).toBe(40);
    });

    it("costs one read of the machine, not one per screen that wants it", async () => {
        await collectMetricsOnce({ storage: false });
        const afterCollect = statsCalls.length;

        const cards = await getWatchContainers("u1");

        // Watch served what the collector left. The pass it starts behind its own
        // answer is the sampler's, single-flight per machine - not a second read
        // held in front of this call.
        expect(statsCalls.length).toBe(afterCollect);
        expect(cards.find((card) => card.name === "web")?.cpuPercent).toBe(40);
    });

    it("shows nothing for a container that has stopped", async () => {
        await collectMetricsOnce({ storage: false });

        const cards = await getWatchContainers("u1");

        const stopped = cards.find((card) => card.name === "old");
        expect(stopped?.state).toBe("idle");
        expect(stopped?.cpuPercent).toBeNull();
    });

    it("sends Watch to the container's host, by the id that host picker uses", async () => {
        await collectMetricsOnce({ storage: false });

        const cards = await getWatchContainers("u1");

        // ?c= is what the Containers page reads. ?connection= landed on whichever
        // host it opened by default, which is the wrong machine on any install
        // with more than one.
        expect(cards.find((card) => card.name === "web")?.href).toBe("/apps/containers?c=local");
    });
});

describe("addressing the machine Polaris runs on", () => {
    it("is `local` in a URL and the reserved id only in the tables", () => {
        expect(hostRouteId(LOCAL_HOST_SUBJECT)).toBe("local");
        expect(hostSubject("local")).toBe(LOCAL_HOST_SUBJECT);
    });

    it("leaves every other server addressed by its own id", () => {
        const host = "33333333-3333-4333-8333-333333333333";
        expect(hostSubject(host)).toBe(host);
        expect(hostRouteId(host)).toBe(host);
    });
});
