/**
 * A CSV import batch on the server: rows checked again whatever the screen
 * said, references found by name on the reader's shelf only, the rows that pass
 * made in the file's order with a timeline entry each, and nothing made for an
 * actor who may not edit.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    companies: {
        findFirst: vi.fn(async () => ({ position: 0 })),
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
            id: `new-${String(data.firstName ?? data.name)}`,
            position: data.position,
            deletedAt: null,
            ...data
        }))
    },
    crmEvent: { createMany: vi.fn(async () => ({ count: 1 })) }
}));

vi.mock("@polaris/db", () => {
    const client: Record<string, unknown> = {
        crmCompany: db.companies,
        crmPerson: db.companies,
        crmOpportunity: db.companies,
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

const allowed = { read: true, edit: true, delete: true };
const actorWith = (can: typeof allowed) =>
    ({
        user: { id: "u1", name: "Test User" },
        shelf: { orgId: "o1", userId: null, key: "org:o1" },
        can: { companies: can, people: can, opportunities: can }
    }) as never;

beforeEach(() => vi.clearAllMocks());

describe("importRecords", () => {
    it("makes the rows that pass, above the list in file order, and logs each", async () => {
        const result = await importRecords(actorWith(allowed), "companies", {
            mapping: ["name", null, "domain", "accountOwner"],
            rows: [
                ["Acme", "x", "acme.com", "test user"],
                ["", "x", "", ""],
                ["Beta", "x", "not a domain", ""],
                ["Gamma", "x", "", "Nobody"]
            ]
        });
        expect(result).toEqual({
            created: 1,
            failed: [
                { row: 1, problems: [{ key: "name", reason: "required" }] },
                { row: 2, problems: [{ key: "domain", reason: "domain" }] },
                { row: 3, problems: [{ key: "accountOwner", reason: "notOnShelf" }] }
            ]
        });
        expect(db.companies.create).toHaveBeenCalledTimes(1);
        const [[made]] = db.companies.create.mock.calls as unknown as [
            [{ data: Record<string, unknown> }]
        ];
        expect(made.data).toMatchObject({
            name: "Acme",
            domain: "acme.com",
            accountOwnerId: "u1",
            orgId: "o1",
            createdById: "u1",
            position: -1
        });
        const [[logged]] = db.crmEvent.createMany.mock.calls as unknown as [
            [{ data: { kind: string }[] }]
        ];
        expect(logged.data).toEqual([expect.objectContaining({ kind: "imported", orgId: "o1" })]);
    });

    it("finds a referenced company by name on the shelf, and says when two share it", async () => {
        db.companies.findMany.mockResolvedValueOnce([
            { id: "c1", name: "Acme", position: 0 },
            { id: "c2", name: "Twin", position: 1 },
            { id: "c3", name: "twin", position: 2 }
        ]);
        const result = await importRecords(actorWith(allowed), "people", {
            mapping: ["name", "company"],
            rows: [
                ["Ada Lovelace", "ACME"],
                ["Grace Hopper", "Twin"],
                ["Alan Turing", "Gone"]
            ]
        });
        const [[find]] = db.companies.findMany.mock.calls as unknown as [
            [{ where: Record<string, unknown> }]
        ];
        expect(find.where).toMatchObject({ orgId: "o1", deletedAt: null });
        expect(find.where.name).toEqual({ in: ["acme", "twin", "gone"], mode: "insensitive" });
        expect(result.created).toBe(1);
        expect(result.failed).toEqual([
            { row: 1, problems: [{ key: "company", reason: "ambiguous" }] },
            { row: 2, problems: [{ key: "company", reason: "missing" }] }
        ]);
        const [[made]] = db.companies.create.mock.calls as unknown as [
            [{ data: Record<string, unknown> }]
        ];
        expect(made.data).toMatchObject({
            firstName: "Ada",
            lastName: "Lovelace",
            companyId: "c1"
        });
    });

    it("holds the import to the role's field and row rules", async () => {
        const ruled = (rows: "all" | "own", readOnly: string[], hidden: string[] = []) =>
            ({
                user: { id: "u1", name: "Test User" },
                shelf: { orgId: "o1", userId: null, key: "org:o1" },
                can: { companies: allowed, people: allowed, opportunities: allowed },
                rules: {
                    companies: { rows, hidden: [], readOnly: [] },
                    people: { rows: "all", hidden, readOnly },
                    opportunities: { rows: "all", hidden: [], readOnly: [] }
                }
            }) as never;
        await expect(
            importRecords(ruled("all", ["jobTitle"]), "people", {
                mapping: ["name", "jobTitle"],
                rows: [["Ada Lovelace", "Engineer"]]
            })
        ).rejects.toThrow(/cannot change Job title/);
        await expect(
            importRecords(ruled("all", [], ["email"]), "people", {
                mapping: ["name", "email"],
                rows: [["Ada Lovelace", "ada@example.test"]]
            })
        ).rejects.toThrow(/cannot change/);
        expect(db.companies.create).not.toHaveBeenCalled();

        await importRecords(ruled("own", []), "people", {
            mapping: ["name", "company"],
            rows: [["Ada Lovelace", "Acme"]]
        });
        const [[find]] = db.companies.findMany.mock.calls as unknown as [
            [{ where: Record<string, unknown> }]
        ];
        expect(find.where).toMatchObject({
            orgId: "o1",
            AND: [{ OR: [{ accountOwnerId: "u1" }, { createdById: "u1" }] }]
        });
    });

    it("refuses an actor who may not edit, an unknown field and a field mapped twice", async () => {
        const batch = { mapping: ["name"], rows: [["Acme"]] };
        await expect(
            importRecords(actorWith({ ...allowed, edit: false }), "companies", batch)
        ).rejects.toThrow();
        await expect(
            importRecords(actorWith(allowed), "companies", {
                mapping: ["createdAt"],
                rows: [["x"]]
            })
        ).rejects.toThrow();
        await expect(
            importRecords(actorWith(allowed), "companies", {
                mapping: ["name", "name"],
                rows: [["a", "b"]]
            })
        ).rejects.toThrow();
        expect(db.companies.create).not.toHaveBeenCalled();
    });
});
