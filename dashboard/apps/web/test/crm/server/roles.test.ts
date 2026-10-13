/**
 * Role rules on the server: loaded for the reader's role (never for the owner
 * or a full-access role), narrowing reads to their own records, hiding fields
 * from what is sent and refusing changes to hidden or read-only ones, and only
 * somebody who manages roles may change them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    crmRoleRule: {
        findMany: vi.fn(async (): Promise<unknown[]> => []),
        upsert: vi.fn(async (): Promise<unknown> => ({}))
    },
    crmField: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    crmCompany: {
        findMany: vi.fn(async (): Promise<unknown[]> => []),
        count: vi.fn(async () => 0)
    }
}));
const crmHost = vi.hoisted(() => ({
    crmShelf: vi.fn(),
    crmOrgAccess: vi.fn(),
    crmOrgRoles: vi.fn(async (): Promise<unknown[]> => [])
}));

vi.mock("@polaris/db", () => ({ prisma: db, Prisma: { Decimal: class {} } }));
vi.mock("@polaris/app-host", () => ({
    host: { crmHost, i18nRequest: { getLocale: async () => "en-US" } }
}));

import * as access from "@polaris-app/crm/src/lib/access";
import * as records from "@polaris-app/crm/src/lib/records";
import * as roleRules from "@polaris-app/crm/src/lib/roles";
import { CrmRefusal } from "@polaris-app/crm/src/lib/errors";
import { OPEN_RULES } from "@polaris-app/crm/src/model/roles";

const user = { id: "u1", name: "Test User", isAdmin: false } as never;

function inOrg(role: string | null, permissions: string[]) {
    crmHost.crmShelf.mockResolvedValue({ orgId: "o1", orgName: "Example Org" });
    crmHost.crmOrgAccess.mockResolvedValue({ role, permissions });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("actor rules", () => {
    it("loads the rules of the reader's role", async () => {
        inOrg("sales", ["org.read", "crm.companies.edit"]);
        db.crmRoleRule.findMany.mockResolvedValueOnce([
            { object: "companies", rows: "own", hidden: '["employees"]', readOnly: "[]" }
        ]);
        const actor = await access.crmActor(user);
        expect(db.crmRoleRule.findMany.mock.calls[0]).toMatchObject([
            { where: { orgId: "o1", role: "sales" } }
        ]);
        expect(actor.rules?.companies).toEqual({ rows: "own", hidden: ["employees"], readOnly: [] });
        expect(actor.manageRoles).toBe(false);
    });

    it("leaves the owner, a full-access role and a personal shelf open", async () => {
        inOrg(null, ["*"]);
        expect((await access.crmActor(user)).rules).toEqual(OPEN_RULES);
        inOrg("admin", ["*"]);
        expect((await access.crmActor(user)).rules).toEqual(OPEN_RULES);
        crmHost.crmShelf.mockResolvedValue({ orgId: null, orgName: null });
        expect((await access.crmActor(user)).rules).toEqual(OPEN_RULES);
        expect(db.crmRoleRule.findMany).not.toHaveBeenCalled();
    });
});

const ruled = (rule: object, manageRoles = false) =>
    ({
        user: { id: "u1", name: "Test User", isAdmin: false },
        shelf: { orgId: "o1", userId: null, key: "org:o1", orgName: "Example Org" },
        can: {
            companies: { read: true, edit: true, delete: true },
            people: { read: true, edit: true, delete: true },
            opportunities: { read: true, edit: true, delete: true }
        },
        rules: { ...OPEN_RULES, companies: { ...OPEN_RULES.companies, ...rule } },
        manageRoles
    }) as never;

describe("enforcement", () => {
    it("narrows a list to the reader's own records", async () => {
        await records.listRecords(ruled({ rows: "own" }), "companies", {});
        const where = (db.crmCompany.findMany.mock.calls[0] as unknown as [{ where: object }])[0]
            .where as { AND: unknown[] };
        expect(where).toMatchObject({ orgId: "o1", deletedAt: null });
        expect(where.AND).toContainEqual({ OR: [{ accountOwnerId: "u1" }, { createdById: "u1" }] });
        expect(access.recordWhere(ruled({ rows: "own" }), "companies")).toEqual({
            orgId: "o1",
            AND: [{ OR: [{ accountOwnerId: "u1" }, { createdById: "u1" }] }]
        });
        expect(access.recordWhere(ruled({}), "companies")).toEqual({ orgId: "o1" });
    });

    it("sends no hidden value and refuses filtering or sorting by it", async () => {
        db.crmCompany.findMany.mockResolvedValueOnce([
            { id: "c1", position: 0, deletedAt: null, name: "Acme", employees: 12 }
        ]);
        const page = await records.listRecords(ruled({ hidden: ["employees"] }), "companies", {});
        expect(page.records[0]!.values).not.toHaveProperty("employees");
        expect(page.records[0]!.values.name).toBe("Acme");
        await expect(
            records.listRecords(ruled({ hidden: ["employees"] }), "companies", {
                sorts: [{ key: "employees", direction: "asc" }]
            })
        ).rejects.toBeInstanceOf(CrmRefusal);
        await expect(
            records.listRecords(ruled({ hidden: ["employees"] }), "companies", {
                filter: {
                    conjunction: "and",
                    rules: [{ key: "employees", operator: "gt", value: 1 }]
                } as never
            })
        ).rejects.toBeInstanceOf(CrmRefusal);
    });

    it("refuses a change to a read-only or hidden field", async () => {
        await expect(
            records.updateRecords(ruled({ readOnly: ["city"] }), "companies", ["c1"], { city: "X" })
        ).rejects.toThrow("Your role cannot change City here.");
        await expect(
            records.createRecord(ruled({ hidden: ["employees"] }), "companies", {
                name: "Acme",
                employees: 3
            })
        ).rejects.toBeInstanceOf(CrmRefusal);
    });
});

describe("saving rules", () => {
    const rule = { object: "companies", rows: "own", hidden: [], readOnly: [] } as const;

    it("refuses somebody who does not manage roles", async () => {
        await expect(
            roleRules.saveRoleRule(ruled({}), { ...rule, role: "sales" })
        ).rejects.toBeInstanceOf(CrmRefusal);
        expect(db.crmRoleRule.upsert).not.toHaveBeenCalled();
    });

    it("stores a checked rule for a role of the organization, never a full-access one", async () => {
        crmHost.crmOrgRoles.mockResolvedValue([
            { slug: "sales", name: "Sales", permissions: ["org.read"] },
            { slug: "admin", name: "Admin", permissions: ["*"] }
        ]);
        const saved = await roleRules.saveRoleRule(ruled({}, true), {
            ...rule,
            role: "sales",
            hidden: ["employees"],
            readOnly: ["employees", "city"]
        });
        expect(saved).toEqual({ rows: "own", hidden: ["employees"], readOnly: ["city"] });
        expect(db.crmRoleRule.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { orgId_role_object: { orgId: "o1", role: "sales", object: "companies" } }
            })
        );
        await expect(
            roleRules.saveRoleRule(ruled({}, true), { ...rule, role: "admin" })
        ).rejects.toBeInstanceOf(CrmRefusal);
        await expect(
            roleRules.saveRoleRule(ruled({}, true), { ...rule, role: "ghost" })
        ).rejects.toBeInstanceOf(CrmRefusal);
    });
});
