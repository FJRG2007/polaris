"use client";

/**
 * Manage-shares view. Lists the current user's share links with their guardrails
 * and lets them reveal the link again, edit its limits, inspect its access log
 * (who viewed/downloaded, from which IP, how often), and revoke it. The link is
 * recoverable because the token is stored encrypted under the master key; a DB
 * dump alone still yields nothing without that key.
 */

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Ban, Check, Copy, FileText, FolderClosed, FolderOpen, Link2, Pencil, ScrollText } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import {
    getShareLogsAction,
    revealShareLinkAction,
    revokeShareAction,
    updateShareAction,
    type ShareLogRow
} from "../share-actions";

export interface ShareRow {
    id: string;
    path: string;
    kind: string;
    connectionId: string;
    connectionName: string;
    allowUpload: boolean;
    allowDownload: boolean;
    allowPreview: boolean;
    allowedCidrs: string[];
    maxDownloads: number | null;
    downloadCount: number;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    canReveal: boolean;
}

function status(share: ShareRow): { label: string; variant: "success" | "neutral" | "warning" } {
    if (share.revokedAt) return { label: "Revoked", variant: "neutral" };
    if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) {
        return { label: "Expired", variant: "warning" };
    }
    if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) {
        return { label: "Exhausted", variant: "warning" };
    }
    return { label: "Active", variant: "success" };
}

export function SharedView({ shares }: { shares: ShareRow[] }) {
    const [rows, setRows] = useState(shares);
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<string | null>(null);
    const [editing, setEditing] = useState<ShareRow | null>(null);
    const [logsFor, setLogsFor] = useState<ShareRow | null>(null);
    const [revealed, setRevealed] = useState<{ id: string; url: string } | null>(null);
    const [copied, setCopied] = useState(false);

    function onRevoke(id: string) {
        if (!window.confirm("Revoke this link? It will stop working immediately.")) return;
        setBusy(id);
        startTransition(async () => {
            await revokeShareAction(id);
            setRows((prev) => prev.map((row) => (row.id === id ? { ...row, revokedAt: new Date().toISOString() } : row)));
            setBusy(null);
        });
    }

    async function onReveal(row: ShareRow) {
        setBusy(row.id);
        const result = await revealShareLinkAction(row.id);
        setBusy(null);
        if (result.error) {
            window.alert(result.error);
            return;
        }
        setRevealed({ id: row.id, url: result.url ?? "" });
        setCopied(false);
    }

    if (rows.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    You have not shared anything yet. Use the share action on a file or folder in Drive.
                </CardBody>
            </Card>
        );
    }

    return (
        <>
            <div className="flex flex-col gap-2">
                {rows.map((share) => {
                    const state = status(share);
                    const isDir = share.allowUpload || share.path.endsWith("/");
                    return (
                        <Card key={share.id}>
                            <CardBody className="flex flex-col gap-3">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div className="flex min-w-0 items-center gap-3">
                                        {isDir ? (
                                            <FolderClosed className="size-4 shrink-0 text-primary" />
                                        ) : (
                                            <FileText className="size-4 shrink-0 text-muted-foreground" />
                                        )}
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium">{share.path || "(root)"}</p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {share.connectionName}
                                                {share.maxDownloads !== null
                                                    ? ` - ${share.downloadCount}/${share.maxDownloads} downloads`
                                                    : ` - ${share.downloadCount} downloads`}
                                                {share.expiresAt
                                                    ? ` - expires ${new Date(share.expiresAt).toLocaleDateString()}`
                                                    : ""}
                                                {share.allowedCidrs.length > 0 ? ` - IP-restricted` : ""}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Badge variant={state.variant}>{state.label}</Badge>
                                        <Button size="sm" variant="ghost" asChild>
                                            <Link
                                                href={`/drive?c=${share.connectionId}&p=${encodeURIComponent(
                                                    isDir ? share.path : share.path.split("/").slice(0, -1).join("/")
                                                )}`}
                                            >
                                                <FolderOpen className="size-4" />
                                                Open
                                            </Link>
                                        </Button>
                                        {share.canReveal && !share.revokedAt ? (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => onReveal(share)}
                                                disabled={busy === share.id}
                                            >
                                                <Link2 className="size-4" />
                                                Link
                                            </Button>
                                        ) : null}
                                        <Button size="sm" variant="ghost" onClick={() => setLogsFor(share)}>
                                            <ScrollText className="size-4" />
                                            Logs
                                        </Button>
                                        {!share.revokedAt ? (
                                            <Button size="sm" variant="ghost" onClick={() => setEditing(share)}>
                                                <Pencil className="size-4" />
                                                Edit
                                            </Button>
                                        ) : null}
                                        {!share.revokedAt ? (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => onRevoke(share.id)}
                                                disabled={pending && busy === share.id}
                                            >
                                                <Ban className="size-4" />
                                                Revoke
                                            </Button>
                                        ) : null}
                                    </div>
                                </div>
                                {revealed?.id === share.id ? (
                                    <div className="flex items-center gap-2">
                                        <Input readOnly value={revealed.url} className="font-mono text-xs" />
                                        <Button
                                            type="button"
                                            size="icon"
                                            variant="secondary"
                                            onClick={async () => {
                                                await navigator.clipboard.writeText(revealed.url);
                                                setCopied(true);
                                            }}
                                        >
                                            {copied ? (
                                                <Check className="size-4 text-success" />
                                            ) : (
                                                <Copy className="size-4" />
                                            )}
                                        </Button>
                                    </div>
                                ) : null}
                            </CardBody>
                        </Card>
                    );
                })}
            </div>

            <EditShareDialog
                share={editing}
                onOpenChange={(open) => !open && setEditing(null)}
                onSaved={(updated) => {
                    setRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
                    setEditing(null);
                }}
            />
            <ShareLogsDialog share={logsFor} onOpenChange={(open) => !open && setLogsFor(null)} />
        </>
    );
}

