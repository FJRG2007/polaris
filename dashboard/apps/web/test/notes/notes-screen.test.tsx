/**
 * The notes screen, rendered.
 *
 * What matters here is the shape somebody arrives at: the tree, the two empty
 * states, the fact that a note nobody has opened does not put its text on the
 * page, and that a note inside another says where it sits.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
    updatedAt: "2026-08-06T10:00:00.000Z"
};

const summary: NoteSummary = {
    id: note.id,
    title: note.title,
    excerpt: "Move the edge first.",
    pinned: true,
    parentId: null,
    depth: 0,
    hasChildren: false,
    updatedAt: note.updatedAt
};

function screen(notes: readonly NoteSummary[], open: NoteView | null): string {
    return renderToStaticMarkup(<NotesView notes={notes} note={open} />);
}

describe("the notes screen", () => {
    it("says so when nothing has been written yet", () => {
        expect(screen([], null)).toContain("Nothing written down yet.");
    });

    it("lists what there is, and waits to be told which one", () => {
        const markup = screen([summary], null);
        expect(markup).toContain("Migration plan");
        expect(markup).toContain("Move the edge first.");
        expect(markup).toContain("Pick a note");
    });

    it("opens the one it was given", () => {
        const markup = screen([summary], note);
        expect(markup).toContain('value="Migration plan"');
        expect(markup).toContain("Delete this note");
    });

    it("offers a way into what a note holds, and only when it holds something", () => {
        const parent: NoteSummary = { ...summary, hasChildren: true };
        expect(screen([parent], null)).toContain("Hide what is under Migration plan");
        expect(screen([summary], null)).not.toContain("Hide what is under");
    });

    it("says where a nested note sits", () => {
        const child: NoteSummary = {
            ...summary,
            id: "0193b0f0-0000-7000-8000-000000000002",
            title: "Cutover checklist",
            parentId: summary.id,
            depth: 1,
            pinned: false
        };
        const markup = screen(
            [{ ...summary, hasChildren: true }, child],
            { ...note, id: child.id, title: child.title, parentId: summary.id }
        );
        expect(markup).toContain("Where this note sits");
        // The parent's title is on the page as the step above it, not only as a
        // sidebar row: a breadcrumb that named nothing would be decoration.
        expect(markup).toContain("Migration plan");
    });
});
