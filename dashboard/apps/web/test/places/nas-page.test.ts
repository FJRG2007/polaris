import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/storage-service", () => ({ getUnasTarget: vi.fn() }));

import type { UnasMetrics } from "@/lib/unifi-unas";
import { statusOf } from "@/lib/nas/nas-service";
import * as nasView from "@/lib/nas/nas-view";

function disk(slot: number, over: Partial<UnasMetrics["disks"][number]> = {}) {
    return {
        slot,
        present: true,
        state: "normal",
        model: "Example 8TB",
        serial: `SN-${slot}`,
        sizeBytes: 8e12,
        temperature: 38,
        healthy: true,
        powerOnHours: 1000,
        ...over
    } as UnasMetrics["disks"][number];
}

function metrics(disks: UnasMetrics["disks"], pools = 1): UnasMetrics {
    return {
        totalBytes: 100,
        usedBytes: 40,
        pools: Array.from({ length: pools }, (_, index) => ({
            device: `md${index}`,
            totalBytes: 100,
            usedBytes: 40,
            health: "healthy",
            raidLevel: "raid5",
            raidState: "normal",
            membersPresent: 3,
            membersExpected: 3,
            reasons: []
        })),
        disks,
        slotsTotal: 4,
        slotsPopulated: disks.filter((entry) => entry.present).length,
        health: "healthy",
        system: {
            name: "nas",
            model: "UNAS",
            firmware: "1.0",
            cpuTemp: 45,
            cpuLoad: 0.1,
            memoryUsedBytes: 1,
            memoryTotalBytes: 2,
            uptimeSeconds: 90_000
        },
        raw: {}
    } as unknown as UnasMetrics;
}

describe("statusOf", () => {
    const sample = metrics([
        disk(1),
        disk(2),
        disk(3, { present: false, model: null, serial: null })
    ]);

    it("keeps serials for the owner and drops them for a visitor", () => {
        expect(statusOf(sample, false).disks[0]!.serial).toBe("SN-1");
        expect(statusOf(sample, true).disks.every((entry) => entry.serial === null)).toBe(true);
    });

    it("puts present drives in the only pool and leaves empty bays out", () => {
        const disks = statusOf(sample, false).disks;
        expect(disks.map((entry) => entry.pool)).toEqual(["md0", "md0", null]);
    });

    it("does not guess a pool when there are several", () => {
        const disks = statusOf(metrics([disk(1)], 2), false).disks;
        expect(disks[0]!.pool).toBeNull();
    });
});

describe("allDisks", () => {
    it("summarizes present drives only", () => {
        const disks = statusOf(
            metrics([
                disk(1, { temperature: 35, powerOnHours: 100 }),
                disk(2, { temperature: 52, powerOnHours: 301, healthy: false }),
                disk(3, { present: false, temperature: 99, powerOnHours: 9999 })
            ]),
            false
        ).disks;
        expect(nasView.allDisks(disks)).toEqual({
            count: 2,
            maxTemp: 52,
            minTemp: 35,
            avgPowerOnHours: 201,
            notOptimal: 1
        });
    });

    it("answers null when nothing reports a reading", () => {
        const summary = nasView.allDisks([]);
        expect(summary).toMatchObject({
            count: 0,
            maxTemp: null,
            minTemp: null,
            avgPowerOnHours: null
        });
    });
});

describe("filterBays", () => {
    const disks = statusOf(
        metrics([
            disk(1, { temperature: 30 }),
            disk(2, { temperature: 45, healthy: false }),
            disk(3, { temperature: 55 }),
            disk(4, { present: false, temperature: null })
        ]),
        false
    ).disks;
    const slots = (kept: nasView.NasDisk[]) => kept.map((entry) => entry.slot);

    it("bands temperatures at 40 and 50", () => {
        expect([30, 40, 50, 51, null].map(nasView.tempBand)).toEqual([
            "cool",
            "warm",
            "warm",
            "hot",
            null
        ]);
    });

    it("filters by status, temperature and pool", () => {
        expect(slots(nasView.filterBays(disks, "any", "any", ""))).toEqual([1, 2, 3, 4]);
        expect(slots(nasView.filterBays(disks, "optimal", "any", ""))).toEqual([1, 3]);
        expect(slots(nasView.filterBays(disks, "notOptimal", "any", ""))).toEqual([2]);
        expect(slots(nasView.filterBays(disks, "empty", "any", ""))).toEqual([4]);
        expect(slots(nasView.filterBays(disks, "any", "hot", ""))).toEqual([3]);
        expect(slots(nasView.filterBays(disks, "any", "any", "md0"))).toEqual([1, 2, 3]);
        expect(slots(nasView.filterBays(disks, "optimal", "cool", "md0"))).toEqual([1]);
    });
});
