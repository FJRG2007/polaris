"use client";

/**
 * Deleting a drop point, and deciding what happens to its files.
 *
 * A drop point is normally created with a folder of its own, so removing the folder
 * with it is the usual intent and the switch starts on. It is also the only half
 * that cannot be undone, which is why it is a visible choice rather than a footnote:
 * turning it off keeps everything collected so far and only takes away the link.
 *
 * One that collects straight into the connection has no folder of its own, so there
 * is nothing to offer: the switch is replaced by a line saying where the files stay.
 *
 * Its own dialog rather than the shared confirm(), which has no room for a choice.
 */

import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Switch
} from "@polaris/ui";

export interface DropPointTarget {
    id: string;
    title: string;
    /** Where it collects into, shown so nobody deletes the wrong folder. */
    destinationPath: string;
    connectionName: string;
    submissionCount: number;
}

export function DeleteDropPointDialog({
    target,
    busy,
    onCancel,
    onConfirm
}: {
    /** The drop point being deleted, or null when the dialog is closed. */
    target: DropPointTarget | null;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: (deleteFolder: boolean) => void;
}) {
    const [deleteFolder, setDeleteFolder] = useState(true);
    // A drop point pointed at the connection itself has no folder of its own, and
    // "the folder" there is every other folder on it. Nothing to offer.
    const ownFolder = Boolean(target && target.destinationPath !== "");

    // Each drop point is a fresh decision: an operator who kept one folder should
    // not silently keep the next one because the switch remembered.
    useEffect(() => {
        if (target) setDeleteFolder(target.destinationPath !== "");
    }, [target]);

    return (
        <Dialog open={target !== null} onOpenChange={(open) => !open && onCancel()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Delete {target?.title}?</DialogTitle>
                    <DialogDescription>
                        The link stops working and the record of what was collected goes with it.
                    </DialogDescription>
                </DialogHeader>

                {/* The body carries its own spacing: the dialog is a padded box and
                    nothing in it is spaced apart on its own, so the choice would sit
                    flush against the buttons underneath it. */}
                <div className="flex flex-col gap-4">
                    {ownFolder ? (
                        <div className="flex items-start gap-3 rounded-md border border-border p-3">
                            <Switch
                                checked={deleteFolder}
                                aria-label="Delete the folder too"
                                onChange={setDeleteFolder}
                            />
                            <div className="min-w-0 text-sm">
                                <p className="font-medium">Delete the folder too</p>
                                <p className="mt-0.5 break-words text-xs text-muted-foreground">
                                    {target ? (
                                        <>
                                            {target.connectionName} / {target.destinationPath}
                                            {target.submissionCount > 0
                                                ? ` - ${target.submissionCount} collected file${
                                                      target.submissionCount === 1 ? "" : "s"
                                                  }`
                                                : " - empty"}
                                        </>
                                    ) : null}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
                            This one collects straight into {target?.connectionName}, so it has no
                            folder of its own. Whatever was collected stays where it is.
                        </p>
                    )}

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onCancel} disabled={busy}>
                            Cancel
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => onConfirm(deleteFolder)}
                            disabled={busy}
                        >
                            <Trash2 className="size-4" />
                            {busy ? "Deleting..." : "Delete"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
