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
const listFindMany = vi.fn(async () => [] as { id: string; spaceId: string; folderId: string | null }[]);
const spaceFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const folderFindMany = vi.fn(async () => [] as { id: string; parentId: string | null }[]);
const folderMemberFindMany = vi.fn(
    async () => [] as { folderId: string; role: string; folder?: { spaceId: string } }[]
);
const folderTeamFindMany = vi.fn(
    async () => [] as { folderId: string; role: string; folder?: { spaceId: string } }[]
);

vi.mock("@polaris/db", () => ({
    prisma: {
        task: { findMany: taskFindMany },
        taskList: { findMany: listFindMany },
        taskSpace: { findUnique: spaceFindUnique },
        taskFolder: { findMany: folderFindMany },
        taskFolderMember: { findMany: folderMemberFindMany },
        taskFolderTeam: { findMany: folderTeamFindMany }
    }
}));

const { writableTasks } = await import("../../src/lib/tasks/access");

/** One task per list, so a case is written by naming the lists it spans. */
function showing(lists: { id: string; spaceId: string; folderId?: string | null }[]) {
    taskFindMany.mockResolvedValueOnce(
        lists.map((list) => ({ id: `t-${list.id}`, listId: list.id, spaceId: list.spaceId }))
    );
    listFindMany.mockResolvedValueOnce(lists.map((list) => ({ ...list, folderId: list.folderId ?? null })));
}

/** A personal space, which is what these cases are about: no organization, and
 *  no team holding it. The two empty lists are what the query selects. */
function space(visibility: string, members: { role: string }[], ownerId = "someone-else") {
    return { ownerId, visibility, members, orgId: null, teamGrants: [], org: null };
}

describe("the tasks in a set somebody may write", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        folderFindMany.mockResolvedValue([]);
        folderMemberFindMany.mockResolvedValue([]);
        folderTeamFindMany.mockResolvedValue([]);
    });

    it("refuses a reader who only reaches the space because it is internal", async () => {
        showing([{ id: "l1", spaceId: SPACE }]);
        spaceFindUnique.mockResolvedValue(space("internal", []));

        expect(await writableTasks(READER, ["t-l1"], "member")).toEqual([]);
    });

    it("clears a member of the space", async () => {
        showing([{ id: "l1", spaceId: SPACE }]);
        spaceFindUnique.mockResolvedValue(space("internal", [{ role: "member" }]));

        expect(await writableTasks(READER, ["t-l1"], "member")).toEqual([{ id: "t-l1", spaceId: SPACE }]);
    });

    it("drops the tasks in the spaces they only read and keeps the rest", async () => {
        showing([
            { id: "l1", spaceId: SPACE },
            { id: "l2", spaceId: OTHER }
        ]);
        spaceFindUnique.mockImplementation(async (args: unknown) => {
            const { where } = args as { where: { id: string } };
            return where.id === SPACE ? space("private", [{ role: "member" }]) : space("internal", []);
        });

        expect(await writableTasks(READER, ["t-l1", "t-l2"], "member")).toEqual([{ id: "t-l1", spaceId: SPACE }]);
    });

    it("counts a folder grant that reaches the list, and only up to what it gives", async () => {
        spaceFindUnique.mockResolvedValue(space("private", []));
        folderFindMany.mockResolvedValue([{ id: "f1", parentId: null }]);
        folderMemberFindMany.mockResolvedValue([{ folderId: "f1", role: "guest" }]);

        showing([{ id: "l1", spaceId: SPACE, folderId: "f1" }]);
        expect(await writableTasks(READER, ["t-l1"], "member")).toEqual([]);

        folderMemberFindMany.mockResolvedValue([{ folderId: "f1", role: "member" }]);
        showing([{ id: "l1", spaceId: SPACE, folderId: "f1" }]);
        expect(await writableTasks(READER, ["t-l1"], "member")).toEqual([{ id: "t-l1", spaceId: SPACE }]);
    });

    it("asks the database nothing when it was handed nothing", async () => {
        expect(await writableTasks(READER, [], "member")).toEqual([]);
        expect(taskFindMany).not.toHaveBeenCalled();
    });
});
