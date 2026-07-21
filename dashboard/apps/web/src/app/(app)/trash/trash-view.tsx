"use client";

/**
 * Recycle bin view. Lists items moved to Trash and lets the user restore one to
 * its original location or delete it permanently, plus empty the whole bin.
 * Optimistic: a restored/deleted row disappears immediately.
 */

import { useState, useTransition } from "react";
import { FileText, FolderClosed, RotateCcw, Trash2 } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Button, Card, CardBody } from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import {
    deleteTrashForeverAction,
    emptyTrashAction,
    restoreTrashAction
} from "../drive/actions";
import { RelativeTime } from "@/components/relative-time";

export interface TrashRow {
    id: string;
    name: string;
    originalPath: string;
    connectionName: string;
    kind: string;
    size: string;
    deletedAt: string;
}

export function TrashView({ items }: { items: TrashRow[] }) {
    const [rows, setRows] = useState(items);
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    function onRestore(id: string) {
        setBusy(id);
        startTransition(async () => {
            await restoreTrashAction(id);
            setRows((prev) => prev.filter((row) => row.id !== id));
            setBusy(null);
        });
    }

    async function onDelete(id: string) {
        if (!(await confirm({ title: "Permanently delete this item?", description: "This cannot be undone.", confirmLabel: "Delete", danger: true }))) return;
        setBusy(id);
        startTransition(async () => {
            await deleteTrashForeverAction(id);
            setRows((prev) => prev.filter((row) => row.id !== id));
            setBusy(null);
        });
    }

    async function onEmpty() {
        if (!(await confirm({ title: "Empty the Trash?", description: "Permanently delete everything in the Trash. This cannot be undone.", confirmLabel: "Empty Trash", danger: true }))) return;
        startTransition(async () => {
            await emptyTrashAction();
            setRows([]);
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-lg font-semibold">Trash</h1>
                    <p className="text-sm text-muted-foreground">
                        Deleted items are kept here until you restore or permanently delete them.
                    </p>
                </div>
                {rows.length > 0 ? (
                    <Button size="sm" variant="danger" onClick={onEmpty} disabled={pending}>
                        <Trash2 className="size-4" />
                        Empty Trash
                    </Button>
                ) : null}
            </div>

            {rows.length === 0 ? (
                <Card>
                    <CardBody className="p-8 text-center text-sm text-muted-foreground">The Trash is empty.</CardBody>
                </Card>
            ) : (
                <div className="flex flex-col gap-2">
                    {rows.map((row) => (
                        <Card key={row.id}>
                            <CardBody className="flex flex-wrap items-center justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-3">
                                    {row.kind === "dir" ? (
                                        <FolderClosed className="size-4 shrink-0 text-primary" />
                                    ) : (
                                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                                    )}
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">{row.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {row.connectionName} / {row.originalPath || "(root)"}
                                            {row.kind !== "dir" ? ` - ${formatBytes(BigInt(row.size))}` : ""} - deleted{" "}
                                            <RelativeTime iso={row.deletedAt} />
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-1">
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => onRestore(row.id)}
                                        disabled={pending && busy === row.id}
                                    >
                                        <RotateCcw className="size-4" />
                                        Restore
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => onDelete(row.id)}
                                        disabled={pending && busy === row.id}
                                    >
                                        <Trash2 className="size-4" />
                                        Delete forever
                                    </Button>
                                </div>
                            </CardBody>
                        </Card>
                    ))}
                </div>
            )}
            {confirmDialog}
        </div>
    );
}
