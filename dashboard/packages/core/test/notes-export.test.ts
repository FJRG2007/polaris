/**
 * Writing notes back out as a vault of Markdown.
 *
 * What matters is that it re-imports: a zip that opens in Obsidian but comes
 * back into Polaris as a different shape is a backup nobody can restore. So the
 * assertions are the mirror of the import's - a directory is a folder, a file is
 * a note, a note with notes under it is both, and a link is a link again.
 *
 * The other half is the boring half that ruins an export: two notes with the
 * same title, a title with a slash in it, a name Windows refuses.
 */

import { describe, expect, it } from "vitest";
import {
    fileNameFor,
    layOutExport,
    noteFile,
    toWikilinks,
    uniquePath,
    type ExportableFolder,
    type ExportableNote
} from "../src/notes-export.js";

const note = (over: Partial<ExportableNote> & { id: string; title: string }): ExportableNote => ({
    body: "",
    frontmatter: null,
    folderId: null,
    parentId: null,
    ...over
});

describe("a title, as a file can be named", () => {
    it("loses what a filesystem will not take", () => {
        expect(fileNameFor("Q3: profit/loss?")).toBe("Q3 profit loss");
    });

    it("loses the trailing dot Windows drops silently", () => {
        // Left in, two notes become one file and nothing says so.
        expect(fileNameFor("Notes...")).toBe("Notes");
        expect(fileNameFor("  spaced  ")).toBe("spaced");
    });

    it("keeps the characters a filename is allowed to have", () => {
        // Stripping a hyphen turned "well-known" into "well known", which is a
        // different file from the one the vault had.
        expect(fileNameFor("well-known hosts")).toBe("well-known hosts");
        expect(fileNameFor("2026-09-04 standup")).toBe("2026-09-04 standup");
    });

    it("has something to call a note with no title at all", () => {
        expect(fileNameFor("")).toBe("Untitled");
        expect(fileNameFor("///")).toBe("Untitled");
    });

    it("gets out of the way of the names Windows reserves", () => {
        expect(fileNameFor("CON")).toBe("CON_");
        expect(fileNameFor("aux")).toBe("aux_");
    });
});

describe("two things with one name", () => {
    it("numbers the second rather than overwriting the first", () => {
        const taken = new Set<string>();
        expect(uniquePath(taken, "Standup")).toBe("Standup.md");
        expect(uniquePath(taken, "Standup")).toBe("Standup (2).md");
        expect(uniquePath(taken, "Standup")).toBe("Standup (3).md");
    });

    it("compares without minding the case, because a filesystem does not", () => {
        const taken = new Set<string>();
        uniquePath(taken, "Standup");
        expect(uniquePath(taken, "standup")).toBe("standup (2).md");
    });
});

describe("the links", () => {
    const titles: Record<string, string> = { "11111111-1111-4111-8111-111111111111": "Meeting notes" };
    const resolve = (id: string) => titles[id] ?? null;

    it("become the wiki links a vault writes", () => {
        expect(
            toWikilinks("See [Meeting notes](polaris:note/11111111-1111-4111-8111-111111111111).", resolve)
        ).toBe("See [[Meeting notes]].");
    });

    it("keep a label that says something else, as an alias", () => {
        expect(
            toWikilinks("See [the notes](polaris:note/11111111-1111-4111-8111-111111111111).", resolve)
        ).toBe("See [[Meeting notes|the notes]].");
    });

    it("are left alone when the note they name is not in the export", () => {
        // A link to a file that is not in the zip would be a broken link that
        // looks like a working one.
        const outside = "[Elsewhere](polaris:note/22222222-2222-4222-8222-222222222222)";
        expect(toWikilinks(outside, resolve)).toBe(outside);
    });
});

describe("the file itself", () => {
    it("puts the frontmatter back where it was", () => {
        expect(noteFile({ frontmatter: "---\ntitle: X\n---", body: "Body" })).toBe(
            "---\ntitle: X\n---\nBody\n"
        );
    });

    it("is just the body when there was none", () => {
        expect(noteFile({ frontmatter: null, body: "Body\n" })).toBe("Body\n");
        expect(noteFile({ frontmatter: null, body: "" })).toBe("");
    });
});

describe("the layout", () => {
    it("puts a note in its folder, and a folder inside its folder", () => {
        const folders: ExportableFolder[] = [
            { id: "f1", name: "Work", parentId: null },
            { id: "f2", name: "Clients", parentId: "f1" }
        ];
        const files = layOutExport(
            [
                note({ id: "n1", title: "Kickoff", folderId: "f2" }),
                note({ id: "n2", title: "Inbox" })
            ],
            folders
        );
        expect(files.map((file) => file.path).sort()).toEqual(["Inbox.md", "Work/Clients/Kickoff.md"]);
    });

    it("gives a note that holds notes a file and a directory, the way a vault does", () => {
        // It has to be both, or the export does not re-import as the same shape.
        const files = layOutExport(
            [
                note({ id: "n1", title: "Project" }),
                note({ id: "n2", title: "Cutover", parentId: "n1" }),
                note({ id: "n3", title: "Rollback", parentId: "n2" })
            ],
            []
        );
        expect(files.map((file) => file.path)).toEqual([
            "Project.md",
            "Project/Cutover.md",
            "Project/Cutover/Rollback.md"
        ]);
    });

    it("does not let two notes in one folder become one file", () => {
        const files = layOutExport(
            [note({ id: "n1", title: "Standup" }), note({ id: "n2", title: "Standup" })],
            []
        );
        expect(files.map((file) => file.path)).toEqual(["Standup.md", "Standup (2).md"]);
    });

    it("lets the same title live in two different folders", () => {
        const folders: ExportableFolder[] = [
            { id: "f1", name: "A", parentId: null },
            { id: "f2", name: "B", parentId: null }
        ];
        const files = layOutExport(
            [
                note({ id: "n1", title: "Standup", folderId: "f1" }),
                note({ id: "n2", title: "Standup", folderId: "f2" })
            ],
            folders
        );
        expect(files.map((file) => file.path).sort()).toEqual(["A/Standup.md", "B/Standup.md"]);
    });

    it("writes the links between the notes it is exporting", () => {
        const files = layOutExport(
            [
                note({
                    id: "11111111-1111-4111-8111-111111111111",
                    title: "One",
                    body: "see [Two](polaris:note/22222222-2222-4222-8222-222222222222)"
                }),
                note({ id: "22222222-2222-4222-8222-222222222222", title: "Two" })
            ],
            []
        );
        expect(files[0]!.text).toBe("see [[Two]]\n");
    });
});
