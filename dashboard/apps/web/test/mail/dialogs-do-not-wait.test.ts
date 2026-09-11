/**
 * What a dialog does between the press and the server.
 *
 * Every list in Mail moves the moment somebody acts on it - a row archived, a
 * message read, a conversation filed - because every one of those is a round
 * trip to somebody else's IMAP server and waiting reads as the click having done
 * nothing. The dialogs did not: deleting a folder, renaming one, colouring one,
 * throwing a draft away and removing a mailbox all sat there until an answer
 * came back, and then redrew the whole screen for it.
 *
 * So they do what the lists do: the screen moves now, the server is told in the
 * same breath, and a refusal puts it back and says why.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("the overlay a folder edit is drawn from", () => {
    const shell = readFile(`${SRC}app/(app)/mail/mail-shell.tsx`, "utf8");

    it("can say renamed, recoloured or gone", async () => {
        const source = await shell;
        expect(source).toContain(
            "change: { name?: string; color?: string; gone?: boolean } | null"
        );
    });

    it("takes itself back the moment the server's own list moves", async () => {
        // Held any longer and the screen is arguing with the mailbox.
        const source = await shell;
        expect(source).toContain("}, [folderTruth]);");
        expect(source).toContain(
            "setFolderEdits((held) => (Object.keys(held).length === 0 ? held : {}));"
        );
    });

    it("hides a folder that is gone rather than drawing it differently", async () => {
        const source = await shell;
        expect(source).toContain("if (over.gone) return [];");
    });
});

describe("what each dialog does now", () => {
    const rail = readFile(`${SRC}app/(app)/mail/mail-rail.tsx`, "utf8");

    it("deletes a folder from the rail before the mail server answers", async () => {
        const source = await rail;
        const confirm = source.slice(source.indexOf('confirmLabel="Delete it"'));
        const body = confirm.slice(0, confirm.indexOf("/>"));
        expect(body).toContain("patchFolder(folder.id, { gone: true });");
        // And puts it back when the server says no.
        expect(body).toContain("patchFolder(folder.id, null);");
        // The reader is not left standing in a folder that no longer exists.
        expect(body).toContain('router.push("/mail")');
    });

    it("renames one without waiting, and closes as it does", async () => {
        const source = await rail;
        const rename = source.slice(source.indexOf("function RenameFolderDialog"));
        expect(rename).toContain("onClose();");
        expect(rename).toContain("patchFolder(folder.id, { name: wanted });");
        expect(rename).toContain("patchFolder(folder.id, null);");
        // Nothing to spin: there is no wait to report.
        expect(rename).not.toContain("Renaming...");
    });

    it("colours one on the press", async () => {
        const source = await rail;
        const colour = source.slice(source.indexOf("const colour = useCallback"));
        const body = colour.slice(0, colour.indexOf("[patchFolder, toast]"));
        expect(body.indexOf("patchFolder(folderId, { color: hex });")).toBeLessThan(
            body.indexOf("setFolderColorAction")
        );
    });

    it("throws a draft away from the list at once", async () => {
        const drafts = await readFile(`${SRC}app/(app)/mail/drafts/drafts-view.tsx`, "utf8");
        expect(drafts).toContain("setDiscarded((held) => [...held, draft.id]);");
        expect(drafts).toContain("held.filter((id) => id !== draft.id)");
        expect(drafts).not.toContain("router.refresh()");
    });

    it("takes a removed mailbox off the list at once", async () => {
        const accounts = await readFile(
            `${SRC}app/(app)/mail/settings/accounts/accounts-view.tsx`,
            "utf8"
        );
        expect(accounts).toContain("onRemoved(true);");
        expect(accounts).toContain("onRemoved(false);");
        expect(accounts).toContain("!removed.includes(account.id)");
    });
});
