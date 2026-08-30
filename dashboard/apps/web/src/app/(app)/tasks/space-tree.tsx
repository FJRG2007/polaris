"use client";

/**
 * The spaces sidebar: every space, folder and list the reader can reach, and the
 * place they are rearranged from.
 *
 * This is the map of the whole app, so it is present on every task screen rather
 * than only on a "spaces" page - moving between two lists should be one click,
 * not a trip back to an index.
 *
 * Three things make it a tool rather than a menu. Folders nest as deep as the
 * work does, so one space can hold a client, that client's projects, and each
 * project's lists. Everything is rearranged by dragging, reported to the server
 * as the neighbours a row landed between rather than an index, so two people
 * tidying at once cannot renumber each other. And every row renames in place -
 * F2, Enter, or a double click - because a rename that costs a dialog is a
 * rename nobody does, and stale names are how a tree stops being trusted.
 *
 * What is open and what is closed is remembered in the browser: a tree that
 * resets itself on every navigation is a tree nobody uses twice.
 */

import Link from "next/link";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { usePathname } from "next/navigation";
import { AccessDialog, type AccessTarget } from "./access-dialog";
import { dropEdge, neighbours, type DropEdge } from "./drop-edge";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FolderSummary, ListSummary, SpaceTreeView } from "@/lib/tasks/space-service";
import { createOptionsFor, TreeCreate, type CreateAt, type CreateKind } from "./tree-create";
import {
    ChevronDown,
    ChevronRight,
    Folder,
    FolderOpen,
    FolderPlus,
    Hash,
    Pencil,
    Plus,
    Settings2,
    Trash2,
    Users
} from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input,
    Select,
    cn,
    keepFocusOnClose,
    useDeferredFocus
} from "@polaris/ui";

const COLLAPSED_KEY = "polaris.tasks.tree.collapsed";

/** What is being dragged. Kept in state rather than only in the drag payload
 *  because a drop target has to decide whether to light up before the drop. */
interface Dragged {
    readonly kind: "folder" | "list";
    readonly id: string;
    readonly spaceId: string;
}

/** Where something is being created, so the input appears in the right place. */
interface Draft {
    readonly kind: "folder" | "list";
    readonly spaceId: string;
    readonly parentId: string | null;
}

/** A delete waiting to be confirmed. `empty` is what decides how hard the
 *  confirmation is: typing the name back is a toll on losing work, and an empty
 *  list or folder has none to lose. */
type Pending = { kind: "folder" | "list"; id: string; name: string; empty: boolean } | null;

/**
 * One thing a row can do. Declared once and rendered twice - as an icon button
 * that appears on hover, and as a line in the right-click menu - so the two can
 * never drift apart. `quick` is what earns a place on the row itself; deleting
 * deliberately does not, because a dense tree and a one-click delete is how
 * somebody loses a list they meant to collapse.
 */
interface RowAction {
    readonly label: string;
    readonly Icon: typeof Pencil;
    readonly onSelect: () => void;
    readonly quick?: boolean;
    readonly danger?: boolean;
}

/**
 * The plus on a row, and the "Create new" branch of its right-click menu.
 *
 * One list of options rendered two ways. The plus is already the create button,
 * so its menu goes straight to the kinds; the right-click menu also holds rename
 * and delete, so the same kinds sit under one entry there. Both come from
 * `createOptionsFor`, which is what keeps a container from offering something it
 * cannot hold.
 *
 * A list and a folder are named in a row that appears the moment the menu closes,
 * so the menu has to leave focus in that row rather than take it back.
 */
