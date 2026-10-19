/**
 * A UPS's CSV export reads every row in its range, a page at a time, instead
 * of stopping at a cap and leaving the newest rows out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-01T00:00:00Z");

const samples = Array.from({ length: 12_345 }, (_, i) => ({
    ts: new Date(NOW - 10 * DAY_MS + i * 60_000),
    charge: 100,
    runtimeS: 600,
    load: 20,
    powerW: 90,
    inputV: 230,
    inputHz: 50,
    outputV: 230,
    batteryV: 27
}));
const events = Array.from({ length: 7_000 }, (_, i) => ({
    id: `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    ts: new Date(NOW - DAY_MS + Math.floor(i / 2) * 1_000),
    kind: "ONBATT",
    detail: null,
    acknowledgedAt: null
}));

const calls: string[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        upsSample: {
            findMany: async ({
                where,
                take
            }: {
                where: { ts: { gte?: Date; gt?: Date } };
                take: number;
            }) => {
                calls.push("samples");
                return samples
                    .filter((r) => (where.ts.gte ? r.ts >= where.ts.gte : r.ts > where.ts.gt!))
                    .slice(0, take);
            }
        },
        upsEvent: {
            findMany: async ({
                take,
                cursor
            }: {
                take: number;
                cursor?: { id: string };
                skip?: number;
            }) => {
                calls.push("events");
                const from = cursor ? events.findIndex((r) => r.id === cursor.id) + 1 : 0;
                return events.slice(from, from + take);
            }
        }
    }
}));
vi.mock("@/lib/drive-authz", () => ({ requireDriveDriver: vi.fn() }));
vi.mock("@/lib/personal-drive", () => ({ ensurePersonalDrive: vi.fn() }));

const upsData = await import("@/lib/ups/ups-data");

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
    let text = "";
    for await (const chunk of chunks) text += chunk;
    return text.split("\r\n").filter(Boolean);
}

describe("the CSV export", () => {
    beforeEach(() => {
        calls.length = 0;
    });

    it("pages through every sample, past one query's worth", async () => {
        const lines = await collect(upsData.exportCsv("ups", "samples", 365, NOW));
        expect(lines[0]).toMatch(/^time,charge_pct,/);
        expect(lines).toHaveLength(samples.length + 1);
        expect(lines.at(-1)).toContain(samples.at(-1)!.ts.toISOString());
        expect(calls.filter((one) => one === "samples").length).toBeGreaterThan(1);
    });

    it("pages events that share a timestamp without losing or repeating one", async () => {
        const lines = await collect(upsData.exportCsv("ups", "events", 30, NOW));
        expect(lines).toHaveLength(events.length + 1);
        expect(calls.filter((one) => one === "events").length).toBeGreaterThan(1);
    });
});
