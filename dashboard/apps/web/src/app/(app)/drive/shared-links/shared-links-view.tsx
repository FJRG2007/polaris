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
    Input,
    Checkbox
} from "@polaris/ui";
import {
    revealShareLinkAction,
    revokeShareAction,
    updateShareAction,
    type ShareLogRow
} from "../share-actions";
import { useConfirm } from "@/components/confirm-dialog";
import { LinkVisitorCell, signedInVisitors } from "../link-visitor-cell";
import { useDisplayFormat } from "@/components/display-format";
import type { LinkGuardsView } from "@/lib/link-guards";
import {
    LinkAdvancedFields,
    linkExpiry,
    linkExpiryDay,
    linkGuardFields,
    linkHoursIncomplete,
    linkLimits,
    linkPeopleLimits,
    type LinkAdvancedValue
} from "@/components/link-advanced-fields";
import * as polls from "../drive-reads";

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
    allowedCountries: string[];
    allowedContinents: string[];
    hasPassword: boolean;
    /** Start, weekly hours and account rules, as the edit dialog shows them. */
    guards: LinkGuardsView;
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

    /** Show an edit at once; put the row back and say why if it is refused. */
    async function onSaveEdit(updated: ShareRow, edit: Record<string, unknown>) {
        const previous = rows.find((row) => row.id === updated.id);
        setRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
        setEditing(null);
        const result = await updateShareAction(updated.id, edit).catch(() => ({
            error: t("sharedLinks.saveFailedBody")
        }));
        if (!result.error) return;
        if (previous) {
            setRows((prev) => prev.map((row) => (row.id === previous.id ? previous : row)));
        }
        await confirm({
            title: t("sharedLinks.saveFailed"),
            description: result.error,
            alert: true
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
                                                    : t("sharedLinks.downloads", {
                                                          count: share.downloadCount
                                                      })}
                                                {share.expiresAt
                                                    ? ` - ${t("sharedLinks.expires", { date: format.date(share.expiresAt) })}`
                                                    : ""}
                                                {share.allowedCidrs.length > 0 ||
                                                share.allowedCountries.length > 0 ||
                                                share.allowedContinents.length > 0
                                                    ? ` - ${t("sharedLinks.ipRestricted")}`
                                                    : ""}
                                            </p>
                                        </div>
                                    </div>
                                    {/* Six actions do not fit a phone in one row; they wrap
                                        rather than run off the card. */}
                                    <div className="flex flex-wrap items-center gap-1">
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
                onSave={(updated, edit) => void onSaveEdit(updated, edit)}
            />
            <ShareLogsDialog share={logsFor} onOpenChange={(open) => !open && setLogsFor(null)} />
            {confirmDialog}
        </>
    );
}

/** The powers a link hands its holder, in the order the dialog lists them. */
const SHARE_POWERS = [
    ["allowDownload", "sharedLinks.allowDownload"],
    ["allowPreview", "sharedLinks.allowPreview"],
    ["allowUpload", "sharedLinks.allowUpload"],
    ["allowCreateFolder", "sharedLinks.allowMkdir"],
    ["allowOverwrite", "sharedLinks.allowOverwrite"],
    ["allowRename", "sharedLinks.allowRename"],
    ["allowDelete", "sharedLinks.allowDelete"]
] as const satisfies readonly (readonly [keyof SharePowers, NamespaceKey<"drive">])[];

type SharePowers = Pick<
    ShareRow,
    | "allowDownload"
    | "allowPreview"
    | "allowUpload"
    | "allowCreateFolder"
    | "allowOverwrite"
    | "allowRename"
    | "allowDelete"
>;

function powersOf(share: ShareRow): SharePowers {
    return {
        allowDownload: share.allowDownload,
        allowPreview: share.allowPreview,
        allowUpload: share.allowUpload,
        allowCreateFolder: share.allowCreateFolder,
        allowOverwrite: share.allowOverwrite,
        allowRename: share.allowRename,
        allowDelete: share.allowDelete
    };
}

/** A saved link's limits as the Advanced section edits them. */
export function shareAdvancedOf(share: ShareRow): LinkAdvancedValue {
    return {
        password: "",
        expiresAt: linkExpiryDay(share.expiresAt),
        maxUses: share.maxDownloads === null ? "" : String(share.maxDownloads),
        allowedCidrs: share.allowedCidrs,
        allowedCountries: share.allowedCountries,
        allowedContinents: share.allowedContinents,
        ...linkGuardFields(share.guards)
    };
}

