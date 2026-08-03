/**
 * Somewhere to put the first task.
 *
 * A task lives in a list, but a folder is what people work out of, and a folder
 * that holds no list used to answer "make one first". That is an arrangement the
 * person asking for a task should not have to know about, so the list is made
 * where the task was asked for - and only when the container really holds none,
 * because making a second "Tasks" beside an existing list would be worse than
 * the refusal it replaced.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SPACE = "018f2b7a-0000-7000-8000-0000000000c1";
const FOLDER = "018f2b7a-0000-7000-8000-0000000000f1";
const CHILD = "018f2b7a-0000-7000-8000-0000000000f2";

const listFindMany = vi.fn(async () => [] as { id: string; name: string }[]);
const listFindFirst = vi.fn(async () => null as { order: number } | null);
const listCreate = vi.fn(async () => ({ id: "made" }));
const folderFindMany = vi.fn(async () => [
    { id: FOLDER, parentId: null },
    { id: CHILD, parentId: FOLDER }
]);
const folderFindUnique = vi.fn(async () => ({ spaceId: SPACE }));

vi.mock("@polaris/db", () => ({
    prisma: {
        taskList: { findMany: listFindMany, findFirst: listFindFirst, create: listCreate },
        taskFolder: { findMany: folderFindMany, findUnique: folderFindUnique }
    }
}));

const { ensureList } = await import("../../src/lib/tasks/space-service");

/** What the action hands the service: a validated list input carrying the name a
 *  container's first list gets. */
function input(folderId: string | null) {
    return core.listSchema.parse({ spaceId: SPACE, folderId, name: core.DEFAULT_LIST_NAME });
}

describe("the list a task goes into", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listFindMany.mockResolvedValue([]);
    });

    it("makes one named Tasks when the folder holds none", async () => {
        const list = await ensureList(input(FOLDER));

        expect(listCreate).toHaveBeenCalledTimes(1);
        expect(listCreate.mock.calls[0]?.[0]).toMatchObject({
            data: { spaceId: SPACE, folderId: FOLDER, name: core.DEFAULT_LIST_NAME }
        });
        expect(list).toEqual({ id: "made", name: core.DEFAULT_LIST_NAME });
    });

    it("uses the list already there instead of making a second one", async () => {
        listFindMany.mockResolvedValue([{ id: "l1", name: "Backlog" }]);

        const list = await ensureList(input(FOLDER));

        expect(listCreate).not.toHaveBeenCalled();
        expect(list).toEqual({ id: "l1", name: "Backlog" });
    });

    it("counts the lists in the folders below, which the folder's tasks also reach", async () => {
        await ensureList(input(FOLDER));

        expect(listFindMany.mock.calls[0]?.[0]).toMatchObject({
            where: { spaceId: SPACE, archived: false, folderId: { in: [FOLDER, CHILD] } }
        });
    });

    it("makes it at the space root when that is where the task was asked for", async () => {
        const list = await ensureList(input(null));

        expect(listCreate.mock.calls[0]?.[0]).toMatchObject({ data: { folderId: null } });
        expect(list.name).toBe(core.DEFAULT_LIST_NAME);
    });
});
