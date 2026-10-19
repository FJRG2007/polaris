/**
 * A list of a hundred thousand records is read a page at a time by the
 * database: every page asks for one bounded page in the database's own order,
 * a page after the first starts after the last row shown (a cursor, not an
 * offset counted past) and is not counted again, and a board counts its
 * columns in one query instead of one per column.
 *
 * The rows live in a fake table that honours `take`, `skip` and `cursor` the
 * way the database does, so the test walks real pages - what it asserts is the
 * shape of each query, not how long it took.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SEEDED = 100_000;

interface Row {
    id: string;
    name: string;
    createdAt: Date;
    deletedAt: null;
}

/** Newest first, then by id: the order a list with no sorts is read in. */
const rows: Row[] = Array.from({ length: SEEDED }, (_, at) => ({
    id: `00000000-0000-7000-8000-${String(SEEDED - at).padStart(12, "0")}`,
    name: `Example Co ${at}`,
    createdAt: new Date(Date.UTC(2026, 0, 1) - at * 1000),
    deletedAt: null
}));

function readPage(query: { skip?: number; take?: number; cursor?: { id: string } }): Row[] {
    let start = 0;
    if (query.cursor) {
        start = rows.findIndex((row) => row.id === query.cursor!.id);
        if (start < 0) return [];
    }
    start += query.skip ?? 0;
    return rows.slice(start, start + (query.take ?? rows.length));
}

const db = vi.hoisted(() => ({
    crmField: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    crmCompany: {
        findMany: vi.fn(async (_query: Record<string, unknown>): Promise<unknown[]> => []),
        count: vi.fn(async () => 0)
    },
    crmOpportunity: {
        findMany: vi.fn(async (_query: Record<string, unknown>): Promise<unknown[]> => []),
        count: vi.fn(async () => 0),
        groupBy: vi.fn(async (): Promise<unknown[]> => [])
    }
}));
const crmHost = vi.hoisted(() => ({
    crmShelf: vi.fn(async () => ({ orgId: null, orgName: null })),
    crmOrgAccess: vi.fn(),
    crmOrgRoles: vi.fn(async (): Promise<unknown[]> => [])
}));

vi.mock("@polaris/db", () => ({ prisma: db, Prisma: { Decimal: class {} } }));
vi.mock("@polaris/app-host", () => ({
    host: { crmHost, i18nRequest: { getLocale: async () => "en-US" } }
}));

import * as access from "@polaris-app/crm/src/lib/access";
import * as records from "@polaris-app/crm/src/lib/records";

const user = { id: "u1", name: "Test User", isAdmin: false } as never;

beforeEach(() => {
    vi.clearAllMocks();
    db.crmCompany.findMany.mockImplementation(async (query) => readPage(query));
    db.crmCompany.count.mockResolvedValue(SEEDED);
});

describe("a list of a hundred thousand records", () => {
    it("reads one bounded page in the database's order, counted once", async () => {
        const actor = await access.crmActor(user);
        const page = await records.listRecords(actor, "companies", {});
        expect(page.records).toHaveLength(records.PAGE_SIZE);
        expect(page.total).toBe(SEEDED);
        const [query] = db.crmCompany.findMany.mock.calls[0]!;
        expect(query).toMatchObject({
            where: { userId: "u1", deletedAt: null },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: 0,
            take: records.PAGE_SIZE
        });
        expect(query.cursor).toBeUndefined();
        expect(Object.keys(query.select as object).length).toBeGreaterThan(0);
        expect(db.crmCompany.count).toHaveBeenCalledTimes(1);
    });

    it("pages on from the last row shown, without counting or skipping past rows", async () => {
        const actor = await access.crmActor(user);
        const seen: string[] = [];
        let page = await records.listRecords(actor, "companies", {});
        seen.push(...page.records.map((record) => record.id));
        for (let turn = 0; turn < 20; turn++) {
            page = await records.listRecords(actor, "companies", {
                offset: seen.length,
                after: seen[seen.length - 1]
            });
            expect(page.total).toBeNull();
            seen.push(...page.records.map((record) => record.id));
        }
        expect(seen).toEqual(rows.slice(0, 21 * records.PAGE_SIZE).map((row) => row.id));
        expect(db.crmCompany.count).toHaveBeenCalledTimes(1);
        for (const [query] of db.crmCompany.findMany.mock.calls.slice(1)) {
            expect(query).toMatchObject({ skip: 1, take: records.PAGE_SIZE });
            expect(query.cursor).toEqual({ id: expect.any(String) });
        }
    });

    it("falls back to the offset when the row it was to follow is gone", async () => {
        const actor = await access.crmActor(user);
        const page = await records.listRecords(actor, "companies", {
            offset: 50,
            after: "00000000-0000-7000-8000-ffffffffffff"
        });
        expect(page.records.map((record) => record.id)).toEqual(
            rows.slice(50, 100).map((row) => row.id)
        );
        const calls = db.crmCompany.findMany.mock.calls.map(([query]) => query);
        expect(calls[0]).toMatchObject({ cursor: { id: expect.any(String) }, skip: 1 });
        expect(calls[1]).toMatchObject({ skip: 50 });
        expect(calls[1]!.cursor).toBeUndefined();
    });

    it("pages by offset an order a cursor cannot follow - a column that may be empty", async () => {
        const actor = await access.crmActor(user);
        await records.listRecords(actor, "companies", {
            sorts: [{ key: "employees", direction: "desc" }],
            offset: 100,
            after: rows[99]!.id
        });
        const [query] = db.crmCompany.findMany.mock.calls[0]!;
        expect(query).toMatchObject({ skip: 100, take: records.PAGE_SIZE });
        expect(query.cursor).toBeUndefined();
        expect(db.crmCompany.count).not.toHaveBeenCalled();
    });

    it("never reads more than one page, whatever limit is asked for", async () => {
        const actor = await access.crmActor(user);
        await records.listRecords(actor, "companies", { limit: SEEDED });
        expect(db.crmCompany.findMany.mock.calls[0]![0]).toMatchObject({
            take: records.PAGE_SIZE
        });
    });
});

describe("a board of a hundred thousand opportunities", () => {
    it("counts its columns in one query and reads only the columns with cards", async () => {
        db.crmOpportunity.groupBy.mockResolvedValueOnce([
            { stage: "new", _count: { _all: 60_000 } },
            { stage: "proposal", _count: { _all: 40_000 } }
        ]);
        const actor = await access.crmActor(user);
        const groups = await records.listGroups(actor, "opportunities", "stage", {});
        expect(db.crmOpportunity.groupBy).toHaveBeenCalledTimes(1);
        expect(db.crmOpportunity.count).not.toHaveBeenCalled();
        expect(db.crmOpportunity.findMany).toHaveBeenCalledTimes(2);
        for (const [query] of db.crmOpportunity.findMany.mock.calls) {
            expect(query).toMatchObject({ take: records.PAGE_SIZE, skip: 0 });
        }
        expect(groups.find((group) => group.value === "new")?.total).toBe(60_000);
        expect(groups.find((group) => group.value === "proposal")?.total).toBe(40_000);
        expect(groups.find((group) => group.value === "meeting")?.total).toBe(0);
    });
});
