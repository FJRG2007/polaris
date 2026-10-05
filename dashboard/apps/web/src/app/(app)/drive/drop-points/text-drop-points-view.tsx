"use client";

/**
 * The text drop points, listed under the file ones on the same page: they are
 * the same act - asking somebody for something - and splitting them across two
 * screens would mean remembering which kind you opened.
 *
 * Each row opens what it has collected. Copy, close, reopen and delete sit
 * outside the row link so using one does not navigate.
 */

import Link from "next/link";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useConfirm } from "@/components/confirm-dialog";
import { SelectionBar } from "./drop-points-view";
import { useRowSelection } from "./use-row-selection";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Badge, Button, Card, CardBody, Checkbox, cn } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { Ban, Check, Copy, Lock, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import {
    deleteTextRequestAction,
    deleteTextRequestsAction,
    reopenTextRequestAction,
    revealTextRequestLinkAction,
    revokeTextRequestAction
} from "./text-request-actions";

export interface TextDropPointRow {
    id: string;
    title: string;
    requireLogin: boolean;
    maxSubmissions: number | null;
    submissionCount: number;
    startsAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    canReveal: boolean;
}

function status(row: TextDropPointRow): {
    label: NamespaceKey<"drivePoints">;
    variant: "success" | "neutral" | "warning";
} {
    if (row.revokedAt) return { label: "status.closed", variant: "neutral" };
    if (row.startsAt && new Date(row.startsAt).getTime() > Date.now()) {
        return { label: "status.scheduled", variant: "warning" };
    }
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
        return { label: "status.expired", variant: "warning" };
    }
    if (row.maxSubmissions !== null && row.submissionCount >= row.maxSubmissions) {
        return { label: "status.full", variant: "warning" };
    }
    return { label: "status.open", variant: "success" };
}

