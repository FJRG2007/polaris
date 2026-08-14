"use client";

/**
 * The snippet list. A search box filters by title, description or file name;
 * each row opens the snippet, and the actions beside it - copy the link, change
 * how it is shared, read its access log, delete it - sit outside the row link so
 * using one does not navigate away.
 *
 * The rows are held locally so sharing or revoking one is instant, and taken
 * back over whenever the server sends a newer list.
 */

import Link from "next/link";
import { formatBytes } from "@polaris/core";
import { useConfirm } from "@/components/confirm-dialog";
import { useDisplayFormat } from "@/components/display-format";
import { Badge, Button, Card, CardBody, Input } from "@polaris/ui";
import { useEffect, useMemo, useState, useTransition } from "react";
import { ShareSnippetDialog, type SnippetSharing } from "./share-snippet-dialog";
import {
    Code2,
    Copy,
    Check,
    EyeOff,
    Flame,
    ScrollText,
    Search,
    Share2,
    Trash2
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@polaris/ui";
import {
    deleteSnippetAction,
    getSnippetLogsAction,
    revealSnippetLinkAction,
    type SnippetLogRow
} from "./snippet-actions";

export interface SnippetRow {
    id: string;
    title: string;
    description: string | null;
    visibility: string;
    clientSealed: boolean;
    burnAfterRead: boolean;
    maxViews: number | null;
    viewCount: number;
    expiresAt: string | null;
    revokedAt: string | null;
    updatedAt: string;
    canReveal: boolean;
    files: { name: string; language: string; size: number }[];
}

function status(snippet: SnippetRow): {
    label: string;
    variant: "success" | "neutral" | "warning";
} {
    if (snippet.visibility === "private" && !snippet.revokedAt) {
        return { label: "Private", variant: "neutral" };
    }
    if (snippet.revokedAt) return { label: "Revoked", variant: "neutral" };
    if (snippet.expiresAt && new Date(snippet.expiresAt).getTime() <= Date.now()) {
        return { label: "Expired", variant: "warning" };
    }
    if (snippet.maxViews !== null && snippet.viewCount >= snippet.maxViews) {
        return { label: "Used up", variant: "warning" };
    }
    return {
        label: snippet.visibility === "invite" ? "Shared with people" : "Link",
        variant: "success"
    };
}

/** The line under the title: what is in it, and what limits it is under. */
function summary(snippet: SnippetRow, expires: string | null): string {
    const bytes = snippet.files.reduce((total, file) => total + file.size, 0);
    const parts = [
        snippet.files.length === 1 ? snippet.files[0]!.name : `${snippet.files.length} files`,
        formatBytes(bytes)
    ];
    if (snippet.visibility !== "private") {
        parts.push(
            snippet.maxViews !== null
                ? `${snippet.viewCount}/${snippet.maxViews} views`
                : `${snippet.viewCount} views`
        );
    }
    if (expires) parts.push(`expires ${expires}`);
    return parts.join(" - ");
}

export function SnippetsView({ snippets }: { snippets: SnippetRow[] }) {
    const format = useDisplayFormat();
    const [rows, setRows] = useState(snippets);
    const [query, setQuery] = useState("");
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<string | null>(null);
    const [sharing, setSharing] = useState<SnippetSharing | null>(null);
    const [logsFor, setLogsFor] = useState<SnippetRow | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    useEffect(() => setRows(snippets), [snippets]);

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return rows;
        return rows.filter((row) =>
            [row.title, row.description ?? "", ...row.files.map((file) => file.name)]
                .join(" ")
                .toLowerCase()
                .includes(needle)
        );
    }, [rows, query]);

    async function onCopyLink(row: SnippetRow) {
        setBusy(row.id);
        const result = await revealSnippetLinkAction(row.id);
        setBusy(null);
        if (result.error || !result.url) {
            await confirm({
                title: "No link to copy",
                description: result.error ?? "This snippet has not been shared yet.",
                alert: true
            });
            return;
        }
        await navigator.clipboard.writeText(result.url);
        setCopied(row.id);
        window.setTimeout(() => setCopied(null), 2000);
    }

    async function onDelete(row: SnippetRow) {
        const confirmed = await confirm({
            title: `Delete "${row.title}"?`,
            description: "The text is deleted with it, and any link stops working.",
            confirmLabel: "Delete",
            danger: true
        });
        if (!confirmed) return;
        setBusy(row.id);
        startTransition(async () => {
            const result = await deleteSnippetAction(row.id);
            setBusy(null);
            if (result.error) {
                await confirm({
                    title: "Could not delete it",
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
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    Nothing here yet. A snippet is text you can hand out by link - a config file, an
                    .env, a stack trace - under the same limits as a shared file.
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
                    placeholder="Search snippets"
                    className="pl-9"
                />
            </div>

            {filtered.length === 0 ? (
                <Card>
                    <CardBody className="p-6 text-center text-sm text-muted-foreground">
                        No snippets match &quot;{query}&quot;.
                    </CardBody>
                </Card>
            ) : (
                <div className="flex flex-col gap-2">
                    {filtered.map((row) => {
                        const state = status(row);
                        const expires = row.expiresAt ? format.date(row.expiresAt) : null;
                        return (
                            <Card key={row.id}>
                                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                                    <Link
                                        href={`/drive/snippets/${row.id}`}
                                        className="flex min-w-0 flex-1 items-center gap-3 rounded-md transition-colors hover:opacity-80"
                                    >
                                        <Code2 className="size-4 shrink-0 text-primary" />
                                        <div className="min-w-0">
                                            <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                                                {row.title}
                                                {row.clientSealed ? (
                                                    <EyeOff
                                                        className="size-3 shrink-0 text-muted-foreground"
                                                        aria-label="Sealed - Polaris cannot read this"
                                                    />
                                                ) : null}
                                                {row.burnAfterRead ? (
                                                    <Flame
                                                        className="size-3 shrink-0 text-muted-foreground"
                                                        aria-label="Deleted after it is read once"
                                                    />
                                                ) : null}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {summary(row, expires)}
                                            </p>
                                        </div>
                                    </Link>
                                    <div className="flex items-center gap-1">
                                        <Badge variant={state.variant}>{state.label}</Badge>
                                        {row.canReveal && !row.revokedAt ? (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                title="Copy the link"
                                                aria-label={`Copy the link to ${row.title}`}
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
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            title="Sharing"
                                            aria-label={`Change how ${row.title} is shared`}
                                            onClick={() =>
                                                setSharing({
                                                    id: row.id,
                                                    title: row.title,
                                                    visibility: row.visibility,
                                                    burnAfterRead: row.burnAfterRead,
                                                    maxViews: row.maxViews,
                                                    expiresAt: row.expiresAt
                                                })
                                            }
                                        >
                                            <Share2 className="size-4" />
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            title="Who opened it"
                                            aria-label={`Access log for ${row.title}`}
                                            onClick={() => setLogsFor(row)}
                                        >
                                            <ScrollText className="size-4" />
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            title="Delete"
                                            aria-label={`Delete ${row.title}`}
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
                </div>
            )}

            <ShareSnippetDialog
                snippet={sharing}
                onOpenChange={(open) => !open && setSharing(null)}
                onSaved={(id, visibility) => {
                    setRows((prev) =>
                        prev.map((row) =>
                            row.id === id
                                ? {
                                      ...row,
                                      visibility,
                                      canReveal: visibility !== "private",
                                      revokedAt:
                                          visibility === "private" ? new Date().toISOString() : null
                                  }
                                : row
                        )
                    );
                    setSharing(null);
                }}
            />
            <SnippetLogsDialog
                snippet={logsFor}
                onOpenChange={(open) => !open && setLogsFor(null)}
            />
            {confirmDialog}
        </div>
    );
}

/** Who opened a snippet, when, and from where. */
function SnippetLogsDialog({
    snippet,
    onOpenChange
}: {
    snippet: SnippetRow | null;
    onOpenChange: (open: boolean) => void;
}) {
    const format = useDisplayFormat();
    const [logs, setLogs] = useState<SnippetLogRow[] | null>(null);

    useEffect(() => {
        if (!snippet) {
            setLogs(null);
            return;
        }
        let live = true;
        void getSnippetLogsAction(snippet.id).then((result) => {
            if (live) setLogs(result.logs);
        });
        return () => {
            live = false;
        };
    }, [snippet]);

    return (
        <Dialog open={snippet !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Access log</DialogTitle>
                    <DialogDescription>{snippet?.title}</DialogDescription>
                </DialogHeader>
                {logs === null ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">Loading...</p>
                ) : logs.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        Nobody has opened this link yet.
                    </p>
                ) : (
                    <div className="max-h-80 overflow-auto">
                        <table className="w-full text-left text-xs">
                            <thead className="text-muted-foreground">
                                <tr>
                                    <th className="py-1 pr-3 font-medium">When</th>
                                    <th className="py-1 pr-3 font-medium">Address</th>
                                    <th className="py-1 font-medium">What</th>
                                </tr>
                            </thead>
                            <tbody>
                                {logs.map((log) => (
                                    <tr key={log.id} className="border-t border-border">
                                        <td className="py-1 pr-3 whitespace-nowrap">
                                            {format.dateTime(log.at)}
                                        </td>
                                        <td className="py-1 pr-3 font-mono">{log.ip ?? "-"}</td>
                                        <td className="py-1">
                                            {log.action}
                                            {log.reason ? ` (${log.reason})` : ""}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
