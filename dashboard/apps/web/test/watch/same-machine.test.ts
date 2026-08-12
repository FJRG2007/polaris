/**
 * The box that is both "the machine Polaris runs on" and a server somebody
 * enrolled over SSH.
 *
 * It is one machine, and monitoring it twice is not a cosmetic duplicate: the two
 * passes sample it seconds apart through different paths, so the same CPU shows up
 * as two servers that disagree with each other, and every container on it is
 * listed twice. The Docker daemon's id is what settles the question, and these pin
 * down that the answer is used in both places - the collector, which must not
 * write two series, and the cards, which must not show two servers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const LOCAL_SUBJECT = "00000000-0000-4000-8000-000000000001";

interface HostRow extends Record<string, unknown> {
    id: string;
    name: string;
    ownerId: string;
    address: string;
    username: string;
    dockerId: string | null;
}

let hosts: HostRow[] = [];
/** Which daemon each server ACTUALLY answers with when it is reached. Separate
 *  from the `dockerId` on the row, which is only what was recorded last time. */
let daemons: Record<string, string> = {};
let localDockerIdValue: string | null = null;
/** What the mDNS responder published as this machine's own address, if anything. */
let lanIp: string | null = null;
const written: Record<string, unknown>[] = [];

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
            // Keyed, not blanket: the local machine is now identified from more
            // than one setting, and a mock that answers every key with the daemon
            // id would let a test pass on a signal it never set.
            findUnique: async ({ where }: { where: { key: string } }) =>
                where.key === "metrics.localDockerId" && localDockerIdValue ? { value: localDockerIdValue } : null,
            upsert: async ({ create }: { create: { value: string } }) => {
                localDockerIdValue = create.value;
                return create;
            }
        },
        application: { findMany: async () => [] },
        alarm: { findMany: async () => [] },
        metricSample: {
            findMany: async () => [],
            createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
                written.push(...data);
                return { count: data.length };
            }
        }
    }
}));

/** An engine reporting a given daemon id, with one running container. */
function engine(dockerId: string) {
    return {
        info: async () => ({ id: dockerId, name: "box", serverVersion: "27", containers: 1, containersRunning: 1, containersStopped: 0, images: 1, ncpu: 4, memTotal: 8_000_000_000 }),
        listContainers: async () => [{ id: `${dockerId}-c1`, name: "web", image: "nginx", state: "running", status: "Up 2 hours" }],
        statsMany: async (ids: string[]) =>
            new Map(ids.map((id) => [id, { cpuPercent: 40, memUsage: 1_000_000, memLimit: 8_000_000_000, memPercent: 12.5 }])),
        stats: async () => ({ cpuPercent: 40, memUsage: 1_000_000, memLimit: 8_000_000_000, memPercent: 12.5 }),
        dispose: async () => undefined
    };
}

/** The daemon every path lands on when the enrolled server IS the local box. */
const SAME = "AAAA:BBBB:SAME";
const OTHER = "CCCC:DDDD:OTHER";

