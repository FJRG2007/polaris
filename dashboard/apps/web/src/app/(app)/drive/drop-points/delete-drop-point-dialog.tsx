"use client";

/**
 * Deleting a drop point - or several - and deciding what happens to their files.
 *
 * A drop point is normally created with a folder of its own, so removing the folder
 * with it is the usual intent and the switch starts on. It is also the only half
 * that cannot be undone, which is why it is a visible choice rather than a footnote:
 * turning it off keeps everything collected so far and only takes away the link.
 *
 * One that collects straight into the connection has no folder of its own, so there
 * is nothing to offer: the switch is replaced by a line saying where the files stay.
 * Several at once ask the one question for all of them; the ones with no folder of
 * their own are simply deleted without one.
 *
 * Its own dialog rather than the shared confirm(), which has no room for a choice.
 */

import { Trash2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState } from "react";
import { normalizeRelPath } from "@polaris/core";
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

/** Whether a drop point has a folder of its own to delete. Normalized rather than
 *  compared to "", because that is what the server does before it refuses: a
 *  destination stored as "/" or "." is the same root. */
export function hasOwnFolder(target: Pick<DropPointTarget, "destinationPath">): boolean {
    return normalizeRelPath(target.destinationPath) !== "";
}

export function DeleteDropPointDialog({
    target,
    busy,
    onCancel,
    onConfirm
}: {
    /** The drop point being deleted - or the drop points, for a bulk delete - or
     *  null when the dialog is closed. */
    target: DropPointTarget | readonly DropPointTarget[] | null;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: (deleteFolder: boolean) => void;
}) {
    const t = useTranslations("drivePoints");
    const targets: readonly DropPointTarget[] =
        target === null ? [] : Array.isArray(target) ? target : [target as DropPointTarget];
    const single = targets.length === 1 ? targets[0]! : null;
    const withFolder = targets.filter(hasOwnFolder);
    const anyFolder = withFolder.length > 0;
    const [deleteFolder, setDeleteFolder] = useState(true);

    // Each delete is a fresh decision: an operator who kept one folder should not
    // silently keep the next one because the switch remembered. Keyed on which
    // drop points they are, not on the objects: a caller that builds the target
    // inline hands a new one on every render, and the switch was put back on the
    // moment anybody turned it off.
    const identity = targets.map((one) => `${one.id}:${one.destinationPath}`).join("|");
    useEffect(() => {
        if (identity) setDeleteFolder(anyFolder);
    }, [identity, anyFolder]);

    const files = withFolder.reduce((sum, one) => sum + one.submissionCount, 0);
    const switchLabel = single
        ? t("deleteDialog.deleteTheFolderToo")
        : t("deleteDialog.deleteTheirFoldersToo");

    return (
        <Dialog open={targets.length > 0} onOpenChange={(open) => !open && onCancel()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {single
                            ? t("deleteDialog.title", { name: single.title })
                            : t("deleteDialog.titleMany", { count: targets.length })}
                    </DialogTitle>
                    <DialogDescription>
                        {single
                            ? t("deleteDialog.theLinkStopsWorkingAnd")
                            : t("deleteDialog.theLinksStopWorking")}
                    </DialogDescription>
                </DialogHeader>

                {/* The body carries its own spacing: the dialog is a padded box and
                    nothing in it is spaced apart on its own, so the choice would sit
                    flush against the buttons underneath it. */}
                <div className="flex flex-col gap-4">
                    {anyFolder ? (
                        <div className="flex items-start gap-3 rounded-md border border-border p-3">
                            <Switch
                                checked={deleteFolder}
                                aria-label={switchLabel}
                                onChange={setDeleteFolder}
                            />
                            <div className="min-w-0 text-sm">
                                <p className="font-medium">{switchLabel}</p>
                                <p className="mt-0.5 break-words text-xs text-muted-foreground">
                                    {single ? (
                                        <>
                                            {single.connectionName} / {single.destinationPath}
                                            {t("deleteDialog.files", { count: single.submissionCount })}
                                        </>
                                    ) : (
                                        t("deleteDialog.foldersSummary", {
                                            folders: withFolder.length,
                                            files
                                        })
                                    )}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
                            {single
                                ? t("deleteDialog.noFolder", { name: single.connectionName })
                                : t("deleteDialog.noFolderMany")}
                        </p>
                    )}

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onCancel} disabled={busy}>
                            {t("deleteDialog.cancel")}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => onConfirm(anyFolder && deleteFolder)}
                            disabled={busy}
                        >
                            <Trash2 className="size-4" />
                            {busy ? t("deleteDialog.deleting") : t("deleteDialog.delete")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
