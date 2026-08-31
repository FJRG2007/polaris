/**
 * Who reaches a project and to do what.
 *
 * The cases worth pinning are the ones a role could not express before: an entry
 * that reaches somebody through a team rather than by name, one that lapses, one
 * that names only some of the project's environments, and two entries that both
 * reach the same person - where the answer has to be the wider of them, not
 * whichever row came back first.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const projectFindUnique = vi.fn();
const memberFindMany = vi.fn();
const environmentFindUnique = vi.fn();
const applicationFindUnique = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        project: { findUnique: projectFindUnique, findMany: vi.fn() },
        projectMember: { findMany: memberFindMany },
        environment: { findUnique: environmentFindUnique },
        application: { findUnique: applicationFindUnique },
        managedDatabase: { findUnique: vi.fn() },
        domain: { findUnique: vi.fn() },
        deployment: { findUnique: vi.fn() }
    }
}));

// Resource grants and organizations answer "nothing here" throughout: this file
// is about the entries on the project, and the paths behind them have their own.
vi.mock("@polaris/auth", () => ({
    canOn: async () => false,
    grantedResourceIds: async () => ({ ids: [], everyOne: false })
}));

const teamIdsFor = vi.fn(async () => [] as string[]);
const memberOrgIds = vi.fn(async () => [] as string[]);

vi.mock("@/lib/orgs/org-service", () => ({
    teamIdsFor: (userId: string) => teamIdsFor(userId),
    memberOrgIds: (userId: string) => memberOrgIds(userId),
    orgIdsWhere: async () => [],
    orgCan: () => false,
    resolveOrgAccess: async () => null
}));

const {
    accessCan,
    accessInEnvironment,
    projectAccess,
    requireApplicationAccess,
    requireProjectAccess
} = await import("../../src/lib/deploy-project-access");

const PROJECT = { id: "project-1", ownerId: "owner-1", orgId: null, visibility: "private" };

/** One stored entry, in the shape the resolver reads. */
function entry(
    capabilities: string[],
    options: { environments?: string[] | null } = {}
): { capabilities: string; environments: string | null } {
    return {
        capabilities: JSON.stringify(capabilities),
        environments: options.environments ? JSON.stringify(options.environments) : null
    };
}

