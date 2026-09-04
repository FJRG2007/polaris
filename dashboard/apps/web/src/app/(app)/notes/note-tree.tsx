"use client";

/**
 * The left pane: every shelf, its folders, and the notes on it.
 *
 * Three kinds of row and one behaviour, which is the point - a shelf, a folder
 * and a note all rename in place, all right-click to the same shaped menu, and
 * all take a drop. Somebody who has used a file manager already knows how to use
 * this, and somebody who has used Notion finds the note-inside-a-note they
 * expect underneath it.
 *
 * Searching flattens everything on purpose: the answer to "where is the note
 * about X" is the note, and hiding it inside a folded folder because its folder
 * did not match is the one thing a search must not do.
 *
 * What is collapsed is remembered per browser rather than stored, because which
 * parts of a tree are folded is a property of the window somebody is looking at
 * and not of the writing.
 */

import Fuse from "fuse.js";
import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import type { NoteSummary } from "@/lib/notes/note-service";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FolderSummary } from "@/lib/notes/shelf-service";
import {
    cn,
    Button,
    ConfirmDeleteDialog,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    Input,
    MenuShortcut
} from "@polaris/ui";
import {
    Archive,
    ChevronRight,
    CornerDownRight,
    Download,
    FilePlus2,
    Folder,
    FolderOpen,
    FolderPlus,
    Import,
    NotebookPen,
    Pencil,
    Pin,
    PinOff,
    Plus,
    Search,
    Trash2,
    Users
} from "lucide-react";

/** One shelf, as the page read it. */
export interface ShelfData {
    readonly space: {
        readonly id: string;
        readonly name: string;
        readonly icon: string | null;
        readonly color: string;
        readonly visibility: string;
        readonly orgId: string | null;
        readonly role: string;
    } | null;
    readonly folders: readonly FolderSummary[];
    readonly notes: readonly NoteSummary[];
}

/** What is being dragged, as the drop targets need to know it. */
interface Dragged {
    readonly kind: "note" | "folder";
    readonly id: string;
    readonly spaceId: string | null;
}

/** Where the folded branches are remembered. */
const COLLAPSED_KEY = "polaris.notes.collapsed";

/** The private shelf has no id, and something has to key it. */
const OWN = "own";

/**
 * Where a download comes from.
 *
 * A plain address rather than an action, because what comes back is a file and
 * only the browser can save one. Assigning it starts the download without
 * leaving the page, since the answer carries a Content-Disposition.
 */
function exportHref(scope: "note" | "folder" | "space", id: string | null): string {
    const params = new URLSearchParams({ scope });
    if (id) params.set("id", id);
    return `/api/notes/export?${params.toString()}`;
}

function download(scope: "note" | "folder" | "space", id: string | null): void {
    window.location.assign(exportHref(scope, id));
}

/**
 * The two keys every row answers to.
 *
 * Declared once because a shelf, a folder and a note all take them, and three
 * copies is three chances for one of them to stop matching what its own menu
 * says it does. A key pressed while a name is being typed is part of the name -
 * without that guard, backspacing over a folder name deletes the folder.
 */
function rowKeys(
    event: React.KeyboardEvent,
    handlers: { onRename?: () => void; onDelete?: () => void }
): void {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    if (event.key === "F2" && handlers.onRename) {
        event.preventDefault();
        event.stopPropagation();
        handlers.onRename();
        return;
    }
    if (event.key === "Delete" && handlers.onDelete) {
        event.preventDefault();
        event.stopPropagation();
        handlers.onDelete();
    }
}

const shelfKey = (shelf: ShelfData) => shelf.space?.id ?? OWN;

/** Whether a role may change what is on a shelf. The private one is always
 *  yours; a space's guests read and no more. */
function canWrite(shelf: ShelfData): boolean {
    return !shelf.space || shelf.space.role === "owner" || shelf.space.role === "admin" || shelf.space.role === "member";
}

