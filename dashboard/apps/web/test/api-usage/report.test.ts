import { describe, expect, it, vi } from "vitest";

const queries: Record<string, any>[] = [];
const at = (iso: string) => new Date(iso);

vi.mock("@polaris/db", () => ({
    prisma: {
        apiKeyCallHour: {
            groupBy: async (args: Record<string, any>) => {
                queries.push(args);
                const by = args.by.join(",");
                const failed = Boolean(args.where.status);
                if (by === "hour") {
                    return failed
                        ? [{ hour: at("2026-10-15T09:00:00Z"), _sum: { calls: 2 } }]
                        : [
                              { hour: at("2026-10-15T09:00:00Z"), _sum: { calls: 10 } },
                              { hour: at("2026-10-15T10:00:00Z"), _sum: { calls: 5 } }
                          ];
                }
                if (by === "method,route") {
                    return failed
                        ? [{ method: "GET", route: "/api/v1/me", _sum: { calls: 2 } }]
                        : [{ method: "GET", route: "/api/v1/me", _sum: { calls: 15, ms25: 5, ms50: 5, ms100: 4, msOver: 1 } }];
                }
                return [
                    { status: 200, _sum: { calls: 13 } },
                    { status: 404, _sum: { calls: 1 } },
                    { status: 502, _sum: { calls: 1 } }
                ];
            }
        }
    }
}));

import * as report from "@/lib/api-usage/report";

const EMPTY = { ms25: 0, ms50: 0, ms100: 0, ms250: 0, ms500: 0, ms1000: 0, ms2500: 0, ms5000: 0, msOver: 0 };

describe("a key's usage report", () => {
    it("reads percentiles off the histogram, interpolating inside the bucket", () => {
        expect(report.percentile(EMPTY, 0.5)).toBeNull();
        expect(report.percentile({ ...EMPTY, ms25: 10 }, 0.5)).toEqual({ ms: 13, over: false });
        expect(report.percentile({ ...EMPTY, ms25: 5, ms100: 5 }, 0.95)).toEqual({ ms: 95, over: false });
        expect(report.percentile({ ...EMPTY, ms25: 1, msOver: 9 }, 0.95)).toEqual({ ms: 5000, over: true });
    });

    it("aggregates in the database, scoped to the key and the window, and fills quiet hours with zeros", async () => {
        queries.length = 0;
        const result = await report.keyUsageReport("k1", "24h", new Date("2026-10-15T10:30:00Z"));
        expect(queries).toHaveLength(5);
        for (const query of queries) {
            expect(query.where.apiKeyId).toBe("k1");
            expect(query.where.hour.gte.toISOString()).toBe("2026-10-14T11:00:00.000Z");
        }
        expect(result.series).toHaveLength(24);
        expect(result.series.at(-2)).toMatchObject({ calls: 10, errors: 2 });
        expect(result.series.at(-1)).toMatchObject({ calls: 5, errors: 0 });
        expect(result.series[0]).toMatchObject({ calls: 0, errors: 0 });
        expect(result.total).toBe(15);
        expect(result.classes).toEqual({ success: 13, client: 1, server: 1 });
        expect(result.routes[0]).toMatchObject({ route: "/api/v1/me", calls: 15, errors: 2 });
        expect(result.p50).toEqual({ ms: 38, over: false });
    });

    it("folds the long windows into days", async () => {
        const result = await report.keyUsageReport("k1", "90d", new Date("2026-10-15T10:30:00Z"));
        expect(result.bucket).toBe("day");
        expect(result.series).toHaveLength(90);
        expect(result.series.at(-1)).toMatchObject({ calls: 15, errors: 2 });
    });
});