describe("projectAccess", () => {
    beforeEach(() => {
        projectFindUnique.mockReset();
        memberFindMany.mockReset();
        teamIdsFor.mockClear();
        memberOrgIds.mockClear();
        projectFindUnique.mockResolvedValue(PROJECT);
        memberFindMany.mockResolvedValue([]);
    });

    it("gives the owner everything, in every environment", async () => {
        const access = await projectAccess("project-1", "owner-1");
        expect(access?.isOwner).toBe(true);
        expect(access?.environmentIds).toBeNull();
        expect(accessCan(access!, "members.manage")).toBe(true);
    });

    it("says nothing at all about somebody with no entry on a private project", async () => {
        expect(await projectAccess("project-1", "stranger")).toBeNull();
    });

    it("carries the capabilities the entry was written with", async () => {
        memberFindMany.mockResolvedValue([entry(["project.read", "logs.read", "deploy.run"])]);
        const access = await projectAccess("project-1", "helper");
        expect(accessCan(access!, "deploy.run")).toBe(true);
        // The whole point of the granular set: shipping the service without
        // reading what it is configured with.
        expect(accessCan(access!, "variables.read")).toBe(false);
        expect(accessCan(access!, "console.use")).toBe(false);
    });

    it("names the role a stored set came from, and calls a hand-built one custom", async () => {
        memberFindMany.mockResolvedValue([entry(["project.read", "logs.read"])]);
        expect((await projectAccess("project-1", "helper"))?.role).toBe("viewer");

        memberFindMany.mockResolvedValue([entry(["project.read", "logs.read", "deploy.run"])]);
        expect((await projectAccess("project-1", "helper"))?.role).toBe("custom");
    });

    it("unions two entries rather than letting the narrower one win", async () => {
        memberFindMany.mockResolvedValue([
            entry(["project.read", "logs.read"], { environments: ["env-dev"] }),
            entry(["project.read", "variables.read"])
        ]);
        const access = await projectAccess("project-1", "helper");
        expect(accessCan(access!, "variables.read")).toBe(true);
        // One unrestricted entry makes the access unrestricted; the environment
        // list on the other one cannot take back what it never granted.
        expect(access?.environmentIds).toBeNull();
    });

    it("keeps an entry to the environments it names", async () => {
        memberFindMany.mockResolvedValue([
            entry(["project.read", "logs.read", "deploy.run"], { environments: ["env-dev"] })
        ]);
        const access = await projectAccess("project-1", "helper");
        expect(access?.environmentIds).toEqual(["env-dev"]);
        expect(accessInEnvironment(access!, "env-dev")).toBe(true);
        expect(accessInEnvironment(access!, "env-prod")).toBe(false);
    });

    it("asks for entries that have not lapsed, and for the ones reaching this person", async () => {
        teamIdsFor.mockResolvedValueOnce(["team-1"]);
        memberOrgIds.mockResolvedValueOnce(["org-1"]);
        await projectAccess("project-1", "helper");
        const where = memberFindMany.mock.calls[0]?.[0]?.where;
        expect(where.projectId).toBe("project-1");
        const [unexpired, principals] = where.AND;
        expect(unexpired.OR[0]).toEqual({ expiresAt: null });
        expect(principals.OR).toEqual([
            { userId: "helper" },
            { teamId: { in: ["team-1"] } },
            { orgId: { in: ["org-1"] } },
            { userId: null, teamId: null, orgId: null }
        ]);
    });

    it("reads an unreadable stored set as nothing rather than as everything", async () => {
        memberFindMany.mockResolvedValue([{ capabilities: "not json", environments: null }]);
        const access = await projectAccess("project-1", "helper");
        expect(access?.capabilities).toEqual([]);
        expect(accessCan(access!, "project.read")).toBe(false);
    });

    it("lets anyone read an internal project, and no more than read it", async () => {
        projectFindUnique.mockResolvedValue({ ...PROJECT, visibility: "internal" });
        const access = await projectAccess("project-1", "anybody");
        expect(accessCan(access!, "project.read")).toBe(true);
        expect(accessCan(access!, "deploy.run")).toBe(false);
    });
});

describe("requireProjectAccess", () => {
    beforeEach(() => {
        projectFindUnique.mockReset();
        memberFindMany.mockReset();
        projectFindUnique.mockResolvedValue(PROJECT);
        memberFindMany.mockResolvedValue([entry(["project.read", "logs.read"])]);
    });

    it("answers the same way for a project that is not there and one that is not theirs", async () => {
        await expect(requireProjectAccess("project-1", "helper", "deploy.run")).rejects.toThrow(
            /project not found/i
        );
        projectFindUnique.mockResolvedValue(null);
        await expect(requireProjectAccess("project-1", "helper", "project.read")).rejects.toThrow(
            /project not found/i
        );
    });

    it("hands back the project owner, so the caller acts on the owner's resources", async () => {
        const access = await requireProjectAccess("project-1", "helper", "project.read");
        expect(access.ownerId).toBe("owner-1");
    });
});

describe("requireApplicationAccess", () => {
    beforeEach(() => {
        projectFindUnique.mockReset();
        memberFindMany.mockReset();
        applicationFindUnique.mockReset();
        projectFindUnique.mockResolvedValue(PROJECT);
        applicationFindUnique.mockResolvedValue({
            environmentId: "env-prod",
            environment: { projectId: "project-1" }
        });
    });

    it("refuses a service in an environment the entry does not name", async () => {
        memberFindMany.mockResolvedValue([
            entry(["project.read", "logs.read", "deploy.run"], { environments: ["env-dev"] })
        ]);
        await expect(requireApplicationAccess("app-1", "helper", "deploy.run")).rejects.toThrow(
            /service not found/i
        );
    });

    it("allows one in an environment it does", async () => {
        memberFindMany.mockResolvedValue([
            entry(["project.read", "logs.read", "deploy.run"], { environments: ["env-prod"] })
        ]);
        const access = await requireApplicationAccess("app-1", "helper", "deploy.run");
        expect(access.environmentId).toBe("env-prod");
        expect(access.ownerId).toBe("owner-1");
    });
});
