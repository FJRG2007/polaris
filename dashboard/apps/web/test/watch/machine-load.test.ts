/**
 * What a server's Load chart is measured from.
 *
 * It used to be the containers on the machine and nothing else, which made the
 * one server most in need of monitoring - a box with nothing deployed on it yet -
 * chart a flat zero, directly under a panel reporting its real CPU, memory and
 * disk. Reading the same machine two ways and drawing the emptier of them is not
 * a machine at rest; it is monitoring that does not work.
 *
 * These pin the arrangement that replaced it: the machine answers for itself, its
 * containers answer for what the machine could not be asked, and a server that
 * answers neither way is a gap rather than a zero.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const LOCAL_SUBJECT = "00000000-0000-4000-8000-000000000001";

interface HostRow extends Record<string, unknown> {
    id: string;
    ownerId: string;
    dockerId: string | null;
}

let hosts: HostRow[] = [];
/** Which servers have a reachable daemon, and the id it answers with. */
let daemons: Record<string, string> = {};
/** What each server says about itself when it is probed. Absent means the probe
 *  failed - no login, or the machine is off. */
let probes: Record<string, Partial<ProbeReading>> = {};
const settings = new Map<string, string>();
const written: Record<string, unknown>[] = [];

interface ProbeReading {
    loadAverage: number | null;
    cpuCount: number | null;
    memoryUsedBytes: number | null;
    memoryTotalBytes: number | null;
    diskUsedBytes: number | null;
    diskTotalBytes: number | null;
    netRxBytes: number | null;
    netTxBytes: number | null;
}

vi.mock("@polaris/db", () => ({
    prisma: {
        host: {
            findMany: async () => hosts,
            updateMany: async ({ where, data }: { where: { id: string }; data: { dockerId: string } }) => {
                const host = hosts.find((entry) => entry.id === where.id);
                if (host) host.dockerId = data.dockerId;
                return { count: host ? 1 : 0 };
            }
        },
        setting: {
            findMany: async () => [],
            findUnique: async ({ where }: { where: { key: string } }) => {
                const value = settings.get(where.key);
                return value === undefined ? null : { value };
            },
            upsert: async ({ create }: { create: { key: string; value: string } }) => {
                settings.set(create.key, create.value);
                return create;
            }
        },
        application: { findMany: async () => [] },
        metricSample: {
            findMany: async () => [],
            createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
                written.push(...data);
                return { count: data.length };
            }
        }
    }
}));

/** A daemon with one running container, so the container path has something to
 *  add up whenever the machine itself cannot be read. */
function engine(dockerId: string) {
    return {
        info: async () => ({
            id: dockerId,
            name: "box",
            serverVersion: "27",
            containers: 1,
            containersRunning: 1,
            containersStopped: 0,
            images: 1,
            ncpu: 4,
            memTotal: 8_000_000_000
        }),
        listContainers: async () => [
            { id: `${dockerId}-c1`, name: "web", image: "nginx", state: "running", status: "Up 2 hours" }
        ],
        statsMany: async (ids: string[]) =>
            new Map(
                ids.map((id) => [
                    id,
                    {
                        cpuPercent: 40,
                        memUsage: 1_000_000,
                        memLimit: 8_000_000_000,
                        memPercent: 12.5,
                        netRx: 5_000,
                        netTx: 2_000
                    }
                ])
            ),
        stats: async () => ({ cpuPercent: 40, memUsage: 1_000_000, memLimit: 8_000_000_000, memPercent: 12.5 }),
        dispose: async () => undefined
    };
}

const LOCAL_ENGINE = "AAAA:LOCAL";

vi.mock("@/lib/docker-service", () => ({
    LOCAL_DOCKER_CONNECTION_ID: "local",
    HOST_DOCKER_PREFIX: "host:",
    localDockerDriver: () => engine(LOCAL_ENGINE),
    hostDockerDriver: async (hostId: string) => {
        const id = daemons[hostId];
        // A server where Docker was never installed. It is the state every
        // enrolled machine starts in, and it used to mean no chart at all.
        if (!id) throw new Error("no daemon");
        return engine(id);
    }
}));

