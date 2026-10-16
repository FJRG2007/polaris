/**
 * Reading the NVIDIA cards on a machine: what `nvidia-smi` prints, how a process
 * is tied to the container it runs in, and the machine-wide row a chart draws.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as nvidia from "@/lib/gpu/nvidia";
import { parseProbe } from "@/lib/server-probe";

const CONTAINER = "a".repeat(64);
const OTHER = "b".repeat(64);

const OUTPUT = [
    "os=Ubuntu 24.04 LTS",
    "gpu=0, GPU-11111111-2222-3333-4444-555555555555, 37, 2048, 24576, 61, 182.43, NVIDIA GeForce RTX 4090",
    "gpu=1, GPU-66666666-7777-8888-9999-000000000000, [N/A], 512, 16384, [Not Supported], [N/A], NVIDIA A2, Rev B",
    `gpuproc=GPU-11111111-2222-3333-4444-555555555555,4242,1500,${CONTAINER}`,
    `gpuproc=GPU-66666666-7777-8888-9999-000000000000,4242,100,${CONTAINER}`,
    `gpuproc=GPU-11111111-2222-3333-4444-555555555555,5151,300,${OTHER}`,
    "gpuproc=GPU-11111111-2222-3333-4444-555555555555,77,64,",
    "load=0.4"
].join("\n");

describe("an nvidia-smi reading", () => {
    it("reads each card, keeping a missing figure missing rather than zero", () => {
        const report = nvidia.parseGpuReport(OUTPUT);
        expect(report.gpus).toHaveLength(2);
        expect(report.gpus[0]).toEqual({
            index: 0,
            uuid: "GPU-11111111-2222-3333-4444-555555555555",
            name: "NVIDIA GeForce RTX 4090",
            utilizationPercent: 37,
            memoryUsedBytes: 2048 * 1024 * 1024,
            memoryTotalBytes: 24576 * 1024 * 1024,
            temperatureC: 61,
            powerWatts: 182.43
        });
        expect(report.gpus[1]).toMatchObject({
            name: "NVIDIA A2, Rev B",
            utilizationPercent: null,
            temperatureC: null,
            powerWatts: null
        });
    });

    it("is empty on a machine with no card", () => {
        expect(nvidia.parseGpuReport("os=Debian\nload=1\n")).toEqual({ gpus: [], processes: [] });
        expect(nvidia.parseGpuReport("")).toEqual({ gpus: [], processes: [] });
    });

    it("skips a line it cannot read and a card it has already seen", () => {
        const report = nvidia.parseGpuReport(
            [
                "gpu=garbage",
                "gpu=0, , 1, 2, 3, 4, 5, Nameless uuid",
                "gpu=0, GPU-x, 1, 2, 3, 4, 5, A",
                "gpu=0, GPU-x, 9, 9, 9, 9, 9, A again",
                "gpuproc=GPU-x,notapid,10,",
                "gpuproc=GPU-x,12,10,not-a-container-id"
            ].join("\n")
        );
        expect(report.gpus.map((gpu) => gpu.name)).toEqual(["A"]);
        expect(report.processes).toEqual([
            { gpuUuid: "GPU-x", pid: 12, memoryUsedBytes: 10 * 1024 * 1024, containerId: null }
        ]);
    });

    it("keeps a bounded number of cards", () => {
        const lines = Array.from({ length: 40 }, (_, index) => `gpu=${index}, GPU-${index}, 1, 1, 1, 1, 1, Card`);
        expect(nvidia.parseGpuReport(lines.join("\n")).gpus).toHaveLength(nvidia.MAX_GPUS);
    });
});

describe("a card's processes, by container", () => {
    it("adds up each container's memory across the cards it holds", () => {
        const report = nvidia.parseGpuReport(OUTPUT);
        const usage = nvidia.gpuUsageByContainer(report, [{ id: CONTAINER }, { id: OTHER.slice(0, 12) }]);
        expect(usage.get(CONTAINER)).toEqual({
            memoryUsedBytes: 1600 * 1024 * 1024,
            gpuUuids: ["GPU-11111111-2222-3333-4444-555555555555", "GPU-66666666-7777-8888-9999-000000000000"]
        });
        // A listing that gives the short id still finds its container.
        expect(usage.get(OTHER.slice(0, 12))?.memoryUsedBytes).toBe(300 * 1024 * 1024);
        expect(usage.size).toBe(2);
    });

    it("leaves out a process on the host and one in a container that is not listed", () => {
        const usage = nvidia.gpuUsageByContainer(nvidia.parseGpuReport(OUTPUT), [{ id: "c".repeat(64) }]);
        expect(usage.size).toBe(0);
    });
});

describe("the machine's cards as one row", () => {
    it("averages how busy, adds memory and power, and takes the hottest card", () => {
        const summary = nvidia.summarizeGpus(nvidia.parseGpuReport(OUTPUT).gpus);
        expect(summary).toEqual({
            utilizationPercent: 37,
            memoryUsedBytes: 2560 * 1024 * 1024,
            memoryTotalBytes: 40960 * 1024 * 1024,
            temperatureC: 61,
            powerWatts: 182.43
        });
    });

    it("is null with no card", () => {
        expect(nvidia.summarizeGpus([])).toBeNull();
    });
});

describe("the script", () => {
    it("is the one the host daemon runs, word for word", () => {
        const rust = readFileSync(
            new URL("../../../../../crates/polaris-hostd/src/gpu.rs", import.meta.url),
            "utf8"
        );
        expect(rust).toContain(`r#"${nvidia.GPU_SCRIPT}"#`);
    });

    it("does nothing on a machine without nvidia-smi", () => {
        expect(nvidia.GPU_SCRIPT.startsWith("if command -v nvidia-smi >/dev/null 2>&1; then\n")).toBe(true);
        expect(nvidia.GPU_SCRIPT.trimEnd().endsWith("fi")).toBe(true);
    });
});

describe("a server's probe", () => {
    it("carries the cards, and keeps their lines out of the machine's own figures", () => {
        const metrics = parseProbe(OUTPUT);
        expect(metrics.os).toBe("Ubuntu 24.04 LTS");
        expect(metrics.gpu?.gpus.map((gpu) => gpu.index)).toEqual([0, 1]);
        expect(metrics.gpu?.processes).toHaveLength(4);
        expect(metrics.consumers).toEqual([]);
    });

    it("has no card on a machine without nvidia-smi", () => {
        expect(parseProbe(["os=Debian 12", "load=0.1"].join("\n")).gpu).toEqual({ gpus: [], processes: [] });
    });
});
