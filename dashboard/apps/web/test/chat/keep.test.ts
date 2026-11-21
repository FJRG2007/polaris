/**
 * Keep in chat (ledger row 9): who may keep a disappearing message, that a
 * kept one stops expiring and gets its timer back when the last keep goes,
 * that its author can take every keep back or forbid keeping, and that the
 * instance policy and a group's owner-only switch are honoured.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const FUTURE = new Date(Date.now() + 60_000);

interface Message {
    channelId: string;
    authorId: string | null;
    deletedAt: Date | null;
    audience: string[];
    expiresAt: Date | null;
    keptExpiresAt: Date | null;
    keepable: boolean;
    channel: { spaceId: string | null; ownerId: string | null; membersMayKeep: boolean };
}

let message: Message;
let keeps: Set<string>;
let policy: string | null;
let access: Record<string, unknown>;
const notices: string[] = [];

const db = {
    chatMessage: {
        findUnique: vi.fn(async () => ({ ...message })),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Message> }) => {
            if ("keepable" in where && where.keepable !== message.keepable) return { count: 0 };
            if ("keptExpiresAt" in where && where.keptExpiresAt !== message.keptExpiresAt) return { count: 0 };
            Object.assign(message, data);
            return { count: 1 };
        }),
        update: vi.fn(async ({ data }: { data: Partial<Message> }) => Object.assign(message, data))
    },
    chatMessageKeep: {
        createMany: vi.fn(async ({ data }: { data: { userId: string }[] }) => {
            const had = keeps.has(data[0].userId);
            keeps.add(data[0].userId);
            return { count: had ? 0 : 1 };
        }),
        deleteMany: vi.fn(async ({ where }: { where: { userId?: string } }) => {
            if (where.userId) return { count: keeps.delete(where.userId) ? 1 : 0 };
            const count = keeps.size;
            keeps.clear();
            return { count };
        }),
        count: vi.fn(async () => keeps.size),
        findMany: vi.fn(async () => [...keeps].filter((id) => id === "me").map(() => ({ messageId: "m1" })))
    },
    chatChannel: {
        findMany: vi.fn(async () => [{ id: "c1", ...message.channel }])
    },
    user: { findUnique: vi.fn(async () => ({ name: "Grace" })) },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(db))
};

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => policy), setSetting: vi.fn() }));
vi.mock("@/lib/chat/access", async () => {
    class ChatAccessError extends Error {
        constructor(readonly text: { key: string } = { key: "errors.notFound" }) {
            super(text.key);
        }
    }
    class ChatRuleError extends ChatAccessError {}
    return {
        ChatAccessError,
        ChatRuleError,
        requireChannel: vi.fn(async () => access),
        channelAccess: vi.fn(async () => access)
    };
});
vi.mock("@/lib/chat/history-visibility", () => ({ requireReadable: vi.fn(async () => undefined) }));
vi.mock("@/lib/chat/notices", () => ({
    postNoticeBody: vi.fn(async (_channelId: string, body: string) => {
        notices.push(body);
    })
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: vi.fn() }));

const keep = await import("@/lib/chat/keep");
const me = { id: "me", name: "Me" };
const author = { id: "author", name: "Ada" };

beforeEach(() => {
    message = {
        channelId: "c1",
        authorId: "author",
        deletedAt: null,
        audience: [],
        expiresAt: FUTURE,
        keptExpiresAt: null,
        keepable: true,
        channel: { spaceId: null, ownerId: "owner", membersMayKeep: true }
    };
    keeps = new Set();
    policy = null;
    access = { spaceId: null, member: true, mayAdminister: false, archived: false };
    notices.length = 0;
});

describe("keep in chat", () => {
    it("stops a kept message expiring and says who kept it", async () => {
        await keep.keepMessage(me, "m1");
        expect(message.expiresAt).toBeNull();
        expect(message.keptExpiresAt).toEqual(FUTURE);
        expect(keeps.has("me")).toBe(true);
        expect(notices[0]).toContain("kept a message");
    });

    it("says nothing the second time the same person keeps it", async () => {
        await keep.keepMessage(me, "m1");
        await keep.keepMessage(me, "m1");
        expect(notices).toHaveLength(1);
    });

    it("refuses a message that does not disappear", async () => {
        message.expiresAt = null;
        await expect(keep.keepMessage(me, "m1")).rejects.toThrow("errors.keepNotDisappearing");
    });

    it("refuses when its author forbade keeping", async () => {
        message.keepable = false;
        await expect(keep.keepMessage(me, "m1")).rejects.toThrow("errors.keepNotAllowed");
        expect(message.expiresAt).toEqual(FUTURE);
    });

    it("refuses everywhere when the instance forbids keeping", async () => {
        policy = JSON.stringify({ keep: "forbidden" });
        await expect(keep.keepMessage(me, "m1")).rejects.toThrow("errors.keepNotAllowed");
    });

    it("refuses a one-reader message", async () => {
        message.audience = ["me"];
        await expect(keep.keepMessage(me, "m1")).rejects.toThrow("errors.keepNotAllowed");
    });

    it("keeps it to the owner in a group whose owner said so", async () => {
        message.channel.membersMayKeep = false;
        await expect(keep.keepMessage(me, "m1")).rejects.toThrow("errors.keepAdminsOnly");
        await keep.keepMessage({ id: "owner", name: "Owner" }, "m1");
        expect(keeps.has("owner")).toBe(true);
    });

    it("puts the timer back when the last keep goes, not before", async () => {
        await keep.keepMessage(me, "m1");
        await keep.keepMessage({ id: "other", name: "Other" }, "m1");
        await keep.unkeepMessage(me, "m1");
        expect(message.expiresAt).toBeNull();
        await keep.unkeepMessage({ id: "other", name: "Other" }, "m1");
        expect(message.expiresAt).toEqual(FUTURE);
        expect(message.keptExpiresAt).toBeNull();
    });

    it("lets its author take every keep back at once", async () => {
        await keep.keepMessage(me, "m1");
        await keep.keepMessage({ id: "other", name: "Other" }, "m1");
        await keep.unkeepMessage(author, "m1");
        expect(keeps.size).toBe(0);
        expect(message.expiresAt).toEqual(FUTURE);
        expect(notices.at(-1)).toContain("unkept their message");
    });

    it("forbidding keeping releases the keeps, and only its author may", async () => {
        await keep.keepMessage(me, "m1");
        await expect(keep.setKeepable(me, "m1", false)).rejects.toThrow("errors.keepNotAllowed");
        await keep.setKeepable(author, "m1", false);
        expect(message.keepable).toBe(false);
        expect(keeps.size).toBe(0);
        expect(message.expiresAt).toEqual(FUTURE);
    });

    it("offers keeping only where the reader may", async () => {
        const row = { id: "m1", channelId: "c1", expiresAt: FUTURE, keptExpiresAt: null, keepable: true, deletedAt: null, audience: [] };
        expect((await keep.keepStates(me, [row])).get("m1")).toEqual({ kept: false, keptByMe: false, mayKeep: true });
        expect((await keep.keepStates(me, [{ ...row, keepable: false }])).get("m1")?.mayKeep).toBe(false);
        expect((await keep.keepStates(me, [{ ...row, expiresAt: null }])).size).toBe(0);
        policy = JSON.stringify({ keep: "forbidden" });
        expect((await keep.keepStates(me, [row])).get("m1")?.mayKeep).toBe(false);
    });
});

describe("moderation policy", () => {
    it("reads a missing or broken row as the defaults", async () => {
        const { readModerationPolicy, DEFAULT_MODERATION_POLICY } = await import("@/lib/chat/moderation-policy-rules");
        expect(readModerationPolicy(null)).toEqual(DEFAULT_MODERATION_POLICY);
        expect(readModerationPolicy("{not json")).toEqual(DEFAULT_MODERATION_POLICY);
        expect(readModerationPolicy(JSON.stringify({ keep: "forbidden", autoDownload: "bogus" }))).toEqual({
            ...DEFAULT_MODERATION_POLICY,
            keep: "forbidden"
        });
    });
});
