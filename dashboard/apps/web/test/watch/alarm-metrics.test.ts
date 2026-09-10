/**
 * Disk and network alarms: judged in the unit the form asked for, on targets
 * that have a reading for them.
 *
 * The ways this goes wrong quietly: a network alarm judging the counter (which
 * only ever climbs, so it fires forever) instead of the rate; a service's disk
 * judged as a share of volumes that have no size; and a form that offers a
 * metric the evaluator can never read, which sits at "No data" for good.
 */

import { describe, expect, it } from "vitest";
import { alarmInputSchema } from "@/lib/watch/watch-schema";
import {
    alarmUnit,
    breaches,
    describeThreshold,
    metricsFor,
    sampleValue,
    volumeDiskGb,
    type SampleReading
} from "@/lib/watch/alarm-metrics";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function reading(at: string, fields: Partial<SampleReading> = {}): SampleReading {
    return {
        ts: new Date(at),
        cpuPercent: null,
        memUsedBytes: null,
        memTotalBytes: null,
        diskUsedBytes: null,
        diskTotalBytes: null,
        netRxBytes: null,
        netTxBytes: null,
        ...fields
    };
}

describe("units", () => {
    it("judges a server's disk as a share and a service's as what it holds", () => {
        expect(alarmUnit("disk", "host")).toBe("%");
        expect(alarmUnit("disk", "application")).toBe("GB");
        expect(alarmUnit("network_in", "host")).toBe("MB/s");
        expect(alarmUnit("service", "application")).toBeNull();
        expect(describeThreshold("network_out", "application", "gt", 5)).toBe(
            "Network out > 5 MB/s"
        );
        expect(describeThreshold("disk", "host", "gt", 90)).toBe("Disk > 90%");
    });

    it("offers each target only what it has a reading for", () => {
        expect(metricsFor("host")).toEqual(["cpu", "memory", "disk", "network_in", "network_out"]);
        expect(metricsFor("application")).toContain("service");
        expect(metricsFor("domain")).toEqual(["http"]);
    });
});

describe("readings", () => {
    it("turns the traffic counters into a rate between the last two samples", () => {
        const previous = reading("2026-09-10T10:00:00Z", { netRxBytes: 0n, netTxBytes: 1000n });
        const latest = reading("2026-09-10T10:01:00Z", {
            netRxBytes: BigInt(60 * 2 * MIB),
            netTxBytes: 1000n + BigInt(60 * MIB)
        });
        expect(sampleValue("network_in", latest, previous)).toBeCloseTo(2, 5);
        expect(sampleValue("network_out", latest, previous)).toBeCloseTo(1, 5);
    });

    it("has no rate without a reading close enough before", () => {
        const latest = reading("2026-09-10T10:30:00Z", { netRxBytes: 100n });
        expect(sampleValue("network_in", latest, null)).toBeNull();
        expect(
            sampleValue("network_in", latest, reading("2026-09-10T10:00:00Z", { netRxBytes: 0n }))
        ).toBeNull();
    });

    it("reads a restarted counter as what it counted since, never negative", () => {
        const previous = reading("2026-09-10T10:00:00Z", { netRxBytes: BigInt(500 * MIB) });
        const latest = reading("2026-09-10T10:01:00Z", { netRxBytes: BigInt(60 * MIB) });
        expect(sampleValue("network_in", latest, previous)).toBeCloseTo(1, 5);
    });

    it("reads a server's disk as how full it is, and nothing where it is not measured", () => {
        const latest = reading("2026-09-10T10:00:00Z", {
            diskUsedBytes: 450n,
            diskTotalBytes: 500n
        });
        expect(sampleValue("disk", latest, null)).toBe(90);
        expect(sampleValue("disk", reading("2026-09-10T10:00:00Z"), null)).toBeNull();
    });

    it("adds a service's volumes together, skipping the ones nothing could read", () => {
        expect(
            volumeDiskGb([
                { diskUsedBytes: BigInt(GIB) },
                { diskUsedBytes: BigInt(GIB / 2) },
                { diskUsedBytes: null }
            ])
        ).toBe(1.5);
        expect(volumeDiskGb([{ diskUsedBytes: null }])).toBeNull();
        expect(breaches(1.5, "gt", 1)).toBe(true);
        expect(breaches(1.5, "lt", 1)).toBe(false);
    });
});

describe("the form's rules", () => {
    const base = {
        name: "Disk",
        targetId: "0192f6a0-0000-7000-8000-000000000001",
        forPeriods: 2
    };

    it("takes a disk alarm on a server, with a share as the threshold", () => {
        expect(
            alarmInputSchema.safeParse({
                ...base,
                targetType: "host",
                metric: "disk",
                threshold: 90
            }).success
        ).toBe(true);
        expect(
            alarmInputSchema.safeParse({
                ...base,
                targetType: "host",
                metric: "disk",
                threshold: 120
            }).success
        ).toBe(false);
    });

    it("takes a service's disk above 100, because it is GB rather than a share", () => {
        expect(
            alarmInputSchema.safeParse({
                ...base,
                targetType: "application",
                metric: "disk",
                threshold: 250
            }).success
        ).toBe(true);
    });

    it("asks for a threshold on a network alarm and refuses metrics a target has no reading for", () => {
        expect(
            alarmInputSchema.safeParse({ ...base, targetType: "host", metric: "network_in" })
                .success
        ).toBe(false);
        expect(
            alarmInputSchema.safeParse({ ...base, targetType: "host", metric: "service" }).success
        ).toBe(false);
        expect(
            alarmInputSchema.safeParse({
                ...base,
                targetType: "domain",
                metric: "disk",
                threshold: 1
            }).success
        ).toBe(false);
        expect(
            alarmInputSchema.safeParse({ ...base, targetType: "domain", metric: "http" }).success
        ).toBe(true);
    });
});
