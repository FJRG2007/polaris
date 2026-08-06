/**
 * The Containers listing, and the promise that it does not wait for usage.
 *
 * Docker holds a stats request open for about a second per container, so a page
 * that sampled every container before answering took seconds to paint and paid
 * it again on every five-second poll. The listing now answers from what was last
 * sampled and takes the fresh pass behind the response, which is only true if:
 * the answer really does come back while a pass is still running, the numbers
 * really do arrive on a later read, a warm host is not re-sampled by every tab
 * looking at it, and a container's own page can find the sample the listing took
 * even though it is addressed by name and the listing stored it by id.
 *
 * The engine is a stub whose stats call is deliberately slower than the assertion
 * that overtakes it, which is what makes "did not wait" measurable rather than
 * asserted.
 */

import type { ContainerStats } from "@polaris/docker";
import { rememberSample } from "@/lib/container-stats-cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SAMPLE_MS = 300;

interface StubContainer {
    id: string;
    name: string;
    state: string;
}

let containers: StubContainer[] = [];
let statsCalls: string[][] = [];
let cpu = 10;

const driver = {
    canAttach: true,
    info: async () => ({
        id: "engine",
        name: "docker-host",
        serverVersion: "27.0.0",
        containers: containers.length,
        containersRunning: containers.filter((entry) => entry.state === "running").length,
        containersStopped: containers.filter((entry) => entry.state !== "running").length,
        images: 4,
        ncpu: 16,
        memTotal: 32_000_000_000
    }),
    listContainers: async () =>
        containers.map((entry) => ({ ...entry, image: "nginx:latest", status: "Up 2 hours" })),
    statsMany: async (ids: string[]) => {
        statsCalls.push(ids);
        await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
        return new Map<string, ContainerStats | null>(ids.map((id) => [id, sample(cpu)]));
    }
};

function sample(cpuPercent: number): ContainerStats {
    return {
        cpuPercent,
        memUsage: 273_700_000,
        memLimit: 32_000_000_000,
        memPercent: 0.87,
        netRx: 6_000_000,
        netTx: 1_700_000,
        blockRead: 24_000,
        blockWrite: 8_000
    };
}

vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "user-1" }),
    userHasManage: async () => true
}));

vi.mock("@/lib/docker-service", () => ({
    LOCAL_DOCKER_CONNECTION_ID: "local",
    HOST_DOCKER_PREFIX: "host:",
    // Stands in for the owner-scoped lookup: every host here belongs to the
    // caller except the one named for the case that checks a stranger's does not.
    ownsDockerConnection: async (connectionId: string) => connectionId !== "host-of-somebody-else"
}));

vi.mock("@/lib/container-service", () => ({
    accessFor: () => "hostd",
    withDockerDriver: async (
        _connectionId: string,
        _userId: string,
        run: (value: typeof driver) => unknown
    ) => run(driver),
    containerStats: async (_connectionId: string, _userId: string, id: string) => {
        statsCalls.push([id]);
        await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
        return sample(cpu);
    }
}));

const { GET: listContainers } = await import("../../src/app/api/containers/route");
const { GET: readStats } = await import("../../src/app/api/containers/stats/route");
type HostSnapshot = import("../../src/app/(app)/apps/containers/types").HostSnapshot;
type ContainerUsageReply = import("../../src/app/(app)/apps/containers/types").ContainerUsageReply;

async function list(connection: string): Promise<HostSnapshot> {
    const response = await listContainers(
        new Request(`http://localhost/api/containers?c=${connection}`)
    );
    return (await response.json()) as HostSnapshot;
}

async function stats(connection: string, id: string): Promise<ContainerUsageReply> {
    const response = await readStats(
        new Request(`http://localhost/api/containers/stats?c=${connection}&id=${id}`)
    );
    return (await response.json()) as ContainerUsageReply;
}

/** Poll until a listing carries usage, or give up. The pass runs behind the
 *  response, so this is how a caller learns it landed - the same way the page's
 *  own poll does. */
async function listWithUsage(connection: string, attempts = 20): Promise<HostSnapshot> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const snapshot = await list(connection);
        if (snapshot.statsAt !== null) return snapshot;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("usage never arrived");
}

beforeEach(() => {
    containers = [
        { id: "aaa111", name: "polaris-web", state: "running" },
        { id: "bbb222", name: "polaris-db", state: "running" },
        { id: "ccc333", name: "polaris-old", state: "exited" }
    ];
    statsCalls = [];
    cpu = 10;
});

