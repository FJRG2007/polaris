/**
 * The recycle bin reaches what an organization's runner can manage, not only what
 * they own: the listing includes the organization's projects, a restore or delete
 * acts with the owner's id, and an item outside both is refused. The database and
 * the deploy service are fakes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "00000000-0000-7000-8000-0000000000aa";
const OWNER = "00000000-0000-7000-8000-0000000000bb";
const ORG = "00000000-0000-7000-8000-0000000000cc";
const PROJECT = "00000000-0000-7000-8000-0000000000dd";

const calls: { readonly name: string; readonly args: unknown }[] = [];
let projectRow: { ownerId: string; binnedAt?: Date } | null = null;
let orgsRun: string[] = [];

const prisma = new Proxy(
    {},
    {
        get: (_, model: string) =>
            new Proxy(
                {},
                {
                    get: (__, method: string) => async (args: unknown) => {
                        calls.push({ name: `${model}.${method}`, args });
                        if (model === "project" && method === "findFirst") return projectRow;
                        if (method === "findMany") return [];
                        return null;
                    }
                }
            )
    }
);

const deleteProject = vi.fn(async () => undefined);

vi.mock("@polaris/db", () => ({ prisma, INCLUDING_BINNED: { binnedAt: undefined } }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => null,
    setSetting: async () => undefined
}));
vi.mock("@/lib/restore-points/service", () => ({
    listRestorePoints: async () => [],
    restoreKeys: { routes: (id: string) => id }
}));
vi.mock("@/lib/orgs/org-service", () => ({
    orgIdsWhere: async () => orgsRun,
    memberOrgIds: async () => [],
    orgCan: () => false,
    resolveOrgAccess: async () => null,
    teamIdsFor: async () => []
}));
vi.mock("@/lib/deploy-service", () => ({ deleteProject, syncAppRoutes: async () => undefined }));

const recycleBin = await import("@/lib/deploy/recycle-bin");

beforeEach(() => {
    calls.length = 0;
    projectRow = null;
    orgsRun = [];
    deleteProject.mockClear();
});

describe("recycle bin through organization access", () => {
    it("lists what the user owns and what their organizations hold", async () => {
        orgsRun = [ORG];
        await recycleBin.listBin(USER);
        const listing = calls.find((call) => call.name === "project.findMany")?.args as {
            where: Record<string, unknown>;
        };
        expect(listing.where.OR).toEqual([{ ownerId: USER }, { orgId: { in: [ORG] } }]);
        const services = calls.find((call) => call.name === "application.findMany")?.args as {
            where: { environment: { project: Record<string, unknown> } };
        };
        expect(services.where.environment.project).toEqual({
            OR: [{ ownerId: USER }, { orgId: { in: [ORG] } }],
            binnedAt: null
        });
    });

    it("lists only the user's own items without an organization", async () => {
        await recycleBin.listBin(USER);
        const listing = calls.find((call) => call.name === "project.findMany")?.args as {
            where: Record<string, unknown>;
        };
        expect(listing.where.OR).toEqual([{ ownerId: USER }]);
    });

    it("deletes an organization's project with its owner's id", async () => {
        orgsRun = [ORG];
        projectRow = { ownerId: OWNER };
        await recycleBin.deleteForever("project", PROJECT, USER);
        const check = calls.find((call) => call.name === "project.findFirst")?.args as {
            where: Record<string, unknown>;
        };
        expect(check.where).toMatchObject({
            id: PROJECT,
            binnedAt: { not: null },
            OR: [{ ownerId: USER }, { orgId: { in: [ORG] } }]
        });
        expect(deleteProject).toHaveBeenCalledWith(PROJECT, OWNER);
    });

    it("refuses an item the user cannot manage", async () => {
        await expect(recycleBin.restoreFromBin("project", PROJECT, USER, USER)).rejects.toThrow(
            "no longer in the recycle bin"
        );
        await expect(recycleBin.deleteForever("application", PROJECT, USER)).rejects.toThrow(
            "no longer in the recycle bin"
        );
        expect(deleteProject).not.toHaveBeenCalled();
    });
});
