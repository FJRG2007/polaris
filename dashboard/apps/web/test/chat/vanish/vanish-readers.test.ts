/**
 * Starred messages and a thread's head follow the same disappearing rules as
 * the conversation: nothing expired, nothing the reader deleted for
 * themselves, nothing from before they cleared the chat. Run against the real
 * visibility module.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { matches, type StoredMessage } from "./support/message-store";

let rows: StoredMessage[] = [];
let clearedAt: Date | null = null;

function message(id: string, extra: Partial<StoredMessage> = {}): StoredMessage {
    return {
        id,
        channelId: "c1",
        createdAt: new Date("2026-11-16T10:00:00Z"),
        expiresAt: null,
        parentId: null,
        hiddenFor: [],
        ...extra
    };
}

/** A row as the readers select it. */
function full(row: StoredMessage) {
    return {
        ...row,
        authorId: "ada",
        body: row.id,
        deletedAt: null,
        editedAt: null,
        kind: "text",
        replyCount: 0,
        lastReplyAt: null,
        replyToId: null,
        forwarded: false
    };
}

type Where = Record<string, unknown>;
const pick = (where: Where) => rows.filter((row) => matches(row, where)).map(full);

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: { findUnique: async () => null },
        chatMessage: {
            findMany: async ({ where }: { where: Where }) => pick(where),
            findFirst: async ({ where }: { where: Where }) => pick(where)[0] ?? null,
            findUnique: async ({ where }: { where: { id: string } }) =>
                pick({ id: where.id })[0] ?? null
        },
        chatReaction: { findMany: async () => [] },
        chatAttachment: { findMany: async () => [] },
        // The starred list reads through the star; decorating a page asks
        // which of its messages are starred, which answers nothing here.
        chatStar: {
            findMany: async ({ where }: { where: { message?: Where } }) =>
                where.message ? pick(where.message).map((row) => ({ message: row })) : []
        },
        contactName: { findMany: async () => [] },
        userBlock: { findMany: async () => [] },
        chatChannel: { findUnique: async () => ({ kind: "dm" }), findMany: async () => [] },
        chatChannelMember: {
            findUnique: async () => null,
            findMany: async ({ where }: { where: { clearedAt?: unknown } }) =>
                where.clearedAt && clearedAt ? [{ channelId: "c1", clearedAt }] : []
        },
        user: { findMany: async () => [] }
    }
}));
vi.mock("@/lib/chat/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/chat/access")>()),
    requireChannel: async (_actor: unknown, channelId: string) => ({
        channelId,
        spaceId: null,
        kind: "dm",
        archived: false,
        member: true,
        mayPost: true,
        mayAdminister: false,
        mayModerate: false
    }),
    reachableChannelIds: async () => new Set(["c1"])
}));
vi.mock("@/lib/chat/chat-lock", () => ({
    concealedFor: async () => ({ locked: new Set(), hidden: new Set() }),
    requireUnlocked: async () => undefined,
    unhideOnMessage: async () => undefined
}));
vi.mock("@/lib/chat/age-gate", () => ({
    ageClearedWhere: () => ({}),
    requireAgeCleared: async () => undefined
}));
vi.mock("@/lib/privacy-service", () => ({
    receiptsBetween: async () => null,
    receiptsAmong: async () => new Map(),
    maySee: async () => true,
    allowedBy: async (_viewer: unknown, _field: string, ids: readonly string[]) => new Set(ids)
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/rules", () => ({ rulesForChannel: async () => ({ keepEditHistory: false }) }));
vi.mock("@/lib/chat/link-preview", () => ({
    knownPreviews: async () => new Map(),
    unfurl: async () => undefined
}));
vi.mock("@polaris/auth", () => ({ can: async () => true }));

const { readThread, starred } = await import("@/lib/chat/messages");
const reader = { id: "grace" };
const ids = (list: readonly { id: string }[]) => list.map((one) => one.id);

beforeEach(() => {
    clearedAt = null;
    rows = [];
});

describe("starred messages", () => {
    it("leave out what expired, what the reader deleted and what they cleared", async () => {
        rows = [
            message("kept", { createdAt: new Date("2026-11-16T11:30:00Z") }),
            message("expired", {
                createdAt: new Date("2026-11-16T11:30:00Z"),
                expiresAt: new Date("2026-11-16T11:45:00Z")
            }),
            message("hidden", { createdAt: new Date("2026-11-16T11:30:00Z"), hiddenFor: ["grace"] }),
            message("cleared", { createdAt: new Date("2026-11-16T10:00:00Z") })
        ];
        clearedAt = new Date("2026-11-16T11:00:00Z");
        expect(ids(await starred(reader))).toEqual(["kept"]);
    });
});

describe("a thread's head", () => {
    const reply = (extra: Partial<StoredMessage> = {}) =>
        message("reply", { parentId: "root", createdAt: new Date("2026-11-16T11:50:00Z"), ...extra });

    it("opens the thread while the root is readable", async () => {
        rows = [message("root"), reply()];
        expect(ids(await readThread(reader, "root"))).toEqual(["root", "reply"]);
    });
    it("closes it once the root expired, even with no floor", async () => {
        rows = [message("root", { expiresAt: new Date("2000-01-01T00:00:00Z") }), reply()];
        expect(await readThread(reader, "reply")).toEqual([]);
    });
    it("closes it once the reader deleted the root for themselves", async () => {
        rows = [message("root", { hiddenFor: ["grace"] }), reply()];
        expect(await readThread(reader, "root")).toEqual([]);
    });
    it("closes it when the root is from before they cleared the chat", async () => {
        rows = [message("root"), reply()];
        clearedAt = new Date("2026-11-16T11:00:00Z");
        expect(await readThread(reader, "reply")).toEqual([]);
    });
});
