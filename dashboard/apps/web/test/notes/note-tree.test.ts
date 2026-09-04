/**
 * The tree the sidebar is drawn from, and the moves that are refused.
 *
 * Three things are worth pinning down. The order: depth-first from the top, with
 * pinned-first applied among siblings rather than globally, because a pinned
 * child hoisted above its own parent would be a tree that lies about itself. The
 * refusals: a note put inside its own subtree is cut off from the tree for good,
 * which is the one edit here that loses data. And where a nested note lives -
 * its parent's folder, always, because two ways of filing one thing means there
 * is no answer to where it is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    title: string;
    body: string;
    pinned: boolean;
    parentId: string | null;
    folderId: string | null;
    spaceId: string | null;
    archived: boolean;
    updatedAt: Date;
}

let rows: Row[] = [];
let folders: { id: string; spaceId: string | null }[] = [];
const update = vi.fn(async (_args: unknown) => ({ count: 1 }));
const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));

vi.mock("@polaris/db", () => ({
    prisma: {
        // The service sends its writes through a transaction, and what the tests
        // assert is that a refusal never reached one.
        $transaction: async (entries: unknown[]) => entries,
        note: {
            findMany: async (args: {
                where: { archived?: boolean; spaceId?: string | null };
                orderBy?: unknown;
            }): Promise<Row[]> => {
                const wanted = rows.filter(
                    (row) =>
                        (args.where.archived === undefined || row.archived === args.where.archived) &&
                        (args.where.spaceId === undefined || row.spaceId === args.where.spaceId)
                );
                // The real query orders by pinned then updatedAt; the service
                // relies on that, so the double must honour it.
                return [...wanted].sort(
                    (left, right) =>
                        Number(right.pinned) - Number(left.pinned) ||
                        right.updatedAt.getTime() - left.updatedAt.getTime()
                );
            },
            findUnique: async (args: { where: { id: string } }) =>
                rows.find((row) => row.id === args.where.id) ?? null,
            update,
            updateMany
        },
        noteFolder: {
            findUnique: async (args: { where: { id: string } }) =>
                folders.find((folder) => folder.id === args.where.id) ?? null
        }
    }
}));

const notes = await import("../../src/lib/notes/note-service");

const own = { userId: "u1", spaceId: null };

function row(id: string, parentId: string | null, extra: Partial<Row> = {}): Row {
    return {
        id,
        title: id,
        body: "",
        pinned: false,
        parentId,
        folderId: null,
        spaceId: null,
        archived: false,
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        ...extra
    };
}

/** A move as the action sends one: every destination named together. */
const move = (noteId: string, parentId: string | null, extra: Partial<{ spaceId: string | null; folderId: string | null }> = {}) =>
    notes.moveNote("u1", { noteId, parentId, spaceId: null, folderId: null, ...extra });

beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
    folders = [];
});

