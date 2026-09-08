/**
 * Running the instance is not an invitation into everybody's private lists.
 *
 * Tasks used to hand an instance administrator every space in the deployment, so
 * opening Tasks meant finding every account's personal workspace mixed in with
 * your own - a privacy failure and an unusable screen, from a switch nobody
 * turned on.
 *
 * The two halves are asserted together, because dropping the first without
 * keeping the second would lock an operator out of the instance they run: what
 * an admin is LISTED is now the same as anybody else, and what an admin may READ
 * when they follow a link to a space is still everything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const taskSpace = { findMany: vi.fn(), findUnique: vi.fn() };
const taskFolderMember = { findMany: vi.fn() };
const taskFolderTeam = { findMany: vi.fn() };
const taskFolder = { findMany: vi.fn() };
const taskList = { findMany: vi.fn() };

vi.mock("@polaris/db", () => ({
    prisma: {
        taskSpace,
        taskFolderMember,
        taskFolderTeam,
        taskFolder,
        taskList,
        // Nothing is shared here: a grant is the last way in, and answering
        // empty keeps each case about the narrowing it is actually pinning.
        accessGrant: { findMany: async () => [] },
        teamMember: { findMany: async () => [] },
        organizationMember: { findMany: async () => [] },
        orgRole: { findMany: async () => [] }
    }
}));
vi.mock("@polaris/auth", () => ({
    canOn: vi.fn(async () => false),
    grantedResourceIds: vi.fn(async () => ({ ids: [], all: false }))
}));
vi.mock("@/lib/orgs/org-service", () => ({
    administeredOrgIds: vi.fn(async () => []),
    memberOrgIds: vi.fn(async () => []),
    // Read by the grant resolver, which is a sixth way in and answers nothing
    // here: these cases are about what an administrator is LISTED, not shared.
    teamIdsFor: vi.fn(async () => [])
}));

const access = await import("@/lib/tasks/access");

const ADMIN = { id: "admin-1", isAdmin: true };

beforeEach(() => {
    for (const model of [taskSpace, taskFolderMember, taskFolderTeam, taskFolder, taskList]) {
        for (const method of Object.values(model)) (method as ReturnType<typeof vi.fn>).mockReset();
    }
    taskFolderMember.findMany.mockResolvedValue([]);
    taskFolderTeam.findMany.mockResolvedValue([]);
    taskFolder.findMany.mockResolvedValue([]);
    taskList.findMany.mockResolvedValue([]);
});

describe("what an administrator is shown", () => {
    it("asks the same narrowed question anybody else's account asks", async () => {
        taskSpace.findMany.mockResolvedValue([{ id: "their-own" }]);

        const scope = await access.visibleScope(ADMIN);

        expect(scope.spaceIds).toEqual(["their-own"]);
        // The failure this exists to stop: one unconditional query for every
        // space in the deployment.
        const where = taskSpace.findMany.mock.calls[0]?.[0]?.where;
        expect(where.OR).toBeTruthy();
        expect(where.OR).toContainEqual({ ownerId: ADMIN.id });
    });

    it("does not reach a personal space belonging to somebody else", async () => {
        // The query is what decides this, so the stub answers it honestly: a
        // space owned by another account, internal to nobody, matches no branch
        // of that OR and never comes back.
        taskSpace.findMany.mockResolvedValue([]);

        const scope = await access.visibleScope(ADMIN);

        expect(scope.spaceIds).toEqual([]);
        expect(scope.partialSpaceIds).toEqual([]);
    });
});

describe("what an administrator may still open", () => {
    it("reads as the owner of a space they were sent a link to", async () => {
        // Nobody who runs the instance can be locked out of it - the change is
        // about what appears unasked, not about what may be reached on purpose.
        taskSpace.findUnique.mockResolvedValue({
            id: "someone-elses",
            ownerId: "someone-else",
            orgId: null,
            visibility: "private",
            members: [],
            teamGrants: []
        });

        await expect(access.resolveSpaceRole(ADMIN, "someone-elses")).resolves.toBe("owner");
    });
});