describe("containers listing", () => {
    it("answers before the engine has been asked for usage", async () => {
        const started = Date.now();
        const snapshot = await list("host-a");
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(SAMPLE_MS);
        expect(snapshot.containers).toHaveLength(3);
        expect(snapshot.statsAt).toBeNull();
        expect(snapshot.containers[0]?.cpuPercent).toBeNull();
        // The pass it started is still running behind the answer.
        expect(statsCalls).toHaveLength(1);
    });

    it("samples only the running containers", async () => {
        await list("host-b");
        expect(statsCalls[0]).toEqual(["aaa111", "bbb222"]);
    });

    it("carries the numbers on a later read, with when they were taken", async () => {
        const snapshot = await listWithUsage("host-c");

        expect(snapshot.containers[0]?.cpuPercent).toBe(10);
        expect(snapshot.containers[0]?.statsAt).toBeGreaterThan(0);
        expect(snapshot.overview.aggregateCpuPercent).toBe(20);
        expect(snapshot.overview.aggregateMemUsage).toBe(547_400_000);
        // A stopped container has nothing to sample and is not made to look like
        // it does.
        expect(snapshot.containers[2]?.cpuPercent).toBeNull();
        expect(snapshot.containers[2]?.statsAt).toBeNull();
    });

    it("does not re-sample a host whose readings are still warm", async () => {
        await listWithUsage("host-d");
        const passes = statsCalls.length;
        await list("host-d");
        await list("host-d");
        expect(statsCalls).toHaveLength(passes);
    });

    it("runs one pass at a time however many tabs are watching", async () => {
        await Promise.all([list("host-e"), list("host-e"), list("host-e")]);
        expect(statsCalls).toHaveLength(1);
    });

    it("re-samples the host when a container the last pass never covered appears", async () => {
        await listWithUsage("host-j");
        const passes = statsCalls.length;
        containers.push({ id: "ddd444", name: "polaris-new", state: "running" });

        // One warm container does not make the host warm: the new one has never
        // been sampled, so the readings are incomplete however fresh the rest are.
        const snapshot = await list("host-j");

        expect(snapshot.statsAt).toBeNull();
        expect(statsCalls).toHaveLength(passes + 1);
        expect(statsCalls.at(-1)).toEqual(["aaa111", "bbb222", "ddd444"]);
    });

    it("does not present a half-measured host total as a real figure", async () => {
        await listWithUsage("host-k");
        containers.push({ id: "ddd444", name: "polaris-new", state: "running" });

        const snapshot = await list("host-k");

        // The totals add up only what was measured, so while one container is
        // missing from them they are not offered as the host's usage at all.
        expect(snapshot.statsAt).toBeNull();
        expect(snapshot.containers.find((row) => row.id === "ddd444")?.cpuPercent).toBeNull();
    });

    it("reports a host with nothing running as measured rather than pending", async () => {
        containers = containers.map((entry) => ({ ...entry, state: "exited" }));
        const snapshot = await list("host-l");

        // Nothing to sample is a complete answer: the totals are zero and true,
        // which is a figure rather than a reading that never arrives.
        expect(snapshot.statsAt).not.toBeNull();
        expect(snapshot.overview.aggregateCpuPercent).toBe(0);
        expect(statsCalls).toHaveLength(0);
    });

    it("forgets a container the engine no longer lists", async () => {
        await listWithUsage("host-f");
        containers = containers.filter((entry) => entry.id !== "bbb222");
        // One read to prune and start a pass over what is left, then the answer.
        const snapshot = await listWithUsage("host-f");
        expect(snapshot.containers.map((row) => row.id)).toEqual(["aaa111", "ccc333"]);
        expect(await stats("host-f", "polaris-db")).toMatchObject({ stats: { cpuPercent: 10 } });
    });
});

describe("one container's usage", () => {
    it("is answered from the listing's sample, by name as well as by id", async () => {
        await listWithUsage("host-g");
        const passes = statsCalls.length;

        const byName = await stats("host-g", "polaris-web");
        const byId = await stats("host-g", "aaa111");

        expect(byName.stats?.cpuPercent).toBe(10);
        expect(byName.at).toBeGreaterThan(0);
        expect(byId.stats?.cpuPercent).toBe(10);
        // Neither cost a read: the listing had already taken one.
        expect(statsCalls).toHaveLength(passes);
    });

    it("reads the engine for a container nothing has sampled yet", async () => {
        const reply = await stats("host-h", "polaris-web");
        expect(reply.stats?.cpuPercent).toBe(10);
        expect(statsCalls).toEqual([["polaris-web"]]);
    });

    it("is refused for a host the caller does not own, sample or no sample", async () => {
        rememberSample("host-of-somebody-else", ["aaa111", "polaris-web"], sample(77));

        const response = await readStats(
            new Request(
                "http://localhost/api/containers/stats?c=host-of-somebody-else&id=polaris-web"
            )
        );

        // Answering from the cache resolves no connection, so the ownership the
        // driver would have proved has to be established before the sample is
        // read - not after, and not never.
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain("77");
        expect(statsCalls).toHaveLength(0);
    });

    it("serves what it has while a fresh reading is taken behind it", async () => {
        const cold = await stats("host-i", "polaris-web");
        expect(cold.stats?.cpuPercent).toBe(10);

        cpu = 42;
        await new Promise((resolve) => setTimeout(resolve, 4_100));
        // Aged out: this answer is still the old one, and it starts the refresh.
        const stale = await stats("host-i", "polaris-web");
        expect(stale.stats?.cpuPercent).toBe(10);

        await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS + 100));
        const fresh = await stats("host-i", "polaris-web");
        expect(fresh.stats?.cpuPercent).toBe(42);
    });
});
