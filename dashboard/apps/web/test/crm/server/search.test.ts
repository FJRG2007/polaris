/**
 * The CRM's answer to search's `/records`: only for an account that may use
 * the CRM, only the kinds of record its role lets it see, only on its shelf,
 * and each kind taken in turn so one cannot crowd out the rest.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    companies: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
    people: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
    opportunities: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
    crmRunner: vi.fn(
        async (): Promise<unknown> => ({ id: "u1", name: "Test User", isAdmin: false })
    ),
    crmShelf: vi.fn(async () => ({ orgId: null as string | null, orgName: null as string | null })),
    crmOrgPermissions: vi.fn(async (): Promise<string[] | null> => [])
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        crmCompany: { findMany: mocks.companies },
        crmPerson: { findMany: mocks.people },
        crmOpportunity: { findMany: mocks.opportunities }
    },
    Prisma: { Decimal: class {} }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        crmHost: {
            crmRunner: mocks.crmRunner,
            crmShelf: mocks.crmShelf,
            crmOrgPermissions: mocks.crmOrgPermissions
        },
        i18nRequest: { getLocale: async () => "en-US" }
    }
}));

import { searchAllRecords } from "@polaris-app/crm/src/lib/records";

beforeEach(() => vi.clearAllMocks());

describe("searching every kind of record", () => {
    it("answers nothing for an account that may not use the CRM, reading nothing", async () => {
        mocks.crmRunner.mockResolvedValueOnce(null);
        expect(await searchAllRecords("u1", "acme", 12)).toEqual([]);
        expect(mocks.companies).not.toHaveBeenCalled();
    });

    it("takes each kind in turn, named, linked to the record, on the reader's own shelf", async () => {
        mocks.companies.mockResolvedValueOnce([
            { id: "c1", name: "Example Co" },
            { id: "c2", name: "Example Two" }
        ]);
        mocks.people.mockResolvedValueOnce([{ id: "p1", firstName: "Ada", lastName: "Example" }]);
        const hits = await searchAllRecords("u1", "ex", 3);
        expect(hits).toEqual([
            { id: "c1", label: "Example Co", detail: "Companies", href: "/crm/companies/c1" },
            { id: "p1", label: "Ada Example", detail: "People", href: "/crm/people/p1" },
            { id: "c2", label: "Example Two", detail: "Companies", href: "/crm/companies/c2" }
        ]);
        const [[query]] = mocks.companies.mock.calls as unknown as [
            [{ where: Record<string, unknown> }]
        ];
        expect(query.where).toMatchObject({ userId: "u1", orgId: null, deletedAt: null });
    });

    it("leaves out what an organization's role cannot see, and names the organization", async () => {
        mocks.crmShelf.mockResolvedValueOnce({ orgId: "o1", orgName: "Example Org" });
        // A restricted role holding only "edit" on companies: companies, nothing else.
        mocks.crmOrgPermissions.mockResolvedValueOnce(["crm.companies.edit"]);
        mocks.companies.mockResolvedValueOnce([{ id: "c1", name: "Example Co" }]);
        const hits = await searchAllRecords("u1", "", 12);
        expect(hits).toEqual([
            {
                id: "c1",
                label: "Example Co",
                detail: "Companies - Example Org",
                href: "/crm/companies/c1"
            }
        ]);
        expect(mocks.people).not.toHaveBeenCalled();
        expect(mocks.opportunities).not.toHaveBeenCalled();
    });
});