function canAdminister(shelf: ShelfData): boolean {
    return !shelf.space || shelf.space.role === "owner" || shelf.space.role === "admin";
}

export function NoteTree({
    shelves,
    activeNoteId,
    onNewNotebook,
    onPeople,
    onImport,
    onMoveNote
}: {
    shelves: readonly ShelfData[];
    activeNoteId: string | null;
    onNewNotebook: () => void;
    onPeople: (spaceId: string) => void;
    onImport: (shelf: { spaceId: string | null; folderId: string | null }) => void;
    onMoveNote: (noteId: string) => void;
}) {
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [error, setError] = useState("");
    const [collapsed, setCollapsed] = useState<readonly string[]>([]);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [dragged, setDragged] = useState<Dragged | null>(null);
    const [over, setOver] = useState<string | null>(null);
    const [removing, setRemoving] = useState<
        { kind: "folder" | "space"; id: string; name: string; held: string } | null
    >(null);

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

    const toggle = (key: string) => {
        setCollapsed((current) => {
            const next = current.includes(key)
                ? current.filter((entry) => entry !== key)
                : [...current, key];
            window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
            return next;
        });
    };

    const act = async (run: () => Promise<{ error?: string }>) => {
        const result = await runAction(run, setError);
        if (!result?.error) router.refresh();
        return result;
    };

    const open = (id: string) => router.push(`/notes?note=${id}`);

    const create = async (where: {
        spaceId: string | null;
        folderId: string | null;
        parentId?: string | null;
    }) => {
        const result = await runAction(
            () => actions.createNoteAction({ title: "Untitled", body: "", ...where }),
            setError
        );
        if (result?.id) open(result.id);
        else router.refresh();
    };

    const addFolder = async (where: { spaceId: string | null; parentId: string | null }) => {
        const result = await runAction(
            () => actions.createFolderAction({ name: "New folder", ...where }),
            setError
        );
        if (!result?.error) {
            router.refresh();
            // Straight into a rename, because "New folder" is not what anybody
            // wanted it called.
            if (result?.id) setRenaming(`folder:${result.id}`);
        }
    };

    const drop = async (target: { spaceId: string | null; folderId: string | null }) => {
        const moving = dragged;
        setDragged(null);
        setOver(null);
        if (!moving) return;
        if (moving.kind === "note") {
            await act(() =>
                actions.moveNoteAction({
                    noteId: moving.id,
                    // Out to the top of wherever it landed: a note dropped into a
                    // folder is filed there, not nested under whatever was.
                    parentId: null,
                    spaceId: target.spaceId,
                    folderId: target.folderId
                })
            );
            return;
        }
        await act(() =>
            actions.moveFolderAction({
                folderId: moving.id,
                spaceId: target.spaceId,
                parentId: target.folderId
            })
        );
    };

    const term = query.trim();
    const everything = useMemo(
        () => shelves.flatMap((shelf) => shelf.notes.map((note) => ({ ...note, shelf }))),
        [shelves]
    );
    const index = useMemo(
        () =>
            new Fuse(everything, {
                keys: [
                    { name: "title", weight: 3 },
                    { name: "excerpt", weight: 1 }
                ],
                threshold: 0.3,
                ignoreLocation: true
            }),
        [everything]
    );

    if (term) {
        // Ranked rather than filtered: somebody looking for a note is typing a
        // title from memory, and a substring match misses a transposition or two
        // words the other way round.
        const hits = index.search(term).map((hit) => hit.item);
        return (
            <aside className="flex w-full flex-col gap-2 md:w-72 md:shrink-0">
                <TreeSearch query={query} onQuery={setQuery} onNew={() => void create({ spaceId: null, folderId: null })} />
                {hits.length === 0 ? (
                    <Empty>No note matches that.</Empty>
                ) : (
                    <ul className="flex flex-col gap-0.5">
                        {hits.map((hit) => (
                            <li key={hit.id}>
                                <button
                                    type="button"
                                    onClick={() => open(hit.id)}
                                    className={cn(
                                        "flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
                                        activeNoteId === hit.id && "bg-muted"
                                    )}
                                >
                                    <span className="truncate text-sm font-medium" title={hit.title}>{hit.title}</span>
                                    <span className="truncate text-xs text-muted-foreground">
                                        {hit.shelf.space?.name ?? "My notes"}
                                        {hit.excerpt ? ` - ${hit.excerpt}` : ""}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </aside>
        );
    }

    return (
        <aside className="flex w-full flex-col gap-3 md:w-72 md:shrink-0">
            <TreeSearch query={query} onQuery={setQuery} onNew={() => void create({ spaceId: null, folderId: null })} />

            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-2 py-1.5 text-xs text-danger">
                    {error}
                </p>
            )}

            <div className="flex flex-col gap-3">
                {shelves.map((shelf) => {
                    const key = shelfKey(shelf);
                    const folded = collapsed.includes(`shelf:${key}`);
                    return (
                        <section key={key} className="flex flex-col gap-0.5">
                            <ShelfRow
                                shelf={shelf}
                                folded={folded}
                                renaming={renaming === `space:${shelf.space?.id}`}
                                dropping={over === `shelf:${key}`}
                                onToggle={() => toggle(`shelf:${key}`)}
                                onRename={(name) => {
                                    setRenaming(null);
                                    if (shelf.space && name && name !== shelf.space.name) {
                                        void act(() =>
                                            actions.updateSpaceAction({ spaceId: shelf.space!.id, name })
                                        );
                                    }
                                }}
                                onStartRename={() => setRenaming(`space:${shelf.space?.id}`)}
                                onNewNote={() => void create({ spaceId: shelf.space?.id ?? null, folderId: null })}
                                onNewFolder={() =>
                                    void addFolder({ spaceId: shelf.space?.id ?? null, parentId: null })
                                }
                                onPeople={() => shelf.space && onPeople(shelf.space.id)}
                                onImport={() => onImport({ spaceId: shelf.space?.id ?? null, folderId: null })}
                                onExport={() => download("space", shelf.space?.id ?? null)}
                                onDelete={() =>
                                    shelf.space &&
                                    setRemoving({
                                        kind: "space",
                                        id: shelf.space.id,
                                        name: shelf.space.name,
                                        held: ""
                                    })
                                }
                                onDragOver={() => setOver(`shelf:${key}`)}
                                onDragLeave={() => setOver((at) => (at === `shelf:${key}` ? null : at))}
                                onDrop={() => void drop({ spaceId: shelf.space?.id ?? null, folderId: null })}
                            />

                            {!folded && (
                                <Branch
                                    shelf={shelf}
                                    parentId={null}
                                    depth={1}
                                    collapsed={collapsed}
                                    renaming={renaming}
                                    activeNoteId={activeNoteId}
                                    over={over}
                                    onToggle={toggle}
                                    onOpen={open}
                                    onStartRename={setRenaming}
                                    onRenameFolder={(folderId, name) => {
                                        setRenaming(null);
                                        if (name) void act(() => actions.updateFolderAction({ folderId, name }));
                                    }}
                                    onRenameNote={(noteId, title) => {
                                        setRenaming(null);
                                        if (title) void act(() => actions.updateNoteAction({ noteId, title }));
                                    }}
                                    onCreateNote={create}
                                    onCreateFolder={addFolder}
                                    onImport={onImport}
                                    onMoveNote={onMoveNote}
                                    onAct={act}
                                    onRemove={setRemoving}
                                    onDragStart={setDragged}
                                    onDragEnd={() => {
                                        setDragged(null);
                                        setOver(null);
                                    }}
                                    onOver={setOver}
                                    onDrop={drop}
                                />
                            )}
                        </section>
                    );
                })}
            </div>

            <Button size="sm" variant="ghost" onClick={onNewNotebook} className="justify-start">
                <Plus className="size-4" />
                New notebook
            </Button>

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(next) => !next && setRemoving(null)}
                name={removing?.name ?? ""}
                kind={removing?.kind === "space" ? "notebook" : "folder"}
                requireTyping={removing?.kind === "space"}
                description={
                    removing?.kind === "space"
                        ? "Everything on it goes with it: its folders and every note anybody wrote there."
                        : "What is filed in it is kept, and moves up to where the folder was."
                }
                confirmLabel={removing?.kind === "space" ? "Delete notebook" : "Delete folder"}
                onConfirm={async () => {
                    if (!removing) return;
                    await act(() =>
                        removing.kind === "space"
                            ? actions.deleteSpaceAction(removing.id)
                            : actions.deleteFolderAction(removing.id)
                    );
                    setRemoving(null);
                }}
            />
        </aside>
    );
}

function Empty({ children }: { children: React.ReactNode }) {
    return (
        <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
            {children}
        </p>
    );
}

function TreeSearch({
    query,
    onQuery,
    onNew
}: {
    query: string;
    onQuery: (value: string) => void;
    onNew: () => void;
}) {
    return (
        <div className="flex items-center gap-2">
            <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                    value={query}
                    onChange={(event) => onQuery(event.target.value)}
                    placeholder="Find a note"
                    aria-label="Find a note"
                    className="h-8 w-full rounded-md border border-border bg-field pl-7 pr-2 text-xs hover:border-border-strong focus:border-border-strong"
                />
            </div>
            <button
                type="button"
                aria-label="New note"
                title="New note"
                onClick={onNew}
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                <Plus className="size-4" />
            </button>
        </div>
    );
}

/** The name of a row, or the field that is renaming it. One component so a
 *  rename looks identical wherever it happens. */
function RowName({
    name,
    renaming,
    onCommit,
    className
}: {
    name: string;
    renaming: boolean;
    onCommit: (value: string) => void;
    className?: string;
}) {
    const [draft, setDraft] = useState(name);
    const field = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (renaming) {
            setDraft(name);
            field.current?.focus();
            field.current?.select();
        }
    }, [renaming, name]);

    if (!renaming) {
        return (
            <span className={cn("truncate", className)} title={name}>
                {name}
            </span>
        );
    }
    return (
        <Input
            ref={field}
            bare
            value={draft}
            aria-label={`Rename ${name}`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => onCommit(draft.trim())}
            onKeyDown={(event) => {
                if (event.key === "Enter") onCommit(draft.trim());
                // Escape leaves the name alone, which is what every rename
                // anywhere else does.
                if (event.key === "Escape") onCommit("");
            }}
            className={cn("h-6 flex-1 py-0 text-sm", className)}
        />
    );
}

