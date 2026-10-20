/**
 * Branch into new chat: the new conversation holds exactly the path that ends
 * at the chosen message - not the other versions along the way - in order,
 * under new ids, and only the owner can branch a thread.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";

type Row = { id: string; parentId: string | null; role: string; parts: unknown; metadata: unknown };

const state = {
    rows: [] as Row[],
    createdThread: null as Record<string, unknown> | null,
    createdMessages: [] as Record<string, unknown>[],
    temporary: false
};

vi.mock("@/lib/polar/attachments", () => ({
    keepSharedAttachments: async () => [],
    linkPolarAttachments: async () => undefined,
    threadAttachments: async () => [],
    discardPolarAttachments: async () => undefined
}));
vi.mock("@polaris/db", () => {
    const tx = {
        polarThread: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                state.createdThread = data;
                return {
                    id: data.id,
                    title: data.title,
                    updatedAt: new Date(0),
                    pinnedAt: null,
                    archivedAt: null,
                    projectId: data.projectId ?? null
                };
            }
        },
        polarMessage: {
            createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
                state.createdMessages = data;
                return { count: data.length };
            }
        }
    };
    return {
        Prisma: {},
        prisma: {
            $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
            polarThread: {
                findFirst: async ({
                    where
                }: {
                    where: { id: string; userId: string; temporary?: boolean };
                }) =>
                    where.id === THREAD &&
                    where.userId === OWNER &&
                    where.temporary === state.temporary
                        ? {
                              title: "Trip",
                              titleSource: "model",
                              choice: null,
                              projectId: null,
                              branchRootId: null
                          }
                        : null
            },
            polarMessage: { findMany: async () => [...state.rows].reverse() }
        }
    };
});

const { branchPolarThread } = await import("@/lib/polar/threads");

const row = (id: string, parentId: string | null, role = "user"): Row => ({
    id,
    parentId,
    role,
    parts: [{ type: "text", text: id }],
    metadata: null
});

beforeEach(() => {
    // a -> b -> c, with b2 a second version of b that c does not follow.
    state.rows = [row("a", null), row("b", "a", "assistant"), row("b2", "a", "assistant"), row("c", "b")];
    state.createdThread = null;
    state.createdMessages = [];
    state.temporary = false;
});

describe("branchPolarThread", () => {
    it("copies the path to the message, in order, chained under new ids", async () => {
        const thread = await branchPolarThread(OWNER, THREAD, "c");
        expect(thread?.title).toBe("Trip");
        const copied = state.createdMessages;
        expect(copied.map((entry) => (entry.parts as { text: string }[])[0]!.text)).toEqual([
            "a",
            "b",
            "c"
        ]);
        expect(copied.every((entry) => !["a", "b", "c"].includes(entry.id as string))).toBe(true);
        expect(copied[0]!.parentId).toBeNull();
        expect(copied[1]!.parentId).toBe(copied[0]!.id);
        expect(copied[2]!.parentId).toBe(copied[1]!.id);
        const times = copied.map((entry) => (entry.createdAt as Date).getTime());
        expect(times).toEqual([...times].sort((x, y) => x - y));
        expect(new Set(times).size).toBe(3);
        expect(copied.every((entry) => entry.threadId === thread?.id)).toBe(true);
        expect(state.createdThread?.branchRootId).toBe(THREAD);
    });

    it("stops at the message branched from", async () => {
        await branchPolarThread(OWNER, THREAD, "b2");
        expect(state.createdMessages.map((entry) => (entry.parts as { text: string }[])[0]!.text)).toEqual([
            "a",
            "b2"
        ]);
    });

    it("refuses another person's thread and a message not in it", async () => {
        expect(await branchPolarThread("someone-else", THREAD, "c")).toBeNull();
        expect(await branchPolarThread(OWNER, THREAD, "missing")).toBeNull();
        expect(state.createdThread).toBeNull();
    });

    it("refuses a temporary chat, which a branch would keep", async () => {
        state.temporary = true;
        expect(await branchPolarThread(OWNER, THREAD, "c")).toBeNull();
        expect(state.createdThread).toBeNull();
    });
});
