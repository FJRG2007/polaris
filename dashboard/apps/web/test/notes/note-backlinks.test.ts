/**
 * Backlinks: the index a save keeps, and who the list is read for.
 *
 * Two things matter. The index follows the body - a link removed from the text
 * is gone from the index on the next save, a link to a note that does not exist
 * writes nothing, and a note never links to itself. And reading it never widens
 * access: the query a reader gets names only their own private shelf, the
 * spaces they reach and the notes shared with them by name.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "0190a1b2-c3d4-7e5f-8a9b-00000000000a";
const B = "0190a1b2-c3d4-7e5f-8a9b-00000000000b";
const C = "0190a1b2-c3d4-7e5f-8a9b-00000000000c";
const GONE = "0190a1b2-c3d4-7e5f-8a9b-0000000000ff";

let notes: { id: string }[] = [];
let links: { sourceId: string; targetId: string }[] = [];
const findMany = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        $transaction: async (entries: unknown[]) => Promise.all(entries),
        note: { findMany: (args: unknown) => findMany(args) },
        noteLink: {
            deleteMany: async (args: { where: { sourceId: string; targetId?: { notIn: string[] } } }) => {
                const keep = args.where.targetId?.notIn;
                links = links.filter(
                    (link) =>
                        link.sourceId !== args.where.sourceId || (keep !== undefined && keep.includes(link.targetId))
                );
                return { count: 0 };
            },
            createMany: async (args: { data: { sourceId: string; targetId: string }[] }) => {
                for (const row of args.data) {
                    if (!links.some((link) => link.sourceId === row.sourceId && link.targetId === row.targetId))
                        links.push(row);
                }
                return { count: args.data.length };
            }
        }
    }
}));

vi.mock("@/lib/notes/access", () => ({
    visibleSpaceIds: async () => ["space-1"]
}));

vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: async () => new Map([[C, "view"]])
}));

const { syncNoteLinks, indexNoteLinks, listBacklinks } = await import("@/lib/notes/link-service");

const ref = (id: string) => `[note](polaris:note/${id})`;

beforeEach(() => {
    notes = [{ id: A }, { id: B }, { id: C }];
    links = [];
    findMany.mockReset();
    findMany.mockImplementation(async (args: { where: { id?: { in: string[] } } }) =>
        notes.filter((note) => args.where.id?.in.includes(note.id))
    );
});

describe("the index a save keeps", () => {
    it("writes the notes the body links to, and only ones that exist", async () => {
        await syncNoteLinks(A, `${ref(B)} ${ref(GONE)} ${ref(C)}`);
        expect(links).toEqual([
            { sourceId: A, targetId: B },
            { sourceId: A, targetId: C }
        ]);
    });

    it("drops a link that left the text", async () => {
        await syncNoteLinks(A, `${ref(B)} ${ref(C)}`);
        await syncNoteLinks(A, ref(C));
        expect(links).toEqual([{ sourceId: A, targetId: C }]);
    });

    it("clears every link when the body has none", async () => {
        await syncNoteLinks(A, ref(B));
        await syncNoteLinks(A, "plain text");
        expect(links).toEqual([]);
        // Nothing to look up, so no query was spent on it.
        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("never indexes a note linking to itself", async () => {
        await syncNoteLinks(A, ref(A));
        expect(links).toEqual([]);
    });

    it("leaves other notes' links alone", async () => {
        await syncNoteLinks(B, ref(C));
        await syncNoteLinks(A, "");
        expect(links).toEqual([{ sourceId: B, targetId: C }]);
    });

    it("indexes an import in one pass", async () => {
        await indexNoteLinks([
            { id: A, body: ref(B) },
            { id: B, body: `${ref(A)} ${ref(GONE)}` },
            { id: C, body: "nothing" }
        ]);
        expect(links).toEqual([
            { sourceId: A, targetId: B },
            { sourceId: B, targetId: A }
        ]);
        expect(findMany).toHaveBeenCalledTimes(1);
    });
});

describe("who the list is read for", () => {
    it("asks only for notes the reader could open, unarchived, bounded", async () => {
        findMany.mockResolvedValueOnce([{ id: B, title: "Linking", updatedAt: new Date(0) }]);
        const result = await listBacklinks({ id: "user-1", isAdmin: false }, A);
        expect(result).toEqual([{ id: B, title: "Linking", updatedAt: new Date(0).toISOString() }]);
        const args = findMany.mock.calls[0]![0];
        expect(args.where.archived).toBe(false);
        expect(args.where.linksOut).toEqual({ some: { targetId: A } });
        expect(args.where.OR).toEqual([
            { spaceId: null, userId: "user-1" },
            { spaceId: { in: ["space-1"] } },
            { id: { in: [C] } }
        ]);
        expect(args.take).toBeGreaterThan(0);
    });
});
