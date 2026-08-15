"use client";

/**
 * Choosing where a note sits.
 *
 * The candidates are worked out here as well as on the server, for different
 * reasons: the server refuses a move that would cut a note off from the tree
 * because a hand-made request can ask for one, and this list leaves those
 * destinations out because offering a choice that will be refused is a worse
 * answer than not offering it. The note itself and everything under it are the
 * whole of what is excluded.
 */

import { useMemo, useState } from "react";
import { runAction } from "@/lib/run-action";
import { CornerDownRight, Loader2 } from "lucide-react";
import type { NoteSummary } from "@/lib/notes/note-service";
import {
    cn,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function NoteMoveDialog({
    open,
    onOpenChange,
    notes,
    noteId,
    parentId,
    onMove
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    notes: readonly NoteSummary[];
    noteId: string;
    /** Where it is now, so the current place is marked rather than offered as a
     *  change that does nothing. */
    parentId: string | null;
    onMove: (parentId: string | null) => Promise<{ error?: string }>;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const candidates = useMemo(() => {
        const excluded = new Set([noteId]);
        // The list arrives depth-first from the top, so a note's parent is always
        // seen before it and one pass is enough to exclude the whole subtree.
        for (const entry of notes) {
            if (entry.parentId && excluded.has(entry.parentId)) excluded.add(entry.id);
        }
        return notes.filter((entry) => !excluded.has(entry.id));
    }, [notes, noteId]);

    const move = async (target: string | null) => {
        setBusy(true);
        setError("");
        const result = await runAction(() => onMove(target), setError);
        setBusy(false);
        if (!result?.error) onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Move this note</DialogTitle>
                    <DialogDescription>
                        Pick what it should sit under. Anything already under it moves with it.
                    </DialogDescription>
                </DialogHeader>

                <div className="max-h-72 overflow-y-auto">
                    <ul className="flex flex-col gap-0.5">
                        <li>
                            <button
                                type="button"
                                disabled={busy || parentId === null}
                                onClick={() => void move(null)}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                                )}
                            >
                                <span className="font-medium">Top level</span>
                                {parentId === null && (
                                    <span className="text-xs text-muted-foreground">
                                        where it is
                                    </span>
                                )}
                            </button>
                        </li>
                        {candidates.map((entry) => (
                            <li key={entry.id}>
                                <button
                                    type="button"
                                    disabled={busy || parentId === entry.id}
                                    onClick={() => void move(entry.id)}
                                    style={{ paddingLeft: `${0.5 + entry.depth * 0.75}rem` }}
                                    className="flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                                >
                                    <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                                    <span className="truncate" title={entry.title}>
                                        {entry.title}
                                    </span>
                                    {parentId === entry.id && (
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            where it is
                                        </span>
                                    )}
                                </button>
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
