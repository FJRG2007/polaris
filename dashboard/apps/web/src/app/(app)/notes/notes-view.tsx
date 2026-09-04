"use client";

/**
 * Notes: the drafting surface beside the work.
 *
 * Two panes, because that is what a notebook is: everything you have on the
 * left, the one you are in on the right. The left pane is `note-tree` - shelves,
 * folders and notes, each of which right-clicks to what can be done to it.
 *
 * It saves itself. A note is not a form, so there is no moment at which somebody
 * has finished with it, and asking them to press Save is asking them to remember
 * something the machine already knows.
 */

import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { NoteMoveDialog } from "./note-move-dialog";
import { NoteShareDialog } from "./note-share-dialog";
import { NoteTree, type ShelfData } from "./note-tree";
import { RelativeTime } from "@/components/relative-time";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteSummary, NoteView } from "@/lib/notes/note-service";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import { Button, ConfirmDeleteDialog, EmptyState, Input } from "@polaris/ui";
import { Archive, ChevronRight, Download, Move, Pin, PinOff, Plus, Share2, Trash2 } from "lucide-react";
import { ImportNotesDialog, NewNotebookDialog, NotebookPeopleDialog } from "./notebook-dialogs";

/** How long a note sits untouched before it is written. Long enough not to
 *  write on every keystroke, short enough that closing the tab is safe. */
const SAVE_AFTER = 800;

export function NotesView({ shelves, note }: { shelves: readonly ShelfData[]; note: NoteView | null }) {
    const router = useRouter();
    const [title, setTitle] = useState(note?.title ?? "");
    const [body, setBody] = useState(note?.body ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [moving, setMoving] = useState<string | null>(null);
    const [sharing, setSharing] = useState<string | null>(null);
    const [newNotebook, setNewNotebook] = useState(false);
    const [people, setPeople] = useState<string | null>(null);
    const [importing, setImporting] = useState<{
        spaceId: string | null;
        folderId: string | null;
        name: string;
    } | null>(null);

    // What was last written, so an unchanged note is never saved and the
    // "Saved" line is not a guess.
    const stored = useRef({ title: note?.title ?? "", body: note?.body ?? "" });

    useEffect(() => {
        setTitle(note?.title ?? "");
        setBody(note?.body ?? "");
        stored.current = { title: note?.title ?? "", body: note?.body ?? "" };
        setError("");
    }, [note?.id, note?.title, note?.body]);

    const dirty = Boolean(note) && (title !== stored.current.title || body !== stored.current.body);

    useEffect(() => {
        if (!note || !dirty) return;
        const timer = setTimeout(async () => {
            setSaving(true);
            const written = { title: title.trim() || "Untitled", body };
            const result = await runAction(
                () => actions.updateNoteAction({ noteId: note.id, ...written }),
                setError
            );
            setSaving(false);
            if (result?.error) {
                setError(result.error);
                return;
            }
            // Recorded before the refresh: the list re-renders with the new
            // title, and without this the note would look dirty again.
            stored.current = { title, body };
            router.refresh();
        }, SAVE_AFTER);
        return () => clearTimeout(timer);
    }, [note, dirty, title, body, router]);

    const act = async (run: () => Promise<{ error?: string }>) => {
        const result = await runAction(run, setError);
        if (!result?.error) router.refresh();
    };

    /** Every note on every shelf, which is what a breadcrumb is read from - the
     *  open note may be on a shelf that is not the one being browsed. */
    const everything = useMemo(() => shelves.flatMap((shelf) => shelf.notes), [shelves]);
    const ancestors = useMemo(() => trail(everything, note?.id ?? null), [everything, note?.id]);
    const childCount = everything.filter((entry) => entry.parentId === note?.id).length;
    const shelfName =
        shelves.find((shelf) => (shelf.space?.id ?? null) === (note?.spaceId ?? null))?.space?.name ??
        "My notes";

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <NoteTree
                shelves={shelves}
                activeNoteId={note?.id ?? null}
                onNewNotebook={() => setNewNotebook(true)}
                onPeople={setPeople}
                onImport={(where) =>
                    setImporting({
                        ...where,
                        name:
                            shelves.find((shelf) => (shelf.space?.id ?? null) === where.spaceId)?.space
                                ?.name ?? "My notes"
                    })
                }
                onMoveNote={setMoving}
                onShareNote={setSharing}
            />

            <div className="flex min-w-0 flex-1 flex-col gap-3">
                {!note ? (
                    <EmptyState
                        title="Pick a note, or write a new one."
                        description="Your own notes are yours alone. A notebook is shared with the people on it."
                    />
                ) : (
                    <>
                        <nav
                            aria-label="Where this note sits"
                            className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
                        >
                            <span className="rounded px-1 py-0.5">{shelfName}</span>
                            <ChevronRight className="size-3 shrink-0" />
                            {ancestors.map((step) => (
                                <span key={step.id} className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        title={step.title}
                                        onClick={() => router.push(`/notes?note=${step.id}`)}
                                        className="max-w-[14rem] truncate rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        {step.title}
                                    </button>
                                    <ChevronRight className="size-3 shrink-0" />
                                </span>
                            ))}
                        </nav>

                        <div className="flex items-start gap-2">
                            <Input
                                value={title}
                                aria-label="Note title"
                                placeholder="Untitled"
                                onChange={(event) => setTitle(event.target.value)}
                                bare
                                className="h-auto flex-1 text-2xl font-semibold"
                            />
                            <button
                                type="button"
                                aria-label={note.pinned ? "Unpin this note" : "Pin this note"}
                                title={note.pinned ? "Unpin" : "Pin to the top"}
                                onClick={() =>
                                    void act(() =>
                                        actions.updateNoteAction({ noteId: note.id, pinned: !note.pinned })
                                    )
                                }
                                className="mt-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                {note.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                            </button>
                            <button
                                type="button"
                                aria-label="Move this note"
                                title="Move"
                                onClick={() => setMoving(note.id)}
                                className="mt-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <Move className="size-4" />
                            </button>
                            <button
                                type="button"
                                aria-label="Share this note by link"
                                title="Share"
                                onClick={() => setSharing(note.id)}
                                className="mt-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <Share2 className="size-4" />
                            </button>
                            <button
                                type="button"
                                aria-label="Export this note as Markdown"
                                title="Export"
                                onClick={() =>
                                    window.location.assign(`/api/notes/export?scope=note&id=${note.id}`)
                                }
                                className="mt-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <Download className="size-4" />
                            </button>
                            <button
                                type="button"
                                aria-label="Archive this note"
                                title="Archive"
                                onClick={() =>
                                    void act(async () => {
                                        const result = await actions.updateNoteAction({
                                            noteId: note.id,
                                            archived: true
                                        });
                                        if (!result.error) router.push("/notes");
                                        return result;
                                    })
                                }
                                className="mt-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <Archive className="size-4" />
                            </button>
                            <button
                                type="button"
                                aria-label="Delete this note"
                                title="Delete"
                                onClick={() => setConfirmDelete(true)}
                                className="mt-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                            >
                                <Trash2 className="size-4" />
                            </button>
                        </div>

                        <p className="text-xs text-muted-foreground" aria-live="polite">
                            {saving ? (
                                "Saving"
                            ) : dirty ? (
                                "Unsaved changes"
                            ) : (
                                <>
                                    Saved <RelativeTime iso={note.updatedAt} />
                                </>
                            )}
                        </p>

                        {error && (
                            <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                                {error}
                            </p>
                        )}

                        <RichTextEditor
                            key={note.id}
                            value={body}
                            onChange={setBody}
                            placeholder="Type / for a block, @ for somebody, # for a task."
                            className="min-h-[24rem] flex-1"
                        />

                        <ConfirmDeleteDialog
                            open={confirmDelete}
                            onOpenChange={setConfirmDelete}
                            name={note.title}
                            kind="note"
                            requireTyping={false}
                            description={
                                childCount > 0
                                    ? `${childCount === 1 ? "One note sits" : `${childCount} notes sit`} under this one. They are kept, and move up to where this note was.`
                                    : "Nothing else links to it."
                            }
                            confirmLabel="Delete note"
                            onConfirm={async () => {
                                await runAction(() => actions.deleteNoteAction(note.id), setError);
                                setConfirmDelete(false);
                                router.push("/notes");
                            }}
                        />
                    </>
                )}
            </div>

            {moving && (
                <NoteMoveDialog
                    open
                    onOpenChange={(next) => !next && setMoving(null)}
                    shelves={shelves}
                    noteId={moving}
                    from={placeOf(shelves, moving)}
                    onMove={async (target) => {
                        const result = await actions.moveNoteAction({ noteId: moving, ...target });
                        if (!result.error) router.refresh();
                        return result;
                    }}
                />
            )}
            {sharing && (
                <NoteShareDialog
                    noteId={sharing}
                    noteTitle={titleOf(shelves, sharing) ?? note?.title ?? "this note"}
                    open
                    onOpenChange={(next) => !next && setSharing(null)}
                />
            )}
            <NewNotebookDialog open={newNotebook} onOpenChange={setNewNotebook} />
            <NotebookPeopleDialog spaceId={people} onOpenChange={setPeople} />
            <ImportNotesDialog target={importing} onOpenChange={setImporting} />
        </div>
    );
}

