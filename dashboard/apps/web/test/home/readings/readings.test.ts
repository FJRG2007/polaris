/**
 * Readings history: a sync stores a sample only when the figure changed or the
 * last one is old, week-old samples fold into hours, a measure switched off is
 * deleted and never recorded again, and only who manages the device switches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as rk from "@polaris-app/places/src/lib/reading-kinds";

const DEVICE = "0190a0b4-0000-7000-8000-000000000001";
const INSTALL = "install-1";

const device = { readingsOff: [] as string[] };
const createMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const deleteRaw = vi.fn(async (_args: unknown) => ({ count: 0 }));
const deleteHours = vi.fn(async (_args: unknown) => ({ count: 0 }));
const updateDevice = vi.fn(async ({ data }: { data: { readingsOff: string[] } }) => {
    device.readingsOff = data.readingsOff;
    return device;
});
const executeRaw = vi.fn(async (..._args: unknown[]) => 0);
const requireHome = vi.fn();

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        placeDevice: {
            findFirst: async () => ({ readingsOff: [...device.readingsOff] }),
            update: (args: { data: { readingsOff: string[] } }) => updateDevice(args)
        },
        placeDeviceReading: {
            createMany: (args: unknown) => createMany(args),
            deleteMany: (args: unknown) => deleteRaw(args)
        },
        placeDeviceReadingHour: { deleteMany: (args: unknown) => deleteHours(args) },
        $queryRaw: async () => [],
        $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) =>
            executeRaw(strings, ...values),
        $transaction: async (steps: Promise<unknown>[]) => Promise.all(steps)
    }
}));

vi.mock("@polaris-app/places/src/lib/access", () => ({
    requireHome: (permission: string) => requireHome(permission),
    requireHomeInstall: vi.fn(),
    requireHomeShared: vi.fn(),
    managesHome: vi.fn()
}));

vi.mock("@polaris-app/places/src/lib/i18n", async (original) => {
    const real = await original<typeof import("@polaris-app/places/src/lib/i18n")>();
    return { ...real, placesT: async () => real.placesTIn("en-US") };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const readings = await import("@polaris-app/places/src/lib/readings");

const DEHUMIDIFIER = {
    id: DEVICE,
    kind: "dehumidifier",
    value: "54",
    unit: "%",
    climate: null,
    air: {
        mode: "auto",
        modes: ["auto"],
        speed: null,
        speeds: [],
        humidity: null,
        options: {},
        readings: { humidity: 54, temperature: 22 },
        filters: []
    }
};

beforeEach(() => {
    device.readingsOff = [];
    readings.forgetLastSamples();
    vi.clearAllMocks();
    requireHome.mockResolvedValue({ user: { id: "user-1" }, install: { id: INSTALL } });
});

describe("which measures a device reports", () => {
    it("reads a dehumidifier, an air conditioner's room and target, and a meter", () => {
        expect(rk.measuresOf(DEHUMIDIFIER)).toEqual({ humidity: 54, temperature: 22 });
        expect(
            rk.measuresOf({
                kind: "climate",
                value: "23.5",
                unit: "C",
                climate: {
                    mode: "cool",
                    modes: ["cool"],
                    target: 21,
                    min: 16,
                    max: 30,
                    step: 1,
                    unit: "C",
                    fan: null,
                    fans: [],
                    options: {}
                }
            })
        ).toEqual({ temperature: 23.5, target: 21 });
        expect(rk.measuresOf({ kind: "outlet", value: "120", unit: "W" })).toEqual({ power: 120 });
        expect(rk.measuresOf({ kind: "sensor", value: "open", unit: "" })).toEqual({});
        expect(rk.measuresOf({ kind: "lock", value: null, unit: null })).toEqual({});
    });
});

describe("sample dedupe", () => {
    const now = 1_800_000_000_000;

    it("stores the first figure, a change after a minute, and an unchanged one per heartbeat", () => {
        expect(rk.worthStoring(54, undefined, now)).toBe(true);
        expect(rk.worthStoring(55, { at: now - 30_000, value: 54 }, now)).toBe(false);
        expect(rk.worthStoring(55, { at: now - 61_000, value: 54 }, now)).toBe(true);
        expect(rk.worthStoring(54, { at: now - 5 * 60_000, value: 54 }, now)).toBe(false);
        expect(rk.worthStoring(54, { at: now - rk.READING_HEARTBEAT_MS, value: 54 }, now)).toBe(
            true
        );
    });

    it("writes one row per measure and none for a repeat read", async () => {
        await readings.recordReadings([DEHUMIDIFIER]);
        expect(createMany).toHaveBeenCalledTimes(1);
        const first = createMany.mock.calls[0]![0] as { data: { measure: string }[] };
        expect(first.data.map((row) => row.measure).sort()).toEqual(["humidity", "temperature"]);
        await readings.recordReadings([DEHUMIDIFIER]);
        expect(createMany).toHaveBeenCalledTimes(1);
    });
});

describe("downsampling", () => {
    it("folds buckets onto a coarser grid with a weighted mean, min and max", () => {
        const hour = 3_600_000;
        const folded = rk.foldBuckets(
            [
                { t: 0, avg: 10, min: 8, max: 12, count: 1 },
                { t: hour, avg: 20, min: 15, max: 30, count: 3 },
                { t: 6 * hour, avg: 5, min: 5, max: 5, count: 2 }
            ],
            6 * hour
        );
        expect(folded).toEqual([
            { t: 0, avg: 17.5, min: 8, max: 30, count: 4 },
            { t: 6 * hour, avg: 5, min: 5, max: 5, count: 2 }
        ]);
        expect(rk.readingStats(folded)).toEqual({ min: 5, avg: 80 / 6, max: 30 });
        expect(rk.readingStats([])).toBeNull();
    });

    it("folds whole hours older than a week, drops them, and drops hours past retention", async () => {
        const now = Date.UTC(2026, 10, 15, 12, 34, 56);
        await readings.sweepReadings(now);
        const cutoff = new Date(Date.UTC(2026, 10, 8, 12, 0, 0));
        expect(executeRaw).toHaveBeenCalledTimes(1);
        expect(executeRaw.mock.calls[0]).toContainEqual(cutoff);
        expect(deleteRaw).toHaveBeenCalledWith({ where: { at: { lt: cutoff } } });
        expect(deleteHours).toHaveBeenCalledWith({
            where: { hour: { lt: new Date(now - rk.READINGS_RETENTION.hourly) } }
        });
    });
});

describe("switching a measure off", () => {
    it("deletes its stored history and stops recording it", async () => {
        const off = await readings.setReadingTracking(INSTALL, DEVICE, "humidity", false);
        expect(off).toEqual(["humidity"]);
        expect(deleteRaw).toHaveBeenCalledWith({ where: { deviceId: DEVICE, measure: "humidity" } });
        expect(deleteHours).toHaveBeenCalledWith({
            where: { deviceId: DEVICE, measure: "humidity" }
        });

        await readings.recordReadings([{ ...DEHUMIDIFIER, readingsOff: off }]);
        const written = createMany.mock.calls[0]![0] as { data: { measure: string }[] };
        expect(written.data.map((row) => row.measure)).toEqual(["temperature"]);
    });

    it("reads as an empty history, whoever asks", async () => {
        device.readingsOff = ["humidity"];
        const history = await readings.readingHistory(INSTALL, DEVICE, "humidity", "7d");
        expect(history.points).toEqual([]);
        expect(history.stats).toBeNull();
    });

    it("turning it back on deletes nothing", async () => {
        device.readingsOff = ["humidity"];
        expect(await readings.setReadingTracking(INSTALL, DEVICE, "humidity", true)).toEqual([]);
        expect(deleteRaw).not.toHaveBeenCalled();
    });
});

describe("permission", () => {
    it("asks for home.manage, and touches nothing when refused", async () => {
        const { setReadingTrackingAction } = await import(
            "@polaris-app/places/src/screens/actions"
        );
        requireHome.mockRejectedValueOnce(new Error("forbidden"));
        await expect(
            setReadingTrackingAction({ deviceId: DEVICE, measure: "humidity", on: false })
        ).rejects.toThrow("forbidden");
        expect(requireHome).toHaveBeenCalledWith("home.manage");
        expect(updateDevice).not.toHaveBeenCalled();
        expect(deleteRaw).not.toHaveBeenCalled();
    });

    it("refuses a malformed request before anything is changed", async () => {
        const { setReadingTrackingAction } = await import(
            "@polaris-app/places/src/screens/actions"
        );
        const result = await setReadingTrackingAction({ deviceId: "x", measure: "bogus", on: 1 });
        expect(result.error).toBeTruthy();
        expect(updateDevice).not.toHaveBeenCalled();
    });
});
