/**
 * Favorites: the reader's own pins, per shelf, only of what they may see -
 * and what a pin points at is read again every time, so a record gone to the
 * trash or a kind of record the role no longer sees stops being listed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    companies: {
        findFirst: vi.fn(async (): Promise<unknown> => ({ id: "c1" })),
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => [])
    },
    people: {
        findFirst: vi.fn(async (): Promise<unknown> => ({ id: "p1" })),
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => [])
    },
    crmView: {
        findFirst: vi.fn(async (): Promise<unknown> => ({ id: "v1" })),
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => [])
    },
    crmFavorite: {
        count: vi.fn(async () => 0),
        findFirst: vi.fn(async (): Promise<unknown> => null),
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
        upsert: vi.fn(async () => ({})),
        deleteMany: vi.fn(async () => ({ count: 1 }))
    },
    crmRunner: vi.fn(async (): Promise<unknown> => ({ id: "u1", name: "Test User" })),
    crmShelf: vi.fn(async () => ({ orgId: null, orgName: null }))
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        crmCompany: db.companies,
        crmPerson: db.people,
        crmOpportunity: db.companies,
        crmView: db.crmView,
        crmFavorite: db.crmFavorite
    },
    Prisma: { Decimal: class {} }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        crmHost: { crmRunner: db.crmRunner, crmShelf: db.crmShelf },
        i18nRequest: { getLocale: async () => "en-US" }
    }
}));

import { CrmRefusal } from "@polaris-app/crm/src/lib/errors";
import * as favorites from "@polaris-app/crm/src/lib/favorites";

const can = (read: boolean) => ({ read, edit: read, delete: read });
const actor = (people = true) =>
    ({
        user: { id: "u1", name: "Test User" },
        shelf: { orgId: "o1", userId: null, key: "org:o1", orgName: "Example Org" },
        can: { companies: can(true), people: can(people), opportunities: can(true) }
    }) as never;

const C1 = "0193b0f0-0000-7000-8000-0000000000c1";

beforeEach(() => vi.clearAllMocks());

describe("pinning", () => {
    it("pins a record on the shelf after the last one, once", async () => {
        db.crmFavorite.findFirst.mockResolvedValueOnce({ position: 4 });
        await favorites.addFavorite(actor(), "record", "companies", C1);
        const [[find]] = db.companies.findFirst.mock.calls as unknown as [[{ where: unknown }]];
        expect(find.where).toEqual({ id: C1, orgId: "o1", deletedAt: null });
        expect(db.crmFavorite.upsert).toHaveBeenCalledWith({
            where: { userId_kind_targetId: { userId: "u1", kind: "record", targetId: C1 } },
            create: {
                userId: "u1",
                orgId: "o1",
                kind: "record",
                object: "companies",
                targetId: C1,
                position: 5
            },
            update: {}
        });
    });

    it("refuses a record that is not there, a kind the role cannot see, and past the limit", async () => {
        db.companies.findFirst.mockResolvedValueOnce(null);
        await expect(
            favorites.addFavorite(actor(), "record", "companies", C1)
        ).rejects.toBeInstanceOf(CrmRefusal);
        await expect(
            favorites.addFavorite(actor(false), "record", "people", C1)
        ).rejects.toBeInstanceOf(CrmRefusal);
        db.crmFavorite.count.mockResolvedValueOnce(favorites.MAX_FAVORITES);
        await expect(favorites.addFavorite(actor(), "view", "companies", C1)).rejects.toThrow(
            "You already have 50 favorites here. Remove one first."
        );
        expect(db.crmFavorite.upsert).not.toHaveBeenCalled();
    });

    it("pins only a record the reader reaches when their role is held to their own", async () => {
        const ownOnly = {
            user: { id: "u1", name: "Test User" },
            shelf: { orgId: "o1", userId: null, key: "org:o1", orgName: "Example Org" },
            can: { companies: can(true), people: can(true), opportunities: can(true) },
        rules: {
            companies: { rows: "own", hidden: [], readOnly: [] },
            people: { rows: "own", hidden: [], readOnly: [] },
            opportunities: { rows: "own", hidden: [], readOnly: [] }
        }
        } as never;
        db.companies.findFirst.mockResolvedValueOnce(null);
        await expect(
            favorites.addFavorite(ownOnly, "record", "companies", C1)
        ).rejects.toBeInstanceOf(CrmRefusal);
        const [[find]] = db.companies.findFirst.mock.calls as unknown as [[{ where: unknown }]];
        expect(find.where).toEqual({
            id: C1,
            orgId: "o1",
            AND: [{ OR: [{ accountOwnerId: "u1" }, { createdById: "u1" }] }],
            deletedAt: null
        });
        expect(db.crmFavorite.upsert).not.toHaveBeenCalled();
    });

    it("unpins only the reader's own, on this shelf", async () => {
        await favorites.removeFavorite(actor(), "view", C1);
        expect(db.crmFavorite.deleteMany).toHaveBeenCalledWith({
            where: { userId: "u1", orgId: "o1", kind: "view", targetId: C1 }
        });
    });
});

describe("listing", () => {
    it("names what is still there and may be seen, in order, and drops the rest", async () => {
        db.crmFavorite.findMany.mockResolvedValueOnce([
            { id: "f1", kind: "record", object: "companies", targetId: "c1" },
            { id: "f2", kind: "record", object: "people", targetId: "p1" },
            { id: "f3", kind: "view", object: "companies", targetId: "v1" },
            { id: "f4", kind: "record", object: "companies", targetId: "c-trashed" },
            { id: "f5", kind: "view", object: "companies", targetId: "v-default" }
        ]);
        db.companies.findMany.mockResolvedValueOnce([{ id: "c1", name: "Example Co" }]);
        db.crmView.findMany.mockResolvedValueOnce([
            { id: "v1", name: "Hot leads", object: "companies" },
            { id: "v-default", name: "", object: "companies" }
        ]);
        expect(await favorites.listFavorites(actor(false))).toEqual([
            {
                id: "f1",
                kind: "record",
                object: "companies",
                targetId: "c1",
                label: "Example Co",
                href: "/crm/companies/c1"
            },
            {
                id: "f3",
                kind: "view",
                object: "companies",
                targetId: "v1",
                label: "Companies: Hot leads",
                href: "/crm/companies?view=v1"
            },
            {
                id: "f5",
                kind: "view",
                object: "companies",
                targetId: "v-default",
                label: "Companies",
                href: "/crm/companies?view=v-default"
            }
        ]);
        // The people the role cannot see are never read.
        expect(db.people.findMany).not.toHaveBeenCalled();
        const [[read]] = db.companies.findMany.mock.calls as unknown as [[{ where: unknown }]];
        expect(read.where).toEqual({
            id: { in: ["c1", "c-trashed"] },
            orgId: "o1",
            deletedAt: null
        });
    });

    it("answers the rail nothing for an account that may not use the CRM", async () => {
        db.crmRunner.mockResolvedValueOnce(null);
        expect(await favorites.railFavorites("u1")).toEqual([]);
        expect(db.crmFavorite.findMany).not.toHaveBeenCalled();
    });
});
