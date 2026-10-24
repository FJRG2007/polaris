"use client";

/**
 * Recycle bin view. The explorer's own listing in its bin mode - the same list
 * and grid, columns, selection, keyboard and menus - with Restore, Delete
 * forever and Empty Trash in place of the explorer's actions.
 *
 * Optimistic: picked rows leave at once, one request per action whatever the
 * selection, and any row the server could not finish comes back with the reason.
 */

import { useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useConfirm } from "@/components/confirm-dialog";
import { FilesView } from "../files-view";
import type { DriveEntry } from "../types";
import * as driveActions from "../actions";
import { originalFolder, trashBatches, trashEntry, type TrashRow } from "./trash-listing";

export type { TrashRow } from "./trash-listing";

/** What the reader may do in the bin, from the same permissions the actions check. */
export interface TrashAbilities {
    restore: boolean;
    remove: boolean;
}

const NO_ABILITIES = { read: true, write: false, remove: false } as const;
const off = () => undefined;

/** The explorer address of the folder a row was deleted from. */
function folderHref(row: TrashRow): string {
    const query = new URLSearchParams({ c: row.connectionId });
    const folder = originalFolder(row);
    if (folder) query.set("p", folder);
    return `/drive?${query.toString()}`;
}

export function TrashView({ items, abilities }: { items: TrashRow[]; abilities: TrashAbilities }) {
    const t = useTranslations("drive");
    const [rows, setRows] = useState(items);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmDialog] = useConfirm();
    const fileInput = useRef<HTMLInputElement>(null);

    const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
    const entries = useMemo(() => rows.map(trashEntry), [rows]);

    /**
     * Take rows out now, ask the server once per batch, and put back whatever it
     * did not finish - in their places, so a refusal does not reshuffle the list.
     */
    function run(
        ids: string[],
        action: (ids: string[]) => Promise<driveActions.TrashBatchResult>,
        failTitle: string
    ) {
        if (ids.length === 0) return;
        const before = rows;
        const leaving = new Set(ids);
        setRows((prev) => prev.filter((row) => !leaving.has(row.id)));
        startTransition(async () => {
            const done = new Set<string>();
            let error: string | undefined;
            for (const batch of trashBatches(ids)) {
                try {
                    const result = await action(batch);
                    for (const id of result.done) done.add(id);
                    error ??= result.error;
                } catch {
                    error ??= t("trash.somethingWentWrong");
                }
            }
            const back = new Set(ids.filter((id) => !done.has(id)));
            if (back.size > 0) {
                setRows((prev) => {
                    const present = new Set(prev.map((row) => row.id));
                    return before.filter((row) => present.has(row.id) || back.has(row.id));
                });
            }
            if (error) await confirm({ title: failTitle, description: error, alert: true });
        });
    }

    function onRestore(targets: DriveEntry[]) {
        run(
            targets.map((entry) => entry.path),
            driveActions.restoreTrashItemsAction,
            t("trash.couldNotRestoreIt")
        );
    }

    async function onDeleteForever(targets: DriveEntry[]) {
        if (targets.length === 0) return;
        const ok = await confirm({
            title:
                targets.length === 1
                    ? t("trash.permanentlyDeleteThisItem")
                    : t("trash.permanentlyDeleteItems", { count: targets.length }),
            description: t("trash.thisCannotBeUndone"),
            confirmLabel: t("trash.delete"),
            danger: true
        });
        if (!ok) return;
        run(
            targets.map((entry) => entry.path),
            driveActions.deleteTrashItemsForeverAction,
            t("trash.couldNotDeleteIt")
        );
    }

    async function onEmpty() {
        const ok = await confirm({
            title: t("trash.emptyTheTrash"),
            description: t("trash.permanentlyDeleteEverythingInThe"),
            confirmLabel: t("trash.emptyTrash"),
            danger: true
        });
        if (!ok) return;
        const before = rows;
        setRows([]);
        startTransition(async () => {
            let error: string | undefined;
            try {
                error = (await driveActions.emptyTrashAction()).error;
            } catch {
                error = t("trash.somethingWentWrong");
            }
            if (!error) return;
            setRows(before);
            await confirm({
                title: t("trash.couldNotEmptyTheBin"),
                description: error,
                alert: true
            });
        });
    }

    return (
        <>
            <FilesView
                connectionId=""
                path=""
                segments={[]}
                entries={entries}
                loading={false}
                error={null}
                onRetry={off}
                pending={pending}
                uploading={false}
                fileInput={fileInput}
                href={() => "/drive/trash"}
                abilities={NO_ABILITIES}
                onNewFolder={off}
                onNewFile={off}
                onUpload={off}
                onRename={off}
                onToggleHidden={off}
                onSetFavorite={off}
                onSetIcon={off}
                onSetNote={off}
                onMove={off}
                onCopy={off}
                onDeletePermanent={off}
                onEmptyFolder={off}
                onScheduleDelete={off}
                trash={{
                    rows: byId,
                    folderHref,
                    onRestore: abilities.restore ? onRestore : undefined,
                    onDeleteForever: abilities.remove
                        ? (targets) => void onDeleteForever(targets)
                        : undefined,
                    onEmpty: abilities.remove ? () => void onEmpty() : undefined
                }}
            />
            {confirmDialog}
        </>
    );
}
