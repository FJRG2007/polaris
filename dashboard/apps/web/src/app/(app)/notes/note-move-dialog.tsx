"use client";

/**
 * Choosing where a note sits: which notebook, and where on it.
 *
 * The candidates are worked out here as well as on the server, for different
 * reasons: the server refuses a move that would cut a note off from the tree
 * because a hand-made request can ask for one, and this list leaves those
 * destinations out because offering a choice that will be refused is a worse
 * answer than not offering it. The note itself and everything under it are the
 * whole of what is excluded on its own shelf; on any other shelf everything is
 * offered, because nothing there can be inside it.
 *
 * A folder and a note are both destinations and they mean different things - "in
 * this folder" and "under this note" - so they are drawn as two groups rather
 * than one list somebody has to read the icons of.
 */

import { useMemo, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { ShelfData } from "./note-tree";
import { CornerDownRight, Folder, Loader2 } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select
} from "@polaris/ui";

/** Where a note can be put. `parentId` and `folderId` are exclusive: a nested
 *  note is filed where its parent is. */
export interface MoveTarget {
    readonly spaceId: string | null;
    readonly folderId: string | null;
    readonly parentId: string | null;
}

export function NoteMoveDialog({
    open,
    onOpenChange,
    shelves,
    noteId,
    from,
    onMove
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    shelves: readonly ShelfData[];
    noteId: string;
    /** Where it is now, so the current place is marked rather than offered as a
     *  change that does nothing. */
    from: MoveTarget;
    onMove: (target: MoveTarget) => Promise<{ error?: string }>;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [shelfId, setShelfId] = useState(from.spaceId ?? "");

    const shelf = useMemo(
        () => shelves.find((entry) => (entry.space?.id ?? "") === shelfId) ?? shelves[0],
        [shelves, shelfId]
    );
    const spaceId = shelf?.space?.id ?? null;
    const sameShelf = spaceId === from.spaceId;

    const notes = useMemo(() => {
        if (!shelf) return [];
        if (!sameShelf) return shelf.notes;
        const excluded = new Set([noteId]);
        // The list arrives depth-first from the top, so a note's parent is always
        // seen before it and one pass is enough to exclude the whole subtree.
        for (const entry of shelf.notes) {
            if (entry.parentId && excluded.has(entry.parentId)) excluded.add(entry.id);
        }
        return shelf.notes.filter((entry) => !excluded.has(entry.id));
    }, [shelf, sameShelf, noteId]);

    const move = async (target: MoveTarget) => {
        setBusy(true);
        setError("");
        const result = await runAction(() => onMove(target), setError);
        setBusy(false);
        if (!result?.error) onOpenChange(false);
    };

    const here = (target: MoveTarget) =>
        sameShelf && target.folderId === from.folderId && target.parentId === from.parentId;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Move this note</DialogTitle>
                    <DialogDescription>
                        Anything under it moves with it.
                    </DialogDescription>
                </DialogHeader>

                {shelves.length > 1 && (
                    <label className="flex flex-col gap-1 text-sm">
                        <span>Notebook</span>
                        <Select
                            value={shelfId}
                            onValueChange={setShelfId}
                            options={shelves.map((entry) => ({
                                value: entry.space?.id ?? "",
                                label: entry.space?.name ?? "My notes"
                            }))}
                        />
                    </label>
                )}

                <div className="max-h-72 overflow-y-auto">
                    <ul className="flex flex-col gap-0.5">
                        <li>
                            <Destination
                                label="Top level"
                                busy={busy}
                                here={here({ spaceId, folderId: null, parentId: null })}
                                onSelect={() => void move({ spaceId, folderId: null, parentId: null })}
                            />
                        </li>
                        {shelf?.folders.map((folder) => (
                            <li key={folder.id}>
                                <Destination
                                    label={folder.name}
                                    icon={<Folder className="size-3.5 shrink-0 text-muted-foreground" />}
                                    busy={busy}
                                    here={here({ spaceId, folderId: folder.id, parentId: null })}
                                    onSelect={() =>
                                        void move({ spaceId, folderId: folder.id, parentId: null })
                                    }
                                />
                            </li>
                        ))}
                        {notes.map((entry) => (
                            <li key={entry.id}>
                                <Destination
                                    label={`Under ${entry.title}`}
                                    icon={
                                        <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                                    }
                                    depth={entry.depth}
                                    busy={busy}
                                    here={here({ spaceId, folderId: null, parentId: entry.id })}
                                    onSelect={() =>
                                        void move({ spaceId, folderId: null, parentId: entry.id })
                                    }
                                />
                            </li>
                        ))}
                    </ul>
                </div>

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Destination({
    label,
    icon,
    depth = 0,
    busy,
    here,
    onSelect
}: {
    label: string;
    icon?: React.ReactNode;
    depth?: number;
    busy: boolean;
    here: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            disabled={busy || here}
            onClick={onSelect}
            style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
            className="flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
        >
            {icon}
            <span className="truncate" title={label}>
                {label}
            </span>
            {here && <span className="shrink-0 text-xs text-muted-foreground">where it is</span>}
        </button>
    );
}
