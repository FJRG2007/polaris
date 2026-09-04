/**
 * Reading a vault of Markdown.
 *
 * An import runs once, on writing somebody cannot get back, so the half of this
 * file that matters is what it must not do: eat the first paragraph of a note
 * that opens with a rule, invent a folder from a path that climbs out of the
 * vault, point a link at a plausible note rather than the named one, or drop a
 * file without saying it did.
 */

import { describe, expect, it } from "vitest";
import {
    importedTitle,
    linkIndex,
    normalizePath,
    planImport,
    rewriteWikilinks,
    splitFrontmatter,
    wikilinkTargets,
    type ImportFile
} from "../src/notes-import.js";

const plan = (files: readonly ImportFile[], keepFolders = true) =>
    planImport(files, { keepFolders, maxFiles: 100 });

describe("the frontmatter block", () => {
    it("is lifted off the top and kept as written", () => {
        const { frontmatter, body, fields } = splitFrontmatter(
            "---\ntitle: Migration plan\ntags: [ops]\n---\n# Heading\n\nBody text.\n"
        );
        expect(frontmatter).toBe("---\ntitle: Migration plan\ntags: [ops]\n---");
        expect(body).toBe("# Heading\n\nBody text.\n");
        expect(fields.title).toBe("Migration plan");
    });

    it("is only a block that opens on the first line", () => {
        // A `---` further down is a horizontal rule somebody wrote on purpose,
        // and reading it as metadata would eat the paragraph above it.
        const text = "An opening line.\n\n---\n\nAnd more.\n";
        expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text, fields: {} });
    });

    it("leaves a file whose block never closes alone", () => {
        const text = "---\ntitle: unfinished\n\nstill going\n";
        expect(splitFrontmatter(text).frontmatter).toBeNull();
        expect(splitFrontmatter(text).body).toBe(text);
    });

    it("reads keys shallowly and quotes off, and ignores what it cannot", () => {
        const { fields } = splitFrontmatter(
            "---\ntitle: \"Quoted\"\naliases:\n  - one\n  - two\ncreated: 2026-01-02\n---\nBody\n"
        );
        expect(fields.title).toBe("Quoted");
        expect(fields.created).toBe("2026-01-02");
        // A nested list is not a key it understands, and it does not guess.
        expect(fields.aliases).toBeUndefined();
    });
});

describe("what an imported note is called", () => {
    it("is the filename, because that is what the vault links to", () => {
        expect(importedTitle("projects/Rewrite the edge.md", {}, "# Something else")).toBe(
            "Rewrite the edge"
        );
    });

    it("prefers a title somebody actually wrote in the frontmatter", () => {
        expect(importedTitle("2026-01-02.md", { title: "Standup" }, "")).toBe("Standup");
    });

    it("falls back to the first heading for a file named by date", () => {
        expect(importedTitle(".md", {}, "## Retro\n\nNotes")).toBe("Retro");
    });
});

describe("a path from a zip somebody else wrote", () => {
    it("is read with either separator and no leading dot", () => {
        expect(normalizePath("./notes\\daily/today.md")).toBe("notes/daily/today.md");
    });

    it("cannot climb out of the vault", () => {
        expect(normalizePath("../../etc/passwd.md")).toBe("etc/passwd.md");
        expect(normalizePath("../..")).toBe("");
    });
});

describe("the plan", () => {
    it("makes every folder on the way down, parents first", () => {
        const { folders, notes } = plan([
            { path: "work/clients/acme/kickoff.md", text: "Hello" },
            { path: "work/notes.md", text: "Hello" }
        ]);
        expect(folders).toEqual(["work", "work/clients", "work/clients/acme"]);
        expect(notes.map((note) => note.folder)).toEqual(["work/clients/acme", "work"]);
    });

    it("files everything flat when the folders are not wanted", () => {
        const { folders, notes } = plan([{ path: "a/b/c.md", text: "Hello" }], false);
        expect(folders).toEqual([]);
        expect(notes[0]?.folder).toBeNull();
    });

    it("says what it left behind rather than dropping it quietly", () => {
        const { notes, skipped } = plan([
            { path: "vault/note.md", text: "Kept" },
            { path: "vault/photo.png", text: "binary" },
            { path: "vault/blank.md", text: "   \n" }
        ]);
        expect(notes.map((note) => note.path)).toEqual(["vault/note.md"]);
        expect(skipped).toEqual([
            { path: "vault/photo.png", reason: "not a text file" },
            { path: "vault/blank.md", reason: "empty" }
        ]);
    });

    it("stops at the ceiling and reports the rest", () => {
        const files = Array.from({ length: 4 }, (_, at) => ({ path: `${at}.md`, text: "x" }));
        const { notes, skipped } = planImport(files, { keepFolders: true, maxFiles: 2 });
        expect(notes).toHaveLength(2);
        expect(skipped.every((entry) => entry.reason === "too many files")).toBe(true);
    });
});

describe("the links a vault has to itself", () => {
    const notes = plan([
        { path: "Meeting notes.md", text: "a" },
        { path: "projects/Edge rewrite.md", text: "b" }
    ]).notes;
    const index = linkIndex(notes);
    const ids = { "Meeting notes.md": "11111111-1111-4111-8111-111111111111" } as Record<string, string>;
    const resolve = (target: string) => {
        const path = index.get(target);
        return path ? (ids[path] ?? null) : null;
    };

    it("finds a note by bare name, by filename and by path", () => {
        expect(index.get("meeting notes")).toBe("Meeting notes.md");
        expect(index.get("meeting notes.md")).toBe("Meeting notes.md");
        expect(index.get("projects/edge rewrite")).toBe("projects/Edge rewrite.md");
    });

    it("becomes a Polaris address, keeping an alias where one was written", () => {
        expect(rewriteWikilinks("See [[Meeting notes]].", resolve)).toBe(
            `See [Meeting notes](polaris:note/${ids["Meeting notes.md"]}).`
        );
        expect(rewriteWikilinks("See [[Meeting notes|the notes]].", resolve)).toBe(
            `See [the notes](polaris:note/${ids["Meeting notes.md"]}).`
        );
    });

    it("keeps the heading a link pointed at, since Polaris has no address for one", () => {
        expect(rewriteWikilinks("[[Meeting notes#Actions]]", resolve)).toBe(
            `[Meeting notes#Actions](polaris:note/${ids["Meeting notes.md"]})`
        );
    });

    it("leaves a link nothing answers for exactly as it was written", () => {
        // A dead link that still says what it was looking for is more use than a
        // live one pointing somewhere else.
        expect(rewriteWikilinks("[[Edge rewrite]]", resolve)).toBe("[[Edge rewrite]]");
        expect(rewriteWikilinks("[[Never existed]]", resolve)).toBe("[[Never existed]]");
    });

    it("leaves an embed alone, because it is not a link", () => {
        expect(rewriteWikilinks("![[Meeting notes]]", resolve)).toBe("![[Meeting notes]]");
    });

    it("lists what a body is looking for", () => {
        expect(wikilinkTargets("[[One]] and [[Two|second]] and ![[Three]]")).toEqual(["one", "two"]);
    });
});
