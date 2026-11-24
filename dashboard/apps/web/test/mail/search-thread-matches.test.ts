/**
 * A search says which messages of a conversation it found.
 *
 * A thread of four where only the second and the fourth hold the word: the row
 * names those two, its line is taken from around the word rather than from the
 * newest message's greeting, and a ranked search pages by position.
 */

import { describe, expect, it, vi } from "vitest";

const asked: { where: Record<string, unknown> }[] = [];

function message(id: string, threadId: string, day: number, body: string) {
    return {
        id,
        threadId,
        subject: "Proyecto",
        snippet: body.slice(0, 40),
        bodyText: body,
        fromJson: [{ name: "Ana", address: "ana@example.com" }],
        toJson: [{ name: "Me", address: "me@example.com" }],
        ccJson: [],
        hasAttachments: false,
        seen: true,
        flagged: false,
        sentAt: new Date(`2026-09-${String(day).padStart(2, "0")}T10:00:00Z`),
        attachments: [],
        labels: []
    };
}

const FILLER = "Hola, seguimos con el proyecto. ".repeat(10);
// Newest first, the way the database answers.
const MESSAGES = [
    message("m4", "t1", 4, `${FILLER} El contrato queda firmado.`),
    message("m3", "t1", 3, "Gracias, lo reviso."),
    message("m2", "t1", 2, `${FILLER} Te adjunto el contrato.`),
    message("m1", "t1", 1, "Empezamos el lunes."),
    message("x1", "t2", 5, "Otro hilo sin la palabra clave contrato contrato contrato")
];

vi.mock("@/lib/mailbox/access", () => ({
    onShelf: () => true,
    unifiedAccountIds: async () => ["acc1"]
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        mailMessage: {
            findMany: async (query: { where: Record<string, unknown> }) => {
                asked.push(query);
                return MESSAGES;
            }
        },
        mailThread: {
            findMany: async (query: { where: { id?: { in: string[] } } }) =>
                (query.where.id?.in ?? []).map((id) => ({
                    id,
                    accountId: "acc1",
                    subject: "Proyecto",
                    snippet: "Hola",
                    participants: [],
                    messageCount: 4,
                    unreadCount: 0,
                    starred: false,
                    important: false,
                    pinned: false,
                    muted: false,
                    hasAttachments: false,
                    size: 0,
                    lastMessageAt: new Date("2026-09-04T10:00:00Z"),
                    messages: []
                }))
        }
    }
}));

const { listThreads, EMPTY_QUERY, rankOffset } = await import("@/lib/mailbox/views");

describe("what a search found in a conversation", () => {
    it("names only the messages that matched, oldest first", async () => {
        const found = await listThreads("u1", { ...EMPTY_QUERY, query: "contrato" }, null);
        const thread = found.threads.find((one) => one.id === "t1");
        expect(thread?.matches).toEqual(["m2", "m4"]);
    });

    it("takes the row's line from around the word, not the newest greeting", async () => {
        const found = await listThreads("u1", { ...EMPTY_QUERY, query: "contrato" }, null);
        const thread = found.threads.find((one) => one.id === "t1");
        expect(thread?.snippet).toContain("contrato");
        expect(thread?.snippet.startsWith("...")).toBe(true);
    });

    it("leaves a plain list without matches", async () => {
        asked.length = 0;
        const found = await listThreads("u1", { ...EMPTY_QUERY, query: "" }, null);
        expect(found.threads.every((thread) => thread.matches === undefined)).toBe(true);
    });

    it("asks the database for a phrase instead of reading every message for it", async () => {
        asked.length = 0;
        await listThreads("u1", { ...EMPTY_QUERY, query: '"queda firmado" filename:acta' }, null);
        expect(asked[0]!.where.AND).toEqual([
            {
                OR: [
                    { subject: { contains: "queda firmado", mode: "insensitive" } },
                    { snippet: { contains: "queda firmado", mode: "insensitive" } },
                    { bodyText: { contains: "queda firmado", mode: "insensitive" } }
                ]
            },
            { attachments: { some: { name: { contains: "acta", mode: "insensitive" } } } }
        ]);
    });
});

describe("a ranked search", () => {
    it("pages by position and says where the next page starts", async () => {
        const first = await listThreads(
            "u1",
            { ...EMPTY_QUERY, query: "contrato order:relevance", limit: 1 },
            null
        );
        expect(first.threads).toHaveLength(1);
        expect(first.cursor).toBe("rank:1");
        const second = await listThreads(
            "u1",
            { ...EMPTY_QUERY, query: "contrato order:relevance", limit: 1, cursor: first.cursor },
            null
        );
        expect(second.threads).toHaveLength(1);
        expect(second.threads[0]!.id).not.toBe(first.threads[0]!.id);
        expect(second.cursor).toBe("");
    });

    it("reads a cursor that is not a rank as the end", () => {
        expect(rankOffset("")).toBe(0);
        expect(rankOffset("rank:20")).toBe(20);
        expect(rankOffset("0|2026-01-01")).toBe(-1);
        expect(rankOffset("rank:-3")).toBe(-1);
    });
});
