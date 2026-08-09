"use client";

/**
 * One protected thing: its copies, and where each one landed.
 *
 * The per-destination status is the whole point of this screen. A backup whose
 * bucket copy failed while its local copy landed is still restorable, and saying
 * only "partial" would leave somebody guessing which half they still have.
 *
 * Restoring is destructive and says so before it runs. Downloading is not, so it
 * is a plain link - the one thing somebody reaching for a backup at 3am should
 * not have to think about.
 */

import Link from "next/link";
import { readJson } from "../read-json";
import { formatBytes } from "@polaris/core";
import { useCallback, useEffect, useState } from "react";
import type { PointRow, ResourceDetail } from "../types";
import { useDisplayFormat } from "@/components/display-format";
import { backUpNowAction, deletePointAction, restoreAction } from "../actions";
import { ArrowLeft, Download, HardDriveDownload, Loader2, RotateCcw, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ConfirmDeleteDialog,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Skeleton
} from "@polaris/ui";

export function ResourceDetailView({ resourceId }: { resourceId: string }) {
    const format = useDisplayFormat();
    const [detail, setDetail] = useState<ResourceDetail | null>(null);
    const [missing, setMissing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [restoring, setRestoring] = useState<{ copyId: string; where: string } | null>(null);
    const [deleting, setDeleting] = useState<PointRow | null>(null);

    // Read the way the console reads: a session that has run out is answered with
    // the sign-in page, which `json()` throws on - and a throw inside this effect
    // is what takes the page down rather than showing that it has nothing to draw.
    const load = useCallback(async () => {
        const result = await readJson<ResourceDetail>(`/api/backups/resources/${resourceId}`);
        if (result.ok) {
            setDetail(result.value);
            setError(null);
            return;
        }
        // A row somebody deleted in another tab is gone, not broken.
        if (result.status === 404) setMissing(true);
        else setError(result.reason);
    }, [resourceId]);

    useEffect(() => {
        void load();
    }, [load]);

    async function onBackUpNow() {
        setBusy(true);
        setError(null);
        const result = await backUpNowAction(resourceId);
        setBusy(false);
        if (result.error) setError(result.error);
        await load();
    }

    async function onRestore() {
        if (!restoring) return;
        const target = restoring;
        setRestoring(null);
        setBusy(true);
        setError(null);
        const result = await restoreAction({ copyId: target.copyId, confirm: true });
        setBusy(false);
        if (result.error) setError(result.error);
        await load();
    }

    async function onDeletePoint() {
        if (!deleting) return;
        const target = deleting;
        setDeleting(null);
        setBusy(true);
        const result = await deletePointAction(target.id);
        setBusy(false);
        if (result.error) setError(result.error);
        await load();
    }

    if (missing) {
        return (
            <Card>
                <CardBody className="flex flex-col items-start gap-3 py-10">
                    <p className="text-sm text-muted-foreground">That protected item does not exist any more.</p>
                    <Button asChild variant="ghost" size="sm">
                        <Link href="/apps/backups">
                            <ArrowLeft className="size-4" />
                            Back to backups
                        </Link>
                    </Button>
                </CardBody>
            </Card>
        );
    }

    const resource = detail?.resource;

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    {resource ? (
                        <>
                            <h1 className="truncate text-lg font-medium" title={resource.name}>{resource.name}</h1>
                            <p className="text-xs text-muted-foreground">
                                {resource.kindLabel}
                                {resource.planName ? ` - ${resource.planName}` : " - on demand"}
                                {resource.nextDueAt ? ` - next ${format.dateTime(resource.nextDueAt)}` : ""}
                            </p>
                        </>
                    ) : (
                        <Skeleton className="h-7 w-56" />
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <Button asChild variant="ghost" size="sm">
                        <Link href="/apps/backups">
                            <ArrowLeft className="size-4" />
                            Back
                        </Link>
                    </Button>
                    <Button size="sm" onClick={() => void onBackUpNow()} disabled={busy || !resource}>
                        {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <HardDriveDownload className="size-4" />
                        )}
                        Back up now
                    </Button>
                </div>
            </div>

            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {resource?.lastStatus === "partial" ? (
                <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                    The last copy landed in some destinations but not all. What did land is still restorable.
                </p>
            ) : null}

            <Card>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="border-b border-border text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2 font-medium">Taken</th>
                                <th className="px-3 py-2 text-right font-medium">Size</th>
                                <th className="px-3 py-2 font-medium">Where it is</th>
                                <th className="px-3 py-2 font-medium">Expires</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {detail === null ? (
                                Array.from({ length: 4 }, (_, index) => (
                                    <tr key={index} className="border-b border-border last:border-0">
                                        <td colSpan={5} className="px-3 py-2.5">
                                            <Skeleton className="h-5 w-full" />
                                        </td>
                                    </tr>
                                ))
                            ) : detail.points.length === 0 ? (
                                <tr>
                                    <td colSpan={5} className="px-3 py-10 text-center text-sm text-muted-foreground">
                                        No copies yet. Back it up now, or give it a plan.
                                    </td>
                                </tr>
                            ) : (
                                detail.points.map((point) => (
                                    <tr key={point.id} className="border-b border-border last:border-0 align-top">
                                        <td className="px-3 py-2.5">
                                            {format.dateTime(point.takenAt)}
                                            {point.status === "partial" ? (
                                                <Badge variant="warning" className="ml-2">
                                                    Partial
                                                </Badge>
                                            ) : null}
                                            {point.error ? (
                                                <p className="text-xs text-danger">{point.error}</p>
                                            ) : null}
                                        </td>
                                        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                                            {formatBytes(BigInt(point.sizeBytes))}
                                        </td>
                                        <td className="px-3 py-2.5">
                                            <ul className="flex flex-col gap-1">
                                                {point.copies.map((copy) => (
                                                    <li key={copy.id} className="flex items-center gap-2 text-xs">
                                                        <span
                                                            className={
                                                                copy.status === "available"
                                                                    ? "text-foreground"
                                                                    : "text-danger"
                                                            }
                                                        >
                                                            {copy.destinationName}
                                                        </span>
                                                        {copy.status !== "available" ? (
                                                            <span className="text-danger" title={copy.error ?? ""}>
                                                                {copy.status}
                                                            </span>
                                                        ) : null}
                                                        {copy.downloadable ? (
                                                            <a
                                                                href={`/api/backups/copies/${copy.id}/download`}
                                                                download
                                                                className="text-primary hover:underline"
                                                                aria-label={`Download the copy in ${copy.destinationName}`}
                                                            >
                                                                <Download className="size-3.5" />
                                                            </a>
                                                        ) : null}
                                                        {copy.downloadable && resource?.canRestore ? (
                                                            <button
                                                                type="button"
                                                                className="text-primary hover:underline"
                                                                aria-label={`Restore from ${copy.destinationName}`}
                                                                title="Put this copy back"
                                                                onClick={() =>
                                                                    setRestoring({
                                                                        copyId: copy.id,
                                                                        where: copy.destinationName
                                                                    })
                                                                }
                                                            >
                                                                <RotateCcw className="size-3.5" />
                                                            </button>
                                                        ) : null}
                                                    </li>
                                                ))}
                                            </ul>
                                        </td>
                                        <td className="px-3 py-2.5 text-xs text-muted-foreground">
                                            {point.expiresAt ? format.dateTime(point.expiresAt) : "Kept"}
                                        </td>
                                        <td className="px-3 py-2.5">
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                aria-label="Delete this backup"
                                                title="Delete this backup everywhere"
                                                onClick={() => setDeleting(point)}
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </Card>

            {resource && !resource.canRestore ? (
                <p className="text-xs text-muted-foreground">
                    {resource.kind === "polaris-database"
                        ? "Polaris is running on this database, so it cannot be rewritten from here. Download the copy and load it with Polaris stopped."
                        : "This kind cannot be put back automatically - download the copy and restore it yourself."}
                </p>
            ) : null}

            {restoring ? (
                <Dialog open onOpenChange={(open) => !open && setRestoring(null)}>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle>Put this copy back?</DialogTitle>
                            <DialogDescription>
                                The copy in {restoring.where} will be written over what is there now. For a game
                                world it lands as a new level beside the one being played, so nothing is lost until
                                you switch to it. For anything else, the current data is replaced.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex justify-end gap-2">
                            <DialogClose asChild>
                                <Button variant="ghost">Cancel</Button>
                            </DialogClose>
                            <Button variant="danger" onClick={() => void onRestore()}>
                                Restore
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            ) : null}

            {deleting ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setDeleting(null)}
                    name={format.dateTime(deleting.takenAt)}
                    kind="backup"
                    requireTyping={false}
                    description={`Every copy of it goes - ${deleting.copies.length === 1 ? `the one in ${deleting.copies[0]?.destinationName}` : `all ${deleting.copies.length} of them`}. This cannot be undone.`}
                    confirmLabel="Delete everywhere"
                    onConfirm={() => void onDeletePoint()}
                />
            ) : null}
        </div>
    );
}
