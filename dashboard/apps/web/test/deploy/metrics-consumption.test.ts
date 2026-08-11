/**
 * What a service is costing, as the Usage screen reads it.
 *
 * Two of the four charts are not columns in the database, and both are easy to
 * get subtly wrong in a way nobody notices for months.
 *
 * Bandwidth is stored as the container's own counters, which only ever climb -
 * charted raw it is a line that rises forever whatever the traffic is doing, and
 * a restart resets them, which differences into a huge negative spike. Storage is
 * not the service's at all: what fills up is the volumes it mounts, measured as
 * their own subjects on a slower cadence, so they have to be laid over the
 * service's points without punching holes between measurements.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const APP = "bbbbbbbb-1111-4111-8111-111111111111";

interface SampleRow {
    subjectType: string;
    subjectId: string;
    ts: Date;
    cpuPercent: number | null;
    cpuTempC: number | null;
    memUsedBytes: bigint | null;
    memTotalBytes: bigint | null;
    diskUsedBytes: bigint | null;
    diskTotalBytes: bigint | null;
    netRxBytes: bigint | null;
    netTxBytes: bigint | null;
}

let samples: SampleRow[] = [];
let volumes: { id: string }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        application: { findFirst: async () => ({ id: APP }) },
        volume: { findMany: async () => volumes },
        metricSample: {
            findMany: async ({ where }: { where: { subjectType: string; subjectId: unknown } }) => {
                const ids =
                    typeof where.subjectId === "string"
                        ? [where.subjectId]
                        : ((where.subjectId as { in: string[] }).in ?? []);
                return samples
                    .filter((row) => row.subjectType === where.subjectType && ids.includes(row.subjectId))
                    .sort((left, right) => left.ts.getTime() - right.ts.getTime());
            }
        },
        metricRollup: { findMany: async () => [] }
    }
}));

const { getMetricSeries } = await import("@/lib/metrics-history-service");
const { counterAdvance } = await import("@/lib/metrics-shared");

const START = Date.parse("2026-08-12T10:00:00.000Z");
const MINUTE = 60_000;

/** One tick of a container's stats, `minute` minutes into the window. */
function appSample(minute: number, netRx: number | null, netTx: number | null): SampleRow {
    return {
        subjectType: "app",
        subjectId: APP,
        ts: new Date(START + minute * MINUTE),
        cpuPercent: 5,
        cpuTempC: null,
        memUsedBytes: 1_000n,
        memTotalBytes: 4_000n,
        diskUsedBytes: null,
        diskTotalBytes: null,
        netRxBytes: netRx == null ? null : BigInt(netRx),
        netTxBytes: netTx == null ? null : BigInt(netTx)
    };
}

/** One measurement of a volume, which happens far less often. */
function volumeSample(id: string, minute: number, used: number, total: number | null): SampleRow {
    return {
        subjectType: "volume",
        subjectId: id,
        ts: new Date(START + minute * MINUTE),
        cpuPercent: null,
        cpuTempC: null,
        memUsedBytes: null,
        memTotalBytes: null,
        diskUsedBytes: BigInt(used),
        diskTotalBytes: total == null ? null : BigInt(total),
        netRxBytes: null,
        netTxBytes: null
    };
}

async function read() {
    return getMetricSeries({
        subjectType: "app",
        subjectId: APP,
        ownerId: OWNER,
        from: new Date(START - MINUTE),
        to: new Date(START + 60 * MINUTE)
    });
}

beforeEach(() => {
    samples = [];
    volumes = [];
});

