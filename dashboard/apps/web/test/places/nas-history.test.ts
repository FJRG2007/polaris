import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/storage-service", () => ({ getUnasTarget: vi.fn() }));
vi.mock("@/lib/automations/outbox", () => ({ emitAutomationEvent: vi.fn() }));

import * as watch from "@/lib/nas/nas-watch";
import * as history from "@/lib/nas/nas-history";
import type { UnasMetrics } from "@/lib/unifi-unas";
import { unasAlerts } from "@/lib/unifi-unas-control";

function disk(slot: number, temperature: number | null, present = true) {
    return {
        slot,
        present,
        state: present ? "normal" : "nodisk",
        model: null,
        serial: null,
        type: null,
        sizeBytes: 0,
        temperature,
        healthy: true,
        rpm: null,
        powerOnHours: null
    };
}

const metrics: UnasMetrics = {
    totalBytes: 1000,
    usedBytes: 250,
    pools: [],
    disks: [disk(1, 40), disk(2, 52), disk(3, null, false)],
    slotsTotal: 3,
    slotsPopulated: 2,
    health: "healthy",
    system: {
        name: "nas",
        model: "UNAS Pro",
        firmware: "4.1.7",
        cpuTemp: 61,
        cpuLoad: 0.1,
        memoryUsedBytes: 0,
        memoryTotalBytes: 0,
        uptimeSeconds: 0
    },
    raw: {}
};

describe("a NAS reading", () => {
    it("keeps the bays that have a drive and a temperature", () => {
        const row = history.sampleOf(metrics);
        expect(row.diskTemps).toEqual({ "1": 40, "2": 52 });
        expect(row.diskTempMaxC).toBe(52);
        expect(row.diskTempAvgC).toBe(46);
        expect(row.cpuTempC).toBe(61);
        expect(row.usedBytes).toBe(250n);
    });

    it("has no temperature when no bay reports one", () => {
        const row = history.sampleOf({ ...metrics, disks: [disk(1, null, false)] });
        expect(row.diskTempMaxC).toBeNull();
        expect(row.diskTempAvgC).toBeNull();
    });
});

describe("chart buckets", () => {
    const from = 0;
    const to = 1000;
    const row = (t: number, cpu: number, bays: Record<string, number>) => ({
        ts: new Date(t),
        cpuTempC: cpu,
        diskTempMaxC: null,
        diskTempAvgC: null,
        usedBytes: 50n,
        totalBytes: 100n,
        diskTemps: bays
    });

    it("averages the readings inside one bucket and leaves empty ones out", () => {
        const points = history.bucketSamples(
            [row(10, 40, { "1": 30 }), row(20, 50, { "1": 40 }), row(900, 70, {})],
            from,
            to,
            10
        );
        expect(points).toHaveLength(2);
        expect(points[0]).toMatchObject({ cpuTempC: 45, usedPercent: 50, bays: { "1": 35 } });
        expect(points[1]!.cpuTempC).toBe(70);
    });

    it("never draws more than the cap, and drops readings outside the range", () => {
        const rows = Array.from({ length: 500 }, (_, i) => row(i * 2, 1, {}));
        const points = history.bucketSamples([...rows, row(5000, 1, {})], from, to, 50);
        expect(points.length).toBeLessThanOrEqual(50);
        expect(points.every((point) => point.t <= to)).toBe(true);
    });

    it("spans each range the console offers", () => {
        expect(Object.keys(history.NAS_RANGE_MS)).toEqual(["1h", "1d", "1w", "1m"]);
        expect(history.NAS_SAMPLE_RETENTION_DAYS * 86_400_000).toBeGreaterThan(
            history.NAS_RANGE_MS["1m"]
        );
        expect(history.nasRangeSchema.safeParse("1y").success).toBe(false);
    });
});

describe("NAS automation events", () => {
    const nas = { id: "00000000-0000-4000-8000-000000000001", name: "nas" };

    it("sends one event when a condition starts and none while it lasts", () => {
        const alerts = unasAlerts(metrics, [], new Date());
        const first = watch.nasEvents(nas, [], alerts);
        expect(first.map((event) => event.name)).toEqual(["nas.disk-temperature"]);
        expect(first[0]!.payload).toMatchObject({ nasId: nas.id, subject: "2", value: 52 });
        const keys = alerts.map((alert) => alert.key);
        expect(watch.nasEvents(nas, keys, alerts)).toEqual([]);
    });

    it("names every event it can send from the list the trigger picker offers", () => {
        const offline = watch.nasEvents(nas, [], [watch.offlineAlert("nas")]);
        expect(offline[0]!.name).toBe("nas.offline");
        for (const name of watch.NAS_EVENT_NAMES) expect(name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    });
});
