"use client";

/**
 * Drop-points list, as a table - the same table Game Servers lists its servers
 * in, so the two screens that list things somebody runs read alike.
 *
 * A search box filters by title, destination, or connection. Each name opens the
 * drop point's detail page (collected files, config, visitors). Rows are chosen
 * the way Drive chooses files - the checkbox, Shift for a stretch, Ctrl (Cmd)
 * with a press, Ctrl+A for every row shown - and the chosen ones are deleted in
 * one go behind one question, the same one a single delete asks. Deleting asks
 * what to do with the folder, so it opens its own dialog rather than the shared
 * confirm. The public link is never shown here - only its hash is stored.
 */

import Link from "next/link";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useRowSelection } from "./use-row-selection";
import { useConfirm } from "@/components/confirm-dialog";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Card, CardBody, Checkbox, Input, cn } from "@polaris/ui";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Ban, Inbox, Lock, RotateCcw, Search, Trash2, X } from "lucide-react";
import { DeleteDropPointDialog, type DropPointTarget } from "./delete-drop-point-dialog";
import {
    deleteFileRequestAction,
    deleteFileRequestsAction,
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

const targetOf = (row: DropPointRow): DropPointTarget => ({
    id: row.id,
    title: row.title,
    destinationPath: row.destinationPath,
    connectionName: row.connectionName,
    submissionCount: row.submissionCount
});

export function DropPointsView({ requests }: { requests: DropPointRow[] }) {
    const t = useTranslations("drivePoints");
    const format = useDisplayFormat();
    const [rows, setRows] = useState(requests);
    const [query, setQuery] = useState("");
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<DropPointTarget | readonly DropPointTarget[] | null>(
        null
    );
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
    const ids = useMemo(() => filtered.map((row) => row.id), [filtered]);
    const selection = useRowSelection(ids);
    const chosenRows = filtered.filter((row) => selection.isChosen(row.id));

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
        const many = Array.isArray(target) ? (target as readonly DropPointTarget[]) : null;
        setBusy(many ? "bulk" : (target as DropPointTarget).id);
        startTransition(async () => {
            if (many) {
                const result = await deleteFileRequestsAction(
                    many.map((one) => one.id),
                    deleteFolder
                );
                setBusy(null);
                setDeleting(null);
                setRows((prev) => prev.filter((row) => !result.deleted.includes(row.id)));
                selection.forget(result.deleted);
                const failures = result.failed.length;
                if (result.error || failures > 0) {
                    // What went is gone and what stayed is still listed and still
                    // chosen, with the reasons in front of the user.
                    await confirm({
                        title: t("list.someNotDeleted", { count: failures || many.length }),
                        description:
                            result.error ??
                            result.failed
                                .map((one) => {
                                    const name = many.find((row) => row.id === one.id)?.title ?? "";
                                    return `${name}: ${one.error}`;
                                })
                                .join("\n"),
                        alert: true
                    });
                }
                return;
            }
            const single = target as DropPointTarget;
            const result = await deleteFileRequestAction(single.id, deleteFolder);
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
            setRows((prev) => prev.filter((row) => row.id !== single.id));
            selection.forget([single.id]);
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
                    aria-label={t("list.searchDropPoints")}
                    className="pl-9"
                />
            </div>

            {selection.chosen.length > 0 && (
                <SelectionBar
                    count={selection.chosen.length}
                    busy={pending && busy === "bulk"}
                    onDelete={() => setDeleting(chosenRows.map(targetOf))}
                    onClear={selection.clear}
                />
            )}

            {filtered.length === 0 ? (
                <Card>
                    <CardBody className="p-6 text-center text-sm text-muted-foreground">
                        {t("list.noMatch", { query })}
                    </CardBody>
                </Card>
            ) : (
                <div
                    className="overflow-x-auto rounded-lg border border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    // The table is where Ctrl+A and Escape are heard, as Drive's
                    // file list hears them.
                    tabIndex={0}
                    onKeyDown={selection.onKeyDown}
                    aria-label={t("list.tableLabel")}
                >
                    <table className="w-full min-w-[36rem] text-sm">
                        <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="w-10 px-3 py-2">
                                    <Checkbox
                                        aria-label={t("list.selectAll")}
                                        checked={selection.all}
                                        indeterminate={selection.some}
                                        onChange={selection.toggleAll}
                                    />
                                </th>
                                <th className="px-3 py-2 font-medium">{t("list.name")}</th>
                                <th className="hidden px-3 py-2 font-medium sm:table-cell">
                                    {t("list.destination")}
                                </th>
                                <th className="px-3 py-2 font-medium">{t("list.files")}</th>
                                <th className="px-3 py-2 font-medium">{t("list.state")}</th>
                                <th className="hidden px-3 py-2 font-medium md:table-cell">
                                    {t("list.window")}
                                </th>
                                <th className="px-3 py-2">
                                    <span className="sr-only">{t("list.actions")}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((request) => {
                                const state = status(request);
                                const scheduled =
                                    request.startsAt &&
                                    new Date(request.startsAt).getTime() > Date.now();
                                const chosen = selection.isChosen(request.id);
                                const rowBusy = pending && busy === request.id;
                                const where = `${request.connectionName}${request.destinationPath ? ` / ${request.destinationPath}` : ""}`;
                                return (
                                    <tr
                                        key={request.id}
                                        aria-selected={chosen}
                                        onClick={(event) => selection.pressRow(request.id, event)}
                                        className={cn(
                                            "border-t border-border transition-colors hover:bg-card-hover",
                                            chosen && "bg-primary/5"
                                        )}
                                    >
                                        <td className="px-3 py-2">
                                            <Checkbox
                                                aria-label={t("list.selectNamed", {
                                                    name: request.title
                                                })}
                                                checked={chosen}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    selection.pressBox(request.id, event);
                                                }}
                                                onChange={() => undefined}
                                            />
                                        </td>
                                        <td className="max-w-0 px-3 py-2">
                                            <Link
                                                href={`/drive/drop-points/${request.id}`}
                                                onClick={(event) => {
                                                    // Shift or Ctrl chooses the row
                                                    // instead of opening it.
                                                    if (
                                                        event.shiftKey ||
                                                        event.ctrlKey ||
                                                        event.metaKey
                                                    ) {
                                                        event.preventDefault();
                                                    }
                                                }}
                                                className="flex min-w-0 items-center gap-2 font-medium hover:underline"
                                                title={request.title}
                                            >
                                                <Inbox className="size-4 shrink-0 text-primary" />
                                                <span className="truncate">{request.title}</span>
                                                {request.requireLogin ? (
                                                    <Lock
                                                        className="size-3 shrink-0 text-muted-foreground"
                                                        aria-label={t("list.signInRequired")}
                                                    />
                                                ) : null}
                                            </Link>
                                            {/* Under the name where the column is
                                                hidden, so a phone still says where
                                                it collects. */}
                                            <p
                                                className="truncate text-xs text-muted-foreground sm:hidden"
                                                title={where}
                                            >
                                                {where}
                                            </p>
                                        </td>
                                        <td className="hidden max-w-0 px-3 py-2 text-xs text-muted-foreground sm:table-cell">
                                            <span className="block truncate" title={where}>
                                                {where}
                                            </span>
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">
                                            {request.maxFiles !== null
                                                ? `${request.submissionCount}/${request.maxFiles}`
                                                : request.submissionCount}
                                        </td>
                                        <td className="px-3 py-2">
                                            <Badge variant={state.variant}>{t(state.label)}</Badge>
                                        </td>
                                        <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground md:table-cell">
                                            {scheduled && request.startsAt
                                                ? t("list.opensOn", {
                                                      date: format.date(request.startsAt)
                                                  })
                                                : request.expiresAt
                                                  ? t("list.untilOn", {
                                                        date: format.date(request.expiresAt)
                                                    })
                                                  : "-"}
                                        </td>
                                        <td className="px-3 py-2">
                                            <div className="flex items-center justify-end gap-1">
                                                {request.revokedAt ? (
                                                    <Button
                                                        size="icon-sm"
                                                        variant="ghost"
                                                        aria-label={t("list.reopenNamed", {
                                                            name: request.title
                                                        })}
                                                        title={t("list.reopen")}
                                                        onClick={() => onReopen(request.id)}
                                                        disabled={rowBusy}
                                                    >
                                                        <RotateCcw className="size-4" />
                                                    </Button>
                                                ) : (
                                                    <Button
                                                        size="icon-sm"
                                                        variant="ghost"
                                                        aria-label={t("list.closeNamed", {
                                                            name: request.title
                                                        })}
                                                        title={t("list.close")}
                                                        onClick={() => void onRevoke(request.id)}
                                                        disabled={rowBusy}
                                                    >
                                                        <Ban className="size-4" />
                                                    </Button>
                                                )}
                                                <Button
                                                    size="icon-sm"
                                                    variant="ghost"
                                                    aria-label={t("list.deleteNamed", {
                                                        name: request.title
                                                    })}
                                                    title={t("list.delete")}
                                                    onClick={() => setDeleting(targetOf(request))}
                                                    disabled={rowBusy}
                                                >
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            <DeleteDropPointDialog
                target={deleting}
                busy={
                    pending &&
                    (busy === "bulk" ||
                        (!Array.isArray(deleting) &&
                            busy === (deleting as DropPointTarget | null)?.id))
                }
                onCancel={() => setDeleting(null)}
                onConfirm={onDelete}
            />
            {confirmDialog}
        </div>
    );
}

/** What can be done to the chosen rows, and a way to let go of them. */
export function SelectionBar({
    count,
    busy,
    onDelete,
    onClear
}: {
    count: number;
    busy: boolean;
    onDelete: () => void;
    onClear: () => void;
}) {
    const t = useTranslations("drivePoints");
    return (
        <div
            role="region"
            aria-label={t("list.selectionLabel")}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2"
        >
            <span className="text-sm font-medium">{t("list.selected", { count })}</span>
            <div className="flex items-center gap-1">
                <Button size="sm" variant="danger" onClick={onDelete} disabled={busy}>
                    <Trash2 className="size-4" />
                    {t("list.deleteSelected", { count })}
                </Button>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("list.clearSelection")}
                    title={t("list.clearSelection")}
                    onClick={onClear}
                >
                    <X className="size-4" />
                </Button>
            </div>
        </div>
    );
}