function CreateButton({ at, onPick }: { at: CreateAt; onPick: (kind: CreateKind) => void }) {
    const options = createOptionsFor(at);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={`Create in ${at.name}`}
                    title="Create"
                    onClick={(event) => event.preventDefault()}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                >
                    <Plus className="size-3.5" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44" onCloseAutoFocus={keepFocusOnClose}>
                {options.map((option) => (
                    <DropdownMenuItem
                        key={option.kind}
                        onSelect={() => onPick(option.kind)}
                        className="gap-2"
                    >
                        <option.Icon className="size-3.5" />
                        {option.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function CreateSubmenu({ at, onPick }: { at: CreateAt; onPick: (kind: CreateKind) => void }) {
    return (
        <ContextMenuSub>
            <ContextMenuSubTrigger>
                <Plus className="size-3.5" />
                Create new
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-44">
                {createOptionsFor(at).map((option) => (
                    <ContextMenuItem
                        key={option.kind}
                        onSelect={() => onPick(option.kind)}
                        className="gap-2"
                    >
                        <option.Icon className="size-3.5" />
                        {option.label}
                    </ContextMenuItem>
                ))}
            </ContextMenuSubContent>
        </ContextMenuSub>
    );
}

function canWrite(role: string): boolean {
    return role === "owner" || role === "admin" || role === "member";
}

function canAdmin(role: string): boolean {
    return role === "owner" || role === "admin";
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

interface RowProps {
    readonly label: string;
    readonly icon: React.ReactNode;
    readonly depth: number;
    readonly href?: string;
    readonly active?: boolean;
    readonly badge?: string;
    readonly editable: boolean;
    readonly renaming: boolean;
    readonly onRename: (name: string) => void;
    readonly onRenameStart: () => void;
    readonly onRenameCancel: () => void;
    readonly actions: readonly RowAction[];
    /** Drag and drop, all optional so a row can be a source, a target, or both. */
    readonly onDragStart?: () => void;
    readonly onDragEnd?: () => void;
    readonly onDropInto?: () => void;
    /** Ordered against this row, on the side of it the pointer was on. */
    readonly onDropAt?: (edge: DropEdge) => void;
    /** Whether this row can take what is currently being dragged, and how. A row
     *  only orders against its own kind - a folder dropped between two lists has
     *  no siblings there to sit between - so the two are answered separately. */
    readonly acceptsBeside: boolean;
    readonly acceptsInto: boolean;
    /** Whether this row is the one being dragged. It still swallows the drop -
     *  letting it through would reach the space underneath, which means "put it
     *  at the root" - but it promises no line and moves nothing. */
    readonly dragged?: boolean;
    readonly expander?: React.ReactNode;
    /** The plus, shown next to the row's own quick actions. */
    readonly create?: React.ReactNode;
    /** The "Create new" branch, shown at the top of the right-click menu. */
    readonly createMenu?: React.ReactNode;
}

function TreeRow({
    label,
    icon,
    depth,
    href,
    active,
    badge,
    editable,
    renaming,
    onRename,
    onRenameStart,
    onRenameCancel,
    actions: rowActions,
    onDragStart,
    onDragEnd,
    onDropInto,
    onDropAt,
    acceptsBeside,
    acceptsInto,
    dragged,
    expander,
    create,
    createMenu
}: RowProps) {
    const [over, setOver] = useState<"into" | DropEdge | null>(null);
    // Renaming is reached from the right-click menu, which is still trapping
    // focus when the field appears; it claims focus once the menu has gone.
    const field = useDeferredFocus<HTMLInputElement>(renaming);

    if (renaming) {
        return (
            <div className="flex items-center gap-1 py-0.5" style={{ paddingLeft: depth * 12 }}>
                <Input
                    ref={field}
                    defaultValue={label}
                    aria-label={`Rename ${label}`}
                    onFocus={(event) => event.target.select()}
                    onBlur={(event) => {
                        const next = event.target.value.trim();
                        if (next && next !== label) onRename(next);
                        else onRenameCancel();
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            onRenameCancel();
                        }
                        if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                        }
                    }}
                    className="h-7 text-sm"
                />
            </div>
        );
    }

    const body = (
        <>
            {expander}
            {icon}
            <span className="flex-1 truncate text-left">{label}</span>
            {badge && <span className="text-[11px] opacity-70">{badge}</span>}
        </>
    );

    return (
        <div
            className="relative"
            draggable={Boolean(onDragStart)}
            onDragStart={(event) => {
                if (!onDragStart) return;
                event.stopPropagation();
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", label);
                onDragStart();
            }}
            onDragEnd={onDragEnd}
            onDragOver={(event) => {
                if (!acceptsBeside && !acceptsInto) return;
                event.preventDefault();
                event.stopPropagation();
                if (dragged) {
                    setOver(null);
                    return;
                }
                // A row that cannot be nested into is split down the middle, so a
                // row dragged downwards lands under the one it was released over
                // rather than above it. A folder keeps its middle for "put it
                // inside" and answers the few pixels at each end with the side
                // they are on - one target, three answers, which is what a tree
                // needs to express both reordering and nesting.
                const bounds = event.currentTarget.getBoundingClientRect();
                const edge = dropEdge(event.clientY, event.currentTarget);
                const atEnd = event.clientY - bounds.top < 6 || bounds.bottom - event.clientY < 6;
                const wantsEdge = (atEnd || !acceptsInto) && acceptsBeside;
                setOver(wantsEdge ? edge : acceptsInto ? "into" : null);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(event) => {
                if (!acceptsBeside && !acceptsInto) return;
                event.preventDefault();
                event.stopPropagation();
                const where = over;
                setOver(null);
                if (where === "into" && onDropInto) onDropInto();
                else if (where !== null && where !== "into" && onDropAt) onDropAt(where);
            }}
            onKeyDown={(event) => {
                if (event.key === "F2" && editable) {
                    event.preventDefault();
                    onRenameStart();
                }
            }}
            // Double-click renames only where the row is not also a link: the
            // first click of a double click has already navigated, so on a list
            // it would rename a row that is no longer on screen. Lists rename
            // through F2, the pencil, or the right-click menu.
            onDoubleClick={
                editable && !href
                    ? (event) => {
                          event.preventDefault();
                          onRenameStart();
                      }
                    : undefined
            }
        >
            {(over === "before" || over === "after") && (
                <span
                    aria-hidden
                    className={cn(
                        "pointer-events-none absolute left-0 z-10 h-0.5 w-full rounded bg-primary",
                        over === "before" ? "-top-px" : "-bottom-px"
                    )}
                />
            )}
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div
                        className={cn(
                            "group flex items-center gap-1.5 rounded-md pr-1 transition-colors",
                            over === "into" && "bg-primary/10 ring-1 ring-primary/40",
                            active ? "bg-muted" : "hover:bg-muted"
                        )}
                        style={{ paddingLeft: depth * 12 }}
                    >
                        {href ? (
                            <Link
                                href={href}
                                className={cn(
                                    "flex min-w-0 flex-1 items-center gap-1.5 py-1 text-sm",
                                    active ? "font-medium text-foreground" : "text-muted-foreground"
                                )}
                            >
                                {body}
                            </Link>
                        ) : (
                            <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-sm text-muted-foreground">
                                {body}
                            </div>
                        )}
                        {(rowActions.length > 0 || create) && (
                            <span className="flex shrink-0 items-center transition-opacity md:opacity-0 focus-within:opacity-100 md:group-hover:opacity-100">
                                {create}
                                {rowActions
                                    .filter((action) => action.quick)
                                    .map((action) => (
                                        <button
                                            key={action.label}
                                            type="button"
                                            aria-label={action.label}
                                            title={action.label}
                                            onClick={(event) => {
                                                event.preventDefault();
                                                action.onSelect();
                                            }}
                                            className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                                        >
                                            <action.Icon className="size-3.5" />
                                        </button>
                                    ))}
                            </span>
                        )}
                    </div>
                </ContextMenuTrigger>
                {(rowActions.length > 0 || createMenu) && (
                    <ContextMenuContent onCloseAutoFocus={keepFocusOnClose}>
                        {createMenu}
                        {createMenu && rowActions.length > 0 && <ContextMenuSeparator />}
                        {rowActions.map((action, index) => (
                            <span key={action.label}>
                                {action.danger && index > 0 && <ContextMenuSeparator />}
                                <ContextMenuItem
                                    variant={action.danger ? "danger" : "default"}
                                    onSelect={action.onSelect}
                                >
                                    <action.Icon className="size-3.5" />
                                    {action.label}
                                </ContextMenuItem>
                            </span>
                        ))}
                    </ContextMenuContent>
                )}
            </ContextMenu>
        </div>
    );
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/**
 * The spaces, folders and lists column beside every task screen.
 *
 * `canManage` is the instance permission (`tasks.manage`), not a role in any one
 * space: a role says which spaces somebody reaches, and this says whether they
 * may reshape any of them. Without it the tree drew every space a reader could
 * see with its rename, delete, create and drag affordances intact, all of which
 * bounce off the actions behind them.
 */
export function SpaceTree({
    spaces,
    canCreate,
    canManage
}: {
    spaces: readonly SpaceTreeView[];
    /** Whether this screen offers to start a new space at all. Off on the
     *  screens that read across every space rather than work inside one. */
    canCreate: boolean;
    /** Whether this account may change anything here - `tasks.manage`, held on
     *  the instance rather than in any one space. */
    canManage: boolean;
}) {
    const pathname = usePathname();
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const [draft, setDraft] = useState<Draft | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [dragging, setDragging] = useState<Dragged | null>(null);
    const [confirm, setConfirm] = useState<Pending>(null);
    const [access, setAccess] = useState<AccessTarget | null>(null);
    const [create, setCreate] = useState<{ kind: CreateKind; at: CreateAt } | null>(null);
    const [newSpace, setNewSpace] = useState(false);
    const [spaceName, setSpaceName] = useState("");
    // Who the new space would belong to. Empty until the form is opened, and
    // usually empty afterwards too - most people are in no organization, and the
    // picker is not drawn when there is only one answer.
    const [spaceOrgs, setSpaceOrgs] = useState<{ id: string; name: string }[]>([]);
    const [spaceOwner, setSpaceOwner] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        try {
            const stored = window.localStorage.getItem(COLLAPSED_KEY);
            if (stored) setCollapsed(new Set(JSON.parse(stored) as string[]));
        } catch {
            // A tree that will not draw because a stored preference is malformed
            // is worse than one that forgets what was closed.
        }
    }, []);

    const remember = (next: ReadonlySet<string>) => {
        setCollapsed(next);
        try {
            window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
        } catch {
            // Private browsing refuses the write; the tree still works this visit.
        }
    };

    const toggle = (key: string) => {
        const next = new Set(collapsed);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        remember(next);
    };

    /** Open everything on the way to a row, in one write. Two toggles in a row
     *  both read the same state, so the second undoes the first and whatever was
     *  about to appear stays hidden inside a folder nobody opened. */
    const reveal = (...keys: readonly (string | null)[]) => {
        if (!keys.some((key) => key !== null && collapsed.has(key))) return;
        const next = new Set(collapsed);
        for (const key of keys) if (key) next.delete(key);
        remember(next);
    };

    const run = async (call: () => Promise<{ error?: string }>) => {
        setError("");
        const result = await runAction(call, setError);
        if (result?.error) setError(result.error);
    };

    // Stable, because it is a dependency of the fetch that opens a create dialog:
    // a fresh arrow every render sends that effect round again on every keystroke
    // anywhere in the tree.
    const closeCreate = useCallback(() => setCreate(null), []);

    /**
     * What "create a <kind> here" means.
     *
     * A list and a folder are only a name, so they are typed into the tree where
     * they will appear - naming a thing in the place it is going is faster and
     * says more than a dialog does. Everything else needs more than a name and
     * goes to TreeCreate.
     */
    const pickCreate = (kind: CreateKind, at: CreateAt) => {
        if (kind === "list" || kind === "folder") {
            setDraft({ kind, spaceId: at.spaceId, parentId: at.folderId });
            // A container is opened when something is being put into it, or the
            // new row appears somewhere nobody is looking.
            reveal(at.spaceId, at.folderId);
            return;
        }
        setCreate({ kind, at });
    };

    const dropFolder = (
        spaceId: string,
        parentId: string | null,
        position: { beforeId: string | null; afterId: string | null }
    ) => {
        if (!dragging || dragging.spaceId !== spaceId) return;
        const move = { parentId, ...position };
        const { kind, id } = dragging;
        setDragging(null);
        void run(() =>
            kind === "folder"
                ? actions.moveFolderAction(id, move)
                : actions.moveListAction(id, move)
        );
    };

    return (
        <nav aria-label="Spaces" className="flex w-full flex-col gap-3 md:w-60 md:shrink-0">
            <div className="flex items-center justify-between">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Spaces
                </h2>
                {canManage && canCreate && (
                    <button
                        type="button"
                        aria-label="Create a space"
                        title="Create a space"
                        onClick={() => {
                            const opening = !newSpace;
                            setNewSpace(opening);
                            if (!opening) return;
                            void (async () => {
                                const result = await runAction(
                                    () => actions.spaceOwnerOptionsAction(),
                                    setError
                                );
                                setSpaceOrgs(result?.orgs ?? []);
                            })();
                        }}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <Plus className="size-3.5" />
                    </button>
                )}
            </div>

            {newSpace && (
                <div className="flex flex-col gap-2 rounded-md border border-border p-2">
                    <Input
                        autoFocus
                        value={spaceName}
                        placeholder="Space name"
                        onChange={(event) => setSpaceName(event.target.value)}
                        className="h-8 text-sm"
                    />
                    {spaceOrgs.length > 0 && (
                        <Select
                            value={spaceOwner}
                            aria-label="Who this space belongs to"
                            className="h-8 text-sm"
                            options={[
                                { value: "", label: "Your own space" },
                                ...spaceOrgs.map((org) => ({ value: org.id, label: org.name }))
                            ]}
                            onValueChange={setSpaceOwner}
                        />
                    )}
                    <div className="flex gap-2">
                        <Button
                            size="sm"
                            disabled={!spaceName.trim()}
                            onClick={async () => {
                                await run(() =>
                                    actions.createSpaceAction({
                                        name: spaceName.trim(),
                                        orgId: spaceOwner || null
                                    })
                                );
                                setSpaceName("");
                                setSpaceOwner("");
                                setNewSpace(false);
                            }}
                        >
                            Create
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setNewSpace(false)}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}

            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-2 py-1.5 text-xs text-danger">
                    {error}
                </p>
            )}

            {spaces.length === 0 && (
                <p className="text-xs text-muted-foreground">
                    No spaces yet. A space holds the lists one team works out of.
                </p>
            )}

            {spaces.map((space) => (
                <SpaceSection
                    key={space.id}
                    space={space}
                    canManage={canManage}
                    pathname={pathname}
                    collapsed={collapsed}
                    onToggle={toggle}
                    draft={draft}
                    onDraft={setDraft}
                    renaming={renaming}
                    onRenaming={setRenaming}
                    dragging={dragging}
                    onDragging={setDragging}
                    onDrop={dropFolder}
                    onConfirm={setConfirm}
                    onAccess={setAccess}
                    onCreate={pickCreate}
                    run={run}
                />
            ))}

            <TreeCreate
                request={create}
                onClose={closeCreate}
                onDone={closeCreate}
                onError={setError}
            />

            <AccessDialog target={access} onClose={() => setAccess(null)} />

            <ConfirmDeleteDialog
                open={confirm !== null}
                onOpenChange={(open) => (open ? undefined : setConfirm(null))}
                name={confirm?.name ?? ""}
                kind={confirm?.kind ?? "folder"}
                requireTyping={!confirm?.empty}
                description={
                    confirm?.empty
                        ? "It is empty, so nothing goes with it."
                        : confirm?.kind === "folder"
                          ? "What is inside moves up one level rather than being deleted with it."
                          : "The tasks in this list, and their comments and tracked time, go with it."
                }
                confirmLabel={confirm?.kind === "folder" ? "Delete folder" : "Delete list"}
                onConfirm={async () => {
                    if (!confirm) return;
                    await run(() =>
                        confirm.kind === "folder"
                            ? actions.deleteFolderAction(confirm.id)
                            : actions.deleteListAction(confirm.id)
                    );
                    setConfirm(null);
                }}
            />
        </nav>
    );
}

// ---------------------------------------------------------------------------
// One space, and everything under it
// ---------------------------------------------------------------------------

interface SectionProps {
    readonly space: SpaceTreeView;
    /** Whether this account may change anything here at all. */
    readonly canManage: boolean;
    readonly pathname: string;
    readonly collapsed: ReadonlySet<string>;
    readonly onToggle: (key: string) => void;
    readonly draft: Draft | null;
    readonly onDraft: (draft: Draft | null) => void;
    readonly renaming: string | null;
    readonly onRenaming: (key: string | null) => void;
    readonly dragging: Dragged | null;
    readonly onDragging: (dragged: Dragged | null) => void;
    readonly onDrop: (
        spaceId: string,
        parentId: string | null,
        position: { beforeId: string | null; afterId: string | null }
    ) => void;
    readonly onConfirm: (pending: Pending) => void;
    readonly onAccess: (target: AccessTarget) => void;
    readonly onCreate: (kind: CreateKind, at: CreateAt) => void;
    readonly run: (call: () => Promise<{ error?: string }>) => Promise<void>;
}

function SpaceSection({
    space,
    canManage,
    pathname,
    collapsed,
    onToggle,
    draft,
    onDraft,
    renaming,
    onRenaming,
    dragging,
    onDragging,
    onDrop,
    onConfirm,
    onAccess,
    onCreate,
    run
}: SectionProps) {
    const open = !collapsed.has(space.id);
    const editable = canManage && canWrite(space.role);
    const tree = useMemo(() => core.buildFolderTree(space.folders), [space.folders]);
    // Renaming a space is reached from its right-click menu; the field waits for
    // the menu to let go of focus before taking it.
    const nameField = useDeferredFocus<HTMLInputElement>(renaming === `space:${space.id}`);

    /** Whether what is being dragged may land in this container at all. */
    const accepts = (parentId: string | null) =>
        dragging !== null &&
        dragging.spaceId === space.id &&
        // A folder dropped into its own branch would detach the subtree. The
        // engine refuses it server-side; refusing the drop here says so first,
        // without a round trip and an error message.
        (dragging.kind !== "folder" ||
            parentId === null ||
            core.folderMoveRefusal(space.folders, dragging.id, parentId) === null);

    /** Where a create menu opened on this list points. */
    const listAt = (list: ListSummary): CreateAt => ({
        kind: "list",
        spaceId: space.id,
        folderId: list.folderId,
        listId: list.id,
        depth: 0,
        name: list.name
    });

    /** Where a list's access comes from: the folder it sits in, or the space when
     *  it sits in none. A list has no grants of its own, so this is the level a
     *  menu entry on it has to open and the role that decides whether it may. */
    const listGovernedBy = (list: ListSummary): { scope: AccessTarget["scope"]; role: string } => {
        const folder = list.folderId
            ? space.folders.find((entry) => entry.id === list.folderId)
            : undefined;
        return folder
            ? { scope: { kind: "folder", id: folder.id }, role: folder.role }
            : { scope: { kind: "space", id: space.id }, role: space.role };
    };

    const renderList = (list: ListSummary, depth: number, siblings: readonly { id: string }[]) => (
        <TreeRow
            key={list.id}
            label={list.name}
            depth={depth}
            create={
                editable ? (
                    <CreateButton
                        at={listAt(list)}
                        onPick={(kind) => onCreate(kind, listAt(list))}
                    />
                ) : undefined
            }
            createMenu={
                editable ? (
                    <CreateSubmenu
                        at={listAt(list)}
                        onPick={(kind) => onCreate(kind, listAt(list))}
                    />
                ) : undefined
            }
            href={`/tasks/l/${list.id}`}
            active={pathname === `/tasks/l/${list.id}`}
            badge={list.openCount > 0 ? String(list.openCount) : undefined}
            icon={<Hash className="size-3.5 shrink-0 opacity-60" />}
            editable={editable}
            renaming={renaming === `list:${list.id}`}
            onRenameStart={() => onRenaming(`list:${list.id}`)}
            onRenameCancel={() => onRenaming(null)}
            onRename={async (name) => {
                onRenaming(null);
                await run(() => actions.renameListAction(list.id, name));
            }}
            acceptsBeside={dragging?.kind === "list" && accepts(list.folderId)}
            acceptsInto={false}
            dragged={dragging?.kind === "list" && dragging.id === list.id}
            onDragStart={
                editable
                    ? () => onDragging({ kind: "list", id: list.id, spaceId: space.id })
                    : undefined
            }
            onDragEnd={() => onDragging(null)}
            onDropAt={(edge) => {
                const at = neighbours(siblings, list.id, dragging?.id ?? "", edge);
                if (at) onDrop(space.id, list.folderId, at);
            }}
            actions={
                editable
                    ? [
                          ...(canAdmin(listGovernedBy(list).role)
                              ? [
                                    {
                                        label: "Who can reach this",
                                        Icon: Users,
                                        onSelect: () =>
                                            onAccess({
                                                scope: listGovernedBy(list).scope,
                                                asked: { kind: "list" as const, name: list.name }
                                            })
                                    }
                                ]
                              : []),
                          {
                              label: "Rename (F2)",
                              Icon: Pencil,
                              quick: true,
                              onSelect: () => onRenaming(`list:${list.id}`)
                          },
                          ...(canAdmin(space.role)
                              ? [
                                    {
                                        label: "Delete list",
                                        Icon: Trash2,
                                        danger: true,
                                        onSelect: () =>
                                            onConfirm({
                                                kind: "list",
                                                id: list.id,
                                                name: list.name,
                                                empty: list.empty
                                            })
                                    }
                                ]
                              : [])
                      ]
                    : []
            }
        />
    );

    /** Where a create menu opened on this folder points. */
    const folderAt = (node: core.FolderNode<FolderSummary>): CreateAt => ({
        kind: "folder",
        spaceId: space.id,
        folderId: node.folder.id,
        listId: null,
        depth: node.depth,
        name: node.folder.name
    });

    /** What a folder offers beyond creating things: the plus holds those now, so
     *  the row keeps two icons instead of five. */
    const folderActions = (node: core.FolderNode<FolderSummary>): RowAction[] => {
        const folder = node.folder;
        return [
            ...(canAdmin(folder.role)
                ? [
                      {
                          label: "Who can reach this",
                          Icon: Users,
                          quick: true,
                          onSelect: () => onAccess({ scope: { kind: "folder", id: folder.id } })
                      }
                  ]
                : []),
            {
                label: "Rename (F2)",
                Icon: Pencil,
                quick: true,
                onSelect: () => onRenaming(`folder:${folder.id}`)
            },
            ...(canAdmin(folder.role)
                ? [
                      {
                          label: "Delete folder",
                          Icon: Trash2,
                          danger: true,
                          onSelect: () =>
                              onConfirm({
                                  kind: "folder",
                                  id: folder.id,
                                  name: folder.name,
                                  empty: node.children.length === 0 && folder.lists.length === 0
                              })
                      }
                  ]
                : [])
        ];
    };

    const renderFolder = (
        node: core.FolderNode<FolderSummary>,
        depth: number,
        siblings: readonly { id: string }[]
    ): React.ReactNode => {
        const folder = node.folder;
        const folderOpen = !collapsed.has(folder.id);
        const canEditHere = canWrite(folder.role);
        const children = folder.lists as readonly { id: string }[];
        return (
            <div key={folder.id}>
                <TreeRow
                    label={folder.name}
                    depth={depth}
                    create={
                        canEditHere ? (
                            <CreateButton
                                at={folderAt(node)}
                                onPick={(kind) => onCreate(kind, folderAt(node))}
                            />
                        ) : undefined
                    }
                    createMenu={
                        canEditHere ? (
                            <CreateSubmenu
                                at={folderAt(node)}
                                onPick={(kind) => onCreate(kind, folderAt(node))}
                            />
                        ) : undefined
                    }
                    icon={
                        folderOpen ? (
                            <FolderOpen className="size-3.5 shrink-0 opacity-60" />
                        ) : (
                            <Folder className="size-3.5 shrink-0 opacity-60" />
                        )
                    }
                    expander={
                        <button
                            type="button"
                            aria-label={
                                folderOpen ? `Collapse ${folder.name}` : `Expand ${folder.name}`
                            }
                            onClick={(event) => {
                                event.preventDefault();
                                onToggle(folder.id);
                            }}
                            className="-ml-1 rounded p-0.5 text-muted-foreground hover:text-foreground"
                        >
                            {folderOpen ? (
                                <ChevronDown className="size-3.5" />
                            ) : (
                                <ChevronRight className="size-3.5" />
                            )}
                        </button>
                    }
                    editable={canEditHere}
                    renaming={renaming === `folder:${folder.id}`}
                    onRenameStart={() => onRenaming(`folder:${folder.id}`)}
                    onRenameCancel={() => onRenaming(null)}
                    onRename={async (name) => {
                        onRenaming(null);
                        await run(() => actions.renameFolderAction(folder.id, name));
                    }}
                    acceptsBeside={dragging?.kind === "folder" && accepts(folder.parentId)}
                    acceptsInto={accepts(folder.id)}
                    dragged={dragging?.kind === "folder" && dragging.id === folder.id}
                    onDragStart={
                        canEditHere
                            ? () => onDragging({ kind: "folder", id: folder.id, spaceId: space.id })
                            : undefined
                    }
                    onDragEnd={() => onDragging(null)}
                    onDropInto={() =>
                        onDrop(space.id, folder.id, { beforeId: null, afterId: null })
                    }
                    onDropAt={(edge) => {
                        const at = neighbours(siblings, folder.id, dragging?.id ?? "", edge);
                        if (at) onDrop(space.id, folder.parentId, at);
                    }}
                    actions={canEditHere ? folderActions(node) : []}
                />
                {folderOpen && (
                    <div>
                        {node.children.map((child) =>
                            renderFolder(
                                child,
                                depth + 1,
                                node.children.map((entry) => entry.folder)
                            )
                        )}
                        {folder.lists.map((list) => renderList(list, depth + 1, children))}
                        {draft?.parentId === folder.id && (
                            <DraftRow
                                draft={draft}
                                depth={depth + 1}
                                onCancel={() => onDraft(null)}
                                run={run}
                            />
                        )}
                    </div>
                )}
            </div>
        );
    };

    const rootFolders = tree.map((node) => node.folder);

    const spaceManageable = canAdmin(space.role) && !space.partial;

    /** Where a create menu opened on the space itself points. */
    const spaceAt: CreateAt = {
        kind: "space",
        spaceId: space.id,
        folderId: null,
        listId: null,
        depth: 0,
        name: space.name
    };

    return (
        <section className="flex flex-col gap-0.5">
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div
                        className="flex items-center gap-1"
                        onKeyDown={(event) => {
                            if (event.key === "F2" && spaceManageable) {
                                event.preventDefault();
                                onRenaming(`space:${space.id}`);
                            }
                        }}
                    >
                        <button
                            type="button"
                            onClick={() => onToggle(space.id)}
                            aria-label={open ? `Collapse ${space.name}` : `Expand ${space.name}`}
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            {open ? (
                                <ChevronDown className="size-3.5" />
                            ) : (
                                <ChevronRight className="size-3.5" />
                            )}
                        </button>
                        <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: space.color }}
                        />
                        {renaming === `space:${space.id}` ? (
                            <Input
                                ref={nameField}
                                defaultValue={space.name}
                                aria-label={`Rename ${space.name}`}
                                onFocus={(event) => event.target.select()}
                                onBlur={async (event) => {
                                    const next = event.target.value.trim();
                                    onRenaming(null);
                                    if (next && next !== space.name) {
                                        await run(() => actions.renameSpaceAction(space.id, next));
                                    }
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === "Escape") onRenaming(null);
                                    if (event.key === "Enter") event.currentTarget.blur();
                                }}
                                className="h-7 flex-1 text-sm"
                            />
                        ) : (
                            <Link
                                href={`/tasks/s/${space.id}`}
                                className="flex-1 truncate text-sm font-medium hover:underline"
                            >
                                {space.name}
                            </Link>
                        )}
                        <span className="font-mono text-[10px] text-muted-foreground">
                            {space.prefix}
                        </span>
                        {editable && !space.partial && (
                            <CreateButton at={spaceAt} onPick={(kind) => onCreate(kind, spaceAt)} />
                        )}
                        {spaceManageable && (
                            <Link
                                href={`/tasks/s/${space.id}`}
                                aria-label={`${space.name} settings`}
                                title="Space settings"
                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <Settings2 className="size-3.5" />
                            </Link>
                        )}
                    </div>
                </ContextMenuTrigger>
                {editable && !space.partial && (
                    <ContextMenuContent onCloseAutoFocus={keepFocusOnClose}>
                        <CreateSubmenu at={spaceAt} onPick={(kind) => onCreate(kind, spaceAt)} />
                        {spaceManageable && (
                            <>
                                <ContextMenuSeparator />
                                <ContextMenuItem
                                    onSelect={() =>
                                        onAccess({ scope: { kind: "space", id: space.id } })
                                    }
                                >
                                    <Users className="size-3.5" />
                                    Who can reach this
                                </ContextMenuItem>
                                <ContextMenuItem onSelect={() => onRenaming(`space:${space.id}`)}>
                                    <Pencil className="size-3.5" />
                                    Rename (F2)
                                </ContextMenuItem>
                                <ContextMenuItem asChild>
                                    <Link href={`/tasks/s/${space.id}`}>
                                        <Settings2 className="size-3.5" />
                                        Space settings
                                    </Link>
                                </ContextMenuItem>
                            </>
                        )}
                    </ContextMenuContent>
                )}
            </ContextMenu>

            {open && (
                <div
                    className="ml-2 flex flex-col gap-0.5"
                    onDragOver={(event) => {
                        if (accepts(null) && !space.partial) event.preventDefault();
                    }}
                    onDrop={(event) => {
                        if (space.partial) return;
                        event.preventDefault();
                        onDrop(space.id, null, { beforeId: null, afterId: null });
                    }}
                >
                    {tree.map((node) => renderFolder(node, 0, rootFolders))}
                    {space.lists.map((list) => renderList(list, 0, space.lists))}

                    {draft?.spaceId === space.id && draft.parentId === null && (
                        <DraftRow
                            draft={draft}
                            depth={0}
                            onCancel={() => onDraft(null)}
                            run={run}
                        />
                    )}

                    {editable && !space.partial && (
                        <div className="flex items-center gap-1 pt-0.5">
                            <button
                                type="button"
                                onClick={() => onCreate("list", spaceAt)}
                                className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <Plus className="size-3.5" /> List
                            </button>
                            <button
                                type="button"
                                aria-label={`Add a folder to ${space.name}`}
                                title="Add a folder"
                                onClick={() => onCreate("folder", spaceAt)}
                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <FolderPlus className="size-3.5" />
                            </button>
                        </div>
                    )}

                    {space.partial && (
                        <p className="px-2 py-1 text-[11px] text-muted-foreground">
                            You have been given part of this space.
                        </p>
                    )}
                </div>
            )}
        </section>
    );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** The input that appears where a new folder or list is being created. */
