"use client";

/**
 * Notes: the drafting surface beside the work.
 *
 * Two panes, because that is what a notebook is: everything you have on the
 * left, the one you are in on the right. Nothing here is shared, assigned or
 * scheduled - a note that needed any of those would have been a task, and
 * turning one into the other is a copy and a paste, which is a decision worth
 * making deliberately.
 *
 * It saves itself. A note is not a form, so there is no moment at which
 * somebody has finished with it, and asking them to press Save is asking them
 * to remember something the machine already knows.
 */

import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useEffect, useRef, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import { cn, Button, ConfirmDeleteDialog, Input } from "@polaris/ui";
import type { NoteSummary, NoteView } from "@/lib/notes/note-service";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";

/** How long a note sits untouched before it is written. Long enough not to
 *  write on every keystroke, short enough that closing the tab is safe. */
const SAVE_AFTER = 800;

export function NotesView({ notes, note }: { notes: readonly NoteSummary[]; note: NoteView | null }) {
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [title, setTitle] = useState(note?.title ?? "");
    const [body, setBody] = useState(note?.body ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [confirmDelete, setConfirmDelete] = useState(false);

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

    const open = (id: string) => router.push(`/account/notes?note=${id}`);

    const create = async () => {
        const result = await runAction(() => actions.createNoteAction({ title: "Untitled", body: "" }), setError);
        if (result?.id) open(result.id);
        else router.refresh();
    };

    const term = query.trim().toLowerCase();
    const shown = term
        ? notes.filter(
              (entry) =>
                  entry.title.toLowerCase().includes(term) || entry.excerpt.toLowerCase().includes(term)
          )
        : notes;

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <aside className="flex w-full flex-col gap-2 md:w-64 md:shrink-0">
                <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Find a note"
                            aria-label="Find a note"
                            className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-primary"
                        />
                    </div>
                    <button
                        type="button"
                        aria-label="New note"
                        title="New note"
                        onClick={() => void create()}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <Plus className="size-4" />
                    </button>
                </div>

                {shown.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                        {notes.length === 0 ? "Nothing written down yet." : "No note matches that."}
                    </p>
                ) : (
                    <ul className="flex flex-col gap-0.5">
                        {shown.map((entry) => (
                            <li key={entry.id}>
                                <button
                                    type="button"
                                    onClick={() => open(entry.id)}
                                    className={cn(
                                        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
                                        note?.id === entry.id && "bg-muted"
                                    )}
                                >
                                    <span className="flex items-center gap-1.5">
                                        {entry.pinned && <Pin className="size-3 shrink-0 text-primary" />}
                                        <span className="truncate text-sm font-medium" title={entry.title}>{entry.title}</span>
                                    </span>
                                    {entry.excerpt && (
                                        <span className="truncate text-xs text-muted-foreground" title={entry.excerpt}>{entry.excerpt}</span>
                                    )}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </aside>

            <div className="flex min-w-0 flex-1 flex-col gap-3">
                {!note ? (
                    <p className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
                        Pick a note, or write a new one. Nobody else can read these.
                    </p>
                ) : (
                    <>
                        <div className="flex items-start gap-2">
                            <Input
                                value={title}
                                aria-label="Note title"
                                placeholder="Untitled"
                                onChange={(event) => setTitle(event.target.value)}
                                className="h-auto flex-1 border-0 bg-transparent px-0 text-2xl font-semibold focus:border-0 focus-visible:ring-0"
                            />
                            <button
                                type="button"
                                aria-label={note.pinned ? "Unpin this note" : "Pin this note"}
                                title={note.pinned ? "Unpin" : "Pin to the top"}
                                onClick={async () => {
                                    await runAction(
                                        () => actions.updateNoteAction({ noteId: note.id, pinned: !note.pinned }),
                                        setError
                                    );
                                    router.refresh();
                                }}
                                className="mt-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                {note.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                            </button>
                            <button
                                type="button"
                                aria-label="Delete this note"
                                title="Delete"
                                onClick={() => setConfirmDelete(true)}
                                className="mt-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                            >
                                <Trash2 className="size-4" />
                            </button>
                        </div>

                        <p className="text-xs text-muted-foreground" aria-live="polite">
                            {saving ? "Saving" : dirty ? "Unsaved changes" : <>Saved <RelativeTime iso={note.updatedAt} /></>}
                        </p>

                        {error && (
                            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
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
                            description="Nobody else could read it, and nothing else links to it."
                            confirmLabel="Delete note"
                            onConfirm={async () => {
                                await runAction(() => actions.deleteNoteAction(note.id), setError);
                                setConfirmDelete(false);
                                router.push("/account/notes");
                            }}
                        />
                    </>
                )}
            </div>
        </div>
    );
}

/** The button the empty state offers, kept out of the tree above so the page
 *  header can place one as well. */
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
                    if (result?.id) router.push(`/account/notes?note=${result.id}`);
                    else router.refresh();
                }}
            >
                <Plus className="size-4" />
                New note
            </Button>
            {error && <span className="text-xs text-destructive">{error}</span>}
        </>
    );
}
