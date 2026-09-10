/**
 * A mailbox added a moment ago is heard from at once.
 *
 * The stream resolves which mailboxes are the reader's when it opens. A mailbox
 * connected after that was only asked about once a 30-second window had passed,
 * so its first sync - which is exactly when its mail arrives - was dropped, and
 * nothing moved on screen until the page was reloaded.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const owned = vi.hoisted(() => ({ ids: [] as string[], asked: 0 }));

vi.mock("@/lib/session", () => ({
    resolveSession: async () => ({ id: "reader" }),
    sessionCan: async () => true
}));
vi.mock("@/lib/mailbox/watch", () => ({ watchMailboxes: () => () => {} }));
vi.mock("@/lib/mailbox/access", () => ({
    everyAccountId: async () => {
        owned.asked += 1;
        return [...owned.ids];
    }
}));

const { GET } = await import("@/app/api/mail/stream/route");
const { publishMail } = await import("@/lib/mailbox/live");

/** Read frames off the stream until one carries data, or give up. */
async function nextFrame(reader: ReadableStreamDefaultReader<Uint8Array>, waitMs: number) {
    const decoder = new TextDecoder();
    const deadline = Date.now() + waitMs;
    let text = "";
    while (Date.now() < deadline) {
        const chunk = await Promise.race([
            reader.read(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))
        ]);
        if (!chunk || chunk.done) break;
        text += decoder.decode(chunk.value);
        const data = text.split("\n\n").find((frame) => frame.startsWith("data: "));
        if (data) return JSON.parse(data.slice("data: ".length)) as { kind: string; accounts: string[] };
    }
    return null;
}

describe("the mail stream", () => {
    const aborts: AbortController[] = [];
    afterEach(() => {
        for (const abort of aborts) abort.abort();
        owned.ids = [];
        owned.asked = 0;
    });

    async function open() {
        const abort = new AbortController();
        aborts.push(abort);
        const response = await GET(new Request("http://polaris.test/api/mail/stream", { signal: abort.signal }));
        const reader = response.body!.getReader();
        await reader.read(); // the opening comment
        return reader;
    }

    it("wakes the tab for a mailbox connected after it opened", async () => {
        const reader = await open();
        owned.ids = ["fresh"];
        publishMail({ accountId: "fresh", actorId: "reader", kind: "messages" });
        const frame = await nextFrame(reader, 2_000);
        expect(frame).toEqual({ kind: "mail", seq: 1, accounts: ["fresh"] });
    });

    it("does not look somebody else's busy mailbox up on every change", async () => {
        const reader = await open();
        const before = owned.asked;
        publishMail({ accountId: "theirs", actorId: "someone", kind: "messages" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        publishMail({ accountId: "theirs", actorId: "someone", kind: "messages" });
        publishMail({ accountId: "theirs", actorId: "someone", kind: "messages" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(owned.asked - before).toBe(1);
        expect(await nextFrame(reader, 600)).toBeNull();
    });
});
