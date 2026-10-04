"use client";

/**
 * Manage-shares view. Lists the current user's share links with their guardrails
 * and lets them reveal the link again, edit its limits, inspect its access log
 * (who viewed/downloaded, from which IP, how often), and revoke it. The link is
 * recoverable because the token is stored encrypted under the master key; a DB
 * dump alone still yields nothing without that key.
 */

import { useEffect, useState, useTransition } from "react";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import Link from "next/link";
import {
    Ban,
    Check,
    Copy,
    FileText,
    FolderClosed,
    FolderOpen,
    Link2,
    Pencil,
    ScrollText
} from "lucide-react";
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
import { useConfirm } from "@/components/confirm-dialog";
import { LinkVisitorCell, signedInVisitors } from "../link-visitor-cell";
import { useDisplayFormat } from "@/components/display-format";
import { useFormChanged } from "@/lib/use-form-changed";

export interface ShareRow {
    id: string;
    path: string;
    kind: string;
    connectionId: string;
    connectionName: string;
    allowUpload: boolean;
    allowRename: boolean;
    allowDelete: boolean;
    allowCreateFolder: boolean;
    allowOverwrite: boolean;
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

function status(share: ShareRow): {
    label: NamespaceKey<"drive">;
    variant: "success" | "neutral" | "warning";
} {
    if (share.revokedAt) return { label: "sharedLinks.status.revoked", variant: "neutral" };
    if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) {
        return { label: "sharedLinks.status.expired", variant: "warning" };
    }
    if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) {
        return { label: "sharedLinks.status.exhausted", variant: "warning" };
    }
    return { label: "sharedLinks.status.active", variant: "success" };
}

/** What a visitor did, in words; an action this list does not know shows as recorded. */
const LOG_ACTIONS: Record<string, NamespaceKey<"drive">> = {
    view: "sharedLinks.actions.view",
    download: "sharedLinks.actions.download",
    upload: "sharedLinks.actions.upload",
    rename: "sharedLinks.actions.rename",
    delete: "sharedLinks.actions.delete",
    mkdir: "sharedLinks.actions.mkdir"
};

