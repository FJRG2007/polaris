/**
 * A search reads a conversation whole.
 *
 * A thread is in the inbox because of what arrived, and the reply somebody wrote
 * to it is in Sent. Searching the inbox for a word from their own reply used to
 * read only the inbox's messages and found nothing. The rest of a conversation is
 * searched too - except what of it is in Trash, Spam or All Mail - and the
 * replies' bodies are held so there is something in them to find.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const asked: { where: Record<string, unknown> }[] = [];

const INBOX_MESSAGE = {
    threadId: "t1",
    subject: "Presupuesto de la reforma",
    snippet: "Hola, te paso el presupuesto",
    bodyText: "Hola, te paso el presupuesto de la reforma.",
    fromJson: [{ name: "Ana", address: "ana@example.com" }],
    toJson: [{ name: "Me", address: "me@example.com" }],
    ccJson: [],
    hasAttachments: false,
    seen: true,
    flagged: false,
    sentAt: new Date("2026-09-20T10:00:00Z")
};
const SENT_REPLY = {
    ...INBOX_MESSAGE,
    subject: "Re: Presupuesto de la reforma",
    snippet: "Perfecto",
    bodyText: "Perfecto, lo firmo el jueves con el notario.",
    fromJson: [{ name: "Me", address: "me@example.com" }],
    toJson: [{ name: "Ana", address: "ana@example.com" }],
    sentAt: new Date("2026-09-21T10:00:00Z")
};

vi.mock("@/lib/mailbox/access", () => ({
    onShelf: () => true,
    unifiedAccountIds: async () => ["acc1"]
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        mailMessage: {
            findMany: async (query: { where: Record<string, unknown> }) => {
                asked.push(query);
                return [INBOX_MESSAGE, SENT_REPLY];
            }
        },
        mailThread: {
            findMany: async (query: { where: { id?: { in: string[] } } }) =>
                (query.where.id?.in ?? []).map((id) => ({
                    id,
                    accountId: "acc1",
                    subject: "Presupuesto de la reforma",
                    snippet: "",
                    participants: [],
                    messageCount: 2,
                    unreadCount: 0,
                    starred: false,
                    important: false,
                    pinned: false,
                    muted: false,
                    hasAttachments: false,
                    size: 0,
                    lastMessageAt: new Date("2026-09-21T10:00:00Z"),
                    messages: []
                }))
        }
    }
}));

const { listThreads, EMPTY_QUERY } = await import("@/lib/mailbox/views");

describe("searching a list", () => {
    it("finds a conversation in the inbox by a word only its reply in Sent holds", async () => {
        asked.length = 0;
        const found = await listThreads(
            "u1",
            { ...EMPTY_QUERY, folderId: "inbox-folder", query: "notario" },
            null
        );
        expect(found.threads.map((thread) => thread.id)).toEqual(["t1"]);
    });

    it("reads every message of the conversations in the list, but not the rest of them in Trash or Spam", async () => {
        asked.length = 0;
        await listThreads(
            "u1",
            { ...EMPTY_QUERY, folderId: "inbox-folder", query: "notario" },
            null
        );
        const where = asked[0]!.where;
        // Not only the inbox's own messages...
        expect(where.folderId).toBeUndefined();
        // ...but every message of a thread the inbox list shows,
        const inList = (where.thread as { messages: { some: Record<string, unknown> } }).messages
            .some;
        expect(inList).toMatchObject({ accountId: { in: ["acc1"] }, folderId: "inbox-folder" });
        // ...the inbox's own messages, and the rest wherever they are but Trash,
        // Spam or the All Mail copies.
        expect(where.OR).toEqual([
            inList,
            { folder: { role: { notIn: ["trash", "junk", "all"] } } }
        ]);
    });

    it("asks what the list itself asks, snooze and dates included", async () => {
        asked.length = 0;
        const since = new Date("2026-01-01T00:00:00Z");
        await listThreads(
            "u1",
            { ...EMPTY_QUERY, folderId: "inbox-folder", since, query: "notario" },
            null
        );
        const inList = (asked[0]!.where.thread as { messages: { some: Record<string, unknown> } })
            .messages.some;
        expect(inList.sentAt).toEqual({ gte: since });
        expect(inList.OR).toEqual([
            { snoozedUntil: null },
            { snoozedUntil: { lte: expect.any(Date) } }
        ]);
    });

    it("adds nothing to a list that narrows nothing", async () => {
        asked.length = 0;
        await listThreads("u1", { ...EMPTY_QUERY, query: "notario" }, null);
        const where = asked[0]!.where;
        expect(where.thread).toBeUndefined();
        expect(where.OR).toBeUndefined();
    });
});

describe("what is held whole", () => {
    it("includes Sent, so a reply's words can be found", async () => {
        const sync = await readFile(
            fileURLToPath(new URL("../../src/lib/mailbox/sync.ts", import.meta.url)),
            "utf8"
        );
        const roles = sync.slice(sync.indexOf("const BODY_ROLES"));
        expect(roles.slice(0, roles.indexOf(";"))).toContain('"sent"');
    });
});
