"use client";

/**
 * Folders, which are one person's own way of arranging their own vault.
 *
 * Personal on purpose, and worth saying because the word means something else
 * next door: a folder name is encrypted under the owner's key, so it cannot
 * mean anything to anybody else and is not how a password is shared. Sharing is
 * an organization's collection, which is a different thing with a different key
 * (see `share-dialog.tsx`).
 *
 * Deleting one never deletes what is in it. The items simply stop being filed.
 */

import { useState } from "react";
import type { VaultFolder } from "./vault-model";
import * as vaultCrypto from "@/lib/vault/crypto";
import { useConfirm } from "@/components/confirm-dialog";
import { deleteFolderAction, saveFolderAction } from "./vault-actions";
import { Check, FolderPlus, Loader2, Pencil, Trash2, X } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

export function FolderDialog({
    open,
    folders,
    vaultKey,
    onClose,
    onChanged
}: {
    open: boolean;
    folders: VaultFolder[];
    vaultKey: vaultCrypto.SymmetricKey;
    onClose: () => void;
    /** Called after any write, so the screen behind can reload its folders. */
    onChanged: () => Promise<void>;
}) {
    const [adding, setAdding] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    async function save(folderId: string | null, name: string): Promise<void> {
        const trimmed = name.trim();
        if (!trimmed) return;
        setPending(true);
        setError(null);
        // Encrypted here, like every other name in a vault - the server stores a
        // string it cannot read.
        const result = await saveFolderAction(
            folderId,
            await vaultCrypto.encrypt(trimmed, vaultKey)
        );
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setAdding("");
        setEditingId(null);
        await onChanged();
    }

    async function remove(folder: VaultFolder): Promise<void> {
        const confirmed = await confirm({
            title: `Delete "${folder.name || "Untitled"}"?`,
            description: "What is in it stays in your vault; it just stops being filed here.",
            confirmLabel: "Delete",
            danger: true
        });
        if (!confirmed) return;
        setPending(true);
        setError(null);
        const result = await deleteFolderAction(folder.id);
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        await onChanged();
    }

    return (
        <>
            <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Folders</DialogTitle>
                        <DialogDescription>
                            Yours alone. The names are encrypted with everything else, so nobody
                            else can read them.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-2">
                        <form
                            className="flex items-center gap-2"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void save(null, adding);
                            }}
                        >
                            <Input
                                value={adding}
                                onChange={(event) => setAdding(event.target.value)}
                                placeholder="New folder"
                                aria-label="New folder name"
                            />
                            <Button type="submit" size="sm" disabled={pending || !adding.trim()}>
                                {pending ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <FolderPlus className="size-4" />
                                )}
                                Add
                            </Button>
                        </form>

                        {folders.length === 0 ? (
                            <p className="py-4 text-center text-sm text-muted-foreground">
                                No folders yet.
                            </p>
                        ) : (
                            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                                {folders.map((folder) => (
                                    <li key={folder.id} className="flex items-center gap-2 p-2">
                                        {editingId === folder.id ? (
                                            <>
                                                <Input
                                                    value={editingName}
                                                    autoFocus
                                                    onChange={(event) =>
                                                        setEditingName(event.target.value)
                                                    }
                                                    onKeyDown={(event) => {
                                                        if (event.key === "Enter") {
                                                            event.preventDefault();
                                                            void save(folder.id, editingName);
                                                        }
                                                        if (event.key === "Escape")
                                                            setEditingId(null);
                                                    }}
                                                    aria-label={`Rename ${folder.name}`}
                                                />
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    title="Save"
                                                    aria-label="Save the new name"
                                                    disabled={pending}
                                                    onClick={() =>
                                                        void save(folder.id, editingName)
                                                    }
                                                >
                                                    <Check className="size-4" />
                                                </Button>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    title="Cancel"
                                                    aria-label="Stop renaming"
                                                    onClick={() => setEditingId(null)}
                                                >
                                                    <X className="size-4" />
                                                </Button>
                                            </>
                                        ) : (
                                            <>
                                                <span className="min-w-0 flex-1 truncate text-sm">
                                                    {folder.name || "Untitled"}
                                                </span>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    title="Rename"
                                                    aria-label={`Rename ${folder.name}`}
                                                    onClick={() => {
                                                        setEditingId(folder.id);
                                                        setEditingName(folder.name);
                                                    }}
                                                >
                                                    <Pencil className="size-4" />
                                                </Button>
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    title="Delete"
                                                    aria-label={`Delete ${folder.name}`}
                                                    disabled={pending}
                                                    onClick={() => void remove(folder)}
                                                >
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={onClose}>
                            Done
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {confirmDialog}
        </>
    );
}
