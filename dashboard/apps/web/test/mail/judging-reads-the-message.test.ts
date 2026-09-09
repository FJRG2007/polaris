/**
 * What the junk filter is actually looking at when it judges.
 *
 * Half of what the filter is written to read lives in the body: the links, and
 * the paragraph that asks the reader to go and confirm their account. A message
 * is judged the moment it arrives, and a row has no body until somebody opens
 * the message - so every one of those rules was reading an empty string, and the
 * one that keeps real brand mail out of Junk (a message that links to the brand
 * is that brand's message) could never fire at all.
 *
 * The part is already in hand: the sync fetches the first few kilobytes of each
 * message for the preview line. It is handed to the judge rather than thrown
 * away, which costs no read, no connection and no command to the mail server.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const MAILBOX = fileURLToPath(new URL("../../src/lib/mailbox/", import.meta.url));

describe("the filter judges what the message says", () => {
    it("is given the part the sync already read", async () => {
        const sync = await readFile(`${MAILBOX}sync.ts`, "utf8");
        expect(sync).toContain("judgeArrival(account.id, row.id, snippets.get(message.uid)");
    });

    it("reads that part as the message's body rather than an empty one", async () => {
        const spam = await readFile(`${MAILBOX}spam.ts`, "utf8");
        expect(spam).toContain("bodyText: row.bodyText ?? arriving.text");
        expect(spam).toContain("bodyHtml: row.bodyHtml ?? arriving.html");
    });

    it("keeps the markup for the links and the words for the wording", async () => {
        // The link reader needs the `href` a preview would have stripped out,
        // and everything that reads sentences needs the sentences.
        const spam = await readFile(`${MAILBOX}spam.ts`, "utf8");
        expect(spam).toContain("core.snippetFrom(part, JUDGE_BODY)");
    });

    it("still judges a message it was handed nothing for", async () => {
        // A folder resynced from a server that will not answer for one part
        // must not be a folder nobody judges.
        const spam = await readFile(`${MAILBOX}spam.ts`, "utf8");
        expect(spam).toContain('function judgeable(row: JudgeRow, part = "")');
        expect(spam).toContain('if (!part.trim()) return { text: "", html: "" };');
    });
});
