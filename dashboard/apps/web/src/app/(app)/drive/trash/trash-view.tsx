"use client";

/**
 * Recycle bin view. Lists items moved to Trash and lets the user restore one to
 * its original location or delete it permanently, plus empty the whole bin.
 * Optimistic: a restored/deleted row disappears immediately.
 */

import { useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { FileText, FolderClosed, RotateCcw, Trash2 } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Button, Card, CardBody } from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { deleteTrashForeverAction, emptyTrashAction, restoreTrashAction } from "../actions";
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
    const t = useTranslations("drive");
    const [rows, setRows] = useState(items);
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    /**
     * A row only leaves the list once the server says it left the bin.
     *
     * These actions reach storage that can refuse - a share that has gone away,
     * a path something else is holding - and dropping the row regardless made a
     * refusal look like a success until the page was reloaded.
     */
    function onRestore(id: string) {
        setBusy(id);
        startTransition(async () => {
            const result = await restoreTrashAction(id);
            setBusy(null);
            if (result.error) {
                await confirm({
                    title: t("trash.couldNotRestoreIt"),
                    description: result.error,
                    alert: true
                });
                return;
            }
            setRows((prev) => prev.filter((row) => row.id !== id));
        });
    }

    async function onDelete(id: string) {
        if (
            !(await confirm({
                title: t("trash.permanentlyDeleteThisItem"),
                description: t("trash.thisCannotBeUndone"),
                confirmLabel: t("trash.delete"),
                danger: true
            }))
        )
            return;
        setBusy(id);
        startTransition(async () => {
            const result = await deleteTrashForeverAction(id);
            setBusy(null);
            if (result.error) {
                await confirm({
                    title: t("trash.couldNotDeleteIt"),
                    description: result.error,
                    alert: true
                });
                return;
            }
            setRows((prev) => prev.filter((row) => row.id !== id));
        });
    }

    async function onEmpty() {
        if (
            !(await confirm({
                title: t("trash.emptyTheTrash"),
                description: t("trash.permanentlyDeleteEverythingInThe"),
                confirmLabel: t("trash.emptyTrash"),
                danger: true
            }))
        )
            return;
        startTransition(async () => {
            const result = await emptyTrashAction();
            if (result.error) {
                await confirm({
                    title: t("trash.couldNotEmptyTheBin"),
                    description: result.error,
                    alert: true
                });
                return;
            }
            setRows([]);
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("trash.trash")}</h1>
                    <p className="text-sm text-muted-foreground">
                        {t("trash.deletedItemsAreKeptHere")}
                    </p>
                </div>
                {rows.length > 0 ? (
                    <Button size="sm" variant="danger" onClick={onEmpty} disabled={pending}>
                        <Trash2 className="size-4" />
                        {t("trash.emptyTrash")}
                    </Button>
                ) : null}
            </div>

            {rows.length === 0 ? (
                <Card>
                    <CardBody className="p-8 text-center text-sm text-muted-foreground">
                        {t("trash.theTrashIsEmpty")}
                    </CardBody>
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
                                            {row.connectionName} / {row.originalPath || t("trash.root")}
                                            {row.kind !== "dir"
                                                ? ` - ${formatBytes(BigInt(row.size))}`
                                                : ""}{" "}
                                            {t.rich("trash.deletedAt", {
                                                time: () => <RelativeTime key="time" iso={row.deletedAt} />
                                            })}
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
                                        {t("trash.restore")}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => onDelete(row.id)}
                                        disabled={pending && busy === row.id}
                                    >
                                        <Trash2 className="size-4" />
                                        {t("trash.deleteForever")}
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
