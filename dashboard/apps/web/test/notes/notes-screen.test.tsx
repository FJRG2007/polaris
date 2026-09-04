/**
 * The notes screen, rendered.
 *
 * What matters here is the shape somebody arrives at: the shelves and the tree
 * on each, the two empty states, the fact that a note nobody has opened does not
 * put its text on the page, and that a note inside another says where it sits.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShelfData } from "@/app/(app)/notes/note-tree";
import type { NoteSummary, NoteView } from "@/lib/notes/note-service";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh() {}, push() {} }),
    usePathname: () => "/notes"
}));
vi.mock("@/app/(app)/notes/actions", () => ({}));
vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));

const { NotesView } = await import("@/app/(app)/notes/notes-view");

const note: NoteView = {
    id: "0193b0f0-0000-7000-8000-000000000001",
    title: "Migration plan",
    body: "Move the edge first.",
    pinned: false,
    parentId: null,
    spaceId: null,
    folderId: null,
    updatedAt: "2026-08-06T10:00:00.000Z"
};

const summary: NoteSummary = {
    id: note.id,
    title: note.title,
    excerpt: "Move the edge first.",
    pinned: true,
    parentId: null,
    folderId: null,
    depth: 0,
    hasChildren: false,
    updatedAt: note.updatedAt
};

/** The private shelf, which every account has and which is the one these render
 *  against unless a test says otherwise. */
function ownShelf(notes: readonly NoteSummary[], folders: ShelfData["folders"] = []): ShelfData {
    return { space: null, folders, notes };
}

function screen(shelves: readonly ShelfData[], open: NoteView | null): string {
    return renderToStaticMarkup(<NotesView shelves={shelves} note={open} />);
}

describe("the notes screen", () => {
    it("says so when nothing has been written yet", () => {
        const markup = screen([ownShelf([])], null);
        expect(markup).toContain("Nothing here yet.");
        expect(markup).toContain("Pick a note");
    });

    it("lists what there is, and waits to be told which one", () => {
        const markup = screen([ownShelf([summary])], null);
        expect(markup).toContain("Migration plan");
        expect(markup).toContain("Move the edge first.");
        expect(markup).toContain("Pick a note");
    });

    it("opens the one it was given", () => {
        const markup = screen([ownShelf([summary])], note);
        expect(markup).toContain('value="Migration plan"');
        expect(markup).toContain("Delete this note");
    });

    it("offers a way into what a note holds, and only when it holds something", () => {
        const parent: NoteSummary = { ...summary, hasChildren: true };
        expect(screen([ownShelf([parent])], null)).toContain("Hide what is under Migration plan");
        expect(screen([ownShelf([summary])], null)).not.toContain("Hide what is under");
    });

    it("names the shelf a note is on, and the notes above it", () => {
        const child: NoteSummary = {
            ...summary,
            id: "0193b0f0-0000-7000-8000-000000000002",
            title: "Cutover checklist",
            parentId: summary.id,
            depth: 1,
            pinned: false
        };
        const markup = screen([ownShelf([{ ...summary, hasChildren: true }, child])], {
            ...note,
            id: child.id,
            title: child.title,
            parentId: summary.id
        });
        expect(markup).toContain("Where this note sits");
        // The parent's title is on the page as the step above it, not only as a
        // sidebar row: a breadcrumb that named nothing would be decoration.
        expect(markup).toContain("Migration plan");
        expect(markup).toContain("My notes");
    });

    it("draws a folder, and the notes filed in it", () => {
        const filed: NoteSummary = { ...summary, folderId: "f1", pinned: false };
        const markup = screen(
            [
                ownShelf(
                    [filed],
                    [{ id: "f1", name: "Runbooks", icon: null, parentId: null, order: 1024 }]
                )
            ],
            null
        );
        expect(markup).toContain("Runbooks");
        expect(markup).toContain("Migration plan");
    });

    it("draws a shared notebook beside the private shelf", () => {
        const shared: ShelfData = {
            space: {
                id: "0193b0f0-0000-7000-8000-0000000000ff",
                name: "Engineering",
                icon: null,
                color: "#7c5cff",
                visibility: "private",
                orgId: null,
                role: "member"
            },
            folders: [],
            notes: [{ ...summary, id: "0193b0f0-0000-7000-8000-000000000003", title: "Oncall" }]
        };
        const markup = screen([ownShelf([]), shared], null);
        expect(markup).toContain("My notes");
        expect(markup).toContain("Engineering");
        expect(markup).toContain("Oncall");
    });

    it("does not offer to change a notebook somebody may only read", () => {
        // A guest's rows have no menu at all: an action that would be refused is
        // worse than an action that is not offered.
        const readOnly: ShelfData = {
            space: {
                id: "0193b0f0-0000-7000-8000-0000000000ee",
                name: "Handbook",
                icon: null,
                color: "#7c5cff",
                visibility: "internal",
                orgId: null,
                role: "guest"
            },
            folders: [],
            notes: [summary]
        };
        const markup = screen([readOnly], null);
        expect(markup).toContain("Handbook");
        expect(markup).not.toContain("New note in Handbook");
    });
});