function ShelfRow({
    shelf,
    folded,
    renaming,
    dropping,
    onToggle,
    onRename,
    onStartRename,
    onNewNote,
    onNewFolder,
    onPeople,
    onImport,
    onExport,
    onDelete,
    onDragOver,
    onDragLeave,
    onDrop
}: {
    shelf: ShelfData;
    folded: boolean;
    renaming: boolean;
    dropping: boolean;
    onToggle: () => void;
    onRename: (name: string) => void;
    onStartRename: () => void;
    onNewNote: () => void;
    onNewFolder: () => void;
    onPeople: () => void;
    onImport: () => void;
    onExport: () => void;
    onDelete: () => void;
    onDragOver: () => void;
    onDragLeave: () => void;
    onDrop: () => void;
}) {
    const name = shelf.space?.name ?? "My notes";
    const writable = canWrite(shelf);
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <div
                    onKeyDown={(event) =>
                        rowKeys(event, {
                            onRename: shelf.space && canAdminister(shelf) ? onStartRename : undefined,
                            onDelete: shelf.space && canAdminister(shelf) ? onDelete : undefined
                        })
                    }
                    onDragOver={(event) => {
                        if (!writable) return;
                        event.preventDefault();
                        onDragOver();
                    }}
                    onDragLeave={onDragLeave}
                    onDrop={(event) => {
                        event.preventDefault();
                        onDrop();
                    }}
                    className={cn(
                        "group flex items-center gap-1 rounded-md px-1 py-1 transition-colors hover:bg-muted",
                        dropping && "bg-primary/10 ring-1 ring-primary/40"
                    )}
                >
                    <button
                        type="button"
                        onClick={onToggle}
                        aria-expanded={!folded}
                        aria-label={folded ? `Show ${name}` : `Hide ${name}`}
                        className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <ChevronRight className={cn("size-3.5 transition-transform", !folded && "rotate-90")} />
                    </button>
                    {shelf.space ? (
                        <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: shelf.space.color }}
                        />
                    ) : (
                        <NotebookPen className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <RowName
                        name={name}
                        renaming={renaming}
                        onCommit={onRename}
                        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    />
                    {writable && (
                        <button
                            type="button"
                            aria-label={`New note in ${name}`}
                            title="New note"
                            onClick={onNewNote}
                            className="ml-auto rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        >
                            <Plus className="size-3.5" />
                        </button>
                    )}
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
                {writable && (
                    <>
                        <ContextMenuItem onSelect={onNewNote}>
                            <FilePlus2 className="size-3.5" />
                            New note
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={onNewFolder}>
                            <FolderPlus className="size-3.5" />
                            New folder
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={onImport}>
                            <Import className="size-3.5" />
                            Import Markdown here
                        </ContextMenuItem>
                    </>
                )}
                <ContextMenuItem onSelect={onExport}>
                    <Download className="size-3.5" />
                    Export as Markdown
                </ContextMenuItem>
                {shelf.space && canAdminister(shelf) && (
                    <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={onStartRename}>
                            <Pencil className="size-3.5" />
                            Rename
                            <MenuShortcut>F2</MenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={onPeople}>
                            <Users className="size-3.5" />
                            Who can reach this
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="danger" onSelect={onDelete}>
                            <Trash2 className="size-3.5" />
                            Delete notebook
                            <MenuShortcut>Del</MenuShortcut>
                        </ContextMenuItem>
                    </>
                )}
            </ContextMenuContent>
        </ContextMenu>
    );
}

