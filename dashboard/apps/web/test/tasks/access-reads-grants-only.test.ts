/**
 * Taking somebody off a space or a folder in the share dialog takes their access
 * away.
 *
 * Memberships used to live in TaskSpaceMember / TaskFolderMember /
 * TaskSpaceTeam / TaskFolderTeam. Those rows were copied into AccessGrant and
 * left in place, so the failure to avoid is an old row still opening a space
 * after the grant that replaced it was removed. Here the old tables answer with
 * a row for the reader and the grants answer nothing: the reader must get
 * nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const READER = { id: "u1", isAdmin: false };

const granted = { space: null as string | null, folders: new Map<string, string>() };

const oldRow = vi.fn(async () => [{ folderId: "f1", role: "admin", folder: { spaceId: "s1" } }]);

vi.mock("@polaris/db", () => ({
    prisma: {
        taskSpace: {
            // Answers with the old relations too, as a query that still selected
            // them would see them: none of it may count.
            findUnique: async () => ({
                ownerId: "someone-else",
                visibility: "private",
                orgId: null,
                org: null,
                members: [{ role: "admin" }],
                teamGrants: [{ role: "admin" }]
            }),
            findMany: async () => []
        },
        taskFolder: {
            findUnique: async () => ({ spaceId: "s1", parentId: null }),
            findMany: async () => [{ id: "f1", parentId: null }]
        },
        taskList: { findMany: async () => [] },
        taskSpaceMember: { findMany: oldRow },
        taskFolderMember: { findMany: oldRow },
        taskSpaceTeam: { findMany: oldRow },
        taskFolderTeam: { findMany: oldRow }
    }
}));

vi.mock("@polaris/auth", () => ({
    canOn: async () => false,
    grantedResourceIds: async () => ({ ids: [], everyOne: false })
}));

vi.mock("@/lib/access/grants", () => ({
    grantedCapability: async () => granted.space,
    grantedSubjects: async (_user: string, subject: string) =>
        subject === "task.folder" ? granted.folders : new Map()
}));

vi.mock("@/lib/orgs/org-service", () => ({
    administeredOrgIds: async () => [],
    memberOrgIds: async () => []
}));

vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: async () => null }));

const access = await import("@/lib/tasks/access");

beforeEach(() => {
    granted.space = null;
    granted.folders = new Map();
    oldRow.mockClear();
});

describe("a space", () => {
    it("opens for the role its grant carries", async () => {
        granted.space = "member";
        expect(await access.resolveSpaceRole(READER, "s1")).toBe("member");
    });

    it("is closed once the grant is removed, whatever the old membership row says", async () => {
        expect(await access.resolveSpaceRole(READER, "s1")).toBeNull();
        await expect(access.requireSpace(READER, "s1", "guest")).rejects.toBeInstanceOf(
            access.TaskAccessError
        );
    });
});

describe("a folder", () => {
    it("opens for the role its grant carries", async () => {
        granted.folders = new Map([["f1", "guest"]]);
        expect((await access.requireFolder(READER, "f1", "guest")).role).toBe("guest");
    });

    it("is closed once the grant is removed, and the old tables are not asked", async () => {
        await expect(access.requireFolder(READER, "f1", "guest")).rejects.toBeInstanceOf(
            access.TaskAccessError
        );
        const scope = await access.visibleScope(READER);
        expect(scope.partialSpaceIds).toEqual([]);
        expect(oldRow).not.toHaveBeenCalled();
    });
});
