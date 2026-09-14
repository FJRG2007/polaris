/**
 * Why opening a message was still slow after the words were already here.
 *
 * The body had stopped being the problem: a pass over a folder brings the
 * newest messages down whole, so by the time anybody clicks a row the words are
 * on this machine. Opening one was still a wait, and the reason was the shape of
 * the request rather than what it asked for.
 *
 * It was a server action. The router runs those one at a time, so the open
 * queued behind whatever had been asked for last - the prefetch of the row the
 * pointer passed over, the flag from the message read a second ago - and each
 * answer carries a re-render of the whole route back with it. None of that is
 * anything to do with reading a message, and all of it was spent between the
 * click and the words.
 *
 * So it is a plain GET, and the prefetch asks for exactly what the press asks
 * for: the same address, the same cache, so a message somebody pointed at is
 * already in this tab when they press it, and a message opened twice is fetched
 * once.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("the way a message is asked for", () => {
    it("is an endpoint of its own", async () => {
        const route = await readFile(`${SRC}app/api/mail/message/[messageId]/route.ts`, "utf8");
        expect(route).toContain("export async function GET(");
        expect(route).toContain("await apiPermission(\"mail.use\")");
        expect(route).toContain("openMessage(user.id, messageId)");
    });

    it("is never held by anything in between", async () => {
        const route = await readFile(`${SRC}app/api/mail/message/[messageId]/route.ts`, "utf8");
        expect(route).toContain('"cache-control": "private, no-store"');
    });

    it("answers for somebody else's message exactly as for one that is gone", async () => {
        const route = await readFile(`${SRC}app/api/mail/message/[messageId]/route.ts`, "utf8");
        const refused = route.slice(route.indexOf("caught instanceof MailAccessError"));
        expect(refused).toContain("That message is no longer here.");
        expect(refused).toContain("status: 404");
    });

    it("is no longer a server action", async () => {
        const actions = await readFile(`${SRC}app/(app)/mail/actions.ts`, "utf8");
        expect(actions).not.toContain("openMessageAction");
        expect(actions).not.toContain("warmMessageAction");
    });
});

describe("what this tab keeps", () => {
    const store = readFile(`${SRC}app/(app)/mail/message-store.ts`, "utf8");

    it("joins a request in flight rather than sending a second", async () => {
        const source = await store;
        // The promise is what is held, which is what makes a hover followed by a
        // press one fetch instead of two.
        expect(source).toContain("const held = new Map<string, Promise<OpenedMessage>>();");
        expect(source).toContain("const already = held.get(messageId);");
        expect(source).toContain("if (already) return already;");
    });

    it("does not keep a failure", async () => {
        const source = await store;
        expect(source).toContain("held.delete(messageId);");
    });

    it("warms with the same request the open uses", async () => {
        const source = await store;
        const warm = source.slice(source.indexOf("export function warmMessage"));
        expect(warm).toContain("readMessage(messageId)");
    });

    it("holds them in memory and nowhere else", async () => {
        const source = await store;
        expect(source).not.toContain("sessionStorage");
        expect(source).not.toContain("localStorage");
    });
});

describe("what the screens do with it", () => {
    it("draws the body from the store", async () => {
        const thread = await readFile(`${SRC}app/(app)/mail/thread-view.tsx`, "utf8");
        expect(thread).toContain('import { readMessage } from "./message-store";');
        expect(thread).toContain("const opened = await readMessage(message.id);");
    });

    it("prefetches through the store too", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        expect(view).toContain("await warmMessage(next);");
    });
});

describe("the notice the system drew about it", () => {
    it("can be taken back at all", async () => {
        const notify = await readFile(`${SRC}lib/desktop-notify.ts`, "utf8");
        expect(notify).toContain("export function closeDesktopNotice(tag: string): void {");
        expect(notify).toContain("const shown = new Map<string, { close: () => void }>();");
    });

    it("goes when the conversation is opened", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        expect(view).toContain("closeDesktopNotice(`mail:${row.id}`);");
    });

    it("goes when it is read, archived or binned from the list", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        expect(view).toContain("for (const id of aimed) closeDesktopNotice(`mail:${id}`);");
    });

    it("takes the one that stood for the rest with it", async () => {
        const unread = await readFile(`${SRC}components/mail-unread.tsx`, "utf8");
        expect(unread).toContain('if (unread.messages === 0) closeDesktopNotice("mail:more");');
    });
});
