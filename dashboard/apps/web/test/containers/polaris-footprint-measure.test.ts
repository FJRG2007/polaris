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

const driver = {
    listContainers: async () => {
        started += 1;
        await inFlight;
        return [
            {
                id: "c1",
                name: "polaris-web-181",
                image: "polaris/web:181",
                state: "running",
                composeProject: "polaris",
                composeService: "web"
            }
        ];
    },
    info: async () => ({ memTotal: 16_000 }),
    statsMany: async () => new Map(),
    inspect: async () => ({ mounts: [], sizeRw: 10, sizeRootFs: 100 }),
    dispose: async () => undefined
};

vi.mock("@/lib/docker-service", () => ({ localDockerDriver: () => driver }));

vi.mock("@/lib/deploy/ports-hostd", () => ({
    HostdPorts: class {
        async diskUsage(): Promise<number | null> {
            return null;
        }
        async dispose(): Promise<void> {}
    }
}));

const { readPolarisFootprint } = await import("@/lib/polaris-footprint");

beforeEach(() => {
    started = 0;
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
