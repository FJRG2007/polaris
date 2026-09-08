/**
 * What Polaris' own junk verdict actually does to a message.
 *
 * The filter used to file into Junk by rewriting the row's `folderId` and
 * telling the mail server nothing. Three things followed from that, and all
 * three were somebody else's mail: the message was still in the inbox on the
 * phone, the row carried the inbox's uid under the Junk folder's id - so a later
 * Not junk moved whichever message happened to hold that uid in Junk - and Save
 * this message downloaded by the same wrong pair.
 *
 * So it goes through the same action a person pressing Junk goes through, and
 * the two things that must not come with it are said explicitly: it teaches the
 * filter nothing, because a classifier trained on its own output converges on
 * whatever it thought first, and it does not open a second connection to read
 * the destination, because the sync it runs inside reads Junk later in the same
 * pass.
 *
 * The loop guard beside it has the same shape of failure: a header nothing ever
 * fetched is a guard that cannot fire.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const MAILBOX = fileURLToPath(new URL("../../src/lib/mailbox/", import.meta.url));

describe("the junk filter files on the mail server", () => {
    it("moves through the ordinary action rather than rewriting the row", async () => {
        const spam = await readFile(`${MAILBOX}spam.ts`, "utf8");
        expect(spam).toContain('actOnMessages(account.userId, [row.id], "junk"');
        expect(spam).not.toContain("data: { folderId: junk.id }");
    });

    it("teaches nothing and settles nothing", async () => {
        const spam = await readFile(`${MAILBOX}spam.ts`, "utf8");
        expect(spam).toContain("{ teach: false, settle: false }");
    });

    it("leaves the message where it is when the mailbox has no Junk folder", async () => {
        const spam = await readFile(`${MAILBOX}spam.ts`, "utf8");
        // `findFolderForRole`, which answers null, rather than the one that makes
        // a folder: inventing one is not the filter's decision to take.
        expect(spam).toContain('findFolderForRole(accountId, "junk")');
        expect(spam).toContain("if (!junk || junk.id === row.folderId) return;");
    });
});

describe("the forward loop guard reads a header that is fetched", () => {
    it("asks the server for the stamp forwarding leaves", async () => {
        const sync = await readFile(`${MAILBOX}sync.ts`, "utf8");
        expect(sync).toContain('"x-polaris-forwarded"');
    });

    it("is the same name the guard looks under", async () => {
        const rules = await readFile(`${MAILBOX}rules.ts`, "utf8");
        expect(rules).toContain('headers["x-polaris-forwarded"]');
    });
});
