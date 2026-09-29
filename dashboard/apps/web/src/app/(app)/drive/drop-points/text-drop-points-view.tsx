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
import { useEffect, useState, useTransition } from "react";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { Ban, Check, Copy, Lock, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import {
    deleteTextRequestAction,
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
        <div className="flex flex-col gap-2">
            {rows.map((row) => {
                const state = status(row);
                const scheduled = row.startsAt && new Date(row.startsAt).getTime() > Date.now();
                return (
                    <Card key={row.id}>
                        <CardBody className="flex flex-wrap items-center justify-between gap-3">
                            <Link
                                href={`/drive/drop-points/text/${row.id}`}
                                className="flex min-w-0 flex-1 items-center gap-3 rounded-md transition-colors hover:opacity-80"
                            >
                                <MessageSquare className="size-4 shrink-0 text-primary" />
                                <div className="min-w-0">
                                    <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                                        {row.title}
                                        {row.requireLogin ? (
                                            <Lock className="size-3 text-muted-foreground" />
                                        ) : null}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {t("list.collected", {
                                            count:
                                                row.maxSubmissions !== null
                                                    ? `${row.submissionCount}/${row.maxSubmissions}`
                                                    : String(row.submissionCount)
                                        })}
                                        {scheduled && row.startsAt
                                            ? t("list.opens", { date: format.date(row.startsAt) })
                                            : row.expiresAt
                                              ? t("list.until", { date: format.date(row.expiresAt) })
                                              : ""}
                                    </p>
                                </div>
                            </Link>
                            <div className="flex items-center gap-1">
                                <Badge variant={state.variant}>{t(state.label)}</Badge>
                                {row.canReveal && !row.revokedAt ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        title={t("textList.copyTheLink")}
                                        aria-label={t("list.copyLinkTo", { name: row.title })}
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
                                        size="sm"
                                        variant="ghost"
                                        title={t("textList.reopen")}
                                        aria-label={t("list.reopenNamed", { name: row.title })}
                                        onClick={() => onReopen(row)}
                                        disabled={pending && busy === row.id}
                                    >
                                        <RotateCcw className="size-4" />
                                    </Button>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        title={t("textList.close")}
                                        aria-label={t("list.closeNamed", { name: row.title })}
                                        onClick={() => onClose(row)}
                                        disabled={pending && busy === row.id}
                                    >
                                        <Ban className="size-4" />
                                    </Button>
                                )}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    title={t("textList.delete")}
                                    aria-label={t("list.deleteNamed", { name: row.title })}
                                    onClick={() => onDelete(row)}
                                    disabled={pending && busy === row.id}
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            </div>
                        </CardBody>
                    </Card>
                );
            })}
            {confirmDialog}
        </div>
    );
}