export function TextDropPointsView({ requests }: { requests: TextDropPointRow[] }) {
    const t = useTranslations("drivePoints");
    const format = useDisplayFormat();
    const [rows, setRows] = useState(requests);
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    useEffect(() => setRows(requests), [requests]);

    const ids = useMemo(() => rows.map((row) => row.id), [rows]);
    const selection = useRowSelection(ids);

    /** Every chosen one, behind one question. What each collected stays in the
     *  owner's snippets, as it does for one. */
    async function onDeleteChosen() {
        const chosen = rows.filter((row) => selection.isChosen(row.id));
        const confirmed = await confirm({
            title: t("textList.deleteMany", { count: chosen.length }),
            description: t("textList.theLinksStopWorking"),
            confirmLabel: t("textList.delete"),
            danger: true
        });
        if (!confirmed) return;
        setBusy("bulk");
        startTransition(async () => {
            const result = await deleteTextRequestsAction(chosen.map((row) => row.id));
            setBusy(null);
            setRows((prev) => prev.filter((row) => !result.deleted.includes(row.id)));
            selection.forget(result.deleted);
            if (result.error || result.failed.length > 0) {
                await confirm({
                    title: t("list.someNotDeleted", {
                        count: result.failed.length || chosen.length
                    }),
                    description:
                        result.error ??
                        result.failed
                            .map(
                                (one) =>
                                    `${chosen.find((row) => row.id === one.id)?.title ?? ""}: ${one.error}`
                            )
                            .join("\n"),
                    alert: true
                });
            }
        });
    }

    async function onCopyLink(row: TextDropPointRow) {
        setBusy(row.id);
        const result = await revealTextRequestLinkAction(row.id);
        setBusy(null);
        if (result.error || !result.url) {
            await confirm({
                title: t("textList.noLinkToCopy"),
                description: result.error ?? t("textList.thisDropPointHasNo"),
                alert: true
            });
            return;
        }
        await navigator.clipboard.writeText(result.url);
        setCopied(row.id);
        window.setTimeout(() => setCopied(null), 2000);
    }

    async function onClose(row: TextDropPointRow) {
        const confirmed = await confirm({
            title: t("list.closeTitle", { name: row.title }),
            description: t("textList.itStopsAcceptingAnythingImmediately"),
            confirmLabel: t("textList.close"),
            danger: true
        });
        if (!confirmed) return;
        setBusy(row.id);
        startTransition(async () => {
            await revokeTextRequestAction(row.id);
            setRows((prev) =>
                prev.map((item) =>
                    item.id === row.id ? { ...item, revokedAt: new Date().toISOString() } : item
                )
            );
            setBusy(null);
        });
    }

    function onReopen(row: TextDropPointRow) {
        setBusy(row.id);
        startTransition(async () => {
            await reopenTextRequestAction(row.id);
            setRows((prev) =>
                prev.map((item) => (item.id === row.id ? { ...item, revokedAt: null } : item))
            );
            setBusy(null);
        });
    }

    async function onDelete(row: TextDropPointRow) {
        const confirmed = await confirm({
            title: t("list.deleteTitle", { name: row.title }),
            description: t("textList.theLinkStopsWorkingWhat"),
            confirmLabel: t("textList.delete"),
            danger: true
        });
        if (!confirmed) return;
        setBusy(row.id);
        startTransition(async () => {
            const result = await deleteTextRequestAction(row.id);
            setBusy(null);
            if (result.error) {
                await confirm({
                    title: t("textList.couldNotDeleteIt"),
                    description: result.error,
                    alert: true
                });
                return;
            }
            setRows((prev) => prev.filter((item) => item.id !== row.id));
            selection.forget([row.id]);
        });
    }

    if (rows.length === 0) {
        return (
            <Card>
                <CardBody className="p-6 text-center text-sm text-muted-foreground">
                    {t("textList.noTextDropPointsYet")}
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {selection.chosen.length > 0 && (
                <SelectionBar
                    count={selection.chosen.length}
                    busy={pending && busy === "bulk"}
                    onDelete={() => void onDeleteChosen()}
                    onClear={selection.clear}
                />
            )}
            <div
                className="overflow-x-auto rounded-lg border border-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                tabIndex={0}
                onKeyDown={selection.onKeyDown}
                aria-label={t("textList.tableLabel")}
            >
                <table className="w-full min-w-[32rem] text-sm">
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
                            <th className="px-3 py-2 font-medium">{t("textList.answers")}</th>
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
                        {rows.map((row) => {
                            const state = status(row);
                            const scheduled =
                                row.startsAt && new Date(row.startsAt).getTime() > Date.now();
                            const chosen = selection.isChosen(row.id);
                            const rowBusy = pending && busy === row.id;
                            return (
                                <tr
                                    key={row.id}
                                    aria-selected={chosen}
                                    onClick={(event) => selection.pressRow(row.id, event)}
                                    className={cn(
                                        "border-t border-border transition-colors hover:bg-card-hover",
                                        chosen && "bg-primary/5"
                                    )}
                                >
                                    <td className="px-3 py-2">
                                        <Checkbox
                                            aria-label={t("list.selectNamed", { name: row.title })}
                                            checked={chosen}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                selection.pressBox(row.id, event);
                                            }}
                                            onChange={() => undefined}
                                        />
                                    </td>
                                    <td className="max-w-0 px-3 py-2">
                                        <Link
                                            href={`/drive/drop-points/text/${row.id}`}
                                            onClick={(event) => {
                                                if (
                                                    event.shiftKey ||
                                                    event.ctrlKey ||
                                                    event.metaKey
                                                ) {
                                                    event.preventDefault();
                                                }
                                            }}
                                            className="flex min-w-0 items-center gap-2 font-medium hover:underline"
                                            title={row.title}
                                        >
                                            <MessageSquare className="size-4 shrink-0 text-primary" />
                                            <span className="truncate">{row.title}</span>
                                            {row.requireLogin ? (
                                                <Lock
                                                    className="size-3 shrink-0 text-muted-foreground"
                                                    aria-label={t("list.signInRequired")}
                                                />
                                            ) : null}
                                        </Link>
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">
                                        {row.maxSubmissions !== null
                                            ? `${row.submissionCount}/${row.maxSubmissions}`
                                            : row.submissionCount}
                                    </td>
                                    <td className="px-3 py-2">
                                        <Badge variant={state.variant}>{t(state.label)}</Badge>
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-2 text-xs text-muted-foreground md:table-cell">
                                        {scheduled && row.startsAt
                                            ? t("list.opensOn", { date: format.date(row.startsAt) })
                                            : row.expiresAt
                                              ? t("list.untilOn", {
                                                    date: format.date(row.expiresAt)
                                                })
                                              : "-"}
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="flex items-center justify-end gap-1">
                                            {row.canReveal && !row.revokedAt ? (
                                                <Button
                                                    size="icon-sm"
                                                    variant="ghost"
                                                    title={t("textList.copyTheLink")}
                                                    aria-label={t("list.copyLinkTo", {
                                                        name: row.title
                                                    })}
                                                    onClick={() => onCopyLink(row)}
                                                    disabled={busy === row.id}
                                                >
                                                    {copied === row.id ? (
                                                        <Check className="size-4 text-success" />
                                                    ) : (
                                                        <Copy className="size-4" />
                                                    )}
                                                </Button>
                                            ) : null}
                                            {row.revokedAt ? (
                                                <Button
                                                    size="icon-sm"
                                                    variant="ghost"
                                                    title={t("textList.reopen")}
                                                    aria-label={t("list.reopenNamed", {
                                                        name: row.title
                                                    })}
                                                    onClick={() => onReopen(row)}
                                                    disabled={rowBusy}
                                                >
                                                    <RotateCcw className="size-4" />
                                                </Button>
                                            ) : (
                                                <Button
                                                    size="icon-sm"
                                                    variant="ghost"
                                                    title={t("textList.close")}
                                                    aria-label={t("list.closeNamed", {
                                                        name: row.title
                                                    })}
                                                    onClick={() => onClose(row)}
                                                    disabled={rowBusy}
                                                >
                                                    <Ban className="size-4" />
                                                </Button>
                                            )}
                                            <Button
                                                size="icon-sm"
                                                variant="ghost"
                                                title={t("textList.delete")}
                                                aria-label={t("list.deleteNamed", {
                                                    name: row.title
                                                })}
                                                onClick={() => onDelete(row)}
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
            {confirmDialog}
        </div>
    );
}
