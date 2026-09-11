/**
 * What goes when somebody removes a mailbox.
 *
 * Two ways to be wrong about it, and the screen used to leave room for both.
 * "Remove mailbox" reads as "delete my mail" to anybody who has not thought
 * about where mail lives: it is on the server, and Polaris never had it. And it
 * reads as "stop checking it" to anybody who has, while the filters they wrote
 * here, the templates, the signature, the send-as addresses and the drafts exist
 * nowhere else and go with it.
 *
 * So the confirmation says both halves, and the deletion takes everything: the
 * rows by cascade from the mailbox, and the one thing a cascade cannot reach -
 * the files on its drafts, whose rows go with the drafts while the bytes stay on
 * a disk with nothing left pointing at them.
 *
 * What is NOT touched: the mail on the server, and the outside account
 * authorizing it. That link is on somebody's profile and may be authorizing a
 * calendar or a drive as well.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("everything a mailbox holds", () => {
    it("is deleted with it, which the schema is what actually says", async () => {
        const schema = await readFile(`${ROOT}packages/db/prisma/schema.prisma`, "utf8");
        // Every table that hangs off a mailbox cascades from it. One that stops
        // cascading is somebody's filters outliving the mailbox they filtered.
        for (const model of [
            "MailFolder",
            "MailThread",
            "MailMessage",
            "MailDraft",
            "MailRule",
            "MailTemplate",
            "MailIdentity",
            "MailContact",
            "MailTrustedSender",
            "MailSubscription",
            "MailAutoReply",
            "MailSpamToken",
            "MailSpamReputation",
            "MailSpamFeedback"
        ]) {
            const body = schema.slice(schema.indexOf(`model ${model} {`));
            const relation = body.slice(0, body.indexOf("\n}"));
            expect(relation, model).toMatch(
                /account\s+MailAccount\??\s+@relation\([^)]*onDelete:\s*Cascade/
            );
        }
    });

    it("includes the files on its drafts, which no cascade reaches", async () => {
        const uploads = await readFile(`${SRC}lib/mailbox/uploads.ts`, "utf8");
        expect(uploads).toContain(
            "export async function removeAccountUploads(accountId: string): Promise<number>"
        );
        expect(uploads).toContain("where: { draft: { accountId } }");
        // The sweep that catches an abandoned upload works off rows, so once the
        // cascade has run there is nothing left that could ever find these.
        expect(uploads).toContain("where: { draftId: null, createdAt:");
    });

    it("is taken off before the row that names it", async () => {
        for (const file of ["lib/mailbox/accounts.ts", "lib/mailbox/org-mailboxes.ts"]) {
            const source = await readFile(`${SRC}${file}`, "utf8");
            const drop = source.indexOf("removeAccountUploads(");
            const gone = source.indexOf("mailAccount.delete(");
            expect(drop, file).toBeGreaterThan(0);
            expect(drop, file).toBeLessThan(gone);
        }
    });
});

describe("what the person is told", () => {
    it("names what is deleted rather than only what is not", async () => {
        const view = await readFile(
            `${SRC}app/(app)/mail/settings/accounts/accounts-view.tsx`,
            "utf8"
        );
        for (const thing of ["filters", "templates", "signature", "send-as addresses", "drafts"]) {
            expect(view, thing).toContain(thing);
        }
        expect(view).toContain("Nothing on the mail server is touched.");
    });

    it("says the connected account is not one of them", async () => {
        const view = await readFile(
            `${SRC}app/(app)/mail/settings/accounts/accounts-view.tsx`,
            "utf8"
        );
        expect(view).toContain('account.auth === "oauth"');
        expect(view).toContain("Your connected account stays connected");
    });

    it("says the same on the organization's own screen", async () => {
        const view = await readFile(
            `${SRC}app/(app)/account/organizations/[slug]/mailboxes/mailboxes-view.tsx`,
            "utf8"
        );
        expect(view).toContain("the filters and templates they wrote");
        expect(view).toContain("The mailbox itself and its mail are not touched");
    });
});