describe("the notes tree", () => {
    it("draws children under their parent, however recently they were touched", async () => {
        rows = [
            row("a", null, { updatedAt: new Date("2026-08-01T00:00:00.000Z") }),
            row("a-child", "a", { updatedAt: new Date("2026-08-09T00:00:00.000Z") }),
            row("b", null, { updatedAt: new Date("2026-08-05T00:00:00.000Z") })
        ];

        const tree = await notes.listNotes(own);

        expect(tree.map((entry) => entry.id)).toEqual(["b", "a", "a-child"]);
        expect(tree.map((entry) => entry.depth)).toEqual([0, 0, 1]);
    });

    it("pins within a level rather than across the whole tree", async () => {
        rows = [row("a", null), row("a-child", "a", { pinned: true }), row("b", null)];

        const tree = await notes.listNotes(own);

        expect(tree[0]!.id).not.toBe("a-child");
        expect(tree.find((entry) => entry.id === "a-child")!.depth).toBe(1);
    });

    it("marks what can be opened", async () => {
        rows = [row("a", null), row("a-child", "a")];

        const tree = await notes.listNotes(own);

        expect(tree.find((entry) => entry.id === "a")!.hasChildren).toBe(true);
        expect(tree.find((entry) => entry.id === "a-child")!.hasChildren).toBe(false);
    });

    it("keeps a note whose parent was archived, at the top level", async () => {
        rows = [row("a", null, { archived: true }), row("a-child", "a")];

        const tree = await notes.listNotes(own);

        expect(tree).toHaveLength(1);
        expect(tree[0]!.id).toBe("a-child");
        expect(tree[0]!.depth).toBe(0);
        expect(tree[0]!.parentId).toBeNull();
    });

    it("shows one shelf and not another", async () => {
        // The private shelf is the one filtered by the account; a notebook's is
        // filtered by the notebook, because a colleague's note on a shared shelf
        // is the point of the shared shelf.
        rows = [row("mine", null), row("theirs", null, { spaceId: "s1" })];

        expect((await notes.listNotes(own)).map((entry) => entry.id)).toEqual(["mine"]);
        expect(
            (await notes.listNotes({ userId: "u1", spaceId: "s1" })).map((entry) => entry.id)
        ).toEqual(["theirs"]);
    });
});

describe("moving a note", () => {
    it("refuses to put one inside itself", async () => {
        rows = [row("a", null)];

        expect(await move("a", "a")).toBe("A note cannot go inside itself");
        expect(update).not.toHaveBeenCalled();
    });

    it("refuses to put one inside its own descendant", async () => {
        rows = [row("a", null), row("b", "a"), row("c", "b")];

        expect(await move("a", "c")).toBe("A note cannot go inside itself");
        expect(update).not.toHaveBeenCalled();
    });

    it("refuses a move that would push the subtree past the depth limit", async () => {
        // A chain four deep, moved under a note already three deep, would end at
        // seven - past what the sidebar can indent.
        rows = [
            row("p1", null),
            row("p2", "p1"),
            row("p3", "p2"),
            row("m1", null),
            row("m2", "m1"),
            row("m3", "m2")
        ];

        expect(await move("m1", "p3")).toBe("That would nest notes too deeply");
        expect(update).not.toHaveBeenCalled();
    });

    it("allows a move that fits, and out to the top level", async () => {
        rows = [row("a", null), row("b", null)];

        expect(await move("b", "a")).toBeNull();
        expect(await move("b", null)).toBeNull();
        expect(update).toHaveBeenCalledTimes(2);
    });

    it("refuses a note that is not on this shelf", async () => {
        rows = [row("a", null)];

        expect(await move("stranger", "a")).toBe("That note no longer exists");
        expect(await move("a", "stranger")).toBe("That note no longer exists");
    });

    it("files a nested note where its parent is, whatever was asked for", async () => {
        // Two ways of filing one thing would let a note be in a folder and under
        // a parent filed somewhere else, and then there is no answer to where it
        // is. The parent wins.
        rows = [row("a", null, { folderId: "f1" }), row("b", null)];
        folders = [{ id: "f2", spaceId: null }];

        expect(await move("b", "a", { folderId: "f2" })).toBeNull();
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ folderId: "f1" }) })
        );
    });

    it("refuses a folder that is on another notebook", async () => {
        rows = [row("a", null)];
        folders = [{ id: "f1", spaceId: "s1" }];

        expect(await move("a", null, { folderId: "f1" })).toBe(
            "That folder is on a different notebook"
        );
        expect(update).not.toHaveBeenCalled();
    });

    it("takes the subtree along when a note changes shelf", async () => {
        rows = [row("a", null), row("a-child", "a"), row("a-grandchild", "a-child")];

        expect(await move("a", null, { spaceId: "s1" })).toBeNull();
        expect(updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ["a-child", "a-grandchild"] } },
                data: { spaceId: "s1", folderId: null }
            })
        );
    });
});
