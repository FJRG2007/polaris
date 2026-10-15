/**
 * The recycle bin per owner: a stored policy is read back safely, the purge
 * applies each owner's own retention, and an owner with the bin off has a delete
 * remove things for good at once. The database and the deploy services are fakes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "00000000-0000-7000-8000-0000000000aa";
const ORG = "00000000-0000-7000-8000-0000000000cc";
const OTHER_USER = "00000000-0000-7000-8000-0000000000ee";
const PROJECT = "00000000-0000-7000-8000-0000000000dd";
const APP = "00000000-0000-7000-8000-0000000000a1";
const DB = "00000000-0000-7000-8000-0000000000d1";

const calls: { readonly name: string; readonly args: unknown }[] = [];
let settings: Record<string, string> = {};
let respond: (name: string, args: unknown) => unknown = () => null;

const prisma = new Proxy(
    {},
    {
        get: (_, model: string) =>
            new Proxy(
                {},
                {
                    get: (__, method: string) => async (args: unknown) => {
                        const name = `${model}.${method}`;
                        calls.push({ name, args });
                        if (name === "setting.findMany")
                            return Object.entries(settings).map(([key, value]) => ({
                                key,
                                value
                            }));
                        const answer = respond(name, args);
                        if (answer !== undefined && answer !== null) return answer;
                        return method === "findMany" ? [] : null;
                    }
                }
            )
    }
);

const deleteProject = vi.fn(async () => undefined);
const deleteApplication = vi.fn(async () => undefined);
const deleteDatabase = vi.fn(async () => undefined);

vi.mock("@polaris/db", () => ({ prisma, INCLUDING_BINNED: { binnedAt: undefined } }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings[key] ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) delete settings[key];
        else settings[key] = value;
    }
}));
vi.mock("@/lib/restore-points/service", () => ({
    capture: async () => undefined,
    listRestorePoints: async () => [],
    restoreKeys: { routes: (id: string) => id }
}));
vi.mock("@/lib/orgs/org-service", () => ({
    orgIdsWhere: async () => [],
    memberOrgIds: async () => [],
    orgCan: () => false,
    resolveOrgAccess: async () => null,
    teamIdsFor: async () => []
}));
vi.mock("@/lib/deploy-service", () => ({
    deleteProject,
    deleteApplication,
    syncAppRoutes: async () => undefined,
    removeApplicationDeployment: async () => undefined
}));
vi.mock("@/lib/database-service", () => ({
    deleteDatabase,
    stopDatabaseForBin: async () => undefined
}));

const recycleBin = await import("@/lib/deploy/recycle-bin");

const DAY = 86_400_000;
const NOW = new Date("2026-10-15T12:00:00Z");

beforeEach(() => {
    calls.length = 0;
    settings = {};
    respond = () => null;
    deleteProject.mockClear();
    deleteApplication.mockClear();
    deleteDatabase.mockClear();
});

describe("reading a stored policy", () => {
    const fallback = { enabled: true, days: 30 };

    it("falls back when nothing was chosen or the value is unreadable", () => {
        expect(recycleBin.parseBinPolicy(null, fallback)).toEqual(fallback);
        expect(recycleBin.parseBinPolicy("not json", fallback)).toEqual(fallback);
        expect(recycleBin.parseBinPolicy('{"enabled":true,"days":0}', fallback)).toEqual(fallback);
        expect(recycleBin.parseBinPolicy('{"enabled":true,"days":366}', fallback)).toEqual(
            fallback
        );
        expect(recycleBin.parseBinPolicy('{"days":7}', fallback)).toEqual(fallback);
    });

    it("reads back what was stored", () => {
        expect(recycleBin.parseBinPolicy('{"enabled":false,"days":7}', fallback)).toEqual({
            enabled: false,
            days: 7
        });
    });

    it("defaults to on, for the instance's old number of days", async () => {
        expect(await recycleBin.binPolicyFor({ orgId: null, userId: USER })).toEqual({
            enabled: true,
            days: 30
        });
        settings[recycleBin.BIN_RETENTION_KEY] = "14";
        expect(await recycleBin.binPolicyFor({ orgId: ORG, userId: USER })).toEqual({
            enabled: true,
            days: 14
        });
    });

    it("keeps an organization's policy apart from the person's", async () => {
        await recycleBin.setBinPolicy({ orgId: ORG, userId: USER }, { enabled: false, days: 5 });
        expect(await recycleBin.binPolicyFor({ orgId: ORG, userId: OTHER_USER })).toEqual({
            enabled: false,
            days: 5
        });
        expect(await recycleBin.binPolicyFor({ orgId: null, userId: USER })).toEqual({
            enabled: true,
            days: 30
        });
    });

    it("refuses a policy outside 1 to 365 days", async () => {
        await expect(
            recycleBin.setBinPolicy({ orgId: null, userId: USER }, { enabled: true, days: 0 })
        ).rejects.toThrow();
        await expect(
            recycleBin.setBinPolicy({ orgId: null, userId: USER }, { enabled: true, days: 400 })
        ).rejects.toThrow();
    });
});

describe("retention groups", () => {
    it("groups owners by days and leaves the rest to the default", () => {
        const groups = recycleBin.retentionGroups(
            [
                { key: `deploy.recycleBin.org.${ORG}`, value: '{"enabled":true,"days":7}' },
                { key: `deploy.recycleBin.user.${USER}`, value: '{"enabled":false,"days":7}' },
                { key: `deploy.recycleBin.user.${OTHER_USER}`, value: '{"enabled":true,"days":90}' }
            ],
            { enabled: true, days: 30 }
        );
        expect(groups).toEqual([
            {
                days: 7,
                project: {
                    OR: [{ orgId: { in: [ORG] } }, { orgId: null, ownerId: { in: [USER] } }]
                }
            },
            { days: 90, project: { OR: [{ orgId: null, ownerId: { in: [OTHER_USER] } }] } },
            {
                days: 30,
                project: {
                    NOT: [
                        { orgId: { in: [ORG] } },
                        { orgId: null, ownerId: { in: [USER, OTHER_USER] } }
                    ]
                }
            }
        ]);
    });

    it("is only the default when nobody chose", () => {
        expect(recycleBin.retentionGroups([], { enabled: true, days: 30 })).toEqual([
            { days: 30, project: {} }
        ]);
    });
});

describe("the scheduled purge", () => {
    it("asks each retention for what is past its own cutoff, bounded", async () => {
        settings[`deploy.recycleBin.org.${ORG}`] = '{"enabled":true,"days":3}';
        await recycleBin.purgeRecycleBin(NOW);
        const projectReads = calls
            .filter((call) => call.name === "project.findMany")
            .map((call) => call.args as { where: { binnedAt: { lt: Date } }; take: number });
        expect(projectReads.map((read) => read.where.binnedAt.lt.getTime())).toEqual([
            NOW.getTime() - 3 * DAY,
            NOW.getTime() - 30 * DAY
        ]);
        for (const read of projectReads) expect(read.take).toBeLessThanOrEqual(10);
        const orgRead = projectReads[0]?.where as unknown as Record<string, unknown>;
        expect(orgRead.OR).toEqual([{ orgId: { in: [ORG] } }]);
        const restRead = projectReads[1]?.where as unknown as Record<string, unknown>;
        expect(restRead.NOT).toEqual([{ orgId: { in: [ORG] } }]);
    });

    it("deletes for good what one owner's retention has run out on", async () => {
        settings[`deploy.recycleBin.org.${ORG}`] = '{"enabled":true,"days":3}';
        respond = (name, args) => {
            const where = (args as { where?: Record<string, unknown> }).where ?? {};
            if (name === "project.findMany" && "OR" in where)
                return [{ id: PROJECT, ownerId: USER }];
            if (name === "project.findFirst") return { ownerId: USER };
            return null;
        };
        expect(await recycleBin.purgeRecycleBin(NOW)).toEqual({ purged: 1 });
        expect(deleteProject).toHaveBeenCalledWith(PROJECT, USER);
    });
});

describe("deleting with the bin off", () => {
    beforeEach(() => {
        settings[`deploy.recycleBin.user.${USER}`] = '{"enabled":false,"days":30}';
        respond = (name) => {
            if (name === "project.findFirst") return { id: PROJECT, ownerId: USER, orgId: null };
            if (name === "application.findFirst")
                return { id: APP, environment: { projectId: PROJECT } };
            if (name === "managedDatabase.findFirst")
                return { id: DB, parentId: null, environment: { projectId: PROJECT } };
            return null;
        };
    });

    const binned = () =>
        calls.filter(
            (call) =>
                call.name.endsWith(".update") &&
                (call.args as { data?: { binnedAt?: unknown } }).data?.binnedAt
        );

    it("removes a project for good", async () => {
        await recycleBin.binProject(PROJECT, USER, USER);
        expect(deleteProject).toHaveBeenCalledWith(PROJECT, USER);
        expect(binned()).toEqual([]);
    });

    it("removes a service for good, data included", async () => {
        await recycleBin.binApplication(APP, USER, USER);
        expect(deleteApplication).toHaveBeenCalledWith(APP, USER, { deleteData: true });
        expect(binned()).toEqual([]);
    });

    it("removes a database for good", async () => {
        await recycleBin.binDatabase(DB, USER, USER);
        expect(deleteDatabase).toHaveBeenCalledWith(DB, USER);
        expect(binned()).toEqual([]);
    });

    it("still bins when the owner keeps a bin", async () => {
        settings[`deploy.recycleBin.user.${USER}`] = '{"enabled":true,"days":30}';
        await recycleBin.binApplication(APP, USER, USER);
        expect(deleteApplication).not.toHaveBeenCalled();
        expect(binned().map((call) => call.name)).toEqual(["application.update"]);
    });
});
