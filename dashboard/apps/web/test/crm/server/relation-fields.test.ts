/**
 * Relations somebody adds: a field that links a record to one or several
 * records of a chosen kind. Its ids are typed, checked against the shelf,
 * named for the screens, filtered, exported and imported by name, and taken
 * out of every list when the record they name is deleted for good or merged.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Rows = Record<string, unknown>[];
const db = vi.hoisted(() => ({
    fields: [] as { id: string; slot: string; label: string; kind: string; options: string }[]
}));
const { delegate, tables } = vi.hoisted(() => {
    type Rows = Record<string, unknown>[];
    const delegate = () => ({
        findMany: vi.fn(async (): Promise<Rows> => []),
        findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
        count: vi.fn(async () => 0),
        create: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 0 })),
        deleteMany: vi.fn(async () => ({ count: 1 }))
    });
    return {
        delegate,
        tables: {} as Record<string, ReturnType<typeof delegate>> & {
            statements?: { text: string; values: unknown[] }[];
        }
    };
});

vi.mock("@polaris/db", () => {
    tables.statements = [];
    tables.crmCompany = delegate();
    tables.crmPerson = delegate();
    tables.crmOpportunity = delegate();
    const client: Record<string, unknown> = {
        ...tables,
        crmField: { findMany: vi.fn(async () => db.fields) },
        crmEvent: {
            createMany: vi.fn(async () => ({ count: 1 })),
            deleteMany: vi.fn(async () => ({ count: 0 }))
        },
        crmLink: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        crmFavorite: { deleteMany: vi.fn(async () => ({ count: 0 })) }
    };
    client.$transaction = async (run: (tx: unknown) => unknown) => run(client);
    // A statement as its text, with each value a placeholder.
    type Sql = { text: string; values: unknown[] };
    const isSql = (value: unknown): value is Sql =>
        typeof value === "object" && value !== null && "text" in value && "values" in value;
    const sql = (parts: readonly string[], ...values: unknown[]): Sql =>
        values.reduce<Sql>(
            (built, value, at) =>
                isSql(value)
                    ? {
                          text: `${built.text}${value.text}${parts[at + 1]}`,
                          values: [...built.values, ...value.values]
                      }
                    : {
                          text: `${built.text}?${parts[at + 1]}`,
                          values: [...built.values, value]
                      },
            { text: parts[0]!, values: [] }
        );
    client.$executeRaw = vi.fn(async (parts: readonly string[], ...values: unknown[]) => {
        tables.statements!.push(sql(parts, ...values));
        return 1;
    });
    return {
        prisma: client,
        Prisma: {
            Decimal: class {},
            sql,
            raw: (text: string): Sql => ({ text, values: [] }),
            join: (items: Sql[]): Sql => ({
                text: items.map((item) => item.text).join(","),
                values: items.flatMap((item) => item.values)
            })
        }
    };
});
vi.mock("@polaris/app-host", () => ({
    host: {
        crmHost: {},
        i18nRequest: { getLocale: async () => "en-US" },
        accessGrants: { dropGrantsFor: async () => undefined }
    }
}));

import { csvValue } from "@polaris-app/crm/src/model/csv";
import type { CrmRecord } from "@polaris-app/crm/src/model/objects";
import { ruleWhere } from "@polaris-app/crm/src/lib/filters";
import { linkedIds } from "@polaris-app/crm/src/model/import";
import { normalizeInput } from "@polaris-app/crm/src/model/values";
import { nameLinks, relinkRecords } from "@polaris-app/crm/src/lib/linked";
import { createRecord, destroyRecords, updateRecords } from "@polaris-app/crm/src/lib/records";
import { customDef, fieldInputSchema } from "@polaris-app/crm/src/model/fields";
import { columnOf, readValue, toRecord, writeData } from "@polaris-app/crm/src/lib/columns";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

const partners = customDef({
    id: "f1",
    slot: "cRel1",
    label: "Partners",
    kind: "relation",
    options: ["companies", "many"]
});
const referrer = customDef({
    id: "f2",
    slot: "cRel2",
    label: "Referrer",
    kind: "relation",
    options: ["people", "one"]
});

const allowed = { read: true, edit: true, delete: true };
const actor = (people = allowed) =>
    ({
        user: { id: "u1", name: "Test User" },
        shelf: { orgId: "o1", userId: null, key: "org:o1" },
        can: { companies: allowed, people, opportunities: allowed }
    }) as never;

beforeEach(() => {
    vi.clearAllMocks();
    // A value queued for one test never leaks into the next.
    tables.statements!.length = 0;
    for (const table of [tables.crmCompany!, tables.crmPerson!, tables.crmOpportunity!]) {
        const fresh = delegate();
        for (const [method, fn] of Object.entries(table))
            fn.mockReset().mockImplementation(
                fresh[method as keyof typeof fresh].getMockImplementation()! as never
            );
    }
    db.fields = [];
});

describe("the field", () => {
    it("is made with what it links to and how many it holds, both fixed", () => {
        expect(
            fieldInputSchema.parse({
                label: "Partners",
                kind: "relation",
                options: ["companies", "many"]
            }).options
        ).toEqual(["companies", "many"]);
        for (const options of [[], ["companies"], ["planets", "one"], ["people", "two"]]) {
            const parsed = fieldInputSchema.safeParse({ label: "P", kind: "relation", options });
            expect(parsed.success).toBe(false);
        }
        expect(partners).toMatchObject({ kind: "relation", target: "companies", many: true });
        expect(referrer).toMatchObject({ target: "people", many: false });
    });

    it("takes ids once each, and refuses more than it holds or anything not an id", () => {
        expect(normalizeInput(partners, [A, B, A.toUpperCase()])).toEqual({
            ok: true,
            value: [A, B]
        });
        expect(normalizeInput(partners, [{ id: A, name: "Example" }])).toEqual({
            ok: true,
            value: [A]
        });
        expect(normalizeInput(partners, null)).toEqual({ ok: true, value: [] });
        expect(normalizeInput(referrer, [A, B])).toEqual({ ok: false, reason: "tooManyRecords" });
        expect(normalizeInput(partners, ["Example"])).toEqual({ ok: false, reason: "option" });
    });

    it("is kept as a list of ids in its slot", () => {
        const spec = columnOf("people", "cRel1");
        expect(spec).toEqual({ type: "refs", column: "cRel1" });
        expect(readValue(spec, { cRel1: [A] })).toEqual([{ id: A, name: "" }]);
        expect(readValue(spec, {})).toEqual([]);
        expect(writeData("people", partners, [A, B])).toEqual({ cRel1: [A, B] });
    });
});

describe("filters", () => {
    const rule = (operator: string, value: unknown = null) =>
        ruleWhere("people", { key: "cRel1", operator, value } as never, [partners]);

    it("finds records linked to any, none, or nothing", () => {
        const value = [{ id: A, name: "Example" }];
        expect(rule("isAnyOf", value)).toEqual({ cRel1: { hasSome: [A] } });
        expect(rule("isNoneOf", value)).toEqual({ NOT: { cRel1: { hasSome: [A] } } });
        expect(rule("isEmpty")).toEqual({ cRel1: { isEmpty: true } });
        expect(rule("isNotEmpty")).toEqual({ cRel1: { isEmpty: false } });
    });
});

describe("export and import", () => {
    it("writes the names, and reads them back to ids", () => {
        expect(
            csvValue(partners, [
                { id: A, name: "Example One" },
                { id: B, name: "Example Two" }
            ])
        ).toBe("Example One; Example Two");
        const found = new Map([
            ["example one", [A]],
            ["example two", [B]],
            ["twice", [A, B]]
        ]);
        expect(linkedIds(partners, "Example One;  example   two ", found)).toEqual([A, B]);
        expect(linkedIds(partners, "Example One; Nobody", found)).toBe("missing");
        expect(linkedIds(partners, "Twice", found)).toBe("ambiguous");
        expect(linkedIds(referrer, "Example One", found)).toEqual([A]);
    });
});

describe("naming the links", () => {
    const record = (values: Record<string, unknown>) =>
        ({ id: "p1", position: 0, deletedAt: null, values }) as unknown as CrmRecord;

    it("names each id with one read per kind, leaving out what the reader cannot see", async () => {
        tables.crmCompany!.findMany.mockResolvedValueOnce([{ id: A, name: "Example One" }]);
        const [named] = await nameLinks(
            actor(),
            [
                record({
                    cRel1: [
                        { id: A, name: "" },
                        { id: B, name: "" }
                    ],
                    cRel3: [{ id: C, name: "" }]
                })
            ],
            [partners]
        );
        expect(named!.values).toEqual({ cRel1: [{ id: A, name: "Example One" }], cRel3: [] });
        const [[read]] = tables.crmCompany!.findMany.mock.calls as unknown as [
            [{ where: Record<string, unknown> }]
        ];
        // A record in the trash is not drawn; B was not returned, so it is not.
        expect(read.where).toMatchObject({ id: { in: [A, B] }, orgId: "o1", deletedAt: null });
    });

    it("draws nothing linked to a kind the reader may not read", async () => {
        const [named] = await nameLinks(
            actor({ read: false, edit: false, delete: false }),
            [record({ cRel2: [{ id: A, name: "" }] })],
            [referrer]
        );
        expect(named!.values.cRel2).toEqual([]);
        expect(tables.crmPerson!.findMany).not.toHaveBeenCalled();
    });
});

describe("saving", () => {
    beforeEach(() => {
        db.fields = [
            {
                id: "f1",
                slot: "cRel1",
                label: "Partners",
                kind: "relation",
                options: JSON.stringify(["companies", "many"])
            }
        ];
    });

    it("refuses a link to a record that is gone or in the trash", async () => {
        tables.crmCompany!.count.mockResolvedValueOnce(1);
        await expect(
            createRecord(actor(), "people", { name: { first: "Example", last: "" }, cRel1: [A, B] })
        ).rejects.toThrow("That record is gone or in the trash.");
        expect(tables.crmPerson!.create).not.toHaveBeenCalled();
    });

    it("stores the ids when every one of them is there", async () => {
        tables.crmCompany!.count.mockResolvedValueOnce(2);
        tables.crmPerson!.create.mockResolvedValueOnce({
            id: "p1",
            position: 0,
            deletedAt: null,
            cRel1: [A, B]
        });
        await createRecord(actor(), "people", {
            name: { first: "Example", last: "" },
            cRel1: [A, B]
        });
        const [[count]] = tables.crmCompany!.count.mock.calls as unknown as [
            [{ where: Record<string, unknown> }]
        ];
        expect(count.where).toMatchObject({ id: { in: [A, B] }, deletedAt: null });
        const [[made]] = tables.crmPerson!.create.mock.calls as unknown as [
            [{ data: Record<string, unknown> }]
        ];
        expect(made.data.cRel1).toEqual([A, B]);
    });
});

describe("editing a list", () => {
    beforeEach(() => {
        db.fields = [
            {
                id: "f1",
                slot: "cRel1",
                label: "Partners",
                kind: "relation",
                options: JSON.stringify(["companies", "many"])
            },
            {
                id: "f2",
                slot: "cRel2",
                label: "Referrer",
                kind: "relation",
                options: JSON.stringify(["companies", "one"])
            }
        ];
    });

    it("keeps the links the editor cannot see, record by record", async () => {
        tables.crmCompany!.count.mockResolvedValueOnce(1);
        tables.crmPerson!.findMany.mockResolvedValueOnce([
            { id: "p1", cRel1: [A, C], cRel2: [] },
            { id: "p2", cRel1: [A], cRel2: [] }
        ]);
        // A is seen; C is in the trash or not the editor's to read.
        tables.crmCompany!.findMany.mockResolvedValueOnce([{ id: A }]);
        await updateRecords(actor(), "people", ["p1", "p2"], { cRel1: [B] });
        const [[read]] = tables.crmCompany!.findMany.mock.calls as unknown as [
            [{ where: Record<string, unknown> }]
        ];
        expect(read.where).toMatchObject({ id: { in: [A, C] }, orgId: "o1", deletedAt: null });
        const writes = tables.crmPerson!.updateMany.mock.calls as unknown as [
            { where: { id: { in: string[] } }; data: Record<string, unknown> }
        ][];
        expect(writes.map(([call]) => [call.where.id.in, call.data.cRel1])).toEqual([
            [["p1"], [B, C]],
            [["p2"], [B]]
        ]);
    });

    it("replaces a one-record link when one is picked, and keeps it when only cleared", async () => {
        tables.crmCompany!.count.mockResolvedValueOnce(1);
        tables.crmPerson!.findMany.mockResolvedValueOnce([{ id: "p1", cRel1: [], cRel2: [C] }]);
        await updateRecords(actor(), "people", ["p1"], { cRel2: [B] });
        tables.crmPerson!.findMany.mockResolvedValueOnce([{ id: "p1", cRel1: [], cRel2: [C] }]);
        await updateRecords(actor(), "people", ["p1"], { cRel2: [] });
        const writes = tables.crmPerson!.updateMany.mock.calls as unknown as [
            { data: Record<string, unknown> }
        ][];
        expect(writes.map(([call]) => call.data.cRel2)).toEqual([[B], [C]]);
    });
});

describe("a linked record that goes", () => {
    it("is taken out of every list when it is deleted for good, on the timeline", async () => {
        // The company deleted for good, then no built-in relation pointing at it.
        db.fields = [
            {
                id: "f1",
                slot: "cRel1",
                label: "Partners",
                kind: "relation",
                options: JSON.stringify(["companies", "many"])
            }
        ];
        tables
            .crmCompany!.findMany.mockResolvedValueOnce([
                { id: A, name: "Example One", deletedAt: new Date() }
            ])
            .mockResolvedValueOnce([])
            // The link that stays, named for the timeline.
            .mockResolvedValueOnce([{ id: B, name: "Example Two" }]);
        tables
            .crmPerson!.findMany.mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: "p1", cRel1: [B, A], cRel2: [], cRel3: [] }]);
        expect(await destroyRecords(actor(), "companies", [A])).toBe(1);
        const lookups = tables.crmPerson!.findMany.mock.calls as unknown as [
            { where: Record<string, unknown> }
        ][];
        expect(lookups.at(-1)![0].where).toMatchObject({
            orgId: "o1",
            OR: [
                { cRel1: { hasSome: [A] } },
                { cRel2: { hasSome: [A] } },
                { cRel3: { hasSome: [A] } }
            ]
        });
        expect(tables.statements).toEqual([
            {
                text: `UPDATE "CrmPerson" AS t SET "cRel1" = v.after, "updatedAt" = now() AT TIME ZONE 'UTC' FROM (VALUES (?::uuid, ?::uuid[])) AS v(id, after) WHERE t."id" = v.id`,
                values: ["p1", [B]]
            }
        ]);
        const { prisma } = await import("@polaris/db");
        const logged = (
            prisma as unknown as {
                crmEvent: { createMany: { mock: { calls: [{ data: Rows }][] } } };
            }
        ).crmEvent.createMany.mock.calls.flatMap(([call]) => call.data);
        const entry = logged.find((one) => one.recordId === "p1")!;
        expect(entry).toMatchObject({ kind: "updated", object: "people" });
        expect(JSON.parse(entry.changes as string)).toEqual([
            {
                key: "cRel1",
                before: [
                    { id: B, name: "Example Two" },
                    { id: A, name: "Example One" }
                ],
                after: [{ id: B, name: "Example Two" }]
            }
        ]);
    });

    it("is replaced by the record kept when it is merged away, once", async () => {
        tables.crmCompany!.findMany.mockResolvedValueOnce([
            { id: "c9", cRel1: [A, B, C], cRel2: [], cRel3: [] }
        ]);
        const { prisma } = await import("@polaris/db");
        const changed = await relinkRecords(prisma as never, actor(), [B, C], A);
        expect(tables.statements!.map((one) => one.values)).toEqual([["c9", [A]]]);
        expect(tables.statements![0]!.text).toContain('UPDATE "CrmCompany" AS t SET "cRel1"');
        expect(changed).toEqual([
            { object: "companies", recordId: "c9", slot: "cRel1", before: [A, B, C], after: [A] }
        ]);
    });
});

describe("reading a row", () => {
    it("reads a relation slot as a list", () => {
        const read = toRecord("people", {
            id: "p1",
            position: 0,
            deletedAt: null,
            cRel1: [A]
        });
        expect(read.values.cRel1).toEqual([{ id: A, name: "" }]);
    });
});
