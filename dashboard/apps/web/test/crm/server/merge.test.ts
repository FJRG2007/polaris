/**
 * Merging duplicates: the kept record's empty fields are filled from the
 * others in order, whatever pointed at the others points at the kept one, the
 * others go to the trash, and a reader who may not edit and delete, a record
 * missing from the shelf, or too many records refuse it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
    const delegate = () => ({
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        findFirst: vi.fn(async (): Promise<Record<string, unknown>> => ({ id: "c1" })),
        count: vi.fn(async (): Promise<number> => 0),
        updateMany: vi.fn(async ({ where }: { where: { id?: unknown } }) => ({
            count:
                where.id && typeof where.id === "object" && "in" in where.id
                    ? (where.id.in as unknown[]).length
                    : 1
        })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
            id: "c1",
            ...data
        }))
    });
    return {
        crmCompany: delegate(),
        crmPerson: delegate(),
        crmOpportunity: delegate(),
        crmLink: {
            findMany: vi.fn(async (): Promise<{ kind: string; targetId: string }[]> => []),
            deleteMany: vi.fn(async () => ({ count: 0 })),
            updateMany: vi.fn(async () => ({ count: 0 }))
        },
        crmEvent: { createMany: vi.fn(async () => ({ count: 1 })) }
    };
});

vi.mock("@polaris/db", () => {
    const client: Record<string, unknown> = { ...db };
    client.$transaction = async (run: (tx: unknown) => unknown) => run(client);
    return { prisma: client, Prisma: { Decimal: class {} } };
});
vi.mock("@polaris/app-host", () => ({
    host: { crmHost: {}, i18nRequest: { getLocale: async () => "en-US" } }
}));
vi.mock("@polaris-app/crm/src/lib/fields", () => ({ loadFields: async () => [] }));

import { mergeRecords } from "@polaris-app/crm/src/lib/merge";

const allowed = { read: true, edit: true, delete: true };
const actorWith = (
    can: typeof allowed,
    hidden: string[] = [],
    options: { people?: typeof allowed; readOnly?: string[]; rows?: "all" | "own" } = {}
) =>
    ({
        user: { id: "u1", name: "Test User" },
        shelf: { orgId: "o1", userId: null, key: "org:o1" },
        can: { companies: can, people: options.people ?? can, opportunities: can },
        rules:
            hidden.length || options.readOnly || options.rows
                ? {
                      companies: { rows: "all", hidden, readOnly: [] },
                      people: {
                          rows: options.rows ?? "all",
                          hidden,
                          readOnly: options.readOnly ?? []
                      },
                      opportunities: { rows: "all", hidden, readOnly: [] }
                  }
                : undefined
    }) as never;

beforeEach(() => vi.clearAllMocks());

describe("merging records", () => {
    it("fills empty fields from the others in order and trashes them", async () => {
        db.crmCompany.findMany.mockResolvedValueOnce([
            {
                id: "c1",
                name: "Example Co",
                domain: "",
                city: null,
                annualRevenue: null,
                annualRevenueCurrency: null
            },
            {
                id: "c2",
                name: "Example",
                domain: "example.test",
                city: null,
                annualRevenue: null,
                annualRevenueCurrency: null
            },
            {
                id: "c3",
                name: "Ex",
                domain: "other.test",
                city: "Testville",
                annualRevenue: 10,
                annualRevenueCurrency: "EUR"
            }
        ]);
        db.crmCompany.findFirst
            .mockResolvedValueOnce({ id: "c1", name: "Example Co", domain: "" })
            .mockResolvedValueOnce({ id: "c1", name: "Example Co", domain: "example.test" });
        await mergeRecords(actorWith(allowed), "companies", "c1", ["c2", "c3", "c1"]);

        const [[find]] = db.crmCompany.findMany.mock.calls as unknown as [
            [{ where: Record<string, unknown> }]
        ];
        expect(find.where).toEqual({
            orgId: "o1",
            deletedAt: null,
            id: { in: ["c1", "c2", "c3"] }
        });

        const [saved] = db.crmCompany.updateMany.mock.calls[0] as unknown as [
            { where: unknown; data: Record<string, unknown> }
        ];
        expect(saved.where).toEqual({
            orgId: "o1",
            deletedAt: null,
            id: "c1",
            updatedAt: undefined
        });
        expect(saved.data).toMatchObject({
            domain: "example.test",
            city: "Testville",
            annualRevenue: 10,
            annualRevenueCurrency: "EUR",
            updatedById: "u1"
        });
        expect(saved.data).not.toHaveProperty("name");

        expect(db.crmCompany.updateMany).toHaveBeenCalledWith({
            where: { orgId: "o1", deletedAt: null, id: { in: ["c2", "c3"] } },
            data: { deletedAt: expect.any(Date) }
        });
        for (const target of [db.crmPerson, db.crmOpportunity]) {
            expect(target.updateMany).toHaveBeenCalledWith({
                where: { orgId: "o1", companyId: { in: ["c2", "c3"] } },
                data: { companyId: "c1" }
            });
        }
        const [[logged]] = db.crmEvent.createMany.mock.calls as unknown as [
            [{ data: { kind: string; recordId: string }[] }]
        ];
        expect(logged.data.map((event) => [event.kind, event.recordId])).toEqual([
            ["updated", "c1"],
            ["trashed", "c2"],
            ["trashed", "c3"]
        ]);
    });

    it("never copies a field the reader may not see", async () => {
        db.crmCompany.findMany.mockResolvedValueOnce([
            { id: "c1", name: "Example Co", domain: null, city: null },
            { id: "c2", name: "Example", domain: "example.test", city: "Testville" }
        ]);
        await mergeRecords(actorWith(allowed, ["city"]), "companies", "c1", ["c2"]);
        const [saved] = db.crmCompany.updateMany.mock.calls[0] as unknown as [
            { data: Record<string, unknown> }
        ];
        expect(saved.data).toHaveProperty("domain", "example.test");
        expect(saved.data).not.toHaveProperty("city");
    });

    it("moves the others' opportunities and links to the kept person, once each", async () => {
        db.crmPerson.findMany.mockResolvedValueOnce([
            { id: "p1", firstName: "Test", lastName: "Person" },
            { id: "p2", firstName: "Test", lastName: "Person" }
        ]);
        db.crmLink.findMany.mockResolvedValueOnce([{ kind: "note", targetId: "n1" }]);
        await mergeRecords(actorWith(allowed), "people", "p1", ["p2"]);
        expect(db.crmOpportunity.updateMany).toHaveBeenCalledWith({
            where: { orgId: "o1", pointOfContactId: { in: ["p2"] } },
            data: { pointOfContactId: "p1" }
        });
        expect(db.crmCompany.updateMany).not.toHaveBeenCalled();
        expect(db.crmLink.deleteMany).toHaveBeenCalledWith({
            where: {
                orgId: "o1",
                object: "people",
                recordId: { in: ["p2"] },
                OR: [{ kind: "note", targetId: "n1" }]
            }
        });
        expect(db.crmLink.updateMany).toHaveBeenCalledWith({
            where: { orgId: "o1", object: "people", recordId: { in: ["p2"] } },
            data: { recordId: "p1" }
        });
    });

    it("refuses a record that is gone, too many records, or a reader who may not delete", async () => {
        db.crmCompany.findMany.mockResolvedValueOnce([{ id: "c1", name: "Example Co" }]);
        await expect(mergeRecords(actorWith(allowed), "companies", "c1", ["c2"])).rejects.toThrow(
            /gone or in the trash/
        );
        await expect(
            mergeRecords(actorWith(allowed), "companies", "c1", ["c2", "c3", "c4", "c5", "c6"])
        ).rejects.toThrow(/from 2 to 5/);
        await expect(mergeRecords(actorWith(allowed), "companies", "c1", ["c1"])).rejects.toThrow(
            /from 2 to 5/
        );
        await expect(
            mergeRecords(actorWith({ read: true, edit: true, delete: false }), "companies", "c1", [
                "c2"
            ])
        ).rejects.toThrow();
        expect(db.crmCompany.update).not.toHaveBeenCalled();
        expect(db.crmCompany.updateMany).not.toHaveBeenCalled();
    });

    it("refuses when the kept record changed or one of them was trashed since it was read", async () => {
        db.crmCompany.findMany.mockResolvedValueOnce([
            { id: "c1", name: "Example Co", domain: null, updatedAt: new Date(1) },
            { id: "c2", name: "Example", domain: "example.test", updatedAt: new Date(1) }
        ]);
        db.crmCompany.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(mergeRecords(actorWith(allowed), "companies", "c1", ["c2"])).rejects.toThrow(
            /gone or in the trash/
        );
        expect(db.crmCompany.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ updatedAt: new Date(1) }) })
        );
        expect(db.crmPerson.updateMany).not.toHaveBeenCalled();
    });

    it("refuses to repoint people the reader may not change", async () => {
        db.crmPerson.count.mockResolvedValue(2);
        const people = { read: true, edit: false, delete: false };
        await expect(
            mergeRecords(actorWith(allowed, [], { people }), "companies", "c1", ["c2"])
        ).rejects.toThrow();
        await expect(
            mergeRecords(actorWith(allowed, [], { readOnly: ["company"] }), "companies", "c1", [
                "c2"
            ])
        ).rejects.toThrow(/Company/);
        db.crmPerson.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
        await expect(
            mergeRecords(actorWith(allowed, [], { rows: "own" }), "companies", "c1", ["c2"])
        ).rejects.toThrow(/role cannot change/);
        expect(db.crmCompany.findMany).not.toHaveBeenCalled();
        expect(db.crmPerson.updateMany).not.toHaveBeenCalled();
        db.crmPerson.count.mockResolvedValue(0);
    });
});
