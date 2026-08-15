/**
 * The tree the sidebar is drawn from, and the moves that are refused.
 *
 * Two things are worth pinning down. The order: depth-first from the top, with
 * pinned-first applied among siblings rather than globally, because a pinned
 * child hoisted above its own parent would be a tree that lies about itself.
 * And the refusals: a note put inside its own subtree is cut off from the tree
 * for good, which is the one edit here that loses data.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    title: string;
    body: string;
    pinned: boolean;
    parentId: string | null;
    archived: boolean;
    updatedAt: Date;
}

let rows: Row[] = [];
const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));

vi.mock("@polaris/db", () => ({
    prisma: {
        note: {
            findMany: async (args: {
                where: { archived?: boolean };
                orderBy?: unknown;
            }): Promise<Row[]> => {
                const wanted =
                    args.where.archived === undefined
                        ? rows
                        : rows.filter((row) => row.archived === args.where.archived);
                // The real query orders by pinned then updatedAt; the service
                // relies on that, so the double must honour it.
                return [...wanted].sort(
                    (left, right) =>
                        Number(right.pinned) - Number(left.pinned) ||
                        right.updatedAt.getTime() - left.updatedAt.getTime()
                );
            },
            updateMany
        }
    }
}));

const notes = await import("../../src/lib/notes/note-service");

function row(id: string, parentId: string | null, extra: Partial<Row> = {}): Row {
    return {
        id,
        title: id,
        body: "",
        pinned: false,
        parentId,
        archived: false,
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        ...extra
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    rows = [];
});

describe("the notes tree", () => {
    it("draws children under their parent, however recently they were touched", async () => {
        rows = [
            row("a", null, { updatedAt: new Date("2026-08-01T00:00:00.000Z") }),
            row("a-child", "a", { updatedAt: new Date("2026-08-09T00:00:00.000Z") }),
            row("b", null, { updatedAt: new Date("2026-08-05T00:00:00.000Z") })
        ];

        const tree = await notes.listNotes("u1");

        expect(tree.map((entry) => entry.id)).toEqual(["b", "a", "a-child"]);
        expect(tree.map((entry) => entry.depth)).toEqual([0, 0, 1]);
    });

    it("pins within a level rather than across the whole tree", async () => {
        rows = [row("a", null), row("a-child", "a", { pinned: true }), row("b", null)];

        const tree = await notes.listNotes("u1");

        expect(tree[0]!.id).not.toBe("a-child");
        expect(tree.find((entry) => entry.id === "a-child")!.depth).toBe(1);
    });

    it("marks what can be opened", async () => {
        rows = [row("a", null), row("a-child", "a")];

        const tree = await notes.listNotes("u1");

        expect(tree.find((entry) => entry.id === "a")!.hasChildren).toBe(true);
        expect(tree.find((entry) => entry.id === "a-child")!.hasChildren).toBe(false);
    });

    it("keeps a note whose parent was archived, at the top level", async () => {
        rows = [row("a", null, { archived: true }), row("a-child", "a")];

        const tree = await notes.listNotes("u1");

        expect(tree).toHaveLength(1);
        expect(tree[0]!.id).toBe("a-child");
        expect(tree[0]!.depth).toBe(0);
        expect(tree[0]!.parentId).toBeNull();
    });
});

describe("moving a note", () => {
    it("refuses to put one inside itself", async () => {
        rows = [row("a", null)];

        expect(await notes.moveNote("u1", { noteId: "a", parentId: "a" })).toBe(
            "A note cannot go inside itself"
        );
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("refuses to put one inside its own descendant", async () => {
        rows = [row("a", null), row("b", "a"), row("c", "b")];

        expect(await notes.moveNote("u1", { noteId: "a", parentId: "c" })).toBe(
            "A note cannot go inside itself"
        );
        expect(updateMany).not.toHaveBeenCalled();
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

        expect(await notes.moveNote("u1", { noteId: "m1", parentId: "p3" })).toBe(
            "That would nest notes too deeply"
        );
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("allows a move that fits, and out to the top level", async () => {
        rows = [row("a", null), row("b", null)];

        expect(await notes.moveNote("u1", { noteId: "b", parentId: "a" })).toBeNull();
        expect(await notes.moveNote("u1", { noteId: "b", parentId: null })).toBeNull();
        expect(updateMany).toHaveBeenCalledTimes(2);
    });

    it("refuses a note that is not this account's", async () => {
        rows = [row("a", null)];

        expect(await notes.moveNote("u1", { noteId: "stranger", parentId: "a" })).toBe(
            "That note no longer exists"
        );
        expect(await notes.moveNote("u1", { noteId: "a", parentId: "stranger" })).toBe(
            "That note no longer exists"
        );
    });
});
