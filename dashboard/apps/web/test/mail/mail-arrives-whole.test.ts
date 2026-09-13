/**
 * When a message is actually fetched.
 *
 * Polaris used to store headlines. A sync wrote who a message was from, its
 * subject and the first few kilobytes of it for the line under the subject, and
 * stopped there - the message itself was fetched the first time somebody opened
 * it. That is one whole IMAP session between the click and the words: connect,
 * authenticate, select the folder, fetch the parts, log out. On a large provider
 * it is seconds, every time, on a message nobody has read yet.
 *
 * Which is the "opening mail is slow" nobody could point at, because everything
 * else about the screen was instant. Every other mail client on any platform
 * stores the message when it arrives; this does too now. The hover prefetch is
 * still there and still useful - it covers a message older than the window this
 * works through - but it only ever helped somebody who pointed before pressing.
 *
 * Bounded on purpose, in three ways: the folders people actually read, a size
 * past which what is big is the attachments, and a number per pass so a first
 * sync of twenty folders does not turn into a thousand fetches before the rail
 * has drawn.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const sync = readFile(`${SRC}lib/mailbox/sync.ts`, "utf8");

describe("a pass over a folder", () => {
    it("brings the bodies down with it", async () => {
        const source = await sync;
        expect(source).toContain("await warmBodies(client, account, folder, edge);");
    });

    it("does it on the connection the sync already has open", async () => {
        const source = await sync;
        const folder = source.slice(source.indexOf("async function syncFolder"));
        const body = folder.slice(0, folder.indexOf("lock.release()"));
        // Inside the lock: a second session to fetch what this one is already
        // looking at is the cost this exists to remove.
        expect(body).toContain("warmBodies(client, account, folder, edge)");
    });

    it("no longer says that nothing here fetches a body", async () => {
        const source = await sync;
        expect(source).not.toContain("Nothing here fetches a body.");
    });
});

describe("what is worth keeping", () => {
    it("is what people read, and never Gmail's copy of everything", async () => {
        const source = await sync;
        const roles = source.slice(source.indexOf("const BODY_ROLES"));
        const line = roles.slice(0, roles.indexOf(";"));
        expect(line).toContain('"inbox"');
        expect(line).toContain('"archive"');
        expect(line).toContain('"none"');
        expect(line).not.toContain('"all"');
        expect(line).not.toContain('"trash"');
        expect(line).not.toContain('"junk"');
    });

    it("stops where a message stops being writing and starts being attachments", async () => {
        const source = await sync;
        expect(source).toContain("const BODY_MAX_MESSAGE_BYTES = 512_000;");
        expect(source).toContain("size: { lte: BODY_MAX_MESSAGE_BYTES }");
    });

    it("takes the newest first, which is the order mail is read in", async () => {
        const source = await sync;
        const warm = source.slice(source.indexOf("async function warmBodies"));
        expect(warm).toContain('orderBy: { sentAt: "desc" }');
        expect(warm).toContain("BODIES_PER_PASS");
    });

    it("asks only for what is still a headline", async () => {
        const source = await sync;
        const warm = source.slice(source.indexOf("async function warmBodies"));
        expect(warm).toContain("bodyText: null");
        expect(warm).toContain("bodyHtml: null");
    });
});

describe("what it writes", () => {
    it("leaves a message alone when nothing came back, rather than storing empty", async () => {
        // Written as "" in both columns, the message would open blank for ever:
        // a stored body is the thing that stops anybody fetching it again.
        const source = await sync;
        expect(source).toContain("if (!body.text && !body.html) continue;");
    });

    it("keeps the two halves apart", async () => {
        const source = await sync;
        // The preview falls back to the HTML when the plain part is silent. A
        // stored body must not, or one part is written into both columns and the
        // message reads twice.
        expect(source).toContain("(shape) => shape.textPart, BODY_MAX_PART_BYTES");
        expect(source).toContain("(shape) => shape.htmlPart, BODY_MAX_PART_BYTES");
        expect(source).toContain("(shape) => shape.textPart || shape.htmlPart,");
    });

    it("puts a soft-wrapped plain message back into paragraphs", async () => {
        const source = await sync;
        expect(source).toContain("const text = coding?.flowed ? unflow(decoded) : decoded;");
    });

    it("registers what the footer says, which only a body can say", async () => {
        const source = await sync;
        const warm = source.slice(source.indexOf("async function warmBodies"));
        expect(warm).toContain("recordSubscription(account.id, {");
        // Counted as nothing: this is mail being stored, not arriving.
        expect(warm).toContain("counts: false");
    });
});

describe("how much is kept", () => {
    it("holds a fixed number per mailbox rather than a share of its history", async () => {
        // Without this the query walks backwards through the mailbox thirty at a
        // time until every message in it is on this disk - the thing the schema
        // set out not to do, arrived at slowly instead of all at once.
        const source = await sync;
        const edge = source.slice(source.indexOf("async function bodyWindowEdge"));
        expect(edge).toContain("const kept = await bodiesKept();");
        expect(edge).toContain("skip: kept - 1");
    });

    it("takes the number from the admin panel, with the env var only as a fallback", async () => {
        // An env override reaches no existing install, so a window nobody can
        // change is a window that stays at whatever shipped.
        const source = await sync;
        const read = source.slice(source.indexOf("async function bodiesKept"));
        expect(read).toContain("getSetting(core.MAIL_BODY_KEEP_KEY)");
        expect(read).toContain("stored ?? process.env.POLARIS_MAIL_BODY_KEEP ?? null");
    });

    it("holds nothing ahead of time when the window is zero", async () => {
        // Zero is an answer, not an empty field: a mail server on the same LAN
        // answers fast enough that a held copy saves nothing.
        const source = await sync;
        const edge = source.slice(source.indexOf("async function bodyWindowEdge"));
        expect(edge).toContain("if (kept === 0) return new Date();");
    });

    it("does not fetch what it is about to drop", async () => {
        const source = await sync;
        const warm = source.slice(source.indexOf("async function warmBodies"));
        expect(warm).toContain("...(edge ? { sentAt: { gte: edge } } : {})");
    });

    it("lets go of what has fallen out of the window", async () => {
        const source = await sync;
        const prune = source.slice(source.indexOf("async function pruneBodies"));
        const body = prune.slice(0, prune.indexOf("interface BodyOwner"));
        expect(body).toContain("sentAt: { lt: edge }");
        expect(body).toContain("data: { bodyText: null, bodyHtml: null }");
    });

    it("keeps what somebody marked, whatever its age", async () => {
        // Age guesses well at what nobody opens again and badly at the old
        // thread somebody starred so they could come back to it.
        const source = await sync;
        const prune = source.slice(source.indexOf("async function pruneBodies"));
        const body = prune.slice(0, prune.indexOf("interface BodyOwner"));
        expect(body).toContain("flagged: false");
        expect(body).toContain("pinned: false");
    });

    it("reads the window once a pass and enforces it once a pass", async () => {
        const source = await sync;
        const pass = source.slice(source.indexOf("async function onePass"));
        const body = pass.slice(0, pass.indexOf('await recordAccountState(accountId, "ok")'));
        expect(body).toContain("const edge = await bodyWindowEdge(account.id);");
        // After the connection is closed: this is database work.
        expect(body.indexOf("if (edge) await pruneBodies(account.id, edge);")).toBeGreaterThan(
            body.indexOf("await withImap(account,")
        );
    });

    it("does not fetch fifteen times as much because somebody has Mail open", async () => {
        // The watched pass runs every twenty seconds rather than every five
        // minutes. Leaving the number alone spends that on somebody else's
        // server, which is how an account gets rate limited for being read.
        const source = await sync;
        const warm = source.slice(source.indexOf("async function warmBodies"));
        expect(warm).toContain("watchedReaders().has(account.userId)");
        expect(warm).toContain("BODIES_PER_WATCHED_PASS");
        const watched = Number(/const BODIES_PER_WATCHED_PASS = (\d+);/.exec(source)?.[1]);
        const scheduled = Number(/const BODIES_PER_PASS = (\d+);/.exec(source)?.[1]);
        expect(watched).toBeLessThan(scheduled);
    });
});

describe("opening one", () => {
    it("still fetches it when it is not held, and keeps it from then on", async () => {
        const messages = await readFile(`${SRC}lib/mailbox/messages.ts`, "utf8");
        const load = messages.slice(messages.indexOf("export async function loadBody"));
        expect(load).toContain(
            "if (message.bodyText !== null || message.bodyHtml !== null) {"
        );
        expect(load).toContain("data: { bodyText: body.text, bodyHtml: body.html }");
    });
});
