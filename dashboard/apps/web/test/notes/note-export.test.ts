/**
 * What comes back when somebody exports.
 *
 * A zip is the right shape for a notebook and the wrong shape for one note: it
 * is a folder to open and a file to drag out of it before anybody can read what
 * they already had, and on a phone it is mostly a file that will not open. So
 * the rule is the count rather than the scope - a folder holding a single note
 * hands back that note too, and a note with pages under it is still an archive.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    title: string;
    body: string;
    frontmatter: string | null;
    folderId: string | null;
    parentId: string | null;
}

let notes: Row[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        note: { findMany: async () => notes },
        noteFolder: { findMany: async () => [] },
        noteSpace: { findUnique: async () => ({ name: "Work" }) }
    }
}));

vi.mock("../../src/lib/notes/access", () => ({
    requireNote: async () => ({ spaceId: null }),
    requireFolder: async () => ({ spaceId: null }),
    requireSpace: async () => undefined,
    NoteAccessError: class extends Error {}
}));

const { exportArchive } = await import("../../src/lib/notes/export-service");

const me = { id: "u1", isAdmin: false };

function note(over: Partial<Row> & { id: string; title: string }): Row {
    return { body: "the body", frontmatter: null, folderId: null, parentId: null, ...over };
}

beforeEach(() => {
    notes = [];
});

describe("exporting one note", () => {
    beforeEach(() => {
        notes = [note({ id: "n1", title: "Standup" })];
    });

    it("hands back the Markdown itself, not an archive holding it", async () => {
        const archive = await exportArchive(me, { kind: "note", id: "n1" });

        expect(archive.contentType).toBe("text/markdown; charset=utf-8");
        expect(archive.name).toBe("Standup.md");
        expect(archive.notes).toBe(1);
        expect(new TextDecoder().decode(archive.bytes)).toContain("the body");
    });

    // The zip magic number. Worth asserting on the bytes rather than on the name:
    // a download named .md whose content is a zip is the same bug wearing a hat.
    it("is not a zip in disguise", async () => {
        const archive = await exportArchive(me, { kind: "note", id: "n1" });
        expect([...archive.bytes.slice(0, 2)]).not.toEqual([0x50, 0x4b]);
    });
});

describe("exporting more than one", () => {
    it("stays a zip once there is a second file", async () => {
        notes = [note({ id: "n1", title: "Standup" }), note({ id: "n2", title: "Notes", parentId: "n1" })];
        const archive = await exportArchive(me, { kind: "note", id: "n1" });

        expect(archive.contentType).toBe("application/zip");
        expect(archive.name).toBe("Standup.zip");
        expect(archive.notes).toBe(2);
        expect([...archive.bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
    });

    // The count decides, not the scope: a shelf that happens to hold one note is
    // one file, and wrapping it would be the same needless folder.
    it("hands back one file for a notebook that holds one note", async () => {
        notes = [note({ id: "n1", title: "Standup" })];
        const archive = await exportArchive(me, { kind: "space", id: "s1" });

        expect(archive.contentType).toBe("text/markdown; charset=utf-8");
        expect(archive.name).toBe("Standup.md");
    });
});
