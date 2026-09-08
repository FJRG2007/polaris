/**
 * A folder, recognised by its name.
 *
 * Two directions matter and they are not symmetric. Failing to recognise a
 * folder costs a generic icon, which is what happens today. Recognising the
 * WRONG one costs somebody's mail, because the same reading suggests which
 * folder is the bin - so the refusals below are the important half.
 */

import { describe, expect, it } from "vitest";
import * as look from "./mailbox-folder-look.js";

describe("what the server said", () => {
    it("beats any guess at the name", () => {
        // A folder somebody called "Archive" that their server flagged as the
        // bin is the bin. Its own answer is not a guess.
        expect(look.folderLook("Archive", "trash")).toBe("trash");
    });

    it("is used when it says nothing", () => {
        expect(look.folderLook("Papelera", "none")).toBe("trash");
    });
});

describe("the names people's servers actually use", () => {
    it("reads Spanish", () => {
        expect(look.folderLook("Papelera", "none")).toBe("trash");
        expect(look.folderLook("Borradores", "none")).toBe("drafts");
        expect(look.folderLook("Elementos enviados", "none")).toBe("sent");
        expect(look.folderLook("Correo no deseado", "none")).toBe("junk");
        expect(look.folderLook("Bandeja de entrada", "none")).toBe("inbox");
    });

    it("reads German, accents and all", () => {
        expect(look.folderLook("Entwürfe", "none")).toBe("drafts");
        expect(look.folderLook("Papierkorb", "none")).toBe("trash");
        expect(look.folderLook("Gesendete Elemente", "none")).toBe("sent");
    });

    it("reads French and Portuguese", () => {
        expect(look.folderLook("Corbeille", "none")).toBe("trash");
        expect(look.folderLook("Brouillons", "none")).toBe("drafts");
        expect(look.folderLook("Lixeira", "none")).toBe("trash");
    });

    it("does not care about case or punctuation", () => {
        expect(look.folderLook("SENT ITEMS", "none")).toBe("sent");
        expect(look.folderLook("Junk E-mail", "none")).toBe("junk");
    });

    it("reads the leaf of a path, because servers nest", () => {
        expect(look.folderLook("INBOX.Papelera", "none")).toBe("trash");
        expect(look.folderLook("INBOX/Spam", "none")).toBe("junk");
    });
});

describe("what it refuses to recognise", () => {
    it("leaves somebody's own folder alone", () => {
        expect(look.folderLook("Acme", "none")).toBe("folder");
        expect(look.folderLook("2026", "none")).toBe("folder");
        expect(look.folderLook("", "none")).toBe("folder");
    });

    it("does not match on a name that merely contains one", () => {
        // The failure that would matter: this is somebody's own folder of old
        // mail, and calling it the archive would file things into it.
        expect(look.folderLook("Archive of 2019", "none")).toBe("folder");
        expect(look.folderLook("Spam reports", "none")).toBe("folder");
        expect(look.folderLook("Sent to legal", "none")).toBe("folder");
    });
});

describe("the role a name suggests", () => {
    it("is the one behind the icon, for the folders that are roles", () => {
        expect(look.suggestedFolderRole("Papelera")).toBe("trash");
        expect(look.suggestedFolderRole("Archivo")).toBe("archive");
    });

    it("is nothing for a way of looking at a mailbox", () => {
        // Starred is not a place mail is filed, so nothing should ever be filed
        // there.
        expect(look.suggestedFolderRole("Starred")).toBeNull();
        expect(look.suggestedFolderRole("Notas")).toBeNull();
    });

    it("is nothing for a folder somebody made", () => {
        expect(look.suggestedFolderRole("Acme")).toBeNull();
    });
});
