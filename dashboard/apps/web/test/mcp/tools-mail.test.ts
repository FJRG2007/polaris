/**
 * The mail tools, called the way an MCP client calls them.
 *
 * The mail services are tested on their own (test/mail); what is pinned here
 * is the boundary. Reading and sending are separate scopes and neither opens
 * the other's tools; a mailbox is checked as the caller's own before a list is
 * read from it; what is sent goes through the composer's own schema and the
 * same queue as the screen, from the mailbox's own address; and a refusal the
 * mail layer wrote for the person reaches the model, while anything else does
 * not. Nothing here reaches a mail server.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    class MailAccessError extends Error {}
    return {
        MailAccessError,
        ownedAccount: vi.fn(),
        listAccountViews: vi.fn(),
        listThreads: vi.fn(),
        openMessage: vi.fn(),
        queueSend: vi.fn()
    };
});

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/mailbox/access", () => ({
    MailAccessError: mocks.MailAccessError,
    ownedAccount: mocks.ownedAccount
}));
vi.mock("@/lib/mailbox/shelf", () => ({ EVERY_SHELF: "*" }));
vi.mock("@/lib/mailbox/accounts", () => ({ listAccountViews: mocks.listAccountViews }));
vi.mock("@/lib/mailbox/views", () => ({
    EMPTY_QUERY: { accountId: null, role: null, query: "", cursor: "", limit: 50 },
    listThreads: mocks.listThreads
}));
vi.mock("@/lib/mailbox/open", () => ({ openMessage: mocks.openMessage }));
vi.mock("@/lib/mailbox/compose", () => ({ queueSend: mocks.queueSend }));
vi.mock("@/lib/mailbox/credentials", () => ({ MailAuthError: class extends Error {} }));
vi.mock("@/lib/mailbox/imap", () => ({ MailUnreachableError: class extends Error {} }));

const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const SERVER = { name: "polaris", version: "1", instructions: "" };
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const MESSAGE = "22222222-2222-4222-8222-222222222222";

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

async function call(name: string, args: Record<string, unknown>, scopes: string[]) {
    const reply = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        MCP_TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, grantId: "grant-1" },
        SERVER
    );
    return reply?.result as ToolResult;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.ownedAccount.mockResolvedValue({ id: ACCOUNT });
    mocks.queueSend.mockResolvedValue({
        draftId: "d1",
        sendAt: new Date("2026-10-05T10:00:10.000Z")
    });
});

describe("the mail tools", () => {
    it("keep reading and sending apart", async () => {
        const send = await call(
            "mail_send",
            { accountId: ACCOUNT, to: ["ada@example.test"], body: "Hi" },
            ["mail.read"]
        );
        expect(send.isError).toBe(true);
        expect(send.content[0]?.text).toContain("mail.send");
        const read = await call("mail_read", { messageId: MESSAGE }, ["mail.send"]);
        expect(read.isError).toBe(true);
        expect(mocks.queueSend).not.toHaveBeenCalled();
        expect(mocks.openMessage).not.toHaveBeenCalled();
    });

    it("name the mailboxes to either scope", async () => {
        mocks.listAccountViews.mockResolvedValue([
            { id: ACCOUNT, address: "me@example.test", displayName: "Me", label: "", state: "ok" }
        ]);
        for (const scopes of [["mail.read"], ["mail.send"]]) {
            const result = await call("mail_mailboxes", {}, scopes);
            expect(result.isError).toBeUndefined();
            expect(result.structuredContent.mailboxes[0]).toMatchObject({ id: ACCOUNT });
        }
        expect(mocks.listAccountViews).toHaveBeenCalledWith("user-1", "*");
        expect((await call("mail_mailboxes", {}, ["notes.use"])).isError).toBe(true);
    });

    it("check a mailbox is the caller's before listing it", async () => {
        mocks.ownedAccount.mockRejectedValue(
            new mocks.MailAccessError("That mailbox is not yours.")
        );
        const result = await call("mail_list", { accountId: ACCOUNT }, ["mail.read"]);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toBe("That mailbox is not yours.");
        expect(mocks.ownedAccount).toHaveBeenCalledWith("user-1", ACCOUNT);
        expect(mocks.listThreads).not.toHaveBeenCalled();
    });

    it("list a folder, searched, a page at a time", async () => {
        mocks.listThreads.mockResolvedValue({
            threads: [
                {
                    leadMessageId: MESSAGE,
                    accountId: ACCOUNT,
                    subject: "Lunch",
                    participants: [{ name: "Ada", address: "ada@example.test" }],
                    snippet: "Tomorrow?",
                    unreadCount: 1,
                    messageCount: 2,
                    lastMessageAt: "2026-10-05T09:00:00.000Z"
                }
            ],
            cursor: "next-1"
        });
        const result = await call("mail_list", { query: "from:ada", folder: "inbox", limit: 10 }, [
            "mail.read"
        ]);
        expect(mocks.listThreads).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({ role: "inbox", query: "from:ada", limit: 10, cursor: "" }),
            "*"
        );
        expect(result.structuredContent).toMatchObject({
            nextCursor: "next-1",
            items: [{ messageId: MESSAGE, subject: "Lunch", unread: true }]
        });
        expect(result.content[0]?.text).toContain("cursor next-1");
    });

    it("never answer a search with nothing while the folder has mail", async () => {
        const lunch = {
            leadMessageId: MESSAGE,
            accountId: ACCOUNT,
            subject: "Canción",
            participants: [{ name: "Ada", address: "ada@example.test" }],
            snippet: "Tomorrow?",
            unreadCount: 0,
            messageCount: 1,
            lastMessageAt: "2026-10-05T09:00:00.000Z"
        };
        // The search itself runs in the database; only the folder unsearched
        // has anything in it here.
        mocks.listThreads.mockImplementation(async (_user: string, query: { query: string }) =>
            query.query ? { threads: [], cursor: "" } : { threads: [lunch], cursor: "" }
        );
        const result = await call("mail_list", { query: "zebra", limit: 5 }, ["mail.read"]);
        expect(mocks.listThreads).toHaveBeenLastCalledWith(
            "user-1",
            expect.objectContaining({ query: "", limit: 5, cursor: "" }),
            "*"
        );
        expect(result.structuredContent).toMatchObject({
            matched: false,
            items: [{ messageId: MESSAGE }]
        });
        expect(result.content[0]?.text).toContain(
            'Nothing in inbox matches "zebra"; these are the newest conversations there.'
        );
    });

    it("retry a search without its accents before giving up on it", async () => {
        mocks.listThreads.mockImplementation(async (_user: string, query: { query: string }) =>
            query.query === "Cancion"
                ? {
                      threads: [
                          {
                              leadMessageId: MESSAGE,
                              accountId: ACCOUNT,
                              subject: "Cancion",
                              participants: [],
                              snippet: "",
                              unreadCount: 0,
                              messageCount: 1,
                              lastMessageAt: "2026-10-05T09:00:00.000Z"
                          }
                      ],
                      cursor: ""
                  }
                : { threads: [], cursor: "" }
        );
        const result = await call("mail_list", { query: "Canción" }, ["mail.read"]);
        expect(result.structuredContent).toMatchObject({
            matched: true,
            items: [{ subject: "Cancion" }]
        });
    });

    it("read a message's text, falling back to its markup's words", async () => {
        mocks.openMessage.mockResolvedValue({
            envelope: {
                id: MESSAGE,
                accountId: ACCOUNT,
                subject: "Lunch",
                from: [{ name: "Ada", address: "ada@example.test" }],
                to: [{ name: "", address: "me@example.test" }],
                cc: [],
                sentAt: "2026-10-05T09:00:00.000Z"
            },
            readable: { text: "", html: "<p>See you <b>at noon</b></p>" }
        });
        const result = await call("mail_read", { messageId: MESSAGE }, ["mail.read"]);
        expect(mocks.openMessage).toHaveBeenCalledWith("user-1", MESSAGE);
        expect(result.structuredContent.text).toContain("See you at noon");
        expect(result.content[0]?.text).toContain("From: Ada <ada@example.test>");
    });

    it("say so when a message is gone, and keep what failed inside to the log", async () => {
        mocks.openMessage.mockResolvedValueOnce(null);
        expect(
            (await call("mail_read", { messageId: MESSAGE }, ["mail.read"])).content[0]?.text
        ).toBe("That message is no longer there.");
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mocks.openMessage.mockRejectedValueOnce(new Error("imap.example.test:993 ECONNRESET"));
        const failed = await call("mail_read", { messageId: MESSAGE }, ["mail.read"]);
        expect(failed.content[0]?.text).not.toContain("imap.example.test");
        errors.mockRestore();
    });

    it("send through the composer's schema and the screen's queue, from the mailbox's address", async () => {
        const result = await call(
            "mail_send",
            {
                accountId: ACCOUNT,
                to: [" Ada@Example.Test "],
                subject: "Lunch",
                body: "Noon works.",
                inReplyToId: MESSAGE
            },
            ["mail.send"]
        );
        expect(result.isError).toBeUndefined();
        expect(mocks.queueSend).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({
                accountId: ACCOUNT,
                identityId: null,
                to: [{ name: "", address: "ada@example.test" }],
                cc: [],
                bcc: [],
                subject: "Lunch",
                body: "Noon works.",
                inReplyToId: MESSAGE,
                sendAt: null,
                attachmentIds: []
            })
        );
        expect(result.structuredContent).toEqual({
            draftId: "d1",
            sendAt: "2026-10-05T10:00:10.000Z"
        });
    });

    it("refuse a message with nobody to send it to, or an address that is not one", async () => {
        const nobody = await call("mail_send", { accountId: ACCOUNT, body: "Hi" }, ["mail.send"]);
        expect(nobody.isError).toBe(true);
        expect(nobody.content[0]?.text).toContain("Say who it goes to");
        const bad = await call(
            "mail_send",
            { accountId: ACCOUNT, to: ["not an address"], body: "Hi" },
            ["mail.send"]
        );
        expect(bad.isError).toBe(true);
        expect(bad.content[0]?.text).toContain("not an email address");
        expect(mocks.queueSend).not.toHaveBeenCalled();
    });

    it("pass the mail layer's own refusal on, as written", async () => {
        mocks.queueSend.mockRejectedValue(new mocks.MailAccessError("That mailbox is not yours."));
        const result = await call(
            "mail_send",
            { accountId: ACCOUNT, to: ["ada@example.test"], body: "Hi" },
            ["mail.send"]
        );
        expect(result.content[0]?.text).toBe("That mailbox is not yours.");
    });
});
