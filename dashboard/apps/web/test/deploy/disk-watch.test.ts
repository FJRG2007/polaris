/**
 * When a disk is worth warning about.
 *
 * A host was found at 99% with its database crash-looping, and the only warning
 * Polaris had was for its own box at 90% after a sweep. What fills a disk is
 * builds, which come in gigabytes, so a share alone says too late on a large disk
 * and a byte count alone cries wolf on a small one.
 */

import { describe, expect, it } from "vitest";
import { diskFromDf, diskLevel, usageFromSystemDf, worsened } from "@/lib/deploy/disk-watch";

const GB = 1000 ** 3;

describe("the level of a disk", () => {
    it("is fine with room to spare", () => {
        expect(diskLevel(100 * GB, 500 * GB)).toBe("ok");
    });

    it("is low under 10% free", () => {
        expect(diskLevel(90 * GB, 1000 * GB)).toBe("low");
    });

    it("is low under 5 GB free, even when that is more than 10%", () => {
        expect(diskLevel(4.5 * GB, 40 * GB)).toBe("low");
    });

    it("is critical under 5% free", () => {
        expect(diskLevel(40 * GB, 1000 * GB)).toBe("critical");
    });

    it("is critical under 2 GB free", () => {
        expect(diskLevel(1.5 * GB, 20 * GB)).toBe("critical");
    });

    it("is critical at 99% full - the outage this exists for", () => {
        expect(diskLevel(0.4 * GB, 40 * GB)).toBe("critical");
    });

    it("does not call a small disk low only for being small", () => {
        expect(diskLevel(4 * GB, 8 * GB)).toBe("ok");
    });

    it("says nothing about a disk it could not measure", () => {
        expect(diskLevel(0, 0)).toBe("ok");
        expect(diskLevel(Number.NaN, 100 * GB)).toBe("ok");
    });
});

describe("what is news", () => {
    it("is getting worse, not staying bad or getting better", () => {
        expect(worsened(undefined, "low")).toBe(true);
        expect(worsened("low", "critical")).toBe(true);
        expect(worsened("low", "low")).toBe(false);
        expect(worsened("critical", "low")).toBe(false);
        expect(worsened(undefined, "ok")).toBe(false);
    });
});

describe("reading a server", () => {
    it("reads free and total off df", () => {
        const said =
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 41152736 40740000 412736 99% /\n";
        expect(diskFromDf(said)).toEqual({
            free: 412736 * 1024,
            total: (40740000 + 412736) * 1024
        });
        expect(diskFromDf("")).toBeNull();
    });

    it("reads what is using the space, never counting volumes as reclaimable", () => {
        const said = [
            "Images|20.5GB|12GB (58%)",
            "Containers|100MB|0B (0%)",
            "Local Volumes|30GB|5GB (16%)",
            "Build Cache|4GB|4GB"
        ].join("\n");
        expect(usageFromSystemDf(said)).toEqual({
            images: 20.5 * GB,
            containers: 100 * 1000 ** 2,
            volumes: 30 * GB,
            buildCache: 4 * GB,
            reclaimable: 16 * GB
        });
        expect(usageFromSystemDf("")).toBeNull();
    });
});
