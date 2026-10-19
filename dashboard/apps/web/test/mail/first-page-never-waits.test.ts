/**
 * Opening Trash sat on its skeleton for twenty seconds.
 *
 * A folder's first page that ended on what is held here went to the mail server
 * for older mail before it answered - which waits on the mailbox's own sync pass
 * and then on a connection of its own. The first page now answers with what is
 * held and a cursor saying there is more; asking with that cursor is what goes
 * to the server.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const reachForOlder = vi.fn(async () => true);
const olderOnServer = vi.fn(async () => true);
const held = { id: "t1", pinned: false, size: 100, lastMessageAt: "2026-01-02T00:00:00.000Z" };
const listThreads = vi.fn(async (..._: unknown[]) => ({
    threads: [held] as (typeof held)[],
    cursor: ""
}));

vi.mock("@/lib/api-session", () => ({ apiPermission: async () => ({ id: "u1" }) }));
vi.mock("@/lib/mailbox/shelf", () => ({
    mailShelfFor: async () => null,
    mailShelfOfTab: async () => null
}));
vi.mock("@/lib/mailbox/access", () => ({
    everyAccountId: async () => ["a1"],
    unifiedAccountIds: async () => ["a1"]
}));
vi.mock("@/lib/mailbox/sync", () => ({ reachForOlder, olderOnServer }));
vi.mock("@/lib/mailbox/views", async () => ({
    EMPTY_QUERY: (
        await vi.importActual<typeof import("@/lib/mailbox/views")>("@/lib/mailbox/views")
    ).EMPTY_QUERY,
    listThreads
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));

const { GET } = await import("@/app/api/mail/threads/route");

async function ask(query: string) {
    const response = await GET(new Request(`http://polaris.test/api/mail/threads?${query}`));
    return (await response.json()) as { threads: { id: string }[]; cursor: string };
}

beforeEach(() => {
    reachForOlder.mockReset().mockResolvedValue(true);
    olderOnServer.mockClear().mockResolvedValue(true);
    listThreads.mockReset().mockResolvedValue({ threads: [held], cursor: "" });
});

describe("a folder's first page", () => {
    it("answers with what is held, without going to the mail server", async () => {
        const page = await ask("role=trash");
        expect(reachForOlder).not.toHaveBeenCalled();
        expect(page.threads.map((thread) => thread.id)).toEqual(["t1"]);
        expect(page.cursor).toBe(`0|${held.lastMessageAt}`);
    });

    it("hands an empty folder a cursor that still reaches the server", async () => {
        listThreads.mockResolvedValue({ threads: [], cursor: "" });
        const page = await ask("role=trash");
        expect(page.cursor).toBe("older");
    });

    it("says there is nothing more when the server holds nothing more", async () => {
        olderOnServer.mockResolvedValue(false);
        const page = await ask("role=trash");
        expect(page.cursor).toBe("");
        expect(reachForOlder).not.toHaveBeenCalled();
    });
});

describe("every list a folder can be opened as", () => {
    // Spam was as slow as Trash, and for the same reason: every folder list -
    // the merged Spam and Trash, one mailbox's own, a folder by id - is this
    // route, and none of them may wait on the mail server for its first page.
    it.each([
        ["merged Spam", "role=junk"],
        ["merged Trash", "role=trash"],
        ["merged Inbox", "role=inbox"],
        ["one mailbox's Spam", "accountId=a1&role=junk"],
        ["one mailbox's Trash", "accountId=a1&role=trash"],
        ["a folder by id", "accountId=a1&folderId=f1"]
    ])("answers %s at once, even while the server never would", async (_, query) => {
        reachForOlder.mockImplementation(() => new Promise<boolean>(() => undefined));
        listThreads.mockResolvedValue({ threads: [], cursor: "" });
        const page = await ask(query);
        expect(reachForOlder).not.toHaveBeenCalled();
        expect(page.cursor).toBe("older");
    });
});

describe("asking past the first page", () => {
    it("goes to the server, lists again, and keeps going while it holds more", async () => {
        const first = await ask("role=trash");
        const next = await ask(`role=trash&cursor=${first.cursor}`);
        expect(reachForOlder).toHaveBeenCalledTimes(1);
        expect(listThreads).toHaveBeenCalledTimes(3);
        expect(next.cursor).toBe(first.cursor);
    });

    it("continues past the last held row instead of the top of a folder holding several pages", async () => {
        const last = { ...held, id: "t9", lastMessageAt: "2025-06-01T00:00:00.000Z" };
        listThreads.mockResolvedValueOnce({ threads: [], cursor: "" });
        listThreads.mockResolvedValueOnce({ threads: [last], cursor: "" });
        const page = await ask(`role=trash&cursor=0|${held.lastMessageAt}`);
        expect(reachForOlder).toHaveBeenCalledTimes(1);
        expect(listThreads.mock.calls[1][1]).toMatchObject({ cursor: `0|${held.lastMessageAt}` });
        expect(page.threads.map((thread) => thread.id)).toEqual(["t9"]);
        expect(page.cursor).toBe(`0|${last.lastMessageAt}`);
    });

    it("stops once the server has nothing older to give", async () => {
        reachForOlder.mockResolvedValueOnce(false);
        const page = await ask("role=trash&cursor=older");
        expect(page.cursor).toBe("");
    });
});