vi.mock("@/lib/docker-service", () => ({
    LOCAL_DOCKER_CONNECTION_ID: "local",
    HOST_DOCKER_PREFIX: "host:",
    localDockerDriver: () => engine(SAME),
    hostDockerDriver: async (hostId: string) => engine(daemons[hostId] ?? OTHER)
}));
vi.mock("@/lib/host-address", () => ({
    getHostLanIp: async () => lanIp,
    isLanAddress: () => true
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
const { getWatchContainers, getWatchServers } = await import("@/lib/watch-overview-service");

beforeEach(() => {
    written.length = 0;
    localDockerIdValue = null;
    lanIp = null;
    hosts = [];
    daemons = {};
});

describe("collecting from a server that is the machine Polaris runs on", () => {
    it("writes one series for the box, not one per way of reaching it", async () => {
        hosts = [{ id: "h1", name: "lirio-0", ownerId: "u1", address: "192.168.1.138", username: "polaris", dockerId: null }];
        daemons = { h1: SAME };

        await collectMetricsOnce({ storage: false });

        const hostRows = written.filter((row) => row.subjectType === "host");
        expect(hostRows).toHaveLength(1);
        expect(hostRows[0]?.subjectId).toBe(LOCAL_SUBJECT);
    });

    it("remembers which daemon each side turned out to be", async () => {
        hosts = [{ id: "h1", name: "lirio-0", ownerId: "u1", address: "192.168.1.138", username: "polaris", dockerId: null }];
        daemons = { h1: SAME };

        await collectMetricsOnce({ storage: false });

        expect(localDockerIdValue).toBe(SAME);
        expect(hosts[0]?.dockerId).toBe(SAME);
    });

    it("still measures a server that is a different machine", async () => {
        hosts = [
            { id: "h1", name: "lirio-0", ownerId: "u1", address: "192.168.1.138", username: "polaris", dockerId: null },
            { id: "h2", name: "lirio-2", ownerId: "u1", address: "192.168.1.160", username: "polaris", dockerId: OTHER }
        ];
        daemons = { h1: SAME, h2: OTHER };

        await collectMetricsOnce({ storage: false });

        const subjects = written.filter((row) => row.subjectType === "host").map((row) => row.subjectId);
        expect(subjects).toEqual([LOCAL_SUBJECT, "h2"]);
    });
});

describe("the servers Watch shows", () => {
    it("shows the box once, under the name it was enrolled with", async () => {
        hosts = [{ id: "h1", name: "lirio-0", ownerId: "u1", address: "192.168.1.138", username: "polaris", dockerId: SAME }];
        localDockerIdValue = SAME;

        const cards = await getWatchServers("u1");

        expect(cards).toHaveLength(1);
        expect(cards[0]?.id).toBe(LOCAL_SUBJECT);
        expect(cards[0]?.name).toBe("lirio-0");
        // And it says why there is only one of it.
        expect(cards[0]?.detail).toContain("polaris@192.168.1.138");
        expect(cards[0]?.detail).toContain("the machine Polaris runs on");
    });

    it("keeps a genuinely remote server as its own card", async () => {
        hosts = [{ id: "h2", name: "lirio-2", ownerId: "u1", address: "192.168.1.160", username: "polaris", dockerId: OTHER }];
        localDockerIdValue = SAME;

        const cards = await getWatchServers("u1");

        expect(cards.map((card) => card.id)).toEqual([LOCAL_SUBJECT, "h2"]);
        expect(cards[0]?.name).toBe("Local");
    });

    it("lists the box's containers once, not once per route to it", async () => {
        hosts = [{ id: "h1", name: "lirio-0", ownerId: "u1", address: "192.168.1.138", username: "polaris", dockerId: SAME }];
        localDockerIdValue = SAME;

        const cards = await getWatchContainers("u1");

        expect(cards).toHaveLength(1);
        expect(cards[0]?.detail).toContain("lirio-0");
    });

    it("does not merge a server it has not identified yet", async () => {
        // Nothing sampled since the server was added, and no address to go on.
        // Guessing here would hide a real machine, which is worse than briefly
        // showing one twice.
        hosts = [{ id: "h1", name: "lirio-0", ownerId: "u1", address: "192.168.1.138", username: "polaris", dockerId: null }];
        localDockerIdValue = SAME;

        const cards = await getWatchServers("u1");

        expect(cards.map((card) => card.id)).toEqual([LOCAL_SUBJECT, "h1"]);
    });

    // The daemon id only ever arrives for a server the collector can reach over
    // SSH - which is precisely the server that otherwise sits there reporting
    // nothing. The address is known before anything has been sampled.
    it("merges a server enrolled at this machine's own address", async () => {
        hosts = [{ id: "h1", name: "lirio-0", ownerId: "u1", address: "192.168.1.138", username: "polaris", dockerId: null }];
        lanIp = "192.168.1.138";

        const cards = await getWatchServers("u1");

        expect(cards).toHaveLength(1);
        expect(cards[0]?.name).toBe("lirio-0");
    });

    it("leaves a server at another address alone", async () => {
        hosts = [{ id: "h2", name: "lirio-2", ownerId: "u1", address: "192.168.1.160", username: "polaris", dockerId: null }];
        lanIp = "192.168.1.138";

        const cards = await getWatchServers("u1");

        expect(cards.map((card) => card.id)).toEqual([LOCAL_SUBJECT, "h2"]);
    });
});
