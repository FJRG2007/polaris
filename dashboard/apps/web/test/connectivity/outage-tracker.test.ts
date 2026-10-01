/**
 * The tracker against a table: what it writes for a pass, what two containers
 * sweeping at once leave behind, how the report adds up, and how a year-old
 * history is folded into months without counting anything twice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    kind: string;
    startedAt: Date;
    endedAt: Date | null;
    lastSeenAt: Date;
    lastUpAt: Date | null;
    detectedBy: string | null;
    detail: string | null;
    firstBack: string | null;
    firstBackAt: Date | null;
    closedBy: string | null;
    blips: number;
    openSlot: string | null;
}

let rows: Row[] = [];
let months: { month: string; kind: string; count: number; downtimeSeconds: number; longestSeconds: number }[] = [];
const settings = new Map<string, string>();
let nextId = 1;

type Where = { id?: string | { in: string[] }; endedAt?: null | Date | { not?: null; lt?: Date } };

function matches(row: Row, where: Where): boolean {
    if (typeof where.id === "string" && row.id !== where.id) return false;
    if (typeof where.id === "object" && !where.id.in.includes(row.id)) return false;
    if (where.endedAt === null && row.endedAt !== null) return false;
    if (where.endedAt instanceof Date && row.endedAt?.getTime() !== where.endedAt.getTime()) return false;
    if (where.endedAt && !(where.endedAt instanceof Date)) {
        if (row.endedAt === null) return false;
        if (where.endedAt.lt && !(row.endedAt < where.endedAt.lt)) return false;
    }
    return true;
}

function applyData(row: Row, data: Record<string, unknown>): Row {
    const next = { ...row } as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && "increment" in value) {
            next[key] = (next[key] as number) + (value as { increment: number }).increment;
        } else next[key] = value;
    }
    return next as unknown as Row;
}

const uniqueClash = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

const connectivityOutage = {
    findUnique: vi.fn(async ({ where }: { where: { openSlot: string } }) => rows.find((row) => row.openSlot === where.openSlot) ?? null),
    findFirst: vi.fn(async () =>
        [...rows].filter((row) => row.endedAt !== null).sort((a, b) => b.endedAt!.getTime() - a.endedAt!.getTime())[0] ?? null
    ),
    findMany: vi.fn(async ({ where, take }: { where?: Where & { OR?: unknown }; take?: number }) => {
        let found = where && !("OR" in where) ? rows.filter((row) => matches(row, where)) : [...rows];
        found = found.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
        if (where && "endedAt" in where && where.endedAt && !(where.endedAt instanceof Date)) {
            found = found.reverse();
        }
        return found.slice(0, take ?? found.length);
    }),
    create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        if (data.openSlot && rows.some((row) => row.openSlot === data.openSlot)) throw uniqueClash();
        const row: Row = {
            id: String(nextId++),
            kind: "address",
            startedAt: new Date(0),
            endedAt: null,
            lastSeenAt: new Date(0),
            lastUpAt: null,
            detectedBy: null,
            detail: null,
            firstBack: null,
            firstBackAt: null,
            closedBy: null,
            blips: 0,
            openSlot: null,
            ...data
        };
        rows.push(row);
        return row;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const hit = rows.filter((row) => matches(row, where));
        if (data.openSlot && rows.some((row) => row.openSlot === data.openSlot && !hit.includes(row))) throw uniqueClash();
        rows = rows.map((row) => (hit.includes(row) ? applyData(row, data) : row));
        return { count: hit.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const before = rows.length;
        rows = rows.filter((row) => !matches(row, where));
        return { count: before - rows.length };
    })
};

const connectivityOutageMonth = {
    findMany: vi.fn(async () => months),
    findUnique: vi.fn(async ({ where }: { where: { month_kind: { month: string; kind: string } } }) =>
        months.find((m) => m.month === where.month_kind.month && m.kind === where.month_kind.kind) ?? null
    ),
    update: vi.fn(
        async ({ where, data }: { where: { month_kind: { month: string; kind: string } }; data: Record<string, unknown> }) => {
            const index = months.findIndex((m) => m.month === where.month_kind.month && m.kind === where.month_kind.kind);
            months[index] = applyData(months[index] as never, data) as never;
            return months[index];
        }
    ),
    create: vi.fn(async ({ data }: { data: (typeof months)[number] }) => {
        months.push({ ...data });
        return data;
    })
};

const prisma = {
    connectivityOutage,
    connectivityOutageMonth,
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        const saved = { rows: [...rows], months: months.map((m) => ({ ...m })) };
        try {
            return await run(prisma);
        } catch (error) {
            rows = saved.rows;
            months = saved.months;
            throw error;
        }
    }
};

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));

const tracker = await import("@/lib/connectivity/outage-tracker");
const { STALE_AFTER_MS } = await import("@/lib/connectivity/cadence");

const T0 = Date.UTC(2026, 9, 1, 12);
const MINUTE = 60_000;
const lineDown = { up: false as const, kind: "line" as const, detectedBy: "polaris.example.com", detail: "Timed out" };
const up = { up: true as const, via: "polaris.example.com" };

beforeEach(() => {
    rows = [];
    months = [];
    settings.clear();
    nextId = 1;
});

describe("recording passes", () => {
    it("writes one row per outage, with when things were last fine", async () => {
        await tracker.recordPass(up, T0);
        expect(await tracker.recordPass(lineDown, T0 + MINUTE)).toEqual({ closely: true });
        await tracker.recordPass(lineDown, T0 + 2 * MINUTE);
        const back = await tracker.recordPass(up, T0 + 3 * MINUTE);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            kind: "line",
            lastUpAt: new Date(T0),
            endedAt: new Date(T0 + 3 * MINUTE),
            closedBy: "recovered",
            openSlot: null,
            firstBack: "polaris.example.com"
        });
        // Still in the merge window: keep looking closely so a blip is seen.
        expect(back.closely).toBe(true);
        expect((await tracker.recordPass(up, T0 + 10 * MINUTE)).closely).toBe(false);
    });

    it("leaves one open row when two containers record the same pass", async () => {
        await Promise.all([tracker.recordPass(lineDown, T0), tracker.recordPass(lineDown, T0)]);
        expect(rows.filter((row) => row.endedAt === null)).toHaveLength(1);
    });

    it("carries an open outage across a restart that missed nothing, and closes one that did at its last sighting", async () => {
        await tracker.recordPass(lineDown, T0);
        await tracker.recordPass(lineDown, T0 + 5 * MINUTE);
        expect(rows).toHaveLength(1);

        await tracker.recordPass(up, T0 + 5 * MINUTE + STALE_AFTER_MS + 1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ endedAt: new Date(T0 + 5 * MINUTE), closedBy: "unobserved" });
    });

    it("reopens an outage that comes back within the merge gap, and honours a gap set to zero", async () => {
        await tracker.recordPass(lineDown, T0);
        await tracker.recordPass(up, T0 + 20_000);
        await tracker.recordPass(lineDown, T0 + 40_000);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ blips: 1, endedAt: null, openSlot: "open" });

        await tracker.setMergeGapSeconds(0);
        await tracker.recordPass(up, T0 + 60_000);
        await tracker.recordPass(lineDown, T0 + 70_000);
        expect(rows).toHaveLength(2);
    });
});

describe("the report", () => {
    it("says what is going on now and how each period went", async () => {
        await tracker.recordPass(up, T0);
        await tracker.recordPass(lineDown, T0 + 10 * MINUTE);
        await tracker.recordPass(up, T0 + 20 * MINUTE);
        await tracker.recordPass(lineDown, T0 + 30 * MINUTE);

        const report = await tracker.connectivityReport(T0 + 40 * MINUTE);
        expect(report.open?.kind).toBe("line");
        expect(report.lastPass).toEqual({ at: new Date(T0 + 30 * MINUTE).toISOString(), up: false });
        expect(report.since).toBe(new Date(T0).toISOString());
        const day = report.periods.find((period) => period.key === "24h");
        expect(day).toMatchObject({ count: 2, downMs: 20 * MINUTE, longestMs: 10 * MINUTE });
        expect(day?.uptime).toBeCloseTo(0.5, 10);
        expect(report.mergeGapSeconds).toBe(60);
    });
});

describe("keeping a year", () => {
    it("folds outages older than a year into their month and kind, once", async () => {
        const old = Date.UTC(2025, 2, 10);
        for (const [offset, minutes] of [
            [0, 10],
            [86_400_000, 30]
        ] as const) {
            rows.push({
                id: `old-${offset}`,
                kind: "line",
                startedAt: new Date(old + offset),
                endedAt: new Date(old + offset + minutes * MINUTE),
                lastSeenAt: new Date(old + offset),
                lastUpAt: null,
                detectedBy: null,
                detail: null,
                firstBack: null,
                firstBackAt: null,
                closedBy: "recovered",
                blips: 0,
                openSlot: null
            });
        }
        await tracker.recordPass(lineDown, T0);

        expect(await tracker.compactOutages(T0)).toBe(2);
        expect(await tracker.compactOutages(T0)).toBe(0);
        expect(months).toEqual([{ month: "2025-03", kind: "line", count: 2, downtimeSeconds: 2400, longestSeconds: 1800 }]);
        // The ongoing outage is never touched.
        expect(rows).toHaveLength(1);
        expect(rows[0]?.endedAt).toBeNull();
    });

    it("counts nothing when another runner deleted some of the rows first", async () => {
        const old = Date.UTC(2025, 2, 10);
        rows.push({
            id: "old",
            kind: "dns",
            startedAt: new Date(old),
            endedAt: new Date(old + MINUTE),
            lastSeenAt: new Date(old),
            lastUpAt: null,
            detectedBy: null,
            detail: null,
            firstBack: null,
            firstBackAt: null,
            closedBy: "recovered",
            blips: 0,
            openSlot: null
        });
        connectivityOutage.deleteMany.mockImplementationOnce(async () => ({ count: 0 }));
        await expect(tracker.compactOutages(T0)).rejects.toThrow();
        expect(months).toEqual([]);
    });
});
