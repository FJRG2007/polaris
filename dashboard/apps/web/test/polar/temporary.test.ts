/**
 * Temporary chats: a request cannot change a thread's kind, every list leaves
 * them out, and the sweep deletes the ones a day past their last message.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "11111111-1111-4111-8111-111111111111";

const state = {
    existing: null as null | { userId: string; temporary: boolean },
    created: [] as unknown[],
    stale: [] as { id: string; userId: string }[],
    findManyArgs: null as unknown,
    deleted: [] as unknown[]
};

vi.mock("@/lib/polar/attachments", () => ({
    threadAttachments: async () => [],
    discardPolarAttachments: async () => undefined,
    linkPolarAttachments: async () => undefined
}));
vi.mock("@polaris/db", () => ({
    Prisma: { sql: () => "" },
    prisma: {
        polarProject: { count: async () => 1 },
        polarThread: {
            findUnique: async () => state.existing,
            update: async () => undefined,
            create: async (args: unknown) => void state.created.push(args),
            findMany: async (args: unknown) => {
                state.findManyArgs = args;
                return state.stale;
            },
            deleteMany: async (args: unknown) => {
                state.deleted.push(args);
                return { count: 1 };
            }
        }
    }
}));

const threads = await import("@/lib/polar/threads");
const choice = { kind: "language", provider: "openai", model: "m", intelligence: "fast", payer: null } as never;

beforeEach(() => {
    state.existing = null;
    state.created = [];
    state.stale = [];
    state.deleted = [];
});

describe("ensurePolarThread", () => {
    it("makes a new temporary chat outside any project", async () => {
        expect(await threads.ensurePolarThread("u1", ID, "hi", choice, ID, true)).toEqual({
            temporary: true
        });
        expect(state.created[0]).toMatchObject({ data: { temporary: true, projectId: null } });
    });

    it("keeps the stored kind whatever the request says", async () => {
        state.existing = { userId: "u1", temporary: false };
        expect(await threads.ensurePolarThread("u1", ID, "hi", choice, null, true)).toEqual({
            temporary: false
        });
        state.existing = { userId: "u1", temporary: true };
        expect(await threads.ensurePolarThread("u1", ID, "hi", choice)).toEqual({ temporary: true });
    });

    it("answers null for somebody else's id", async () => {
        state.existing = { userId: "u2", temporary: true };
        expect(await threads.ensurePolarThread("u1", ID, "hi", choice)).toBeNull();
    });
});

describe("lists", () => {
    it.each(["recent", "pinned", "archived", "project"] as const)("%s leaves them out", (view) => {
        expect(threads.viewQuery("u1", view, ID).where).toMatchObject({ temporary: false });
    });
});

describe("sweep", () => {
    it("deletes temporary chats idle for a day, each by its owner", async () => {
        state.stale = [
            { id: ID, userId: "u1" },
            { id: "22222222-2222-4222-8222-222222222222", userId: "u2" }
        ];
        const now = new Date("2026-10-20T12:00:00Z");
        expect(await threads.sweepTemporaryPolarThreads(now)).toBe(2);
        expect(state.findManyArgs).toMatchObject({
            where: {
                temporary: true,
                updatedAt: { lt: new Date(now.getTime() - threads.TEMPORARY_TTL_MS) }
            }
        });
        expect(state.deleted).toEqual([
            { where: { id: ID, userId: "u1" } },
            { where: { id: "22222222-2222-4222-8222-222222222222", userId: "u2" } }
        ]);
    });
});
