/**
 * A record's page lists the records pointing at it: through a built-in
 * relation, and through every relation somebody added whose target is its
 * kind - read with "holds this id", capped with a count, out of the trash,
 * within the reader's rows, and not at all through a field the reader's role
 * hides or a kind the reader may not read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    fields: {} as Record<
        string,
        { id: string; slot: string; label: string; kind: string; options: string }[]
    >
}));
const tables = vi.hoisted(() => {
    const delegate = () => ({
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        count: vi.fn(async () => 0)
    });
    return { crmCompany: delegate(), crmPerson: delegate(), crmOpportunity: delegate() };
});

vi.mock("@polaris/db", () => ({
    prisma: {
        ...tables,
        crmField: {
            findMany: vi.fn(
                async ({ where }: { where: { object: string } }) => db.fields[where.object] ?? []
            )
        }
    },
    Prisma: { Decimal: class {} }
}));
vi.mock("@polaris/app-host", () => ({
    host: { crmHost: {}, i18nRequest: { getLocale: async () => "en-US" } }
}));
vi.mock("@polaris-app/crm/src/lib/timeline", () => ({
    listTimeline: async () => ({ events: [], next: null })
}));
vi.mock("@polaris-app/crm/src/lib/favorites", () => ({ pinnedAmong: async () => [] }));
vi.mock("@polaris-app/crm/src/lib/records", async (original) => ({
    ...(await original<typeof import("@polaris-app/crm/src/lib/records")>()),
    getRecord: async () => ({ id: ACME, position: 0, deletedAt: null, values: { name: "Acme" } }),
    shelfPeople: async () => []
}));

import { openRecord, RELATED_LIMIT } from "@polaris-app/crm/src/lib/record-page";

const ACME = "00000000-0000-4000-8000-0000000000ac";
const A = "00000000-0000-4000-8000-00000000000a";

const allowed = { read: true, edit: true, delete: true };
const open = { rows: "all", hidden: [], readOnly: [] };
const actor = (overrides: Record<string, unknown> = {}) =>
    ({
        user: { id: "u1", name: "Test User" },
        shelf: { orgId: "o1", userId: null, key: "org:o1" },
        can: { companies: allowed, people: allowed, opportunities: allowed },
        ...overrides
    }) as never;

const partnersAt = {
    id: "f1",
    slot: "cRel1",
    label: "Partners at",
    kind: "relation",
    options: JSON.stringify(["companies", "many"])
};

beforeEach(() => {
    vi.clearAllMocks();
    db.fields = { people: [partnersAt] };
    for (const table of Object.values(tables)) {
        table.findMany.mockImplementation(async () => []);
        table.count.mockImplementation(async () => 0);
    }
});

describe("the records that link to a record", () => {
    it("lists the records whose added relation holds it, capped and counted", async () => {
        tables.crmPerson.findMany.mockImplementation(async () => [
            { id: A, position: 0, deletedAt: null, name: "Example One" }
        ]);
        tables.crmPerson.count.mockImplementation(async () => 23);
        const page = await openRecord(actor(), "companies", ACME);
        const added = page.related.find((list) => list.field === "cRel1")!;
        expect(added).toMatchObject({
            object: "people",
            column: "cRel1",
            label: "Partners at",
            total: 23,
            records: [{ id: A }]
        });
        const reads = tables.crmPerson.findMany.mock.calls.map(
            (call) => (call as unknown as [{ where: Record<string, unknown>; take: number }])[0]
        );
        const read = reads.find((one) => "cRel1" in one.where)!;
        expect(read.where).toMatchObject({ cRel1: { has: ACME }, deletedAt: null });
        expect(read.take).toBe(RELATED_LIMIT);
        // The built-in relations keep their own lists.
        expect(page.related.map((list) => list.field)).toEqual(
            expect.arrayContaining(["company", "cRel1"])
        );
    });

    it("keeps to the rows the reader's role may read", async () => {
        await openRecord(
            actor({
                rules: { companies: open, people: { ...open, rows: "own" }, opportunities: open }
            }),
            "companies",
            ACME
        );
        const read = tables.crmPerson.findMany.mock.calls
            .map((call) => (call as unknown as [{ where: Record<string, unknown> }])[0])
            .find((one) => "cRel1" in one.where)!;
        expect(JSON.stringify(read.where)).toContain("u1");
    });

    it("leaves out a relation the reader's role hides", async () => {
        const page = await openRecord(
            actor({
                rules: {
                    companies: open,
                    people: { ...open, hidden: ["cRel1"] },
                    opportunities: open
                }
            }),
            "companies",
            ACME
        );
        expect(page.related.some((list) => list.field === "cRel1")).toBe(false);
    });

    it("reads neither the fields nor the records of a kind the reader may not read", async () => {
        const page = await openRecord(
            actor({
                can: {
                    companies: allowed,
                    people: { ...allowed, read: false },
                    opportunities: allowed
                }
            }),
            "companies",
            ACME
        );
        expect(page.related.some((list) => list.object === "people")).toBe(false);
        expect(tables.crmPerson.findMany).not.toHaveBeenCalled();
    });

    it("ignores a relation pointing at another kind", async () => {
        db.fields = {
            people: [{ ...partnersAt, options: JSON.stringify(["opportunities", "many"]) }]
        };
        const page = await openRecord(actor(), "companies", ACME);
        expect(page.related.some((list) => list.field === "cRel1")).toBe(false);
    });
});
