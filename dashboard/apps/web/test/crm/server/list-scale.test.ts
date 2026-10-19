/**
 * A list of a hundred thousand records is read a page at a time by the
 * database: every page asks for one bounded page in the database's own order,
 * a page after the first starts after the values the last row was read with (a
 * cursor, not an offset counted past) and is not counted again, and a board
 * counts its columns in one query instead of one per column.
 *
 * The rows live in a fake table that filters and orders by the rows' values the
 * way the database does, so a row edited between two pages is where the
 * database would find it - what the test asserts is which rows each page holds
 * and the shape of each query, not how long it took.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SEEDED = 100_000;

interface Row {
    id: string;
    name: string;
    idealCustomer: boolean;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
    orgId: null;
    deletedAt: Date | null;
}

/** Newest first, then by id: the order a list with no sorts is read in. */
const seed = (): Row[] =>
    Array.from({ length: SEEDED }, (_, at) => ({
        id: `00000000-0000-7000-8000-${String(SEEDED - at).padStart(12, "0")}`,
        name: `Example Co ${at}`,
        idealCustomer: at % 3 === 0,
        createdAt: new Date(Date.UTC(2026, 0, 1) - at * 1000),
        updatedAt: new Date(Date.UTC(2026, 0, 1)),
        userId: "u1",
        orgId: null,
        deletedAt: null
    }));

let rows = seed();

type Where = Record<string, unknown>;
type Order = Record<string, "asc" | "desc">[];

const plain = (value: unknown): unknown => (value instanceof Date ? value.getTime() : value);

function compare(a: unknown, b: unknown): number {
    const [x, y] = [plain(a), plain(b)];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (x as number) < (y as number) ? -1 : 1;
}

function holds(value: unknown, op: string, operand: unknown): boolean {
    const order = compare(value, operand);
    switch (op) {
        case "gt":
            return order > 0;
        case "gte":
            return order >= 0;
        case "lt":
            return order < 0;
        case "lte":
            return order <= 0;
        case "in":
            return (operand as unknown[]).some((one) => compare(value, one) === 0);
        case "not":
            return operand === null ? value !== null : order !== 0;
        default:
            throw new Error(`fake table: no ${op}`);
    }
}

function matches(row: Row, where: Where): boolean {
    return Object.entries(where).every(([column, test]) => {
        if (column === "AND") return (test as Where[]).every((one) => matches(row, one));
        if (column === "OR") return (test as Where[]).some((one) => matches(row, one));
        const value = row[column as keyof Row];
        if (test === null || typeof test !== "object" || test instanceof Date)
            return compare(value, test) === 0;
        return Object.entries(test).every(([op, operand]) => holds(value, op, operand));
    });
}

function readPage(query: {
    where?: Where;
    orderBy?: Order;
    skip?: number;
    take?: number;
    cursor?: unknown;
}): Row[] {
    if (query.cursor) throw new Error("fake table: a cursor names a row, not a place");
    const order = (query.orderBy ?? []).map((entry) => Object.entries(entry)[0]!);
    const found = rows
        .filter((row) => matches(row, query.where ?? {}))
        .sort((a, b) => {
            for (const [column, direction] of order) {
                const by = compare(a[column as keyof Row], b[column as keyof Row]);
                if (by !== 0) return direction === "asc" ? by : -by;
            }
            return 0;
        });
    const start = query.skip ?? 0;
    return found.slice(start, start + (query.take ?? found.length));
}

/** Every row the list shows, in its order, read whole. */
const ordered = (orderBy: Order) =>
    readPage({ where: { userId: "u1", deletedAt: null }, orderBy }).map((row) => row.id);

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

const ids = (page: { records: { id: string }[] }) => page.records.map((record) => record.id);

