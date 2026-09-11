/**
 * The two things in Mail that were text and are now things.
 *
 * **A folder.** The rail drew one and offered a colour, so renaming or throwing
 * away a folder meant doing it in another client. Both reach the mail server -
 * a rename is renamed for everybody, and a delete takes the mail with it - so
 * both refuse the folders the app is built out of, and the delete asks in the
 * words that are true rather than in the ones that are comfortable.
 *
 * **An address.** A header was a row of people drawn as text, and everything
 * somebody wants to do with one of them meant selecting it by hand. Each is a
 * chip now: copy under the pointer, the rest on the right-click.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("renaming and deleting a folder", () => {
    const folders = readFile(`${SRC}lib/mailbox/folders.ts`, "utf8");

    it("refuses the folders the mailbox is built out of", async () => {
        const source = await folders;
        expect(source.match(/if \(folder\.role !== "none"\)/g)?.length).toBe(2);
    });

    it("tells the server first, and rewrites the rows to match", async () => {
        const source = await folders;
        const rename = source.slice(source.indexOf("export async function renameFolder"));
        const body = rename.slice(0, rename.indexOf("export async function deleteFolder"));
        expect(body.indexOf("client.mailboxRename")).toBeLessThan(body.indexOf("prisma.$transaction"));
        // IMAP renames a path and everything under it comes with it, so the
        // children have to follow or each one points at a path that is gone.
        expect(body).toContain("path: { startsWith: under }");
    });

    it("will not delete a folder out from under its children", async () => {
        const source = await folders;
        expect(source).toContain("That folder has folders inside it. Delete those first.");
    });

    it("deletes the row only once the server has agreed", async () => {
        const source = await folders;
        const remove = source.slice(source.indexOf("export async function deleteFolder"));
        expect(remove.indexOf("client.mailboxDelete")).toBeLessThan(
            remove.indexOf("prisma.mailFolder.delete")
        );
    });

    it("says what deleting one actually does", async () => {
        const rail = await readFile(`${SRC}app/(app)/mail/mail-rail.tsx`, "utf8");
        expect(rail).toContain(
            "The folder and every message in it are deleted on the mail server."
        );
        // And offers neither on a folder that carries a role.
        expect(rail).toContain('{folder.role === "none" ? (');
    });
});

describe("an address in a header", () => {
    const chip = readFile(`${SRC}app/(app)/mail/address-chip.tsx`, "utf8");

    it("is shown once when the name is the address", async () => {
        // Half of what arrives sets the display name to the address itself, and
        // that drew the same string twice on one line.
        const source = await chip;
        expect(source).toContain(
            "const second = core.sameAddress(label, entry.address) ? \"\" : entry.address;"
        );
    });

    it("carries a copy button that the keyboard can reach", async () => {
        const source = await chip;
        expect(source).toContain("aria-label={`Copy ${entry.address}`}");
        expect(source).toContain("focus-visible:opacity-100");
    });

    it("offers what a mail client offers on the right-click", async () => {
        const source = await chip;
        for (const item of ["Copy address", "New message", "Find their mail", "Block them"]) {
            expect(source, item).toContain(item);
        }
    });

    it("only offers a block where a block can be written", async () => {
        // A block is a rule, and a rule belongs to a mailbox.
        const source = await chip;
        expect(source).toContain("{accountId && onBlock ? (");
    });

    it("says undisclosed recipients rather than nobody", async () => {
        // A message delivered with nobody in its To line is a blind copy, which
        // is a fact about it rather than a gap in the screen.
        const thread = await readFile(`${SRC}app/(app)/mail/thread-view.tsx`, "utf8");
        expect(thread).toContain("undisclosed recipients");
        expect(thread).not.toContain('"nobody"');
    });
});