/**
 * One level of a shelf: the folders filed at this level, then the notes.
 *
 * Recursive rather than flattened because a folder holds folders, and the
 * alternative - one list with a depth on every row - has to be rebuilt from
 * scratch every time anything moves.
 */
function Branch({
    shelf,
    parentId,
    depth,
    collapsed,
    renaming,
    activeNoteId,
    over,
    onToggle,
    onOpen,
    onStartRename,
    onRenameFolder,
    onRenameNote,
    onCreateNote,
    onCreateFolder,
    onImport,
    onMoveNote,
    onAct,
    onRemove,
    onDragStart,
    onDragEnd,
    onOver,
    onDrop
}: {
    shelf: ShelfData;
    parentId: string | null;
    depth: number;
    collapsed: readonly string[];
    renaming: string | null;
    activeNoteId: string | null;
    over: string | null;
    onToggle: (key: string) => void;
    onOpen: (id: string) => void;
    onStartRename: (key: string) => void;
    onRenameFolder: (folderId: string, name: string) => void;
    onRenameNote: (noteId: string, title: string) => void;
    onCreateNote: (where: { spaceId: string | null; folderId: string | null; parentId?: string | null }) => void;
    onCreateFolder: (where: { spaceId: string | null; parentId: string | null }) => void;
    onImport: (shelf: { spaceId: string | null; folderId: string | null }) => void;
    onMoveNote: (noteId: string) => void;
    onAct: (run: () => Promise<{ error?: string }>) => Promise<{ error?: string } | null>;
    onRemove: (target: { kind: "folder" | "space"; id: string; name: string; held: string }) => void;
    onDragStart: (dragged: Dragged) => void;
    onDragEnd: () => void;
    onOver: (key: string | null) => void;
    onDrop: (target: { spaceId: string | null; folderId: string | null }) => void;
}) {
    const spaceId = shelf.space?.id ?? null;
    const writable = canWrite(shelf);
    const folders = shelf.folders.filter((folder) => folder.parentId === parentId);
    // Only the top of each note tree: a nested note is drawn by its own parent,
    // and the service already ordered them depth-first.
    const notes = shelf.notes.filter((note) => note.folderId === parentId && note.parentId === null);

    if (folders.length === 0 && notes.length === 0) {
        return parentId === null ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">Nothing here yet.</p>
        ) : null;
    }

    return (
        <ul className="flex flex-col gap-0.5">
            {folders.map((folder) => {
                const folded = collapsed.includes(`folder:${folder.id}`);
                const key = `folder:${folder.id}`;
                return (
                    <li key={folder.id}>
                        <ContextMenu>
                            <ContextMenuTrigger asChild>
                                <div
                                    draggable={writable}
                                    onKeyDown={(event) =>
                                        rowKeys(event, {
                                            onRename: writable ? () => onStartRename(key) : undefined,
                                            onDelete: writable
                                                ? () =>
                                                      onRemove({
                                                          kind: "folder",
                                                          id: folder.id,
                                                          name: folder.name,
                                                          held: ""
                                                      })
                                                : undefined
                                        })
                                    }
                                    onDragStart={() =>
                                        onDragStart({ kind: "folder", id: folder.id, spaceId })
                                    }
                                    onDragEnd={onDragEnd}
                                    onDragOver={(event) => {
                                        if (!writable) return;
                                        event.preventDefault();
                                        onOver(key);
                                    }}
                                    onDragLeave={() => onOver(null)}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        onDrop({ spaceId, folderId: folder.id });
                                    }}
                                    className={cn(
                                        "group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-muted",
                                        over === key && "bg-primary/10 ring-1 ring-primary/40"
                                    )}
                                    style={{ paddingLeft: `${depth * 0.75}rem` }}
                                >
                                    <button
                                        type="button"
                                        onClick={() => onToggle(key)}
                                        aria-expanded={!folded}
                                        aria-label={folded ? `Open ${folder.name}` : `Close ${folder.name}`}
                                        className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                                    >
                                        <ChevronRight
                                            className={cn("size-3.5 transition-transform", !folded && "rotate-90")}
                                        />
                                    </button>
                                    {folder.icon ? (
                                        <span aria-hidden="true" className="text-sm leading-none">
                                            {folder.icon}
                                        </span>
                                    ) : folded ? (
                                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                                    ) : (
                                        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                                    )}
                                    <RowName
                                        name={folder.name}
                                        renaming={renaming === key}
                                        onCommit={(name) => onRenameFolder(folder.id, name)}
                                        className="py-1.5 text-sm"
                                    />
                                    {writable && (
                                        <button
                                            type="button"
                                            aria-label={`New note in ${folder.name}`}
                                            title="New note"
                                            onClick={() => onCreateNote({ spaceId, folderId: folder.id })}
                                            className="ml-auto rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                                        >
                                            <Plus className="size-3.5" />
                                        </button>
                                    )}
                                </div>
                            </ContextMenuTrigger>
                            {writable && (
                                <ContextMenuContent>
                                    <ContextMenuItem
                                        onSelect={() => onCreateNote({ spaceId, folderId: folder.id })}
                                    >
                                        <FilePlus2 className="size-3.5" />
                                        New note
                                    </ContextMenuItem>
                                    <ContextMenuItem
                                        onSelect={() => onCreateFolder({ spaceId, parentId: folder.id })}
                                    >
                                        <FolderPlus className="size-3.5" />
                                        New folder inside
                                    </ContextMenuItem>
                                    <ContextMenuItem
                                        onSelect={() => onImport({ spaceId, folderId: folder.id })}
                                    >
                                        <Import className="size-3.5" />
                                        Import Markdown here
                                    </ContextMenuItem>
                                    <ContextMenuItem onSelect={() => download("folder", folder.id)}>
                                        <Download className="size-3.5" />
                                        Export as Markdown
                                    </ContextMenuItem>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem onSelect={() => onStartRename(key)}>
                                        <Pencil className="size-3.5" />
                                        Rename
                                        <MenuShortcut>F2</MenuShortcut>
                                    </ContextMenuItem>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem
                                        variant="danger"
                                        onSelect={() =>
                                            onRemove({
                                                kind: "folder",
                                                id: folder.id,
                                                name: folder.name,
                                                held: ""
                                            })
                                        }
                                    >
                                        <Trash2 className="size-3.5" />
                                        Delete folder
                                        <MenuShortcut>Del</MenuShortcut>
                                    </ContextMenuItem>
                                </ContextMenuContent>
                            )}
                        </ContextMenu>

                        {!folded && (
                            <Branch
                                shelf={shelf}
                                parentId={folder.id}
                                depth={depth + 1}
                                collapsed={collapsed}
                                renaming={renaming}
                                activeNoteId={activeNoteId}
                                over={over}
                                onToggle={onToggle}
                                onOpen={onOpen}
                                onStartRename={onStartRename}
                                onRenameFolder={onRenameFolder}
                                onRenameNote={onRenameNote}
                                onCreateNote={onCreateNote}
                                onCreateFolder={onCreateFolder}
                                onImport={onImport}
                                onMoveNote={onMoveNote}
                                onAct={onAct}
                                onRemove={onRemove}
                                onDragStart={onDragStart}
                                onDragEnd={onDragEnd}
                                onOver={onOver}
                                onDrop={onDrop}
                            />
                        )}
                    </li>
                );
            })}

            {notes.map((note) => (
                <NoteBranch
                    key={note.id}
                    shelf={shelf}
                    note={note}
                    depth={depth}
                    collapsed={collapsed}
                    renaming={renaming}
                    activeNoteId={activeNoteId}
                    onToggle={onToggle}
                    onOpen={onOpen}
                    onStartRename={onStartRename}
                    onRenameNote={onRenameNote}
                    onCreateNote={onCreateNote}
                    onMoveNote={onMoveNote}
                    onAct={onAct}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                />
            ))}
        </ul>
    );
}

