"use client";

/**
 * What is in the archive, and the two things anybody does with it.
 *
 * A flat list, deliberately: an archived note has no place in the tree any more
 * - what it sat under may itself be archived - and reconstructing one here would
 * be inventing a shape nobody put it in.
 */

import { useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useRouter } from "next/navigation";
import { RelativeTime } from "@/components/relative-time";
import { Archive, RotateCcw, Trash2 } from "lucide-react";
import type { ArchivedNote } from "@/lib/notes/note-service";
import { deletedHere, pendingUpdate } from "../offline-tree";
import { NOTE_DELETE, NOTE_UPDATE, useNoteWrites, writeNote } from "../offline-writes";
import { Button, ConfirmDeleteDialog, EmptyState } from "@polaris/ui";

export function ArchiveView({ notes: served }: { notes: readonly ArchivedNote[] }) {
    const t = useTranslations("notes");
    const router = useRouter();
    // A delete or a restore kept on this device while Polaris was away is gone
    // from here already.
    const writes = useNoteWrites(() => router.refresh());
    const notes = served.filter(
        (note) =>
            !deletedHere(writes.entries, note.id) && pendingUpdate(writes.entries, note.id).archived !== false
    );
    const [error, setError] = useState("");
    const [deleting, setDeleting] = useState<ArchivedNote | null>(null);

    if (notes.length === 0) {
        return (
            <EmptyState
                icon={<Archive />}
                title={t("archive.emptyTitle")}
                description={t("archive.emptyDescription")}
            />
        );
    }

    const restore = async (noteId: string) => {
        setError("");
        const result = await writeNote(NOTE_UPDATE, { noteId, archived: false }, setError);
        if (result?.error) setError(result.error);
        else if (result && !result.queued) router.refresh();
    };

    return (
        <div className="flex flex-col gap-3">
            {error && (
                <p role="alert" className="text-sm text-danger">
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
                                {t.rich("archive.archivedAt", {
                                    time: () => <RelativeTime key="time" iso={note.updatedAt} />
                                })}
                            </span>
                        </span>
                        <Button size="xs" variant="ghost" onClick={() => void restore(note.id)}>
                            <RotateCcw className="size-3.5" />
                            {t("archive.restore")}
                        </Button>
                        <button
                            type="button"
                            aria-label={t("archive.deleteNamed", { name: note.title })}
                            title={t("tree.delete")}
                            onClick={() => setDeleting(note)}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
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
                title={t("view.deleteTitle")}
                question={t.rich("view.deleteQuestion", {
                    name: deleting?.title ?? "",
                    strong: (chunks) => (
                        <span key="name" className="font-medium text-foreground">
                            {chunks}
                        </span>
                    )
                })}
                description={t("archive.deleteBody")}
                confirmLabel={t("view.deleteTitle")}
                onConfirm={async () => {
                    if (deleting) {
                        const result = await writeNote(NOTE_DELETE, { noteId: deleting.id }, setError);
                        if (result?.error) setError(result.error);
                        setDeleting(null);
                        if (result?.queued) return;
                    } else setDeleting(null);
                    router.refresh();
                }}
            />
        </div>
    );
}