function EditShareDialog({
    share,
    onOpenChange,
    onSaved
}: {
    share: ShareRow | null;
    onOpenChange: (open: boolean) => void;
    onSaved: (row: ShareRow) => void;
}) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!share) return;
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const password = String(form.get("password") ?? "");
        const removePassword = form.get("removePassword") === "on";
        const maxDownloads = form.get("maxDownloads");
        const expiresAt = String(form.get("expiresAt") ?? "");
        const allowedCidrs = String(form.get("allowedCidrs") ?? "")
            .split(/[\s,]+/)
            .map((value) => value.trim())
            .filter(Boolean);

        const result = await updateShareAction(share.id, {
            password: removePassword ? null : password ? password : undefined,
            maxDownloads: maxDownloads ? Number(maxDownloads) : null,
            expiresAt: expiresAt || null,
            allowDownload: form.get("allowDownload") === "on",
            allowPreview: form.get("allowPreview") === "on",
            allowUpload: form.get("allowUpload") === "on",
            allowedCidrs
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onSaved({
            ...share,
            maxDownloads: maxDownloads ? Number(maxDownloads) : null,
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            allowDownload: form.get("allowDownload") === "on",
            allowPreview: form.get("allowPreview") === "on",
            allowUpload: form.get("allowUpload") === "on",
            allowedCidrs
        });
    }

    return (
        <Dialog open={share !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Edit link</DialogTitle>
                    <DialogDescription className="truncate">{share?.path || "(root)"}</DialogDescription>
                </DialogHeader>
                {share ? (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Password
                            <Input name="password" type="password" placeholder="Leave blank to keep" autoComplete="off" />
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" name="removePassword" className="size-4" />
                            Remove password
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                Max downloads
                                <Input
                                    name="maxDownloads"
                                    type="number"
                                    min="1"
                                    defaultValue={share.maxDownloads ?? ""}
                                    placeholder="Unlimited"
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                Expires
                                <Input
                                    name="expiresAt"
                                    type="date"
                                    defaultValue={share.expiresAt ? share.expiresAt.slice(0, 10) : ""}
                                />
                            </label>
                        </div>
                        <label className="flex flex-col gap-1 text-sm">
                            Restrict to IPs / ranges
                            <Input
                                name="allowedCidrs"
                                defaultValue={share.allowedCidrs.join(", ")}
                                placeholder="e.g. 203.0.113.4, 10.0.0.0/24"
                                autoComplete="off"
                            />
                        </label>
                        <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="allowDownload"
                                    defaultChecked={share.allowDownload}
                                    className="size-4"
                                />
                                Allow downloading
                            </label>
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="allowPreview"
                                    defaultChecked={share.allowPreview}
                                    className="size-4"
                                />
                                Allow previewing
                            </label>
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="allowUpload"
                                    defaultChecked={share.allowUpload}
                                    className="size-4"
                                />
                                Allow uploads into the folder
                            </label>
                        </div>
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="flex justify-end">
                            <Button type="submit" disabled={pending}>
                                {pending ? "Saving..." : "Save changes"}
                            </Button>
                        </div>
                    </form>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

function ShareLogsDialog({ share, onOpenChange }: { share: ShareRow | null; onOpenChange: (open: boolean) => void }) {
    const [logs, setLogs] = useState<ShareLogRow[] | null>(null);
    const shareId = share?.id ?? null;

    useEffect(() => {
        if (!shareId) return;
        let active = true;
        setLogs(null);
        void getShareLogsAction(shareId).then((result) => {
            if (active) setLogs(result.logs);
        });
        return () => {
            active = false;
        };
    }, [shareId]);

    const views = logs?.filter((row) => row.action === "view").length ?? 0;
    const downloads = logs?.filter((row) => row.action === "download" && !row.reason).length ?? 0;
    const denied = logs?.filter((row) => row.reason).length ?? 0;
    const uniqueIps = new Set((logs ?? []).map((row) => row.ip).filter(Boolean)).size;

    return (
        <Dialog open={share !== null} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Access log</DialogTitle>
                    <DialogDescription className="truncate">{share?.path || "(root)"}</DialogDescription>
                </DialogHeader>
                <div className="mb-2 flex flex-wrap gap-2 text-xs">
                    <Badge variant="neutral">{views} views</Badge>
                    <Badge variant="neutral">{downloads} downloads</Badge>
                    <Badge variant="neutral">{uniqueIps} unique IPs</Badge>
                    {denied > 0 ? <Badge variant="warning">{denied} denied</Badge> : null}
                </div>
                <div className="max-h-[55vh] overflow-auto">
                    {logs === null ? (
                        <p className="p-6 text-center text-sm text-muted-foreground">Loading...</p>
                    ) : logs.length === 0 ? (
                        <p className="p-6 text-center text-sm text-muted-foreground">No access yet.</p>
                    ) : (
                        <table className="w-full text-sm">
                            <thead className="text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="py-1 pr-3 font-medium">When</th>
                                    <th className="py-1 pr-3 font-medium">IP</th>
                                    <th className="py-1 font-medium">Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {logs.map((row) => (
                                    <tr key={row.id} className="hover:bg-card-hover">
                                        <td className="py-1 pr-3 text-muted-foreground">
                                            {new Date(row.at).toLocaleString()}
                                        </td>
                                        <td className="py-1 pr-3 font-mono text-xs">{row.ip ?? "-"}</td>
                                        <td className="py-1">
                                            {row.reason ? (
                                                <span className="text-danger">
                                                    {row.action} denied ({row.reason})
                                                </span>
                                            ) : (
                                                row.action
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