function DraftRow({
    draft,
    depth,
    onCancel,
    run
}: {
    draft: Draft;
    depth: number;
    onCancel: () => void;
    run: (call: () => Promise<{ error?: string }>) => Promise<void>;
}) {
    const [value, setValue] = useState("");
    // The create menu is still trapping focus when this row appears, so the
    // field takes focus a tick after it, once the menu is gone.
    const field = useDeferredFocus<HTMLInputElement>();

    const commit = async () => {
        const name = value.trim();
        onCancel();
        if (!name) return;
        await run(() =>
            draft.kind === "folder"
                ? actions.createFolderAction({
                      spaceId: draft.spaceId,
                      parentId: draft.parentId,
                      name
                  })
                : actions.createListAction({
                      spaceId: draft.spaceId,
                      folderId: draft.parentId,
                      name
                  })
        );
    };

    return (
        <div className="py-0.5" style={{ paddingLeft: depth * 12 }}>
            <Input
                ref={field}
                value={value}
                aria-label={draft.kind === "folder" ? "Folder name" : "List name"}
                placeholder={
                    draft.kind === "folder" ? "Folder name, then enter" : "List name, then enter"
                }
                onChange={(event) => setValue(event.target.value)}
                onBlur={() => void commit()}
                onKeyDown={(event) => {
                    if (event.key === "Escape") {
                        setValue("");
                        onCancel();
                    }
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                className="h-7 text-sm"
            />
        </div>
    );
}
