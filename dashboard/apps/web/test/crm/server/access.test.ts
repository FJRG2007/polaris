/**
 * Who may do what in the CRM: everything on one's own shelf; in an
 * organization, what the role grants per kind of record - with seeing implied
 * by changing or deleting - and the database query narrowed to that shelf.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const crmHost = vi.hoisted(() => ({
    crmShelf: vi.fn(),
    crmOrgPermissions: vi.fn(),
    crmOrgPeople: vi.fn(),
    peopleByIds: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: {}, Prisma: { Decimal: class {} } }));
vi.mock("@polaris/app-host", () => ({
    host: { crmHost, i18nRequest: { getLocale: async () => "en-US" } }
}));

import { CrmRefusal } from "@polaris-app/crm/src/lib/errors";
import { crmActor, requireCan, shelfWhere } from "@polaris-app/crm/src/lib/access";
import { listOrder, listWhere, searchWhere } from "@polaris-app/crm/src/lib/query";

const user = { id: "u1", name: "Ana", email: "ana@example.com", isAdmin: false } as never;

beforeEach(() => {
    vi.clearAllMocks();
});

describe("crmActor", () => {
    it("lets a person do everything on their own shelf", async () => {
        crmHost.crmShelf.mockResolvedValue({ orgId: null, orgName: null });
        const actor = await crmActor(user);
        expect(actor.shelf).toMatchObject({ orgId: null, userId: "u1", key: "user:u1" });
        expect(actor.can.opportunities).toEqual({ read: true, edit: true, delete: true });
        expect(crmHost.crmOrgPermissions).not.toHaveBeenCalled();
    });

    it("lets every member of an organization see it, and change only what the role grants", async () => {
        crmHost.crmShelf.mockResolvedValue({ orgId: "o1", orgName: "Acme" });
        crmHost.crmOrgPermissions.mockResolvedValue(["org.read", "crm.people.edit"]);
        const actor = await crmActor(user);
        expect(actor.shelf).toMatchObject({
            orgId: "o1",
            userId: null,
            key: "org:o1",
            orgName: "Acme"
        });
        expect(actor.can.companies).toEqual({ read: true, edit: false, delete: false });
        expect(actor.can.people).toEqual({ read: true, edit: true, delete: false });
    });

    it("shows a restricted role only the kinds it may change", async () => {
        crmHost.crmShelf.mockResolvedValue({ orgId: "o1", orgName: "Acme" });
        crmHost.crmOrgPermissions.mockResolvedValue(["crm.opportunities.delete"]);
        const actor = await crmActor(user);
        expect(actor.can.opportunities).toEqual({ read: true, edit: false, delete: true });
        expect(actor.can.companies).toEqual({ read: false, edit: false, delete: false });
    });

    it("reads a wildcard role as every permission, and no membership as none", async () => {
        crmHost.crmShelf.mockResolvedValue({ orgId: "o1", orgName: "Acme" });
        crmHost.crmOrgPermissions.mockResolvedValue(["*"]);
        expect((await crmActor(user)).can.opportunities.delete).toBe(true);
        crmHost.crmOrgPermissions.mockResolvedValue(null);
        expect((await crmActor(user)).can.companies.read).toBe(false);
    });

    it("refuses an action the role does not grant, in words", async () => {
        crmHost.crmShelf.mockResolvedValue({ orgId: "o1", orgName: "Acme" });
        crmHost.crmOrgPermissions.mockResolvedValue(["org.read"]);
        const actor = await crmActor(user);
        await expect(requireCan(actor, "companies", "read")).resolves.toBeUndefined();
        await expect(requireCan(actor, "companies", "delete")).rejects.toBeInstanceOf(CrmRefusal);
        await expect(requireCan(actor, "companies", "delete")).rejects.toThrow(
            "Your role cannot delete companies here."
        );
    });
});

describe("the list query", () => {
    const own = { orgId: null, userId: "u1", key: "user:u1", orgName: null };
    const org = { orgId: "o1", userId: null, key: "org:o1", orgName: "Acme" };

    it("keeps to the shelf: a personal shelf never reaches an organization's rows", () => {
        expect(shelfWhere(own)).toEqual({ userId: "u1", orgId: null });
        expect(shelfWhere(org)).toEqual({ orgId: "o1" });
        expect(listWhere("companies", org, {})).toEqual({ orgId: "o1", deletedAt: null });
        expect(listWhere("companies", org, { deleted: true })).toMatchObject({
            deletedAt: { not: null }
        });
    });

    it("finds every word of a search in one of the searched columns", () => {
        const where = searchWhere("people", "  ana   garcia ") as { AND: { OR: unknown[] }[] };
        expect(where.AND).toHaveLength(2);
        expect(where.AND[0]!.OR).toContainEqual({
            firstName: { contains: "ana", mode: "insensitive" }
        });
        expect(where.AND[1]!.OR).toContainEqual({
            lastName: { contains: "garcia", mode: "insensitive" }
        });
        expect(searchWhere("people", "   ")).toEqual({});
    });

    it("orders by the sorts, empty values last, then newest and id so pages never overlap", () => {
        expect(listOrder("opportunities", [{ key: "amount", direction: "desc" }])).toEqual([
            { amount: { sort: "desc", nulls: "last" } },
            { createdAt: "desc" },
            { id: "desc" }
        ]);
        expect(listOrder("people", [{ key: "name", direction: "asc" }]).slice(0, 2)).toEqual([
            { firstName: "asc" },
            { lastName: "asc" }
        ]);
    });
});
