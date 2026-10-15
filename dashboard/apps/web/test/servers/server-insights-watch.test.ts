/**
 * The hourly check that tells people about their servers: an owner hears about
 * their own machine, every administrator about the box Polaris runs on, an
 * unusual stretch is told once, and a disk warning once until it clears.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerInsight } from "@/lib/server-insights/insights";

const LOCAL = "00000000-0000-4000-8000-000000000001";
const HOST = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NOW = new Date("2026-10-10T12:00:00Z");
const HOUR = 3_600_000;

const settings = new Map<string, string>();
const told: { userId: string; event: string; level?: string; audience?: string }[] = [];
let insights: ServerInsight[] = [];
let hosts = [{ id: HOST, name: "web-1", ownerId: "owner" }];
let failAfter = Number.POSITIVE_INFINITY;

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: {
        host: { findMany: async () => hosts },
        user: {
            findMany: async ({ where }: { where: { isAdmin?: boolean; id?: { in: string[] } } }) =>
                where.isAdmin ? [{ id: "admin" }] : (where.id?.in ?? []).map((id) => ({ id }))
        }
    }
}));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: { userId: string; event: string; level?: string; audience?: string }) => {
        told.push(input);
    }
}));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: async () => (key: string) => key }));
vi.mock("@/lib/local-server", () => ({
    getLocalServerName: async () => "polaris-box",
    LOCAL_SERVER_FALLBACK_NAME: "This server"
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
        settings.set(key, value);
    }
}));
vi.mock("@/lib/server-insights/insights", () => ({
    FORECAST_WARN_DAYS: 14,
    readServerInsights: async (subjects: string[]) => {
        if (failAfter-- <= 0) throw new Error("rollups unavailable");
        return insights.filter((one) => subjects.includes(one.subject));
    }
}));

const { freshAnomalies, watchServerInsights } = await import("../../src/lib/server-insights/insights-watch");

const steady = { kind: "steady", usedBytes: 10, totalBytes: 100, bytesPerDay: 0, spanDays: 5 } as const;

function insight(subject: string, starts: number[], diskWarning = false): ServerInsight {
    return {
        subject,
        anomalies: starts.map((start) => ({
            start,
            end: start,
            direction: "high",
            peakAt: start,
            peakValue: 95,
            baseline: 20,
            score: 8,
            metric: "cpu",
            severity: "danger"
        })),
        forecast: diskWarning
            ? { kind: "filling", usedBytes: 90, totalBytes: 100, bytesPerDay: 5, spanDays: 5, days: 2 }
            : steady,
        diskWarning,
        historyHours: 200
    };
}

beforeEach(() => {
    settings.clear();
    told.length = 0;
    hosts = [{ id: HOST, name: "web-1", ownerId: "owner" }];
    failAfter = Number.POSITIVE_INFINITY;
});

describe("freshAnomalies", () => {
    it("on a first run looks back only a few hours", () => {
        const fresh = freshAnomalies([insight(HOST, [NOW.getTime() - 2 * HOUR, NOW.getTime() - 48 * HOUR])], null, NOW.getTime());
        expect(fresh.map((one) => one.anomaly.start)).toEqual([NOW.getTime() - 2 * HOUR]);
    });

    it("after that, only what started past the watermark", () => {
        const mark = NOW.getTime() - HOUR;
        const fresh = freshAnomalies([insight(HOST, [mark, mark + 1])], mark, NOW.getTime());
        expect(fresh.map((one) => one.anomaly.start)).toEqual([mark + 1]);
    });
});

describe("watchServerInsights", () => {
    it("tells a host's owner and every admin about the local box, with the severity", async () => {
        insights = [insight(HOST, [NOW.getTime() - HOUR]), insight(LOCAL, [NOW.getTime() - HOUR])];
        await watchServerInsights(NOW);
        expect(told).toEqual([
            expect.objectContaining({ userId: "owner", event: "server.anomaly", level: "danger", audience: "you" }),
            expect.objectContaining({ userId: "admin", event: "server.anomaly", level: "danger", audience: "admins" })
        ]);
    });

    it("does not tell the same stretch twice", async () => {
        insights = [insight(HOST, [NOW.getTime() - HOUR])];
        await watchServerInsights(NOW);
        await watchServerInsights(new Date(NOW.getTime() + HOUR));
        expect(told.filter((one) => one.event === "server.anomaly")).toHaveLength(1);
    });

    it("warns about a filling disk once, and again only after it cleared", async () => {
        insights = [insight(HOST, [], true)];
        await watchServerInsights(NOW);
        await watchServerInsights(NOW);
        expect(told.filter((one) => one.event === "server.forecast")).toHaveLength(1);
        insights = [insight(HOST, [], false)];
        await watchServerInsights(NOW);
        insights = [insight(HOST, [], true)];
        await watchServerInsights(NOW);
        expect(told.filter((one) => one.event === "server.forecast")).toHaveLength(2);
    });

    it("tells a flapping metric once per cooldown, and the newest stretch of a run only", async () => {
        insights = [insight(HOST, [NOW.getTime() - 2 * HOUR, NOW.getTime() - HOUR])];
        await watchServerInsights(NOW);
        expect(told.filter((one) => one.event === "server.anomaly")).toHaveLength(1);
        insights = [insight(HOST, [NOW.getTime() + HOUR])];
        await watchServerInsights(new Date(NOW.getTime() + 2 * HOUR));
        expect(told.filter((one) => one.event === "server.anomaly")).toHaveLength(1);
        insights = [insight(HOST, [NOW.getTime() + 7 * HOUR])];
        await watchServerInsights(new Date(NOW.getTime() + 8 * HOUR));
        expect(told.filter((one) => one.event === "server.anomaly")).toHaveLength(2);
    });

    it("does not warn again while a forecast wavers just past the line", async () => {
        insights = [insight(HOST, [], true)];
        await watchServerInsights(NOW);
        insights = [
            {
                ...insight(HOST, [], false),
                forecast: { kind: "filling", usedBytes: 80, totalBytes: 100, bytesPerDay: 1, spanDays: 5, days: 16 }
            }
        ];
        await watchServerInsights(NOW);
        insights = [insight(HOST, [], true)];
        await watchServerInsights(NOW);
        expect(told.filter((one) => one.event === "server.forecast")).toHaveLength(1);
    });

    it("does not repeat what an earlier chunk told when a later one fails", async () => {
        const others = Array.from({ length: 25 }, (_, index) => ({
            id: `0190a1b2-c3d4-7e5f-8a9b-${String(index).padStart(12, "0")}`,
            name: `node-${index}`,
            ownerId: "owner"
        }));
        hosts = [{ id: HOST, name: "web-1", ownerId: "owner" }, ...others];
        insights = [insight(HOST, [NOW.getTime() - HOUR], true), insight(LOCAL, [NOW.getTime() - HOUR])];
        failAfter = 1;
        await expect(watchServerInsights(NOW)).rejects.toThrow("rollups unavailable");
        expect(told.map((one) => one.event).sort()).toEqual(["server.anomaly", "server.forecast"]);

        failAfter = Number.POSITIVE_INFINITY;
        await watchServerInsights(new Date(NOW.getTime() + HOUR));
        expect(told.filter((one) => one.userId === "owner")).toHaveLength(2);
        expect(told.filter((one) => one.userId === "admin")).toEqual([
            expect.objectContaining({ event: "server.anomaly", audience: "admins" })
        ]);
    });
});
