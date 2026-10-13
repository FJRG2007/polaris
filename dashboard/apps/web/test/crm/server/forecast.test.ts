/**
 * The forecast on the server: one grouped read of the shelf's opportunities
 * (never the trash, only the reader's when asked), odds kept per shelf, and
 * both refused to a role that may not see or change opportunities.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    crmOpportunity: {
        groupBy: vi.fn(async (): Promise<unknown[]> => []),
        findMany: vi.fn(async (): Promise<unknown[]> => [])
    },
    crmEvent: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    crmForecast: {
        findUnique: vi.fn(async (): Promise<unknown> => null),
        upsert: vi.fn(async () => ({}))
    }
}));

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@polaris/app-host", () => ({
    host: { i18nRequest: { getLocale: async () => "en-US" } }
}));

import { CrmRefusal } from "@polaris-app/crm/src/lib/errors";
import * as forecast from "@polaris-app/crm/src/lib/forecast";
import { DEFAULT_ODDS } from "@polaris-app/crm/src/model/forecast";

const can = (read: boolean, edit = read) => ({ read, edit, delete: false });
const actor = (opportunities = can(true)) =>
    ({
        user: { id: "u1", name: "Test User", isAdmin: false },
        shelf: { orgId: "o1", userId: null, key: "org:o1", orgName: "Example Org" },
        can: { companies: can(true), people: can(true), opportunities }
    }) as never;

const now = new Date("2026-10-13T12:00:00Z");

beforeEach(() => {
    vi.clearAllMocks();
});

describe("forecast", () => {
    it("reads open deals of any date and won ones in range, on this shelf, out of the trash", async () => {
        db.crmOpportunity.groupBy.mockResolvedValueOnce([
            {
                closeDate: new Date("2026-10-20T00:00:00Z"),
                stage: "proposal",
                amountCurrency: "EUR",
                _count: { _all: 2 },
                _sum: { amount: "1000" }
            }
        ]);
        const result = await forecast.forecast(
            actor(),
            { granularity: "month", periods: 3, mine: false },
            now
        );
        const call = (
            db.crmOpportunity.groupBy.mock.calls[0] as unknown as [
                { where: Record<string, unknown>; by: string[]; take: number }
            ]
        )[0];
        expect(call.by).toEqual(["closeDate", "stage", "amountCurrency"]);
        expect(call.where).toMatchObject({ orgId: "o1", deletedAt: null });
        expect(call.where).not.toHaveProperty("ownerId");
        expect(call.where.AND).toEqual([
            { stage: { not: "lost" } },
            { OR: [{ closeDate: null }, { closeDate: { lt: new Date("2027-01-01T00:00:00Z") } }] },
            {
                OR: [
                    { stage: { not: "customer" } },
                    { closeDate: { gte: new Date("2026-10-01T00:00:00Z") } }
                ]
            }
        ]);
        expect(call.take).toBe(forecast.ROW_CAP + 1);
        expect(result.periods[0]!.money.EUR).toEqual({ won: 0, open: 1000, expected: 600 });
        expect(result.odds).toEqual(DEFAULT_ODDS);
        expect(result.capped).toBe(false);
    });

    it("narrows to the reader's own deals and uses the shelf's odds", async () => {
        db.crmForecast.findUnique.mockResolvedValueOnce({ odds: JSON.stringify({ proposal: 90 }) });
        const result = await forecast.forecast(
            actor(),
            { granularity: "quarter", periods: 1, mine: true },
            now
        );
        const call = (
            db.crmOpportunity.groupBy.mock.calls[0] as unknown as [
                { where: Record<string, unknown> }
            ]
        )[0];
        expect(call.where.ownerId).toBe("u1");
        expect(result.odds.proposal).toBe(90);
        expect(result.odds.new).toBe(DEFAULT_ODDS.new);
    });

    it("refuses a role that cannot see opportunities", async () => {
        await expect(
            forecast.forecast(actor(can(false)), { granularity: "month", periods: 1, mine: false })
        ).rejects.toBeInstanceOf(CrmRefusal);
        expect(db.crmOpportunity.groupBy).not.toHaveBeenCalled();
    });
});

describe("saveOdds", () => {
    it("keeps the odds for the shelf", async () => {
        const odds = { new: 5, screening: 15, meeting: 35, proposal: 75 };
        expect(await forecast.saveOdds(actor(), odds)).toEqual(odds);
        expect(db.crmForecast.upsert).toHaveBeenCalledWith({
            where: { shelf: "org:o1" },
            create: { orgId: "o1", userId: null, shelf: "org:o1", odds: JSON.stringify(odds) },
            update: { odds: JSON.stringify(odds) }
        });
    });

    it("refuses a role that cannot change opportunities", async () => {
        await expect(
            forecast.saveOdds(actor(can(true, false)), DEFAULT_ODDS)
        ).rejects.toBeInstanceOf(CrmRefusal);
        expect(db.crmForecast.upsert).not.toHaveBeenCalled();
    });
});

describe("stage flow", () => {
    it("reads the newest deals, their stage moves and won or lost reasons, on this shelf", async () => {
        db.crmOpportunity.findMany.mockResolvedValueOnce([
            { id: "d1", stage: "customer", createdAt: new Date("2026-09-01T00:00:00Z") }
        ]);
        db.crmOpportunity.groupBy.mockResolvedValueOnce([
            { stage: "customer", closeReason: "Price", _count: { _all: 1 } }
        ]);
        db.crmEvent.findMany.mockResolvedValueOnce([
            {
                recordId: "d1",
                createdAt: new Date("2026-09-11T00:00:00Z"),
                changes: JSON.stringify([{ key: "stage", before: "new", after: "customer" }])
            }
        ]);
        const flow = await forecast.stageFlow(actor(), { mine: true });
        const deals = (db.crmOpportunity.findMany.mock.calls[0] as unknown as [
            { where: Record<string, unknown> }
        ])[0];
        expect(deals.where).toMatchObject({ orgId: "o1", deletedAt: null, ownerId: "u1" });
        const events = (db.crmEvent.findMany.mock.calls[0] as unknown as [
            { where: Record<string, unknown> }
        ])[0];
        expect(events.where).toMatchObject({
            orgId: "o1",
            object: "opportunities",
            recordId: { in: ["d1"] }
        });
        expect(flow.won).toBe(1);
        expect(flow.winRate).toBe(100);
        expect(flow.steps.find((step) => step.stage === "new")).toMatchObject({
            reached: 1,
            won: 1,
            averageDays: 10
        });
        expect(flow.wonReasons).toEqual([{ reason: "Price", deals: 1 }]);
    });

    it("is refused to a role that may not read opportunities", async () => {
        await expect(forecast.stageFlow(actor(can(false)), { mine: false })).rejects.toBeInstanceOf(
            CrmRefusal
        );
        expect(db.crmOpportunity.findMany).not.toHaveBeenCalled();
    });
});
