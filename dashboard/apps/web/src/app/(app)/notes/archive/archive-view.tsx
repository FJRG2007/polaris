"use client";

/**
 * What is in the archive, and the two things anybody does with it.
 *
 * A flat list, deliberately: an archived note has no place in the tree any more
 * - what it sat under may itself be archived - and reconstructing one here would
 * be inventing a shape nobody put it in.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { RelativeTime } from "@/components/relative-time";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import type { ArchivedNote } from "@/lib/notes/note-service";
import { deleteNoteAction, updateNoteAction } from "../actions";
import { Button, ConfirmDeleteDialog, EmptyState } from "@polaris/ui";

export function ArchiveView({ notes }: { notes: readonly ArchivedNote[] }) {
    const router = useRouter();
    const [error, setError] = useState("");
    const [deleting, setDeleting] = useState<ArchivedNote | null>(null);

    if (notes.length === 0) {
        return (
            <EmptyState
                icon={<Archive />}
                title="Nothing archived."
                description="Notes you put away from the sidebar end up here."
            />
        );
    }

    const restore = async (noteId: string) => {
        await runAction(() => updateNoteAction({ noteId, archived: false }), setError);
        router.refresh();
    };

    return (
        <div className="flex flex-col gap-3">
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}

            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {notes.map((note) => (
                    <li
                        key={note.id}
                        className="flex items-center gap-3 bg-card px-3 py-2 transition-colors hover:bg-card-hover"
                    >
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium" title={note.title}>
                                {note.title}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                                Archived <RelativeTime iso={note.updatedAt} />
                            </span>
                        </span>
                        <Button size="xs" variant="ghost" onClick={() => void restore(note.id)}>
                            <RotateCcw className="size-3.5" />
                            Put back
                        </Button>
                        <button
                            type="button"
                            aria-label={`Delete ${note.title}`}
                            title="Delete"
                            onClick={() => setDeleting(note)}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                        >
                            <Trash2 className="size-4" />
                        </button>
                    </li>
                ))}
            </ul>

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting?.title ?? ""}
                kind="note"
                requireTyping={false}
                description="This one is gone for good. Anything that sat under it stays."
                confirmLabel="Delete note"
                onConfirm={async () => {
                    if (deleting) await runAction(() => deleteNoteAction(deleting.id), setError);
                    setDeleting(null);
                    router.refresh();
                }}
            />
        </div>
    );
}
