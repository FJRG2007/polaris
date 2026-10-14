/**
 * Dashboards on the server: counted by the database over the shelf's rows
 * (never the trash, a view's filter when named), grouped there, and refused
 * for a kind of record the reader's role cannot see.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    opportunities: {
        aggregate: vi.fn(async (): Promise<unknown> => ({ _count: { _all: 0 } })),
        groupBy: vi.fn(async (): Promise<unknown[]> => []),
        findMany: vi.fn(async (): Promise<unknown[]> => [])
    },
    companies: {
        findMany: vi.fn(async (): Promise<unknown[]> => [])
    },
    crmField: { findMany: vi.fn(async () => []) },
    crmView: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    crmForecast: { findUnique: vi.fn(async (): Promise<unknown> => null) },
    crmDashboard: {
        findFirst: vi.fn(async (): Promise<unknown> => ({ id: "d1" })),
        update: vi.fn(async ({ data }: { data: { widgets: string } }) => ({
            id: "d1",
            name: "Sales",
            widgets: data.widgets
        })),
        count: vi.fn(async () => 0),
        create: vi.fn()
    }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        crmOpportunity: db.opportunities,
        crmCompany: db.companies,
        crmPerson: db.companies,
        crmField: db.crmField,
        crmView: db.crmView,
        crmForecast: db.crmForecast,
        crmDashboard: db.crmDashboard
    },
    Prisma: { Decimal: class {} }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        crmHost: { crmOrgPeople: async () => [{ id: "u2", name: "Test Owner" }] },
        i18nRequest: { getLocale: async () => "en-US" }
    }
}));

import { CrmRefusal } from "@polaris-app/crm/src/lib/errors";
import { defaultConfig } from "@polaris-app/crm/src/model/views";
import * as dashboards from "@polaris-app/crm/src/lib/dashboards";
import type { Widget } from "@polaris-app/crm/src/model/dashboards";

const can = (read: boolean, edit = read) => ({ read, edit, delete: false });
const actor = (opportunities = can(true)) =>
    ({
        user: { id: "u1", name: "Test User", isAdmin: false },
        shelf: { orgId: "o1", userId: null, key: "org:o1", orgName: "Example Org" },
        can: { companies: can(true, false), people: can(true, false), opportunities }
    }) as never;

const widget = (patch: Partial<Widget>): Widget => ({
    id: "0193b0f0-0000-7000-8000-000000000001",
    title: "",
    object: "opportunities",
    chart: "number",
    measure: "count",
    field: null,
    currency: null,
    groupBy: null,
    granularity: null,
    viewId: null,
    wide: false,
    ...patch
});

const ALIVE = { orgId: "o1", deletedAt: null };

beforeEach(() => vi.clearAllMocks());

describe("one figure", () => {
    it("counts the shelf's live records", async () => {
        db.opportunities.aggregate.mockResolvedValueOnce({ _count: { _all: 7 } });
        expect(await dashboards.widgetData(actor(), widget({}))).toEqual({
            kind: "number",
            value: 7
        });
        expect(db.opportunities.aggregate).toHaveBeenCalledWith({
            where: ALIVE,
            _count: { _all: true }
        });
    });

    it("adds up an amount in one currency only", async () => {
        db.opportunities.aggregate.mockResolvedValueOnce({
            _count: { _all: 3, amount: 2 },
            _sum: { amount: "1500.5" },
            _min: { amount: 500 },
            _max: { amount: 1000.5 }
        });
        const answer = await dashboards.widgetData(
            actor(),
            widget({ measure: "sum", field: "amount", currency: "EUR" })
        );
        expect(answer).toEqual({ kind: "number", value: 1500.5 });
        const [[query]] = db.opportunities.aggregate.mock.calls as unknown as [
            [{ where: unknown }]
        ];
        expect(query.where).toEqual({ AND: [ALIVE, { amountCurrency: "EUR" }] });
    });

    it("weighs each stage's amount by the shelf's odds: won in full, lost not at all", async () => {
        db.crmForecast.findUnique.mockResolvedValueOnce({ odds: JSON.stringify({ meeting: 50 }) });
        const sum = (stage: string, amount: number, count = 1) => ({
            stage,
            _count: { _all: count, amount: count },
            _sum: { amount: String(amount) },
            _min: { amount },
            _max: { amount }
        });
        db.opportunities.groupBy.mockResolvedValueOnce([
            sum("customer", 1000),
            sum("meeting", 500, 2),
            sum("new", 200),
            sum("lost", 300)
        ]);
        const answer = await dashboards.widgetData(
            actor(),
            widget({ measure: "weighted", field: "amount", currency: "EUR" })
        );
        // 1000 + 500 x 50% + 200 x the default 10% + 0.
        expect(answer).toEqual({ kind: "number", value: 1270 });
        const [[query]] = db.opportunities.groupBy.mock.calls as unknown as [
            [{ by: string[]; where: unknown }]
        ];
        expect(query.by).toEqual(["stage"]);
        expect(query.where).toEqual({ AND: [ALIVE, { amountCurrency: "EUR" }] });
        expect(db.opportunities.aggregate).not.toHaveBeenCalled();
    });

    it("splits a weighted amount by company, counting each company's stages apart", async () => {
        const row = (companyId: string, stage: string, amount: number) => ({
            companyId,
            stage,
            _count: { _all: 1, amount: 1 },
            _sum: { amount },
            _min: { amount },
            _max: { amount }
        });
        db.opportunities.groupBy.mockResolvedValueOnce([
            row("c1", "customer", 100),
            row("c1", "proposal", 100),
            row("c2", "screening", 1000)
        ]);
        const answer = await dashboards.widgetData(
            actor(),
            widget({
                chart: "bar",
                groupBy: "company",
                measure: "weighted",
                field: "amount",
                currency: "EUR"
            })
        );
        // c1: 100 + 100 x 60%; c2: 1000 x 20%.
        expect(answer).toMatchObject({
            kind: "groups",
            points: [
                { key: "c2", value: 200 },
                { key: "c1", value: 160 }
            ]
        });
        const [[query]] = db.opportunities.groupBy.mock.calls as unknown as [[{ by: string[] }]];
        expect(query.by).toEqual(["companyId", "stage"]);
    });

    it("counts only what a saved view lists", async () => {
        db.crmView.findFirst.mockResolvedValueOnce({
            config: JSON.stringify({
                ...defaultConfig("opportunities"),
                filter: {
                    conjunction: "and",
                    rules: [{ id: "r1", key: "name", operator: "contains", value: "Example" }]
                }
            })
        });
        await dashboards.widgetData(
            actor(),
            widget({ viewId: "0193b0f0-0000-7000-8000-0000000000aa" })
        );
        const [[view]] = db.crmView.findFirst.mock.calls as unknown as [[{ where: unknown }]];
        expect(view.where).toEqual({
            id: "0193b0f0-0000-7000-8000-0000000000aa",
            shelf: "org:o1",
            object: "opportunities"
        });
        const [[query]] = db.opportunities.aggregate.mock.calls as unknown as [
            [{ where: { AND?: unknown[] } }]
        ];
        expect(query.where.AND).toHaveLength(1);
    });

    it("refuses a kind of record the reader's role cannot see, reading nothing", async () => {
        await expect(dashboards.widgetData(actor(can(false)), widget({}))).rejects.toBeInstanceOf(
            CrmRefusal
        );
        expect(db.opportunities.aggregate).not.toHaveBeenCalled();
    });
});

describe("a split", () => {
    it("keeps a pipeline's order, shows the empty stages and groups in the database", async () => {
        db.opportunities.groupBy.mockResolvedValueOnce([
            { stage: "meeting", _count: { _all: 4 } },
            { stage: "new", _count: { _all: 2 } }
        ]);
        const answer = await dashboards.widgetData(
            actor(),
            widget({ chart: "bar", groupBy: "stage" })
        );
        expect(answer).toEqual({
            kind: "groups",
            points: [
                { key: "new", label: null, value: 2 },
                { key: "screening", label: null, value: 0 },
                { key: "meeting", label: null, value: 4 },
                { key: "proposal", label: null, value: 0 },
                { key: "customer", label: null, value: 0 },
                { key: "lost", label: null, value: 0 }
            ],
            other: null,
            capped: false
        });
        const [[query]] = db.opportunities.groupBy.mock.calls as unknown as [
            [{ by: string[]; take: number }]
        ];
        expect(query.by).toEqual(["stage"]);
        expect(query.take).toBe(dashboards.CATEGORY_CAP + 1);
    });

    it("ranks companies by their figure, names them, and adds up the rest", async () => {
        const rows = Array.from({ length: 12 }, (_, at) => ({
            companyId: `c${at}`,
            _count: { _all: 20 - at }
        }));
        db.opportunities.groupBy.mockResolvedValueOnce(rows);
        db.companies.findMany.mockResolvedValueOnce([{ id: "c0", name: "Example Co" }]);
        const answer = await dashboards.widgetData(
            actor(),
            widget({ chart: "bar", groupBy: "company" })
        );
        if (answer.kind !== "groups") throw new Error("expected groups");
        expect(answer.points).toHaveLength(10);
        expect(answer.points[0]).toEqual({ key: "c0", label: "Example Co", value: 20 });
        // The eleventh and twelfth: 10 + 9.
        expect(answer.other).toBe(19);
    });

    it("adds days into months and fills the months between", async () => {
        db.opportunities.groupBy.mockResolvedValueOnce([
            { closeDate: new Date("2026-01-05T00:00:00Z"), _count: { _all: 1 } },
            { closeDate: new Date("2026-01-20T00:00:00Z"), _count: { _all: 2 } },
            { closeDate: new Date("2026-03-02T00:00:00Z"), _count: { _all: 4 } }
        ]);
        const answer = await dashboards.widgetData(
            actor(),
            widget({ chart: "line", groupBy: "closeDate", granularity: "month" })
        );
        expect(answer).toEqual({
            kind: "groups",
            points: [
                { key: "2026-01-01", label: null, value: 3 },
                { key: "2026-02-01", label: null, value: 0 },
                { key: "2026-03-01", label: null, value: 4 }
            ],
            other: null,
            capped: false
        });
    });
});

describe("changing a dashboard", () => {
    it("is refused to somebody who may change no kind of record here", async () => {
        const reader = {
            user: { id: "u1", name: "Test User" },
            shelf: { orgId: "o1", userId: null, key: "org:o1", orgName: null },
            can: {
                companies: can(true, false),
                people: can(true, false),
                opportunities: can(true, false)
            }
        } as never;
        await expect(dashboards.saveWidgets(reader, "d1", [])).rejects.toBeInstanceOf(CrmRefusal);
        await expect(dashboards.createDashboard(reader, "Sales")).rejects.toBeInstanceOf(
            CrmRefusal
        );
    });

    it("keeps only widgets that fit their records now", async () => {
        await expect(
            dashboards.saveWidgets(actor(), "d1", [widget({ measure: "sum", field: "name" })])
        ).rejects.toThrow("This chart counts a field that is no longer there. Edit it.");
        const saved = await dashboards.saveWidgets(actor(), "d1", [widget({})]);
        expect(saved.widgets).toHaveLength(1);
        expect(db.crmDashboard.findFirst).toHaveBeenCalledWith({
            where: { id: "d1", shelf: "org:o1" },
            select: { id: true }
        });
    });
});
