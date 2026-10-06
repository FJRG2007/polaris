/**
 * The chat tools, called the way an MCP client calls them.
 *
 * The messaging layer is tested on its own; what is pinned here is the
 * boundary: a key without `chat.use` is refused before a conversation is read,
 * a message goes through the same `send` as the composer's as the key's own
 * account, the chat's refusal reaches the model as written, and reading hands
 * back a compact page with a cursor to go further back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    class ChatAccessError extends Error {}
    return { ChatAccessError, listChannels: vi.fn(), readChannel: vi.fn(), send: vi.fn() };
});

vi.mock("@polaris/db", () => ({ prisma: {} }));
// The rest of the catalogue loads with these tools; its operations are not under test here.
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/chat/access", () => ({ ChatAccessError: mocks.ChatAccessError }));
vi.mock("@/lib/chat/chat-service", () => ({ listChannels: mocks.listChannels }));
vi.mock("@/lib/chat/messages", () => ({ readChannel: mocks.readChannel, send: mocks.send }));

const { CHAT_TOOLS } = await import("@/lib/mcp/tools/chat");
const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const SERVER = { name: "polaris", version: "1", instructions: "" };
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const REPLY_TO = "44444444-4444-4444-8444-444444444444";

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

function call(name: string, args: Record<string, unknown>, scopes: string[] = ["chat.use"]) {
    return handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        MCP_TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, keyId: "key-1" },
        SERVER
    );
}

function message(index: number, extra: Record<string, unknown> = {}) {
    return {
        id: `m-${index}`,
        channelId: CHANNEL,
        authorId: "user-2",
        authorName: "Ada",
        kind: "text",
        body: `message ${index}`,
        parentId: null,
        replyCount: 0,
        lastReplyAt: null,
        edited: false,
        deleted: false,
        reactions: [],
        attachments: [],
        poll: null,
        quote: null,
        starred: false,
        blocked: false,
        mentionsYou: false,
        references: [],
        createdAt: `2026-10-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        ...extra
    };
}

function channel(index: number, unread: number) {
    return {
        id: `c-${index}`,
        spaceId: null,
        categoryId: null,
        kind: "text",
        name: index === 0 ? "general" : `room-${index}`,
        topic: "",
        private: false,
        archived: false,
        lastMessageAt: null,
        unread,
        muted: false,
        mayAdminister: true,
        ownerId: "user-9",
        others: []
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("the chat tools", () => {
    it("are all in the catalogue, reads before writes, each asking for chat.use", () => {
        const names = MCP_TOOLS.map((tool) => tool.name);
        for (const tool of CHAT_TOOLS) {
            expect(names).toContain(tool.name);
            expect(tool.scope, tool.name).toBe("chat.use");
        }
        expect(CHAT_TOOLS.map((tool) => tool.readOnly)).toEqual([true, true, false]);
    });

    it("refuse a key without chat.use before reaching the conversation", async () => {
        const result = (
            await call("chat_send", { conversationId: CHANNEL, body: "hi" }, ["notes.use"])
        )?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("chat.use");
        expect(mocks.send).not.toHaveBeenCalled();
    });

    it("reject arguments of the wrong shape", async () => {
        expect(
            (await call("chat_send", { conversationId: CHANNEL, body: "   " }))?.error?.code
        ).toBe(-32602);
        expect(
            (await call("chat_send", { conversationId: "general", body: "hi" }))?.error?.code
        ).toBe(-32602);
        expect(
            (await call("chat_messages", { conversationId: CHANNEL, limit: 51 }))?.error?.code
        ).toBe(-32602);
        expect(mocks.send).not.toHaveBeenCalled();
        expect(mocks.readChannel).not.toHaveBeenCalled();
    });

    it("send through the composer's own path, as the key's account", async () => {
        mocks.send.mockResolvedValue("m-new");
        const result = (
            await call("chat_send", {
                conversationId: CHANNEL,
                body: "on my way",
                replyToId: REPLY_TO
            })
        )?.result as ToolResult;
        expect(mocks.send).toHaveBeenCalledWith(
            { id: "user-1" },
            expect.objectContaining({ channelId: CHANNEL, body: "on my way", replyToId: REPLY_TO }),
            [],
            { messageId: REPLY_TO, forwarded: false }
        );
        expect(result.structuredContent).toEqual({ id: "m-new" });
    });

    it("pass the chat's refusal to the model as written", async () => {
        mocks.send.mockRejectedValue(
            new mocks.ChatAccessError("You are not in that conversation.")
        );
        const result = (await call("chat_send", { conversationId: CHANNEL, body: "hi" }))
            ?.result as ToolResult;
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe("You are not in that conversation.");
    });

    it("read the newest messages with a cursor to the ones before", async () => {
        mocks.readChannel.mockResolvedValue({
            messages: Array.from({ length: 50 }, (_, index) =>
                message(index, index === 49 ? { blocked: true, body: "something rude" } : {})
            ),
            olderThan: "m-0"
        });
        const result = (await call("chat_messages", { conversationId: CHANNEL, limit: 5 }))
            ?.result as ToolResult;
        expect(mocks.readChannel).toHaveBeenCalledWith({ id: "user-1" }, CHANNEL, undefined);
        const rows = result.structuredContent.messages;
        expect(rows.map((row: { id: string }) => row.id)).toEqual([
            "m-45",
            "m-46",
            "m-47",
            "m-48",
            "m-49"
        ]);
        expect(result.structuredContent.olderThan).toBe("m-45");
        // What somebody this account blocked wrote is not handed to the model.
        expect(rows[4].body).toBe("");
        expect(result.content[0]?.text).not.toContain("something rude");
        expect(rows[0]).not.toHaveProperty("reactions");
    });

    it("list conversations compactly, a page at a time", async () => {
        mocks.listChannels.mockResolvedValue(
            Array.from({ length: 40 }, (_, index) => channel(index, index % 4 === 0 ? 2 : 0))
        );
        const result = (await call("chat_conversations", { limit: 10 }))?.result as ToolResult;
        expect(mocks.listChannels).toHaveBeenCalledWith({ id: "user-1" });
        expect(result.structuredContent.conversations).toHaveLength(10);
        expect(result.structuredContent.nextOffset).toBe(10);
        expect(result.structuredContent.conversations[0]).not.toHaveProperty("mayAdminister");

        const unread = (await call("chat_conversations", { unreadOnly: true, limit: 100 }))
            ?.result as ToolResult;
        expect(unread.structuredContent.conversations).toHaveLength(10);
        expect(unread.structuredContent.nextOffset).toBeNull();
    });

    it("find a conversation loosely, and list them all when nothing matches", async () => {
        mocks.listChannels.mockResolvedValue([
            channel(0, 0),
            { ...channel(1, 0), name: "Diseño web" },
            channel(2, 0)
        ]);
        const found = (await call("chat_conversations", { query: "diseno" }))?.result as ToolResult;
        expect(found.structuredContent.conversations[0].name).toBe("Diseño web");
        expect(found.structuredContent.matched).toBe(true);

        const none = (await call("chat_conversations", { query: "zebra" }))?.result as ToolResult;
        expect(none.structuredContent.conversations).toHaveLength(3);
        expect(none.structuredContent.matched).toBe(false);
        expect(none.content[0]?.text).toContain(
            'No match for "zebra"; these are all 3 conversations.'
        );
    });
});
