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
const listThreads = vi.fn(async () => ({ threads: [{ id: "t1" }], cursor: "" }));

vi.mock("@/lib/api-session", () => ({ apiPermission: async () => ({ id: "u1" }) }));
vi.mock("@/lib/mailbox/shelf", () => ({ mailShelfFor: async () => null }));
vi.mock("@/lib/mailbox/access", () => ({
    everyAccountId: async () => ["a1"],
    unifiedAccountIds: async () => ["a1"]
}));
vi.mock("@/lib/mailbox/sync", () => ({ reachForOlder, olderOnServer }));
vi.mock("@/lib/mailbox/views", async () => ({
    EMPTY_QUERY: (await vi.importActual<typeof import("@/lib/mailbox/views")>("@/lib/mailbox/views"))
        .EMPTY_QUERY,
    listThreads
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));

const { GET } = await import("@/app/api/mail/threads/route");

async function ask(query: string) {
    const response = await GET(new Request(`http://polaris.test/api/mail/threads?${query}`));
    return (await response.json()) as { threads: { id: string }[]; cursor: string };
}

beforeEach(() => {
    reachForOlder.mockClear();
    olderOnServer.mockClear().mockResolvedValue(true);
    listThreads.mockClear();
});

describe("a folder's first page", () => {
    it("answers with what is held, without going to the mail server", async () => {
        const page = await ask("role=trash");
        expect(reachForOlder).not.toHaveBeenCalled();
        expect(page.threads.map((thread) => thread.id)).toEqual(["t1"]);
        expect(page.cursor).not.toBe("");
    });

    it("says there is nothing more when the server holds nothing more", async () => {
        olderOnServer.mockResolvedValue(false);
        const page = await ask("role=trash");
        expect(page.cursor).toBe("");
        expect(reachForOlder).not.toHaveBeenCalled();
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

    it("stops once the server has nothing older to give", async () => {
        reachForOlder.mockResolvedValueOnce(false);
        const page = await ask("role=trash&cursor=older");
        expect(page.cursor).toBe("");
    });
});
