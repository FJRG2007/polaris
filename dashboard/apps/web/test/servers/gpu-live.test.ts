/**
 * The latest GPU reading of each machine, as the collector keeps it in memory,
 * and the read of the machine Polaris runs on through its host daemon.
 *
 * The daemon is a stand-in here: what is pinned is how often it is asked. A
 * machine without a card must not be asked every minute, and one failed reading
 * on a machine that has a card must not hide it for an hour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hostGpu = vi.fn();
vi.mock("@polaris/hostd-client", () => ({
    HostdClient: class {
        public hostGpu = hostGpu;
    }
}));

import * as live from "@/lib/gpu/gpu-live";
import type { GpuReport } from "@/lib/gpu/nvidia";

const CONTAINER = "c".repeat(64);
const CARD = "GPU-11111111-2222-3333-4444-555555555555";

const REPORT: GpuReport = {
    gpus: [
        {
            index: 0,
            uuid: CARD,
            name: "NVIDIA A2",
            utilizationPercent: 12,
            memoryUsedBytes: 1024,
            memoryTotalBytes: 4096,
            temperatureC: 50,
            powerWatts: 30
        }
    ],
    processes: [
        { gpuUuid: CARD, pid: 10, memoryUsedBytes: 512, containerId: CONTAINER },
        { gpuUuid: CARD, pid: 11, memoryUsedBytes: 256, containerId: null }
    ]
};

beforeEach(() => {
    hostGpu.mockReset();
    live.resetLocalGpuCheck();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("a machine's latest cards", () => {
    it("keeps each container's share by the name it runs under", () => {
        const entry = live.recordMachineGpus("host-a", REPORT, [
            { id: CONTAINER, name: "/web-1" },
            { id: "d".repeat(64), name: "/idle" }
        ]);
        expect(entry?.gpus).toHaveLength(1);
        expect([...(entry?.containers.keys() ?? [])]).toEqual(["web-1"]);
        expect(entry?.containers.get("web-1")).toEqual({ memoryUsedBytes: 512, gpuUuids: [CARD] });
        expect(live.machineGpus("host-a")).toBe(entry);
    });

    it("forgets a machine whose reading has no card", () => {
        live.recordMachineGpus("host-b", REPORT, []);
        expect(live.machineGpus("host-b")).not.toBeNull();
        expect(live.recordMachineGpus("host-b", { gpus: [], processes: [] }, [])).toBeNull();
        expect(live.machineGpus("host-b")).toBeNull();
        live.recordMachineGpus("host-b", REPORT, []);
        expect(live.recordMachineGpus("host-b", null, [])).toBeNull();
        expect(live.machineGpus("host-b")).toBeNull();
    });

    it("does not keep showing a machine that stopped answering", () => {
        vi.useFakeTimers();
        live.recordMachineGpus("host-c", REPORT, []);
        vi.advanceTimersByTime(11 * 60_000);
        expect(live.machineGpus("host-c")).toBeNull();
    });

    it("has nothing for a machine never read", () => {
        expect(live.machineGpus("never-read")).toBeNull();
    });
});

describe("the machine Polaris runs on", () => {
    it("parses what the daemon read", async () => {
        hostGpu.mockResolvedValue({
            present: true,
            output: `gpu=0, ${CARD}, 5, 100, 4096, 40, [N/A], NVIDIA A2\n`
        });
        const report = await live.readLocalGpus();
        expect(report?.gpus.map((gpu) => [gpu.index, gpu.name, gpu.powerWatts])).toEqual([
            [0, "NVIDIA A2", null]
        ]);
    });

    it("asks a machine without a card once an hour, not every minute", async () => {
        vi.useFakeTimers();
        hostGpu.mockResolvedValue({ present: false, output: "" });
        expect(await live.readLocalGpus()).toBeNull();
        vi.advanceTimersByTime(59 * 60_000);
        expect(await live.readLocalGpus()).toBeNull();
        expect(hostGpu).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(2 * 60_000);
        await live.readLocalGpus();
        expect(hostGpu).toHaveBeenCalledTimes(2);
    });

    it("asks again a few minutes after a failed reading", async () => {
        vi.useFakeTimers();
        hostGpu.mockRejectedValue(new Error("hostd gpu reading failed (504)"));
        expect(await live.readLocalGpus()).toBeNull();
        vi.advanceTimersByTime(4 * 60_000);
        await live.readLocalGpus();
        expect(hostGpu).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(2 * 60_000);
        await live.readLocalGpus();
        expect(hostGpu).toHaveBeenCalledTimes(2);
    });

    it("skips a tick on a daemon that is busy or predates the reading", async () => {
        hostGpu.mockResolvedValue(null);
        expect(await live.readLocalGpus()).toBeNull();
        await live.readLocalGpus();
        expect(hostGpu).toHaveBeenCalledTimes(2);
    });
});