/** A note and everything nested under it. */
function NoteBranch({
    shelf,
    note,
    depth,
    collapsed,
    renaming,
    activeNoteId,
    onToggle,
    onOpen,
    onStartRename,
    onRenameNote,
    onCreateNote,
    onMoveNote,
    onAct,
    onDragStart,
    onDragEnd
}: {
    shelf: ShelfData;
    note: NoteSummary;
    depth: number;
    collapsed: readonly string[];
    renaming: string | null;
    activeNoteId: string | null;
    onToggle: (key: string) => void;
    onOpen: (id: string) => void;
    onStartRename: (key: string) => void;
    onRenameNote: (noteId: string, title: string) => void;
    onCreateNote: (where: { spaceId: string | null; folderId: string | null; parentId?: string | null }) => void;
    onMoveNote: (noteId: string) => void;
    onAct: (run: () => Promise<{ error?: string }>) => Promise<{ error?: string } | null>;
    onDragStart: (dragged: Dragged) => void;
    onDragEnd: () => void;
}) {
    const spaceId = shelf.space?.id ?? null;
    const writable = canWrite(shelf);
    const key = `note:${note.id}`;
    const folded = collapsed.includes(key);
    const children = shelf.notes.filter((entry) => entry.parentId === note.id);

    return (
        <li>
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div
                        draggable={writable}
                        onKeyDown={(event) =>
                            rowKeys(event, {
                                onRename: writable ? () => onStartRename(key) : undefined,
                                onDelete: writable
                                    ? () => void onAct(() => actions.deleteNoteAction(note.id))
                                    : undefined
                            })
                        }
                        onDragStart={() => onDragStart({ kind: "note", id: note.id, spaceId })}
                        onDragEnd={onDragEnd}
                        className={cn(
                            "group flex items-center gap-0.5 rounded-md pr-1 transition-colors hover:bg-muted",
                            activeNoteId === note.id && "bg-muted"
                        )}
                        style={{ paddingLeft: `${depth * 0.75}rem` }}
                    >
                        {note.hasChildren ? (
                            <button
                                type="button"
                                onClick={() => onToggle(key)}
                                aria-expanded={!folded}
                                aria-label={
                                    folded ? `Show what is under ${note.title}` : `Hide what is under ${note.title}`
                                }
                                className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <ChevronRight
                                    className={cn("size-3.5 transition-transform", !folded && "rotate-90")}
                                />
                            </button>
                        ) : (
                            <span className="w-[1.125rem] shrink-0" aria-hidden="true" />
                        )}

                        {renaming === key ? (
                            <RowName
                                name={note.title}
                                renaming
                                onCommit={(title) => onRenameNote(note.id, title)}
                                className="py-1.5 text-sm font-medium"
                            />
                        ) : (
                            <button
                                type="button"
                                onClick={() => onOpen(note.id)}
                                className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pr-1 text-left"
                            >
                                <span className="flex min-w-0 items-center gap-1.5">
                                    {note.pinned && <Pin className="size-3 shrink-0 text-primary" />}
                                    <span className="truncate text-sm font-medium" title={note.title}>
                                        {note.title}
                                    </span>
                                </span>
                                {note.excerpt && (
                                    <span
                                        className="truncate text-xs text-muted-foreground"
                                        title={note.excerpt}
                                    >
                                        {note.excerpt}
                                    </span>
                                )}
                            </button>
                        )}
                    </div>
                </ContextMenuTrigger>
                {writable && (
                    <ContextMenuContent>
                        <ContextMenuItem
                            onSelect={() =>
                                onCreateNote({ spaceId, folderId: note.folderId, parentId: note.id })
                            }
                        >
                            <CornerDownRight className="size-3.5" />
                            Add a note under this
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => onStartRename(key)}>
                            <Pencil className="size-3.5" />
                            Rename
                            <MenuShortcut>F2</MenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem
                            onSelect={() =>
                                void onAct(() =>
                                    actions.updateNoteAction({ noteId: note.id, pinned: !note.pinned })
                                )
                            }
                        >
                            {note.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                            {note.pinned ? "Unpin" : "Pin to the top"}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => onMoveNote(note.id)}>
                            <FolderPlus className="size-3.5" />
                            Move to...
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => download("note", note.id)}>
                            <Download className="size-3.5" />
                            Export as Markdown
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                            onSelect={() =>
                                void onAct(() =>
                                    actions.updateNoteAction({ noteId: note.id, archived: true })
                                )
                            }
                        >
                            <Archive className="size-3.5" />
                            Archive
                        </ContextMenuItem>
                        <ContextMenuItem
                            variant="danger"
                            onSelect={() => void onAct(() => actions.deleteNoteAction(note.id))}
                        >
                            <Trash2 className="size-3.5" />
                            Delete
                            <MenuShortcut>Del</MenuShortcut>
                        </ContextMenuItem>
                    </ContextMenuContent>
                )}
            </ContextMenu>

            {!folded && children.length > 0 && (
                <ul className="flex flex-col gap-0.5">
                    {children.map((child) => (
                        <NoteBranch
                            key={child.id}
                            shelf={shelf}
                            note={child}
                            depth={depth + 1}
                            collapsed={collapsed}
                            renaming={renaming}
                            activeNoteId={activeNoteId}
                            onToggle={onToggle}
                            onOpen={onOpen}
                            onStartRename={onStartRename}
                            onRenameNote={onRenameNote}
                            onCreateNote={onCreateNote}
                            onMoveNote={onMoveNote}
                            onAct={onAct}
                            onDragStart={onDragStart}
                            onDragEnd={onDragEnd}
                        />
                    ))}
                </ul>
            )}
        </li>
    );
}