/** An edit as the row it leaves behind, for the list to show before the save lands. */
function editedRow(share: ShareRow, advanced: LinkAdvancedValue, powers: SharePowers): ShareRow {
    const people = linkPeopleLimits(advanced);
    return {
        ...share,
        ...powers,
        hasPassword: advanced.password ? true : advanced.clearPassword ? false : share.hasPassword,
        maxDownloads: advanced.maxUses ? Number(advanced.maxUses) : null,
        expiresAt: linkExpiry(advanced.expiresAt)?.toISOString() ?? null,
        allowedCidrs: advanced.allowedCidrs,
        allowedCountries: advanced.allowedCountries,
        allowedContinents: advanced.allowedContinents,
        guards: {
            startsAt: people.startsAt,
            schedule: people.schedule,
            requireLogin: people.requireLogin,
            allowedUsers: people.allowedUsers
        }
    };
}

/**
 * Edit a link's guardrails with the same Advanced section the create dialog
 * draws, every current value filled in. Save stays off until something differs
 * from what is stored; a typed password always counts, since the stored one
 * cannot be read back to compare. Saving hands the edit to the list, which
 * shows it at once and puts the row back if the server refuses it.
 */
export function EditShareDialog({
    share,
    onOpenChange,
    onSave
}: {
    share: ShareRow | null;
    onOpenChange: (open: boolean) => void;
    onSave: (row: ShareRow, edit: Record<string, unknown>) => void;
}) {
    const t = useTranslations("drive");
    return (
        <Dialog open={share !== null} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>{t("sharedLinks.editTitle")}</DialogTitle>
                    <DialogDescription className="truncate">
                        {share?.path || t("sharedLinks.root")}
                    </DialogDescription>
                </DialogHeader>
                {share ? <EditShareForm key={share.id} share={share} onSave={onSave} /> : null}
            </DialogContent>
        </Dialog>
    );
}

function EditShareForm({
    share,
    onSave
}: {
    share: ShareRow;
    onSave: (row: ShareRow, edit: Record<string, unknown>) => void;
}) {
    const t = useTranslations("drive");
    const [advanced, setAdvanced] = useState<LinkAdvancedValue>(() => shareAdvancedOf(share));
    const [powers, setPowers] = useState<SharePowers>(() => powersOf(share));
    const changed =
        advanced.password !== "" ||
        JSON.stringify(advanced) !== JSON.stringify(shareAdvancedOf(share)) ||
        JSON.stringify(powers) !== JSON.stringify(powersOf(share));
    const blocked = !changed || linkHoursIncomplete(advanced);

    function onSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (blocked) return;
        const { maxViews, ...limits } = linkLimits(advanced);
        onSave(editedRow(share, advanced, powers), {
            ...limits,
            maxDownloads: maxViews,
            ...powers
        });
    }

    return (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <LinkAdvancedFields
                value={advanced}
                onChange={setAdvanced}
                usesLabel={t("sharedLinks.maxDownloads")}
                passwordSet={share.hasPassword}
                clearablePassword
                idPrefix="drive-share-edit"
            />
            <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
                {SHARE_POWERS.map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2">
                        <Checkbox
                            name={key}
                            checked={powers[key]}
                            onChange={(event) =>
                                setPowers({ ...powers, [key]: event.target.checked })
                            }
                        />
                        {t(label)}
                    </label>
                ))}
            </div>
            <div className="flex justify-end">
                <Button type="submit" disabled={blocked}>
                    {t("sharedLinks.save")}
                </Button>
            </div>
        </form>
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
        void polls.shareLogs(shareId).then((result) => {
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
                    <Badge variant="neutral">
                        {t("sharedLinks.downloads", { count: downloads })}
                    </Badge>
                    <Badge variant="neutral">
                        {t("sharedLinks.uniqueIps", { count: uniqueIps })}
                    </Badge>
                    {signedIn > 0 ? (
                        <Badge variant="neutral">
                            {t("linkVisitor.signedIn", { count: signedIn })}
                        </Badge>
                    ) : null}
                    {denied > 0 ? (
                        <Badge variant="warning">
                            {t("sharedLinks.denied", { count: denied })}
                        </Badge>
                    ) : null}
                </div>
                <div className="max-h-[55vh] overflow-auto overscroll-contain">
                    {logs === null ? (
                        <p className="p-6 text-center text-sm text-muted-foreground">
                            {t("sharedLinks.loading")}
                        </p>
                    ) : logs.length === 0 ? (
                        <p className="p-6 text-center text-sm text-muted-foreground">
                            {t("sharedLinks.noAccess")}
                        </p>
                    ) : (
                        <table className="w-full text-sm">
                            <thead className="text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="py-1 pr-3 font-medium">
                                        {t("sharedLinks.when")}
                                    </th>
                                    <th className="py-1 pr-3 font-medium">{t("sharedLinks.ip")}</th>
                                    <th className="py-1 pr-3 font-medium">
                                        {t("linkVisitor.who")}
                                    </th>
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
                                                        action: LOG_ACTIONS[row.action]
                                                            ? t(LOG_ACTIONS[row.action]!)
                                                            : row.action,
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