vi.mock("@/lib/server-metrics-service", () => ({
    getServerMetrics: async (hostId: string) => {
        const probe = probes[hostId];
        if (!probe) throw new Error("unreachable");
        return {
            os: "Ubuntu 22.04.2 LTS",
            kernel: "5.15.0",
            cpuCount: null,
            loadAverage: null,
            memoryTotalBytes: null,
            memoryUsedBytes: null,
            diskTotalBytes: null,
            diskUsedBytes: null,
            netRxBytes: null,
            netTxBytes: null,
            consumers: [],
            probedAt: new Date().toISOString(),
            ...probe
        };
    }
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

/** The row written for one server this tick. */
function rowFor(subjectId: string): Record<string, unknown> | undefined {
    return written.find((row) => row.subjectType === "host" && row.subjectId === subjectId);
}

beforeEach(() => {
    written.length = 0;
    settings.clear();
    hosts = [];
    daemons = {};
    probes = {};
});

describe("a server with nothing deployed on it", () => {
    it("charts the machine's own load, where it used to chart nothing at all", async () => {
        hosts = [{ id: "h1", ownerId: "u1", dockerId: null }];
        probes = {
            h1: {
                loadAverage: 0.11,
                cpuCount: 2,
                memoryUsedBytes: 1_100_000_000,
                memoryTotalBytes: 3_800_000_000,
                diskUsedBytes: 15_000_000_000,
                diskTotalBytes: 155_000_000_000
            }
        };

        await collectMetricsOnce({ storage: false });

        const row = rowFor("h1");
        // 0.11 of two cores, the same reading the panel above the chart shows.
        expect(row?.cpuPercent).toBe(5.5);
        expect(row?.memUsedBytes).toBe(1_100_000_000n);
        expect(row?.memTotalBytes).toBe(3_800_000_000n);
        // And the disk, which a server reached over SSH never reported before.
        expect(row?.diskUsedBytes).toBe(15_000_000_000n);
        expect(row?.diskTotalBytes).toBe(155_000_000_000n);
    });

    it("is a gap, not a zero, when the machine cannot be read at all", async () => {
        hosts = [{ id: "h1", ownerId: "u1", dockerId: null }];

        await collectMetricsOnce({ storage: false });

        expect(rowFor("h1")).toBeUndefined();
    });
});

describe("a server that is running something", () => {
    it("measures the whole machine rather than the sum of its containers", async () => {
        hosts = [{ id: "h2", ownerId: "u1", dockerId: null }];
        daemons = { h2: "BBBB:REMOTE" };
        probes = { h2: { loadAverage: 1, cpuCount: 4, memoryUsedBytes: 2_000_000_000, memoryTotalBytes: 8_000_000_000 } };

        await collectMetricsOnce({ storage: false });

        const row = rowFor("h2");
        // Not the container's 40%, and not its megabyte of memory: everything on
        // the machine counts, including what Polaris did not deploy.
        expect(row?.cpuPercent).toBe(25);
        expect(row?.memUsedBytes).toBe(2_000_000_000n);
    });

    it("falls back to its containers when the machine itself cannot be read", async () => {
        hosts = [{ id: "h2", ownerId: "u1", dockerId: null }];
        daemons = { h2: "BBBB:REMOTE" };

        await collectMetricsOnce({ storage: false });

        const row = rowFor("h2");
        expect(row?.cpuPercent).toBe(40);
        expect(row?.memUsedBytes).toBe(1_000_000n);
    });

    it("still records which daemon the server answered with", async () => {
        hosts = [{ id: "h2", ownerId: "u1", dockerId: null }];
        daemons = { h2: "BBBB:REMOTE" };

        await collectMetricsOnce({ storage: false });

        expect(hosts[0]?.dockerId).toBe("BBBB:REMOTE");
    });

    // The daemon id only ever arrives from a machine that can be reached. One
    // that cannot must not come back as a second server disagreeing with the
    // local half about the same CPU.
    it("does not chart the box Polaris runs on twice when its daemon stops answering", async () => {
        hosts = [{ id: "h1", ownerId: "u1", dockerId: LOCAL_ENGINE }];
        probes = { h1: { loadAverage: 0.5, cpuCount: 2 } };

        await collectMetricsOnce({ storage: false });

        const subjects = written.filter((row) => row.subjectType === "host").map((row) => row.subjectId);
        expect(subjects).toEqual([LOCAL_SUBJECT]);
    });
});

describe("what a server moved over the network", () => {
    it("counts the machine's own interfaces, from the second reading on", async () => {
        hosts = [{ id: "h3", ownerId: "u1", dockerId: null }];
        probes = { h3: { netRxBytes: 900_000_000, netTxBytes: 40_000_000 } };

        await collectMetricsOnce({ storage: false });
        // A counter is a position, not a distance: the first reading of a machine
        // that has been up for a month cannot become a minute's traffic.
        expect(rowFor("h3")?.netRxBytes).toBe(0n);

        written.length = 0;
        probes = { h3: { netRxBytes: 900_500_000, netTxBytes: 40_100_000 } };
        await collectMetricsOnce({ storage: false });

        expect(rowFor("h3")?.netRxBytes).toBe(500_000n);
        expect(rowFor("h3")?.netTxBytes).toBe(100_000n);
    });
});