describe("bandwidth", () => {
    it("is a rate, not the counter it is stored as", async () => {
        // 60 seconds apart, six megabytes further on: 100 KB/s.
        samples = [appSample(0, 0, 0), appSample(1, 6_000_000, 3_000_000)];
        const points = (await read())!;
        expect(points[1]!.netRxBytesPerSecond).toBe(100_000);
        expect(points[1]!.netTxBytesPerSecond).toBe(50_000);
    });

    it("says nothing for the first reading rather than zero", async () => {
        // There is nothing before it to measure against, and a flat zero at the
        // left edge of every chart reads as a minute of silence that never was.
        samples = [appSample(0, 500, 500), appSample(1, 1_000, 1_000)];
        const points = (await read())!;
        expect(points[0]!.netRxBytesPerSecond).toBeNull();
        expect(points[1]!.netRxBytesPerSecond).not.toBeNull();
    });

    it("does not chart a restart as a negative spike", async () => {
        // The container went down and started counting again. What it has counted
        // since is the honest floor; the difference would be minus a gigabyte.
        samples = [appSample(0, 1_000_000_000, 1_000_000_000), appSample(1, 60_000, 120_000)];
        const points = (await read())!;
        expect(points[1]!.netRxBytesPerSecond).toBe(1_000);
        expect(points[1]!.netTxBytesPerSecond).toBe(2_000);
    });

    it("stays null for a series that never reported any", async () => {
        // Everything collected before bandwidth was recorded at all.
        samples = [appSample(0, null, null), appSample(1, null, null)];
        const points = (await read())!;
        expect(points.every((point) => point.netRxBytesPerSecond === null)).toBe(true);
    });
});

describe("storage", () => {
    it("comes from the volumes the service mounts", async () => {
        volumes = [{ id: "vol-a" }];
        samples = [appSample(0, 0, 0), appSample(1, 0, 0), volumeSample("vol-a", 0, 4_000, 10_000)];
        const points = (await read())!;
        expect(points[0]!.diskUsedBytes).toBe(4_000);
        expect(points[0]!.diskTotalBytes).toBe(10_000);
    });

    it("adds every volume up, because that is what the service is storing", async () => {
        volumes = [{ id: "vol-a" }, { id: "vol-b" }];
        samples = [
            appSample(0, 0, 0),
            volumeSample("vol-a", 0, 4_000, 10_000),
            volumeSample("vol-b", 0, 1_000, 5_000)
        ];
        const points = (await read())!;
        expect(points[0]!.diskUsedBytes).toBe(5_000);
        expect(points[0]!.diskTotalBytes).toBe(15_000);
    });

    it("carries the last measurement forward instead of leaving holes", async () => {
        // Volumes are measured every few minutes and containers every minute, so
        // most points have no measurement of their own. A hole per point would be
        // a chart of dots.
        volumes = [{ id: "vol-a" }];
        samples = [
            appSample(0, 0, 0),
            appSample(1, 0, 0),
            appSample(2, 0, 0),
            volumeSample("vol-a", 0, 4_000, 10_000),
            volumeSample("vol-a", 2, 9_000, 10_000)
        ];
        const points = (await read())!;
        expect(points.map((point) => point.diskUsedBytes)).toEqual([4_000, 4_000, 9_000]);
    });

    it("says nothing at all for a service with no volume", async () => {
        // Not zero: a service with nowhere to write is not a service storing
        // nothing, and a flat zero line invites somebody to trust it.
        samples = [appSample(0, 0, 0), appSample(1, 0, 0)];
        const points = (await read())!;
        expect(points.every((point) => point.diskUsedBytes === null)).toBe(true);
    });
});

/**
 * What an hour of a counter is worth, which is what the rollups store.
 *
 * The wide ranges read those rather than the raw table, so a mistake here is a
 * bandwidth chart that is only wrong past 48 hours - the window nobody checks.
 */
describe("folding a counter into an hour", () => {
    it("is the ground it covered, not an average of where it was", async () => {
        expect(counterAdvance([100n, 200n, 500n])).toBe(400n);
    });

    it("counts a restart as what has been counted since", async () => {
        // Not minus a gigabyte, and not zero: the container came back and moved
        // 300 bytes, which is the most that can honestly be claimed.
        expect(counterAdvance([1_000_000_000n, 300n, 800n])).toBe(800n);
    });

    it("is nothing at all under two readings", async () => {
        expect(counterAdvance([500n])).toBeNull();
        expect(counterAdvance([])).toBeNull();
        expect(counterAdvance([null, null])).toBeNull();
    });

    it("ignores the readings that are missing rather than treating them as zero", async () => {
        expect(counterAdvance([100n, null, 400n])).toBe(300n);
    });
});
