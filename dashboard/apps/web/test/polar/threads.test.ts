/**
 * Polar's stored conversations: a turn only ever writes into the thread it was
 * sent to, a long thread reopens at its newest messages, and the history the
 * browser sends stays bounded however long the conversation grows.
 */

import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POLAR_SEND_MOST, sendableTail } from "@/lib/polar/shared";

const OWNER = "11111111-1111-4111-8111-111111111111";
const MINE = "22222222-2222-4222-8222-222222222222";
const THEIRS = "33333333-3333-4333-8333-333333333333";

type Message = {
    id: string;
    threadId: string;
    parentId: string | null;
    role: string;
    parts: unknown;
    createdAt: number;
};

const state = {
    threads: [] as { id: string; userId: string }[],
    messages: [] as Message[],
    linked: [] as unknown[][]
};

vi.mock("@/lib/polar/attachments", () => ({
    linkPolarAttachments: async (...args: unknown[]) => void state.linked.push(args),
    threadAttachments: async () => [],
    discardPolarAttachments: async () => undefined
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
        polarThread: {
            count: async ({ where }: { where: { id: string; userId: string } }) =>
                state.threads.filter(
                    (thread) => thread.id === where.id && thread.userId === where.userId
                ).length,
            update: async () => ({}),
            findFirst: async ({
                where,
                select
            }: {
                where: { id: string; userId: string };
                select: { messages: { take: number } };
            }) => {
                const thread = state.threads.find(
                    (entry) => entry.id === where.id && entry.userId === where.userId
                );
                if (!thread) return null;
                const messages = state.messages
                    .filter((message) => message.threadId === thread.id)
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .slice(0, select.messages.take);
                return { id: thread.id, title: "t", choice: null, queue: [], messages };
            }
        },
        polarMessage: {
            createMany: async ({ data }: { data: Omit<Message, "createdAt">[] }) => {
                let count = 0;
                for (const entry of data) {
                    if (state.messages.some((message) => message.id === entry.id)) continue;
                    state.messages.push({ ...entry, createdAt: state.messages.length });
                    count++;
                }
                return { count };
            },
            updateMany: async ({
                where,
                data
            }: {
                where: { id: string; threadId: string };
                data: { parts: unknown };
            }) => {
                const hit = state.messages.filter(
                    (message) => message.id === where.id && message.threadId === where.threadId
                );
                for (const message of hit) message.parts = data.parts;
                return { count: hit.length };
            }
        }
    }
}));

const { getPolarThread, savePolarMessages } = await import("@/lib/polar/threads");

beforeEach(() => {
    state.threads = [
        { id: MINE, userId: OWNER },
        { id: THEIRS, userId: "44444444-4444-4444-8444-444444444444" }
    ];
    state.messages = [];
    state.linked = [];
});

const text = (id: string, role: UIMessage["role"], value: string): UIMessage => ({
    id,
    role,
    parts: [{ type: "text", text: value }]
});

describe("savePolarMessages", () => {
    it("never rewrites a message that belongs to another thread", async () => {
        state.messages.push({
            id: "victim",
            threadId: THEIRS,
            parentId: null,
            role: "user",
            parts: [{ type: "text", text: "theirs" }],
            createdAt: 0
        });
        await savePolarMessages(OWNER, MINE, [text("victim", "user", "overwritten")], () => null);
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0]).toMatchObject({
            threadId: THEIRS,
            parts: [{ type: "text", text: "theirs" }]
        });
    });

    it("adds new messages and rewrites the thread's own in place", async () => {
        await savePolarMessages(OWNER, MINE, [text("u1", "user", "hi")], () => null);
        await savePolarMessages(
            OWNER,
            MINE,
            [text("u1", "user", "hi again"), text("a1", "assistant", "hello")],
            (index) => (index === 1 ? "u1" : null)
        );
        expect(state.messages.map((message) => [message.id, message.parentId])).toEqual([
            ["u1", null],
            ["a1", "u1"]
        ]);
        expect(state.messages[0]?.parts).toEqual([{ type: "text", text: "hi again" }]);
        expect(state.linked).toHaveLength(2);
    });

    it("writes nothing into a thread the caller does not own", async () => {
        await savePolarMessages(OWNER, THEIRS, [text("u1", "user", "hi")], () => null);
        expect(state.messages).toEqual([]);
    });
});

describe("getPolarThread", () => {
    it("reopens a long thread at its newest messages, oldest first", async () => {
        for (let index = 0; index < 510; index++) {
            state.messages.push({
                id: `m${index}`,
                threadId: MINE,
                parentId: index === 0 ? null : `m${index - 1}`,
                role: index % 2 ? "assistant" : "user",
                parts: [],
                createdAt: index
            });
        }
        const thread = await getPolarThread(OWNER, MINE);
        expect(thread?.messages).toHaveLength(500);
        expect(thread?.messages[0]).toMatchObject({ id: "m10", parentId: null });
        expect(thread?.messages[1]).toMatchObject({ id: "m11", parentId: "m10" });
        expect(thread?.messages.at(-1)?.id).toBe("m509");
    });
});

describe("sendableTail", () => {
    it("keeps a short path whole", () => {
        const path = [{ role: "user" }, { role: "assistant" }];
        expect(sendableTail(path)).toEqual(path);
    });

    it("sends only the newest messages of a long path, starting at a question", () => {
        const path = Array.from({ length: 1000 }, (_, index) => ({
            id: index,
            role: index % 2 ? "assistant" : "user"
        }));
        const tail = sendableTail(path);
        expect(tail.length).toBeLessThanOrEqual(POLAR_SEND_MOST);
        expect(tail[0]?.role).toBe("user");
        expect(tail.at(-1)).toBe(path.at(-1));
    });
});
