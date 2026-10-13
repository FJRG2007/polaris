/**
 * Duplicates on the server: one query on the reader's shelf, never the trash
 * or the record itself, matches named by the field they share, nothing for a
 * reader who may not see the kind - and an import that skips a row matching a
 * record already there or an earlier row of the batch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    records: {
        findFirst: vi.fn(async () => ({ position: 0 })),
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
            id: `new-${String(data.name)}`,
            position: data.position,
            deletedAt: null,
            ...data
        }))
    },
    crmEvent: { createMany: vi.fn(async () => ({ count: 1 })) }
}));

vi.mock("@polaris/db", () => {
    const client: Record<string, unknown> = {
        crmCompany: db.records,
        crmPerson: db.records,
        crmOpportunity: db.records,
        crmEvent: db.crmEvent
    };
    client.$transaction = async (run: (tx: unknown) => unknown) => run(client);
    return { prisma: client, Prisma: { Decimal: class {} } };
});
vi.mock("@polaris/app-host", () => ({
    host: { crmHost: {}, i18nRequest: { getLocale: async () => "en-US" } }
}));
vi.mock("@polaris-app/crm/src/lib/fields", () => ({ loadFields: async () => [] }));
vi.mock("@polaris-app/crm/src/lib/records", () => ({
    shelfPeople: async () => [{ id: "u1", name: "Test User" }]
}));

import { importRecords } from "@polaris-app/crm/src/lib/import";
import { findDuplicates } from "@polaris-app/crm/src/lib/duplicates";

const allowed = { read: true, edit: true, delete: true };
const actorWith = (can: typeof allowed, hidden: string[] = []) =>
    ({
        user: { id: "u1", name: "Test User" },
        shelf: { orgId: "o1", userId: null, key: "org:o1" },
        can: { companies: can, people: can, opportunities: can },
        rules: hidden.length
            ? {
                  companies: { rows: "all", hidden, readOnly: [] },
                  people: { rows: "all", hidden, readOnly: [] },
                  opportunities: { rows: "all", hidden, readOnly: [] }
              }
            : undefined
    }) as never;

beforeEach(() => vi.clearAllMocks());

describe("findDuplicates", () => {
    it("asks once for every key, outside the trash and the record itself", async () => {
        db.records.findMany.mockResolvedValueOnce([
            { id: "p1", firstName: "Test", lastName: "Person", email: "other@example.com" },
            { id: "p2", firstName: "Else", lastName: "Body", email: "test@example.com" }
        ]);
        const [found] = await findDuplicates(
            actorWith(allowed),
            "people",
            [{ name: { first: "test", last: "person" }, email: "TEST@example.com" }],
            ["self"]
        );
        expect(found).toEqual([
            { id: "p1", name: "Test Person", key: "name" },
            { id: "p2", name: "Else Body", key: "email" }
        ]);
        const [[query]] = db.records.findMany.mock.calls as unknown as [
            [{ where: Record<string, unknown> }]
        ];
        expect(query.where).toMatchObject({
            orgId: "o1",
            deletedAt: null,
            id: { notIn: ["self"] },
            OR: [
                {
                    firstName: { equals: "test", mode: "insensitive" },
                    lastName: { equals: "person", mode: "insensitive" }
                },
                { email: "test@example.com" }
            ]
        });
    });

    it("never matches on a field the role hides, nor for a reader who may not read", async () => {
        await findDuplicates(actorWith(allowed, ["domain"]), "companies", [
            { name: "Acme", domain: "acme.com" }
        ]);
        const [[query]] = db.records.findMany.mock.calls as unknown as [
            [{ where: { OR: unknown[] } }]
        ];
        expect(query.where.OR).toEqual([{ name: { equals: "Acme", mode: "insensitive" } }]);

        db.records.findMany.mockClear();
        const none = await findDuplicates(
            actorWith({ read: false, edit: true, delete: false }),
            "companies",
            [{ name: "Acme" }]
        );
        expect(none).toEqual([[]]);
        expect(db.records.findMany).not.toHaveBeenCalled();
    });
});

describe("importRecords with skipDuplicates", () => {
    it("skips a row like a record already there and a repeat of an earlier row", async () => {
        db.records.findMany.mockResolvedValueOnce([{ id: "c1", name: "Acme", domain: "acme.com" }]);
        const result = await importRecords(actorWith(allowed), "companies", {
            mapping: ["name", "domain"],
            rows: [
                ["Other", "ACME.com"],
                ["Fresh", "fresh.com"],
                ["fresh", ""]
            ],
            skipDuplicates: true
        });
        expect(result).toEqual({
            created: 1,
            failed: [
                { row: 0, problems: [{ key: "domain", reason: "duplicate" }] },
                { row: 2, problems: [{ key: "name", reason: "duplicate" }] }
            ]
        });
        expect(db.records.create).toHaveBeenCalledTimes(1);
    });

    it("makes every row when not asked to skip", async () => {
        const result = await importRecords(actorWith(allowed), "companies", {
            mapping: ["name"],
            rows: [["Same"], ["Same"]]
        });
        expect(result).toEqual({ created: 2, failed: [] });
        expect(db.records.findMany).not.toHaveBeenCalled();
    });
});
