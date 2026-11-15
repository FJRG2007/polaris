/**
 * Paying for one measurement rather than one per reader.
 *
 * Measuring the stack is not a cheap read: every part is inspected for its size
 * and every running one is asked to measure its own volumes from inside. The held
 * reading covers the second reader who arrives after the first has finished, and
 * nothing covered the one who arrives while it is still running - which is the
 * expensive case, and the one Measure again creates: two tabs, a reload halfway,
 * anyone calling the endpoint with `fresh=1`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** How many measurements have been started, which is the whole assertion. */
let started = 0;
/** Held open so a second caller is guaranteed to arrive mid-measurement rather
 *  than after one that resolved too quickly to overlap. */
let inFlight: Promise<void>;
let finish: () => void;

/** The parts the engine lists, replaced by a test that needs more than one. */
let parts: Record<string, unknown>[] = [];
/** The ids each `statsMany` call was asked for. */
let sampled: string[][] = [];
/** What each part's inspect reports as mounted. */
let mounts: Record<string, { name: string; destination: string; rw: boolean }[]> = {};
/** How long a `du` takes, and how many ran at once at the peak. */
let duDelayMs = 0;
let duActive = 0;
let duPeak = 0;

const driver = {
    listContainers: async () => {
        started += 1;
        await inFlight;
        return parts;
    },
    info: async () => ({ memTotal: 16_000 }),
    statsMany: async (ids: string[]) => {
        sampled.push(ids);
        return new Map(ids.map((id) => [id, { cpuPercent: 1, memUsage: 100 }]));
    },
    inspect: async (id: string) => ({ mounts: mounts[id] ?? [], sizeRw: 10, sizeRootFs: 100 }),
    dispose: async () => undefined
};

vi.mock("@/lib/docker-service", () => ({
    LOCAL_DOCKER_CONNECTION_ID: "local",
    localDockerDriver: () => driver
}));

/** The Containers table's held samples, as the footprint reads them. */
const held = new Map<string, { stats: { cpuPercent: number; memUsage: number }; at: number }>();
vi.mock("@/lib/container-stats-cache", () => ({
    cachedSamples: () => held,
    rememberSample: (
        _connection: string,
        aliases: string[],
        stats: { cpuPercent: number; memUsage: number }
    ) => {
        for (const alias of aliases) held.set(alias, { stats, at: Date.now() });
    }
}));

vi.mock("@/lib/deploy/ports-hostd", () => ({
    HostdPorts: class {
        async diskUsage(): Promise<number | null> {
            duActive += 1;
            duPeak = Math.max(duPeak, duActive);
            await new Promise((resolve) => setTimeout(resolve, duDelayMs));
            duActive -= 1;
            return 1024;
        }
        async dispose(): Promise<void> {}
    }
}));

function part(id: string, service: string): Record<string, unknown> {
    return {
        id,
        name: `polaris-${service}-1`,
        image: `polaris/${service}:1`,
        state: "running",
        composeProject: "polaris",
        composeService: service
    };
}

const { readPolarisFootprint } = await import("@/lib/polaris-footprint");

beforeEach(() => {
    started = 0;
    parts = [part("c1", "web")];
    sampled = [];
    mounts = {};
    held.clear();
    duDelayMs = 0;
    duActive = 0;
    duPeak = 0;
    inFlight = new Promise<void>((resolve) => {
        finish = resolve;
    });
});

describe("measuring Polaris", () => {
    it("hands a second caller the measurement already running", async () => {
        const first = readPolarisFootprint(true);
        const second = readPolarisFootprint(true);
        finish();
        const [one, two] = await Promise.all([first, second]);

        expect(started).toBe(1);
        expect(one).toBe(two);
    });

    it("measures again once the one it was holding is done", async () => {
        finish();
        await readPolarisFootprint(true);
        expect(started).toBe(1);

        await readPolarisFootprint(true);
        expect(started).toBe(2);
    });

    it("serves the held reading to a caller that did not ask for a fresh one", async () => {
        finish();
        const fresh = await readPolarisFootprint(true);
        expect(started).toBe(1);
        expect(await readPolarisFootprint()).toBe(fresh);
        expect(started).toBe(1);
    });
});

describe("measuring Polaris without waiting on what is already known", () => {
    it("reuses the samples the Containers table holds and samples only the rest", async () => {
        parts = [part("c1", "web"), part("c2", "postgres")];
        held.set("c1", { stats: { cpuPercent: 7, memUsage: 700 }, at: Date.now() });
        finish();
        const footprint = await readPolarisFootprint(true);

        // A forced reading asks for every container fresh.
        expect(sampled).toEqual([["c1", "c2"]]);
        expect(footprint.parts.map((one) => one.cpuPercent)).toEqual([1, 1]);
    });

    it("takes a held sample instead of asking the engine on a normal read", async () => {
        parts = [part("c1", "web"), part("c2", "postgres")];
        held.set("c1", { stats: { cpuPercent: 7, memUsage: 700 }, at: Date.now() });
        finish();
        // Past the held reading the earlier tests left behind.
        vi.useFakeTimers({ now: Date.now() + 120_000, toFake: ["Date"] });
        held.set("c1", { stats: { cpuPercent: 7, memUsage: 700 }, at: Date.now() });
        try {
            const footprint = await readPolarisFootprint();
            expect(sampled).toEqual([["c2"]]);
            expect(footprint.parts.find((one) => one.id === "c1")?.cpuPercent).toBe(7);
            // And what it did sample is left for the table.
            expect(held.get("c2")?.stats.cpuPercent).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("measures volumes side by side, once each, and counts a shared one once", async () => {
        parts = [part("c1", "web"), part("c2", "postgres"), part("c3", "redis")];
        mounts = {
            c1: [
                { name: "uploads", destination: "/data/uploads", rw: true },
                { name: "shared", destination: "/shared", rw: true }
            ],
            c2: [
                { name: "pgdata", destination: "/var/lib/postgresql", rw: true },
                { name: "shared", destination: "/shared", rw: true }
            ],
            c3: [{ name: "redis", destination: "/data", rw: true }]
        };
        duDelayMs = 20;
        finish();
        const footprint = await readPolarisFootprint(true);

        expect(duPeak).toBeGreaterThan(1);
        expect(duPeak).toBeLessThanOrEqual(4);
        expect(footprint.volumeBytes).toBe(4 * 1024);
        expect(footprint.diskComplete).toBe(true);
    });
});
