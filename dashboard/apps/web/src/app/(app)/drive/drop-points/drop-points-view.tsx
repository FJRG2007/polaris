"use client";

/**
 * Drop-points list. A search box filters by title, destination, or connection.
 * Each row links to the drop point's detail page (collected files, config,
 * visitors); the Close/Reopen and Delete actions sit outside the row link so
 * clicking them does not navigate. Deleting asks what to do with the folder, so
 * it opens its own dialog rather than the shared confirm. The public link is never
 * shown here - only its hash is stored.
 */

import Link from "next/link";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useConfirm } from "@/components/confirm-dialog";
import { useDisplayFormat } from "@/components/display-format";
import { Badge, Button, Card, CardBody, Input } from "@polaris/ui";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Ban, Inbox, Lock, RotateCcw, Search, Trash2 } from "lucide-react";
import { DeleteDropPointDialog, type DropPointTarget } from "./delete-drop-point-dialog";
import {
    deleteFileRequestAction,
    reopenFileRequestAction,
    revokeFileRequestAction
} from "../request-actions";

export interface DropPointRow {
    id: string;
    title: string;
    destinationPath: string;
    connectionName: string;
    requireLogin: boolean;
    maxFiles: number | null;
    submissionCount: number;
    startsAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
}

function status(request: DropPointRow): {
    label: NamespaceKey<"drivePoints">;
    variant: "success" | "neutral" | "warning";
} {
    if (request.revokedAt) return { label: "status.closed", variant: "neutral" };
    if (request.startsAt && new Date(request.startsAt).getTime() > Date.now()) {
        return { label: "status.scheduled", variant: "warning" };
    }
    if (request.expiresAt && new Date(request.expiresAt).getTime() <= Date.now()) {
        return { label: "status.expired", variant: "warning" };
    }
    if (request.maxFiles !== null && request.submissionCount >= request.maxFiles) {
        return { label: "status.full", variant: "warning" };
    }
    return { label: "status.open", variant: "success" };
}

export function DropPointsView({ requests }: { requests: DropPointRow[] }) {
    const t = useTranslations("drivePoints");
    const format = useDisplayFormat();
    const [rows, setRows] = useState(requests);
    const [query, setQuery] = useState("");
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<DropPointTarget | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    // The rows are held locally so closing or reopening one is instant. That
    // copy is made once, though, so anything the server learns afterwards - a
    // drop point just created, one closed in another tab - has to be taken back
    // over, or the page looks unchanged until it is reloaded by hand.
    useEffect(() => setRows(requests), [requests]);

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return rows;
        return rows.filter((row) =>
            [row.title, row.connectionName, row.destinationPath]
                .join(" ")
                .toLowerCase()
                .includes(needle)
        );
    }, [rows, query]);

    async function onRevoke(id: string) {
        if (
            !(await confirm({
                title: t("list.closeThisDropPoint"),
                description: t("list.itWillStopAcceptingUploads"),
                confirmLabel: t("list.close"),
                danger: true
            }))
        )
            return;
        setBusy(id);
        startTransition(async () => {
            await revokeFileRequestAction(id);
            setRows((prev) =>
                prev.map((row) =>
                    row.id === id ? { ...row, revokedAt: new Date().toISOString() } : row
                )
            );
            setBusy(null);
        });
    }

    function onReopen(id: string) {
        setBusy(id);
        startTransition(async () => {
            await reopenFileRequestAction(id);
            setRows((prev) =>
                prev.map((row) => (row.id === id ? { ...row, revokedAt: null } : row))
            );
            setBusy(null);
        });
    }

    function onDelete(deleteFolder: boolean) {
        const target = deleting;
        if (!target) return;
        setBusy(target.id);
        startTransition(async () => {
            const result = await deleteFileRequestAction(target.id, deleteFolder);
            setBusy(null);
            if (result.error) {
                // Nothing was deleted: the drop point and its folder are both still
                // there, so the row stays and the reason is put in front of the user.
                setDeleting(null);
                await confirm({
                    title: t("list.couldnTDeleteThisDrop"),
                    description: result.error,
                    alert: true
                });
                return;
            }
            setRows((prev) => prev.filter((row) => row.id !== target.id));
            setDeleting(null);
        });
    }

    if (rows.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    {t("list.noDropPointsYetUse")}
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("list.searchDropPoints")}
                    className="pl-9"
                />
            </div>

            {filtered.length === 0 ? (
                <Card>
                    <CardBody className="p-6 text-center text-sm text-muted-foreground">
                        {t("list.noMatch", { query })}
                    </CardBody>
                </Card>
            ) : (
                <div className="flex flex-col gap-2">
                    {filtered.map((request) => {
                        const state = status(request);
                        const scheduled =
                            request.startsAt && new Date(request.startsAt).getTime() > Date.now();
                        return (
                            <Card key={request.id}>
                                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                                    <Link
                                        href={`/drive/drop-points/${request.id}`}
                                        className="flex min-w-0 flex-1 items-center gap-3 rounded-md transition-colors hover:opacity-80"
                                    >
                                        <Inbox className="size-4 shrink-0 text-primary" />
                                        <div className="min-w-0">
                                            <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                                                {request.title}
                                                {request.requireLogin ? (
                                                    <Lock className="size-3 text-muted-foreground" />
                                                ) : null}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {request.connectionName}
                                                {request.destinationPath
                                                    ? ` / ${request.destinationPath}`
                                                    : ""}
                                                {` - ${request.submissionCount}`}
                                                {request.maxFiles !== null
                                                    ? `/${request.maxFiles}`
                                                    : ""}
                                                {t("list.uploaded")}
                                                {scheduled && request.startsAt
                                                    ? t("list.opens", { date: format.date(request.startsAt) })
                                                    : request.expiresAt
                                                      ? t("list.until", { date: format.date(request.expiresAt) })
                                                      : ""}
                                            </p>
                                        </div>
                                    </Link>
                                    <div className="flex items-center gap-2">
                                        <Badge variant={state.variant}>{t(state.label)}</Badge>
                                        {request.revokedAt ? (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => onReopen(request.id)}
                                                disabled={pending && busy === request.id}
                                            >
                                                <RotateCcw className="size-4" />
                                                {t("list.reopen")}
                                            </Button>
                                        ) : (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => onRevoke(request.id)}
                                                disabled={pending && busy === request.id}
                                            >
                                                <Ban className="size-4" />
                                                {t("list.close")}
                                            </Button>
                                        )}
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            aria-label={t("list.deleteNamed", { name: request.title })}
                                            title={t("list.delete")}
                                            onClick={() =>
                                                setDeleting({
                                                    id: request.id,
                                                    title: request.title,
                                                    destinationPath: request.destinationPath,
                                                    connectionName: request.connectionName,
                                                    submissionCount: request.submissionCount
                                                })
                                            }
                                            disabled={pending && busy === request.id}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </div>
                                </CardBody>
                            </Card>
                        );
                    })}
                </div>
            )}
            <DeleteDropPointDialog
                target={deleting}
                busy={pending && busy === deleting?.id}
                onCancel={() => setDeleting(null)}
                onConfirm={onDelete}
            />
            {confirmDialog}
        </div>
    );
}
