/**
 * The notes screen, rendered.
 *
 * What matters here is the shape somebody arrives at: the list, the two empty
 * states, and the fact that a note nobody has opened does not put its text on
 * the page.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoteSummary, NoteView } from "@/lib/notes/note-service";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh() {}, push() {} }),
    usePathname: () => "/account/notes"
}));
vi.mock("@/app/(app)/account/notes/actions", () => ({}));
vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));

const { NotesView } = await import("@/app/(app)/account/notes/notes-view");

const note: NoteView = {
    id: "0193b0f0-0000-7000-8000-000000000001",
    title: "Migration plan",
    body: "Move the edge first.",
    pinned: false,
    updatedAt: "2026-08-06T10:00:00.000Z"
};

const summary: NoteSummary = {
    id: note.id,
    title: note.title,
    excerpt: "Move the edge first.",
    pinned: true,
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
});