export function SharedView({ shares }: { shares: ShareRow[] }) {
    const format = useDisplayFormat();
    const t = useTranslations("drive");
    const [rows, setRows] = useState(shares);
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<string | null>(null);
    const [editing, setEditing] = useState<ShareRow | null>(null);
    const [logsFor, setLogsFor] = useState<ShareRow | null>(null);
    const [revealed, setRevealed] = useState<{ id: string; url: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [confirm, confirmDialog] = useConfirm();

    async function onRevoke(id: string) {
        if (
            !(await confirm({
                title: t("sharedLinks.revokeTitle"),
                description: t("sharedLinks.revokeBody"),
                confirmLabel: t("sharedLinks.revoke"),
                danger: true
            }))
        )
            return;
        setBusy(id);
        startTransition(async () => {
            await revokeShareAction(id);
            setRows((prev) =>
                prev.map((row) =>
                    row.id === id ? { ...row, revokedAt: new Date().toISOString() } : row
                )
            );
            setBusy(null);
        });
    }

    async function onReveal(row: ShareRow) {
        setBusy(row.id);
        const result = await revealShareLinkAction(row.id);
        setBusy(null);
        if (result.error) {
            await confirm({
                title: t("sharedLinks.revealFailed"),
                description: result.error,
                alert: true
            });
            return;
        }
        setRevealed({ id: row.id, url: result.url ?? "" });
        setCopied(false);
    }

    if (rows.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    {t("sharedLinks.empty")}
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
                                            <p className="truncate text-sm font-medium">
                                                {share.path || t("sharedLinks.root")}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {share.connectionName}
                                                {" - "}
                                                {share.maxDownloads !== null
                                                    ? t("sharedLinks.downloadsOf", {
                                                          count: share.downloadCount,
                                                          max: share.maxDownloads
                                                      })
                                                    : t("sharedLinks.downloads", { count: share.downloadCount })}
                                                {share.expiresAt
                                                    ? ` - ${t("sharedLinks.expires", { date: format.date(share.expiresAt) })}`
                                                    : ""}
                                                {share.allowedCidrs.length > 0
                                                    ? ` - ${t("sharedLinks.ipRestricted")}`
                                                    : ""}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Badge variant={state.variant}>{t(state.label)}</Badge>
                                        <Button size="sm" variant="ghost" asChild>
                                            <Link
                                                href={`/drive?c=${share.connectionId}&p=${encodeURIComponent(
                                                    isDir
                                                        ? share.path
                                                        : share.path
                                                              .split("/")
                                                              .slice(0, -1)
                                                              .join("/")
                                                )}`}
                                            >
                                                <FolderOpen className="size-4" />
                                                {t("sharedLinks.open")}
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
                                                {t("sharedLinks.link")}
                                            </Button>
                                        ) : null}
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => setLogsFor(share)}
                                        >
                                            <ScrollText className="size-4" />
                                            {t("sharedLinks.logs")}
                                        </Button>
                                        {!share.revokedAt ? (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => setEditing(share)}
                                            >
                                                <Pencil className="size-4" />
                                                {t("sharedLinks.edit")}
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
                                                {t("sharedLinks.revoke")}
                                            </Button>
                                        ) : null}
                                    </div>
                                </div>
                                {revealed?.id === share.id ? (
                                    <div className="flex items-center gap-2">
                                        <Input
                                            readOnly
                                            value={revealed.url}
                                            className="font-mono text-xs"
                                        />
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
            {confirmDialog}
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
    const t = useTranslations("drive");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { formProps, changed } = useFormChanged();

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
            allowRename: form.get("allowRename") === "on",
            allowDelete: form.get("allowDelete") === "on",
            allowCreateFolder: form.get("allowCreateFolder") === "on",
            allowOverwrite: form.get("allowOverwrite") === "on",
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
            allowRename: form.get("allowRename") === "on",
            allowDelete: form.get("allowDelete") === "on",
            allowCreateFolder: form.get("allowCreateFolder") === "on",
            allowOverwrite: form.get("allowOverwrite") === "on",
            allowedCidrs
        });
    }

    return (
        <Dialog open={share !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("sharedLinks.editTitle")}</DialogTitle>
                    <DialogDescription className="truncate">
                        {share?.path || t("sharedLinks.root")}
                    </DialogDescription>
                </DialogHeader>
                {share ? (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3" {...formProps}>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("sharedLinks.password")}
                            <Input
                                name="password"
                                type="password"
                                placeholder={t("sharedLinks.keepPassword")}
                                autoComplete="off"
                            />
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" name="removePassword" className="size-4" />
                            {t("sharedLinks.removePassword")}
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                {t("sharedLinks.maxDownloads")}
                                <Input
                                    name="maxDownloads"
                                    type="number"
                                    min="1"
                                    defaultValue={share.maxDownloads ?? ""}
                                    placeholder={t("sharedLinks.unlimited")}
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("sharedLinks.expiresField")}
                                <Input
                                    name="expiresAt"
                                    type="date"
                                    defaultValue={
                                        share.expiresAt ? share.expiresAt.slice(0, 10) : ""
                                    }
                                />
                            </label>
                        </div>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("sharedLinks.cidrs")}
                            <Input
                                name="allowedCidrs"
                                defaultValue={share.allowedCidrs.join(", ")}
                                placeholder={t("sharedLinks.cidrsPlaceholder")}
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
                                {t("sharedLinks.allowDownload")}
                            </label>
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="allowPreview"
                                    defaultChecked={share.allowPreview}
                                    className="size-4"
                                />
                                {t("sharedLinks.allowPreview")}
                            </label>
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="allowUpload"
                                    defaultChecked={share.allowUpload}
                                    className="size-4"
                                />
                                {t("sharedLinks.allowUpload")}
                            </label>
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="allowCreateFolder"
                                    defaultChecked={share.allowCreateFolder}
                                    className="size-4"
                                />
                                {t("sharedLinks.allowMkdir")}
                            </label>
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="allowOverwrite"
                                    defaultChecked={share.allowOverwrite}
                                    className="size-4"
                                />
                                {t("sharedLinks.allowOverwrite")}
                            </label>
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="allowRename"
                                    defaultChecked={share.allowRename}
                                    className="size-4"
                                />
                                {t("sharedLinks.allowRename")}
                            </label>
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    name="allowDelete"
                                    defaultChecked={share.allowDelete}
                                    className="size-4"
                                />
                                {t("sharedLinks.allowDelete")}
                            </label>
                        </div>
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <div className="flex justify-end">
                            <Button type="submit" disabled={pending || !changed}>
                                {pending ? t("sharedLinks.saving") : t("sharedLinks.save")}
                            </Button>
                        </div>
                    </form>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

function ShareLogsDialog({
    share,
    onOpenChange
}: {
    share: ShareRow | null;
    onOpenChange: (open: boolean) => void;
}) {
    const format = useDisplayFormat();
    const t = useTranslations("drive");
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
    const signedIn = signedInVisitors(logs ?? []);

    return (
        <Dialog open={share !== null} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{t("sharedLinks.logTitle")}</DialogTitle>
                    <DialogDescription className="truncate">
                        {share?.path || t("sharedLinks.root")}
                    </DialogDescription>
                </DialogHeader>
                <div className="mb-2 flex flex-wrap gap-2 text-xs">
                    <Badge variant="neutral">{t("sharedLinks.views", { count: views })}</Badge>
                    <Badge variant="neutral">{t("sharedLinks.downloads", { count: downloads })}</Badge>
                    <Badge variant="neutral">{t("sharedLinks.uniqueIps", { count: uniqueIps })}</Badge>
                    {signedIn > 0 ? (
                        <Badge variant="neutral">{t("linkVisitor.signedIn", { count: signedIn })}</Badge>
                    ) : null}
                    {denied > 0 ? (
                        <Badge variant="warning">{t("sharedLinks.denied", { count: denied })}</Badge>
                    ) : null}
                </div>
                <div className="max-h-[55vh] overflow-auto overscroll-contain">
                    {logs === null ? (
                        <p className="p-6 text-center text-sm text-muted-foreground">{t("sharedLinks.loading")}</p>
                    ) : logs.length === 0 ? (
                        <p className="p-6 text-center text-sm text-muted-foreground">
                            {t("sharedLinks.noAccess")}
                        </p>
                    ) : (
                        <table className="w-full text-sm">
                            <thead className="text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="py-1 pr-3 font-medium">{t("sharedLinks.when")}</th>
                                    <th className="py-1 pr-3 font-medium">{t("sharedLinks.ip")}</th>
                                    <th className="py-1 pr-3 font-medium">{t("linkVisitor.who")}</th>
                                    <th className="py-1 font-medium">{t("sharedLinks.action")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {logs.map((row) => (
                                    <tr key={row.id} className="hover:bg-card-hover">
                                        <td className="py-1 pr-3 text-muted-foreground">
                                            {format.dateTime(row.at)}
                                        </td>
                                        <td className="py-1 pr-3 font-mono text-xs">
                                            {row.ip ?? "-"}
                                        </td>
                                        <td className="py-1 pr-3">
                                            <LinkVisitorCell visitor={row.visitor} />
                                        </td>
                                        <td className="py-1">
                                            {row.reason ? (
                                                <span className="text-danger">
                                                    {t("sharedLinks.actionDenied", {
                                                        action: LOG_ACTIONS[row.action] ? t(LOG_ACTIONS[row.action]!) : row.action,
                                                        reason: row.reason
                                                    })}
                                                </span>
                                            ) : LOG_ACTIONS[row.action] ? (
                                                t(LOG_ACTIONS[row.action]!)
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
