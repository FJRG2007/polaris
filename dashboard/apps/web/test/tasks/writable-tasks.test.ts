/**
 * Which of the tasks a screen sends may actually be changed.
 *
 * The cross-space screens hand a write whatever ids they were showing, so being
 * able to see work must not be what clears the write: an internal space is
 * readable by everybody the instance trusts, and reading it makes a guest.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const READER = { id: "u1", isAdmin: false };
const SPACE = "s1";
const OTHER = "s2";

const taskFindMany = vi.fn(async () => [] as { id: string; listId: string; spaceId: string }[]);
const listFindMany = vi.fn(
    async () => [] as { id: string; spaceId: string; folderId: string | null }[]
);
const spaceFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const folderFindMany = vi.fn(async () => [] as { id: string; parentId: string | null }[]);
// What the share dialog handed the reader, per space and per folder. The older
// membership tables are not read any more: a grant is the only way a person or
// a team is given a space or one branch of it.
const spaceGrants = new Map<string, string>();
const folderGrants = new Map<string, string>();
vi.mock("@/lib/access/grants", () => ({
    grantedCapability: async (_user: string, _subject: string, id: string) =>
        spaceGrants.get(id) ?? null,
    grantedSubjects: async (_user: string, subject: string) =>
        subject === "task.folder" ? new Map(folderGrants) : new Map(spaceGrants)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        // Nothing is shared with anybody in these cases: a grant is the last
        // way in and is asked about only when every other has said no, so it
        // answers empty and each case stays about the way in it is pinning.
        accessGrant: { findMany: async () => [] },
        teamMember: { findMany: async () => [] },
        organizationMember: { findMany: async () => [] },
        orgRole: { findMany: async () => [] },
        task: { findMany: taskFindMany },
        taskList: { findMany: listFindMany },
        taskSpace: { findUnique: spaceFindUnique },
        taskFolder: { findMany: folderFindMany }
    }
}));

// Access written for one space alone is a fifth way in, resolved in @polaris/auth
// against tables these cases do not set up. Answering "none" keeps each case about
// the way in it is actually pinning: membership, a team, or the organization.
vi.mock("@polaris/auth", () => ({
    canOn: async () => false,
    grantedResourceIds: async () => ({ ids: [], everyOne: false })
}));

const { writableTasks } = await import("../../src/lib/tasks/access");

/** One task per list, so a case is written by naming the lists it spans. */
function showing(lists: { id: string; spaceId: string; folderId?: string | null }[]) {
    taskFindMany.mockResolvedValueOnce(
        lists.map((list) => ({ id: `t-${list.id}`, listId: list.id, spaceId: list.spaceId }))
    );
    listFindMany.mockResolvedValueOnce(
        lists.map((list) => ({ ...list, folderId: list.folderId ?? null }))
    );
}

/** A personal space, which is what these cases are about: no organization.
 *  `role` is what the share dialog handed the reader on it, if anything. */
function space(visibility: string, role: string | null, ownerId = "someone-else", id = SPACE) {
    if (role) spaceGrants.set(id, role);
    else spaceGrants.delete(id);
    return { ownerId, visibility, orgId: null, org: null };
}

describe("the tasks in a set somebody may write", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        folderFindMany.mockResolvedValue([]);
        spaceGrants.clear();
        folderGrants.clear();
    });

    it("refuses a reader who only reaches the space because it is internal", async () => {
        showing([{ id: "l1", spaceId: SPACE }]);
        spaceFindUnique.mockResolvedValue(space("internal", null));

        expect(await writableTasks(READER, ["t-l1"], "member")).toEqual([]);
    });

    it("clears a member of the space", async () => {
        showing([{ id: "l1", spaceId: SPACE }]);
        spaceFindUnique.mockResolvedValue(space("internal", "member"));

        expect(await writableTasks(READER, ["t-l1"], "member")).toEqual([
            { id: "t-l1", spaceId: SPACE }
        ]);
    });

    it("drops the tasks in the spaces they only read and keeps the rest", async () => {
        showing([
            { id: "l1", spaceId: SPACE },
            { id: "l2", spaceId: OTHER }
        ]);
        spaceFindUnique.mockImplementation(async (args: unknown) => {
            const { where } = args as { where: { id: string } };
            return where.id === SPACE
                ? space("private", "member")
                : space("internal", null, "someone-else", OTHER);
        });

        expect(await writableTasks(READER, ["t-l1", "t-l2"], "member")).toEqual([
            { id: "t-l1", spaceId: SPACE }
        ]);
    });

    it("counts a folder grant that reaches the list, and only up to what it gives", async () => {
        spaceFindUnique.mockResolvedValue(space("private", null));
        folderFindMany.mockResolvedValue([{ id: "f1", parentId: null }]);
        folderGrants.set("f1", "guest");

        showing([{ id: "l1", spaceId: SPACE, folderId: "f1" }]);
        expect(await writableTasks(READER, ["t-l1"], "member")).toEqual([]);

        folderGrants.set("f1", "member");
        showing([{ id: "l1", spaceId: SPACE, folderId: "f1" }]);
        expect(await writableTasks(READER, ["t-l1"], "member")).toEqual([
            { id: "t-l1", spaceId: SPACE }
        ]);
    });

    it("asks the database nothing when it was handed nothing", async () => {
        expect(await writableTasks(READER, [], "member")).toEqual([]);
        expect(taskFindMany).not.toHaveBeenCalled();
    });
});