beforeEach(() => {
    vi.clearAllMocks();
    rows = seed();
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

    it("pages on from where the last page ended, without counting or skipping rows", async () => {
        const actor = await access.crmActor(user);
        const seen: string[] = [];
        let page = await records.listRecords(actor, "companies", {});
        seen.push(...ids(page));
        for (let turn = 0; turn < 20; turn++) {
            expect(page.more).toBe(true);
            page = await records.listRecords(actor, "companies", {
                offset: seen.length,
                after: page.next!
            });
            expect(page.total).toBeNull();
            seen.push(...ids(page));
        }
        expect(seen).toEqual(rows.slice(0, 21 * records.PAGE_SIZE).map((row) => row.id));
        expect(db.crmCompany.count).toHaveBeenCalledTimes(1);
        for (const [query] of db.crmCompany.findMany.mock.calls.slice(1)) {
            expect(query).toMatchObject({ take: records.PAGE_SIZE });
            expect(query.skip).toBeUndefined();
            expect(query.cursor).toBeUndefined();
        }
    });

    it.each([
        ["up the list", "A first"],
        ["down the list", "zz last"]
    ])("follows on after a row edited since its page moved %s", async (_, renamed) => {
        const sorts = [{ key: "name", direction: "asc" as const }];
        const expected = ordered([{ name: "asc" }, { createdAt: "desc" }, { id: "desc" }]);
        const actor = await access.crmActor(user);
        const first = await records.listRecords(actor, "companies", { sorts });
        expect(ids(first)).toEqual(expected.slice(0, 50));
        rows.find((row) => row.id === expected[49])!.name = renamed;
        const second = await records.listRecords(actor, "companies", {
            sorts,
            offset: 50,
            after: first.next!
        });
        expect(ids(second)).toEqual(expected.slice(50, 100));
    });

    it("follows on after a row trashed since its page", async () => {
        const actor = await access.crmActor(user);
        const first = await records.listRecords(actor, "companies", {});
        rows[49]!.deletedAt = new Date();
        const second = await records.listRecords(actor, "companies", {
            offset: 50,
            after: first.next!
        });
        expect(ids(second)).toEqual(rows.slice(50, 100).map((row) => row.id));
    });

    it("follows an order by a yes/no column across where it turns, to its end", async () => {
        const sorts = [{ key: "idealCustomer", direction: "asc" as const }];
        const expected = ordered([{ idealCustomer: "asc" }, { createdAt: "desc" }, { id: "desc" }]);
        const from = expected.indexOf(rows.find((row) => row.idealCustomer)!.id) - 60;
        const actor = await access.crmActor(user);
        const seen: string[] = [];
        let page = await records.listRecords(actor, "companies", { sorts, offset: from });
        seen.push(...ids(page));
        for (let turn = 0; turn < 3; turn++) {
            page = await records.listRecords(actor, "companies", {
                sorts,
                offset: from + seen.length,
                after: page.next!
            });
            seen.push(...ids(page));
        }
        expect(seen).toEqual(expected.slice(from, from + 200));

        const tail = expected.length - 20;
        const last = await records.listRecords(actor, "companies", { sorts, offset: tail - 50 });
        const end = await records.listRecords(actor, "companies", {
            sorts,
            offset: tail,
            after: last.next!
        });
        expect(ids(end)).toEqual(expected.slice(tail));
        expect(end.more).toBe(false);
        const reads = db.crmCompany.findMany.mock.calls.map(([query]) => query);
        expect(reads.filter((query) => query.skip === undefined)).toHaveLength(4);
    });

    it("pages by offset a cursor that does not fit the list's order", async () => {
        const actor = await access.crmActor(user);
        for (const after of [
            "not-a-cursor",
            Buffer.from(JSON.stringify(["x"])).toString("base64url")
        ]) {
            db.crmCompany.findMany.mockClear();
            const page = await records.listRecords(actor, "companies", { offset: 50, after });
            expect(ids(page)).toEqual(rows.slice(50, 100).map((row) => row.id));
            expect(db.crmCompany.findMany.mock.calls[0]![0]).toMatchObject({ skip: 50 });
        }
    });

    it("reads nothing outside the list through a cursor", async () => {
        const actor = await access.crmActor(user);
        const first = await records.listRecords(actor, "companies", {});
        await records.listRecords(actor, "companies", { offset: 50, after: first.next! });
        const [query] = db.crmCompany.findMany.mock.calls[1]!;
        expect((query.where as { AND: unknown[] }).AND[0]).toMatchObject({
            userId: "u1",
            deletedAt: null
        });
        expect(query.cursor).toBeUndefined();
    });

    it("pages by offset an order a cursor cannot follow - a column that may be empty", async () => {
        const actor = await access.crmActor(user);
        const page = await records.listRecords(actor, "companies", {
            sorts: [{ key: "employees", direction: "desc" }],
            offset: 100
        });
        expect(page.next).toBeNull();
        const [query] = db.crmCompany.findMany.mock.calls[0]!;
        expect(query).toMatchObject({ skip: 100, take: records.PAGE_SIZE });
        expect(query.cursor).toBeUndefined();
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
