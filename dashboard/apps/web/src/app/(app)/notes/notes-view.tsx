"use client";

/**
 * Notes: the drafting surface beside the work.
 *
 * Two panes, because that is what a notebook is: everything you have on the
 * left, the one you are in on the right. The left pane is a tree rather than a
 * list - notes nest, and a flat list of forty is a filing problem that the
 * indentation solves for free.
 *
 * It saves itself. A note is not a form, so there is no moment at which
 * somebody has finished with it, and asking them to press Save is asking them
 * to remember something the machine already knows.
 */

import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { NoteMoveDialog } from "./note-move-dialog";
import { RelativeTime } from "@/components/relative-time";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NoteSummary, NoteView } from "@/lib/notes/note-service";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import { Archive, ChevronRight, CornerDownRight, MoreHorizontal, Move, Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import {
    cn,
    Button,
    EmptyState,
    ConfirmDeleteDialog,
    Input,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";

/** How long a note sits untouched before it is written. Long enough not to
 *  write on every keystroke, short enough that closing the tab is safe. */
const SAVE_AFTER = 800;

/** Where the collapsed branches are remembered. Per-browser rather than stored:
 *  which parts of your own tree are folded is a property of the window you are
 *  looking at, not of the notes. */
const COLLAPSED_KEY = "polaris.notes.collapsed";

export function NotesView({
    notes,
    note
}: {
    notes: readonly NoteSummary[];
    note: NoteView | null;
}) {
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [title, setTitle] = useState(note?.title ?? "");
    const [body, setBody] = useState(note?.body ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [moving, setMoving] = useState(false);
    const [collapsed, setCollapsed] = useState<readonly string[]>([]);

    // What was last written, so an unchanged note is never saved and the
    // "Saved" line is not a guess.
    const stored = useRef({ title: note?.title ?? "", body: note?.body ?? "" });

    useEffect(() => {
        setTitle(note?.title ?? "");
        setBody(note?.body ?? "");
        stored.current = { title: note?.title ?? "", body: note?.body ?? "" };
        setError("");
    }, [note?.id, note?.title, note?.body]);

    // Read after mount rather than during render: the server has no window, and
    // a first paint that differed from the second would be a hydration error.
    useEffect(() => {
        const saved = window.localStorage.getItem(COLLAPSED_KEY);
        if (!saved) return;
        try {
            const parsed: unknown = JSON.parse(saved);
            if (Array.isArray(parsed)) setCollapsed(parsed.filter((id) => typeof id === "string"));
        } catch {
            // Somebody else's key, or a half-written one. Start expanded.
        }
    }, []);

    const toggle = (id: string) => {
        setCollapsed((current) => {
            const next = current.includes(id)
                ? current.filter((entry) => entry !== id)
                : [...current, id];
            window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
            return next;
        });
    };

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

    const open = (id: string) => router.push(`/notes?note=${id}`);

    const create = async (parentId: string | null) => {
        const result = await runAction(
            () => actions.createNoteAction({ title: "Untitled", body: "", parentId }),
            setError
        );
        if (result?.id) open(result.id);
        else router.refresh();
    };

    const act = async (run: () => Promise<{ error?: string }>) => {
        const result = await runAction(run, setError);
        if (!result?.error) router.refresh();
    };

    const term = query.trim().toLowerCase();

    /**
     * What the sidebar draws.
     *
     * Searching flattens the tree on purpose: the answer to "where is the note
     * about X" is the note, and hiding it two levels inside a collapsed branch
     * because its parent did not match is the one thing a search must not do.
     */
    const shown = useMemo(() => {
        if (term) {
            return notes
                .filter(
                    (entry) =>
                        entry.title.toLowerCase().includes(term) ||
                        entry.excerpt.toLowerCase().includes(term)
                )
                .map((entry) => ({ ...entry, depth: 0, hasChildren: false }));
        }
        const hidden = new Set<string>();
        return notes.filter((entry) => {
            if (entry.parentId !== null && hidden.has(entry.parentId)) {
                hidden.add(entry.id);
                return false;
            }
            if (collapsed.includes(entry.id)) hidden.add(entry.id);
            return true;
        });
    }, [notes, term, collapsed]);

    const ancestors = useMemo(() => trail(notes, note?.id ?? null), [notes, note?.id]);
    const childCount = notes.filter((entry) => entry.parentId === note?.id).length;

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
                        onClick={() => void create(null)}
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
                                <NoteRow
                                    entry={entry}
                                    active={note?.id === entry.id}
                                    collapsed={collapsed.includes(entry.id)}
                                    onOpen={() => open(entry.id)}
                                    onToggle={() => toggle(entry.id)}
                                    onAddChild={() => void create(entry.id)}
                                    onPin={() =>
                                        void act(() =>
                                            actions.updateNoteAction({
                                                noteId: entry.id,
                                                pinned: !entry.pinned
                                            })
                                        )
                                    }
                                    onArchive={() =>
                                        void act(() =>
                                            actions.updateNoteAction({
                                                noteId: entry.id,
                                                archived: true
                                            })
                                        )
                                    }
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </aside>

            <div className="flex min-w-0 flex-1 flex-col gap-3">
                {!note ? (
                    <EmptyState
                        title="Pick a note, or write a new one."
                        description="Nobody else can read these."
                    />
                ) : (
                    <>
                        {ancestors.length > 0 && (
                            <nav
                                aria-label="Where this note sits"
                                className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
                            >
                                {ancestors.map((step) => (
                                    <span key={step.id} className="flex items-center gap-1">
                                        <button
                                            type="button"
                                            onClick={() => open(step.id)}
                                            className="max-w-[14rem] truncate rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
                                        >
                                            {step.title}
                                        </button>
                                        <ChevronRight className="size-3 shrink-0" />
                                    </span>
                                ))}
                            </nav>
                        )}

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
                                onClick={() =>
                                    void act(() =>
                                        actions.updateNoteAction({
                                            noteId: note.id,
                                            pinned: !note.pinned
                                        })
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
                                onClick={() => setMoving(true)}
                                className="mt-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <Move className="size-4" />
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
                                className="mt-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
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
                            <p
                                role="alert"
                                className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
                            >
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

                        <NoteMoveDialog
                            open={moving}
                            onOpenChange={setMoving}
                            notes={notes}
                            noteId={note.id}
                            parentId={note.parentId}
                            onMove={async (parentId) => {
                                const result = await actions.moveNoteAction({
                                    noteId: note.id,
                                    parentId
                                });
                                if (!result.error) router.refresh();
                                return result;
                            }}
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
                                    : "Nobody else could read it, and nothing else links to it."
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
        </div>
    );
}

/** One row of the tree: the disclosure arrow, the title, and what can be done to
 *  it without opening it. */
function NoteRow({
    entry,
    active,
    collapsed,
    onOpen,
    onToggle,
    onAddChild,
    onPin,
    onArchive
}: {
    entry: NoteSummary;
    active: boolean;
    collapsed: boolean;
    onOpen: () => void;
    onToggle: () => void;
    onAddChild: () => void;
    onPin: () => void;
    onArchive: () => void;
}) {
    return (
        <div
            className={cn(
                "group flex items-center gap-0.5 rounded-md pr-1 transition-colors hover:bg-muted",
                active && "bg-muted"
            )}
            style={{ paddingLeft: `${entry.depth * 0.75}rem` }}
        >
            {entry.hasChildren ? (
                <button
                    type="button"
                    onClick={onToggle}
                    aria-label={collapsed ? `Show what is under ${entry.title}` : `Hide what is under ${entry.title}`}
                    aria-expanded={!collapsed}
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                    <ChevronRight
                        className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")}
                    />
                </button>
            ) : (
                <span className="w-[1.125rem] shrink-0" aria-hidden="true" />
            )}

            <button
                type="button"
                onClick={onOpen}
                className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pr-1 text-left"
            >
                <span className="flex min-w-0 items-center gap-1.5">
                    {entry.pinned && <Pin className="size-3 shrink-0 text-primary" />}
                    <span className="truncate text-sm font-medium" title={entry.title}>
                        {entry.title}
                    </span>
                </span>
                {entry.excerpt && (
                    <span className="truncate text-xs text-muted-foreground" title={entry.excerpt}>
                        {entry.excerpt}
                    </span>
                )}
            </button>

            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={`More for ${entry.title}`}
                        className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                    >
                        <MoreHorizontal className="size-3.5" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={onAddChild}>
                        <CornerDownRight className="size-3.5" />
                        Add a note under this
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onPin}>
                        {entry.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                        {entry.pinned ? "Unpin" : "Pin to the top"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={onArchive}>
                        <Archive className="size-3.5" />
                        Archive
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

/** The notes above this one, outermost first. Empty at the top level. */
function trail(
    notes: readonly NoteSummary[],
    noteId: string | null
): { id: string; title: string }[] {
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
                    if (result?.id) router.push(`/notes?note=${result.id}`);
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