/** What a note is called, read off the shelves the page already sent - so the
 *  share dialog can name one that is not the note being edited. */
function titleOf(shelves: readonly ShelfData[], noteId: string): string | null {
    for (const shelf of shelves) {
        const found = shelf.notes.find((entry) => entry.id === noteId);
        if (found) return found.title;
    }
    return null;
}

/** Where a note is right now, read off the shelves the page already sent. */
function placeOf(shelves: readonly ShelfData[], noteId: string) {
    for (const shelf of shelves) {
        const note = shelf.notes.find((entry) => entry.id === noteId);
        if (note) {
            return {
                spaceId: shelf.space?.id ?? null,
                folderId: note.folderId,
                parentId: note.parentId
            };
        }
    }
    return { spaceId: null, folderId: null, parentId: null };
}

/** The notes above this one, outermost first. Empty at the top level. */
function trail(notes: readonly NoteSummary[], noteId: string | null): { id: string; title: string }[] {
    if (!noteId) return [];
    const byId = new Map(notes.map((entry) => [entry.id, entry]));
    const steps: { id: string; title: string }[] = [];
    let at = byId.get(noteId)?.parentId ?? null;
    while (at) {
        const parent = byId.get(at);
        if (!parent) break;
        steps.unshift({ id: parent.id, title: parent.title });
        at = parent.parentId;
    }
    return steps;
}

/** The button the page header offers, kept out of the tree so the header can
 *  place one as well. */
export function NewNoteButton() {
    const router = useRouter();
    const [error, setError] = useState("");
    return (
        <>
            <Button
                size="sm"
                onClick={async () => {
                    const result = await runAction(
                        () => actions.createNoteAction({ title: "Untitled", body: "" }),
                        setError
                    );
                    if (result?.id) router.push(`/notes?note=${result.id}`);
                    else router.refresh();
                }}
            >
                <Plus className="size-4" />
                New note
            </Button>
            {error && <span className="text-xs text-danger">{error}</span>}
        </>
    );
}
