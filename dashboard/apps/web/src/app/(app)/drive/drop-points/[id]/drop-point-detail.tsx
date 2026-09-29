"use client";

/**
 * Drop-point detail view. Three tabs: Overview (config + schedule/delete policy),
 * Files (collected uploads, deletable by the owner), and Visitors (connected
 * sessions with IP, duration, and upload count). The owner can edit the
 * guardrails, reopen a closed drop point, clone it, save its config as a reusable
 * template, close it, or jump to its folder in Drive. All mutations are
 * re-validated server-side; this view only reflects the result.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatBytes } from "@polaris/core";
import { tokenList } from "@/lib/token-field";
import { useNow } from "@/components/presence";
import { GeoPicker } from "@/components/geo-picker";
import { useFormChanged } from "@/lib/use-form-changed";
import { useConfirm } from "@/components/confirm-dialog";
import { AccountInput } from "@/components/account-input";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { RequestDialog } from "@/app/(app)/drive/request-dialog";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { DeleteDropPointDialog } from "@/app/(app)/drive/drop-points/delete-drop-point-dialog";
import {
    Ban,
    ChevronLeft,
    Copy,
    FileText,
    FolderOpen,
    Inbox,
    Pencil,
    RotateCcw,
    Save,
    Trash2,
    Users
} from "lucide-react";
import {
    cn,
    Card,
    Badge,
    Input,
    Button,
    Dialog,
    CardBody,
    Textarea,
    DialogTitle,
    DialogHeader,
    DialogContent,
    DialogDescription
} from "@polaris/ui";
import {
    deleteFileRequestAction,
    deleteSubmissionAction,
    reopenFileRequestAction,
    revokeFileRequestAction,
    saveDropPointTemplateAction,
    updateFileRequestAction
} from "@/app/(app)/drive/request-actions";

export interface DropPointConfig {
    id: string;
    title: string;
    instructions: string | null;
    connectionName: string;
    destinationConnectionId: string;
    destinationPath: string;
    requireLogin: boolean;
    hasPassword: boolean;
    maxSizeBytes: string;
    minSizeBytes: string | null;
    maxFiles: number | null;
    allowedExtensions: string[];
    deniedExtensions: string[];
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
    allowedUsers: string[];
    startsAt: string | null;
    allowUploaderDelete: boolean;
    allowOverwrite: boolean;
    uploaderDeleteWindowSeconds: number | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    submissionCount: number;
}

export interface SubmissionRow {
    id: string;
    fileName: string;
    size: string;
    status: string;
    at: string;
    uploader: string | null;
}

export interface VisitorRow {
    id: string;
    ip: string | null;
    user: string | null;
    userAgent: string | null;
    uploads: number;
    firstSeenAt: string;
    lastSeenAt: string;
}

function status(config: DropPointConfig): {
    label: "detail.status.closed" | "detail.status.scheduled" | "detail.status.expired" | "detail.status.full" | "detail.status.open";
    variant: "success" | "neutral" | "warning";
} {
    if (config.revokedAt) return { label: "detail.status.closed", variant: "neutral" };
    if (config.startsAt && new Date(config.startsAt).getTime() > Date.now()) {
        return { label: "detail.status.scheduled", variant: "warning" };
    }
    if (config.expiresAt && new Date(config.expiresAt).getTime() <= Date.now()) {
        return { label: "detail.status.expired", variant: "warning" };
    }
    if (config.maxFiles !== null && config.submissionCount >= config.maxFiles) {
        return { label: "detail.status.full", variant: "warning" };
    }
    return { label: "detail.status.open", variant: "success" };
}

function statusTone(value: string): string {
    if (value === "blocked" || value === "quarantined") return "text-danger";
    return "text-muted-foreground";
}

/** Compact human duration for a session's connected time. */
function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

/** Turn ISO into the local value a datetime-local input expects. */
function toLocalInput(iso: string | null): string {
    if (!iso) return "";
    const date = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function DropPointDetail({
    config,
    submissions,
    visitors,
    connections
}: {
    config: DropPointConfig;
    submissions: SubmissionRow[];
    visitors: VisitorRow[];
    connections: { id: string; name: string }[];
}) {
    const router = useRouter();
    const t = useTranslations("drivePoints");
    const [pending, startTransition] = useTransition();
    const [editing, setEditing] = useState(false);
    const [cloning, setCloning] = useState(false);
    const [savingTemplate, setSavingTemplate] = useState(false);
    const [tab, setTab] = useState<"overview" | "files" | "visitors">("overview");
    const [files, setFiles] = useState(submissions);
    const [deleting, setDeleting] = useState(false);
    const [confirm, confirmDialog] = useConfirm();

    const state = status(config);
    const driveHref = `/drive?c=${config.destinationConnectionId}&p=${encodeURIComponent(config.destinationPath)}`;

    function onReopen() {
        startTransition(async () => {
            await reopenFileRequestAction(config.id);
            router.refresh();
        });
    }

    async function onClose() {
        if (
            !(await confirm({
                title: t("detail.closeTitle"),
                description: t("detail.closeDescription"),
                confirmLabel: t("detail.close"),
                danger: true
            }))
        )
            return;
        startTransition(async () => {
            await revokeFileRequestAction(config.id);
            router.refresh();
        });
    }

    function onDelete(deleteFolder: boolean) {
        startTransition(async () => {
            const result = await deleteFileRequestAction(config.id, deleteFolder);
            if (result.error) {
                setDeleting(false);
                await confirm({
                    title: t("detail.deleteFailed"),
                    description: result.error,
                    alert: true
                });
                return;
            }
            // Back to the list: this page's subject no longer exists.
            router.replace("/drive/drop-points");
        });
    }

    async function onDeleteFile(row: SubmissionRow) {
        if (
            !(await confirm({
                title: t("detail.deleteFileTitle"),
                description: t("detail.deleteFileDescription", { name: row.fileName }),
                confirmLabel: t("detail.delete"),
                danger: true
            }))
        )
            return;
        // Optimistically remove, remembering the row's place so a failed delete
        // can restore it exactly where it was instead of leaving a false "gone".
        const index = files.findIndex((item) => item.id === row.id);
        setFiles((prev) => prev.filter((item) => item.id !== row.id));
        startTransition(async () => {
            const result = await deleteSubmissionAction(config.id, row.id);
            if (result?.error) {
                setFiles((prev) => {
                    if (prev.some((item) => item.id === row.id)) return prev;
                    const next = [...prev];
                    next.splice(index < 0 ? next.length : index, 0, row);
                    return next;
                });
                await confirm({
                    title: t("detail.deleteFileFailed"),
                    description: result.error,
                    alert: true
                });
            }
        });
    }

    // Clone opens the create dialog in picker mode, prefilled with this drop
    // point's guardrails; the owner only chooses where the new one collects.
    const cloneInitial = {
        title: t("detail.copyTitle", { title: config.title }),
        instructions: config.instructions ?? "",
        extensions: config.allowedExtensions.join(", "),
        deniedExtensions: config.deniedExtensions.join(", "),
        maxMb: Math.max(1, Math.round(Number(config.maxSizeBytes) / (1024 * 1024))),
        minMb: config.minSizeBytes
            ? Math.max(1, Math.round(Number(config.minSizeBytes) / (1024 * 1024)))
            : undefined,
        maxFiles: config.maxFiles ?? undefined,
        requireLogin: config.requireLogin,
        allowedUsers: config.allowedUsers.join(", "),
        allowedCidrs: config.allowedCidrs.join(", "),
        geoCountries: config.allowedCountries,
        geoContinents: config.allowedContinents,
        allowUploaderDelete: config.allowUploaderDelete,
        allowOverwrite: config.allowOverwrite,
        deleteWindowMin: config.uploaderDeleteWindowSeconds
            ? Math.round(config.uploaderDeleteWindowSeconds / 60)
            : undefined
    };

    const tabs = [
        { id: "overview" as const, label: t("detail.tabs.overview"), icon: Inbox, count: null },
        { id: "files" as const, label: t("detail.tabs.files"), icon: FileText, count: files.length },
        { id: "visitors" as const, label: t("detail.tabs.visitors"), icon: Users, count: visitors.length }
    ];

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <Link
                href="/drive/drop-points"
                className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ChevronLeft className="size-4" />
                {t("detail.back")}
            </Link>

            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                    <Inbox className="size-5 shrink-0 text-primary" />
                    <div className="min-w-0">
                        <h1
                            title={config.title}
                            className="flex items-center gap-2 truncate text-[1.0625rem] font-semibold tracking-tight"
                        >
                            {config.title}
                            <Badge variant={state.variant}>{t(state.label)}</Badge>
                        </h1>
                        <p
                            title={`${config.connectionName}${config.destinationPath ? ` / ${config.destinationPath}` : ""}`}
                            className="truncate text-sm text-muted-foreground"
                        >
                            {config.connectionName}
                            {config.destinationPath ? ` / ${config.destinationPath}` : ""}
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                        <Pencil className="size-4" />
                        {t("detail.configure")}
                    </Button>
                    {config.revokedAt ? (
                        <Button size="sm" variant="ghost" onClick={onReopen} disabled={pending}>
                            <RotateCcw className="size-4" />
                            {t("detail.reopen")}
                        </Button>
                    ) : (
                        <Button size="sm" variant="ghost" onClick={onClose} disabled={pending}>
                            <Ban className="size-4" />
                            {t("detail.close")}
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setSavingTemplate(true)}>
                        <Save className="size-4" />
                        {t("detail.saveTemplate")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setCloning(true)}>
                        <Copy className="size-4" />
                        {t("detail.clone")}
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                        <Link href={driveHref}>
                            <FolderOpen className="size-4" />
                            {t("detail.openFolder")}
                        </Link>
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("detail.deleteThis")}
                        title={t("detail.delete")}
                        onClick={() => setDeleting(true)}
                        disabled={pending}
                    >
                        <Trash2 className="size-4" />
                    </Button>
                </div>
            </div>

            <div className="flex gap-1 border-b border-border">
                {tabs.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        onClick={() => setTab(entry.id)}
                        className={cn(
                            "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                            tab === entry.id
                                ? "border-primary text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        <entry.icon className="size-4" />
                        {entry.label}
                        {entry.count !== null ? (
                            <span className="text-xs text-muted-foreground">({entry.count})</span>
                        ) : null}
                    </button>
                ))}
            </div>

            {tab === "overview" ? <OverviewTab config={config} /> : null}
            {tab === "files" ? (
                <FilesTab files={files} onDelete={onDeleteFile} pending={pending} />
            ) : null}
            {tab === "visitors" ? <VisitorsTab visitors={visitors} /> : null}

            <EditDropPointDialog
                config={config}
                open={editing}
                onOpenChange={setEditing}
                onSaved={() => {
                    setEditing(false);
                    router.refresh();
                }}
            />

            <SaveTemplateDialog
                config={config}
                open={savingTemplate}
                onOpenChange={setSavingTemplate}
            />

            <RequestDialog
                target={cloning ? { connectionId: "", path: "", name: "" } : null}
                connections={connections}
                initial={cloneInitial}
                onOpenChange={(open) => !open && setCloning(false)}
            />
            <DeleteDropPointDialog
                target={
                    deleting
                        ? {
                              id: config.id,
                              title: config.title,
                              destinationPath: config.destinationPath,
                              connectionName: config.connectionName,
                              submissionCount: files.length
                          }
                        : null
                }
                busy={pending}
                onCancel={() => setDeleting(false)}
                onConfirm={onDelete}
            />
            {confirmDialog}
        </div>
    );
}

function OverviewTab({ config }: { config: DropPointConfig }) {
    const t = useTranslations("drivePoints");
    const format = useDisplayFormat();
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                    <Field label={t("detail.fields.maxSize")}>{formatBytes(BigInt(config.maxSizeBytes))}</Field>
                    <Field label={t("detail.fields.minSize")}>
                        {config.minSizeBytes ? formatBytes(BigInt(config.minSizeBytes)) : t("detail.values.none")}
                    </Field>
                    <Field label={t("detail.fields.maxFiles")}>{config.maxFiles ?? t("detail.values.noLimit")}</Field>
                    <Field label={t("detail.fields.collected")}>{config.submissionCount}</Field>
                    <Field label={t("detail.fields.starts")}>
                        {config.startsAt ? format.dateTime(config.startsAt) : t("detail.values.immediately")}
                    </Field>
                    <Field label={t("detail.fields.expires")}>
                        {config.expiresAt ? format.date(config.expiresAt) : t("detail.values.never")}
                    </Field>
                    <Field label={t("detail.fields.signIn")}>
                        {config.requireLogin ? t("detail.values.required") : t("detail.values.notRequired")}
                    </Field>
                    <Field label={t("detail.fields.pin")}>{config.hasPassword ? t("detail.values.set") : t("detail.values.none")}</Field>
                    <Field label={t("detail.fields.uploaderDelete")}>
                        {config.allowUploaderDelete
                            ? config.uploaderDeleteWindowSeconds
                                ? t("detail.values.minutes", { count: Math.round(config.uploaderDeleteWindowSeconds / 60) })
                                : t("detail.values.anytime")
                            : t("detail.values.off")}
                    </Field>
                    <Field label={t("detail.fields.users")}>
                        {config.allowedUsers.length > 0 ? config.allowedUsers.join(", ") : t("detail.values.anyone")}
                    </Field>
                    <Field label={t("detail.fields.fileTypes")}>
                        {config.allowedExtensions.length > 0
                            ? config.allowedExtensions.join(", ")
                            : t("detail.values.any")}
                    </Field>
                    <Field label={t("detail.fields.blockedTypes")}>
                        {config.deniedExtensions.length > 0
                            ? config.deniedExtensions.join(", ")
                            : t("detail.values.none")}
                    </Field>
                    <Field label={t("detail.fields.ipAllowlist")}>
                        {config.allowedCidrs.length > 0 ? config.allowedCidrs.join(", ") : t("detail.values.any")}
                    </Field>
                    <Field label={t("detail.fields.locations")}>
                        {config.allowedContinents.length + config.allowedCountries.length > 0
                            ? [...config.allowedContinents, ...config.allowedCountries].join(", ")
                            : t("detail.values.any")}
                    </Field>
                </dl>
                {config.instructions ? (
                    <p className="whitespace-pre-line border-t border-border pt-3 text-sm text-muted-foreground">
                        {config.instructions}
                    </p>
                ) : null}
            </CardBody>
        </Card>
    );
}

function FilesTab({
    files,
    onDelete,
    pending
}: {
    files: SubmissionRow[];
    onDelete: (row: SubmissionRow) => void;
    pending: boolean;
}) {
    const t = useTranslations("drivePoints");
    const format = useDisplayFormat();
    if (files.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    {t("detail.files.empty")}
                </CardBody>
            </Card>
        );
    }
    return (
        <Card>
            <CardBody className="p-0">
                <div className="max-h-[55vh] overflow-auto overscroll-contain">
                    <table className="w-full min-w-[42rem] text-sm">
                        <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-4 py-2 font-medium">{t("detail.files.file")}</th>
                                <th className="px-4 py-2 font-medium">{t("detail.files.size")}</th>
                                <th className="px-4 py-2 font-medium">{t("detail.files.uploadedBy")}</th>
                                <th className="px-4 py-2 font-medium">{t("detail.files.when")}</th>
                                <th className="px-4 py-2 font-medium">{t("detail.files.status")}</th>
                                <th className="px-4 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {files.map((row) => (
                                <tr
                                    key={row.id}
                                    className="border-t border-border hover:bg-card-hover"
                                >
                                    <td className="max-w-[16rem] truncate px-4 py-2">
                                        {row.fileName}
                                    </td>
                                    <td className="px-4 py-2 text-muted-foreground">
                                        {formatBytes(BigInt(row.size))}
                                    </td>
                                    <td className="px-4 py-2 text-muted-foreground">
                                        {row.uploader ?? t("detail.anonymous")}
                                    </td>
                                    <td className="px-4 py-2 text-muted-foreground">
                                        {format.dateTime(row.at)}
                                    </td>
                                    <td
                                        className={`px-4 py-2 capitalize ${statusTone(row.status)}`}
                                    >
                                        {row.status}
                                    </td>
                                    <td className="px-4 py-2 text-right">
                                        <button
                                            type="button"
                                            onClick={() => onDelete(row)}
                                            disabled={pending}
                                            className="text-muted-foreground hover:text-danger disabled:opacity-50"
                                            aria-label={t("detail.files.delete")}
                                        >
                                            <Trash2 className="size-4" />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </CardBody>
        </Card>
    );
}

function VisitorsTab({ visitors }: { visitors: VisitorRow[] }) {
    // A ticking clock, not one read at render: "Active now" used to stay on screen
    // for as long as the tab was open, however long ago the visitor left.
    const now = useNow(10_000);
    const t = useTranslations("drivePoints");
    const format = useDisplayFormat();
    if (visitors.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    {t("detail.visitors.empty")}
                </CardBody>
            </Card>
        );
    }
    return (
        <Card>
            <CardBody className="p-0">
                <div className="max-h-[55vh] overflow-auto overscroll-contain">
                    <table className="w-full min-w-[42rem] text-sm">
                        <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-4 py-2 font-medium">{t("detail.visitors.ip")}</th>
                                <th className="px-4 py-2 font-medium">{t("detail.visitors.user")}</th>
                                <th className="px-4 py-2 font-medium">{t("detail.visitors.firstSeen")}</th>
                                <th className="px-4 py-2 font-medium">{t("detail.visitors.connected")}</th>
                                <th className="px-4 py-2 font-medium">{t("detail.visitors.uploaded")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visitors.map((row) => {
                                const last = new Date(row.lastSeenAt).getTime();
                                const live = now - last < 45_000;
                                const duration = formatDuration(
                                    last - new Date(row.firstSeenAt).getTime()
                                );
                                return (
                                    <tr
                                        key={row.id}
                                        className="border-t border-border hover:bg-card-hover"
                                    >
                                        <td className="px-4 py-2 font-mono text-xs">
                                            {row.ip ?? t("detail.visitors.unknown")}
                                        </td>
                                        <td className="px-4 py-2 text-muted-foreground">
                                            {row.user ?? t("detail.anonymous")}
                                        </td>
                                        <td className="px-4 py-2 text-muted-foreground">
                                            {format.dateTime(row.firstSeenAt)}
                                        </td>
                                        <td className="px-4 py-2">
                                            <span className="flex items-center gap-1.5">
                                                {live ? (
                                                    <span className="size-2 rounded-full bg-success" />
                                                ) : null}
                                                <span
                                                    className={
                                                        live
                                                            ? "text-success"
                                                            : "text-muted-foreground"
                                                    }
                                                >
                                                    {live ? t("detail.visitors.activeNow") : duration}
                                                </span>
                                            </span>
                                        </td>
                                        <td className="px-4 py-2 text-muted-foreground">
                                            {row.uploads > 0 ? t("detail.visitors.files", { count: row.uploads }) : t("detail.visitors.none")}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </CardBody>
        </Card>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate">{children}</dd>
        </div>
    );
}

function SaveTemplateDialog({
    config,
    open,
    onOpenChange
}: {
    config: DropPointConfig;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("drivePoints");
    const [name, setName] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const result = await saveDropPointTemplateAction(name, {
            instructions: config.instructions ?? undefined,
            allowedExtensions: config.allowedExtensions,
            deniedExtensions: config.deniedExtensions,
            minSizeBytes: config.minSizeBytes ? Number(config.minSizeBytes) : undefined,
            maxSizeBytes: Number(config.maxSizeBytes),
            maxFiles: config.maxFiles ?? undefined,
            requireLogin: config.requireLogin,
            allowedUsers: config.allowedUsers,
            allowedCidrs: config.allowedCidrs,
            allowedCountries: config.allowedCountries,
            allowedContinents: config.allowedContinents,
            allowUploaderDelete: config.allowUploaderDelete,
            allowOverwrite: config.allowOverwrite,
            uploaderDeleteWindowSeconds: config.uploaderDeleteWindowSeconds
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setName("");
        onOpenChange(false);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("detail.saveTemplate")}</DialogTitle>
                    <DialogDescription>{t("template.description")}</DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        {t("template.name")}
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("template.namePlaceholder")}
                            autoFocus
                        />
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end">
                        <Button type="submit" disabled={pending || !name.trim()}>
                            {pending ? t("form.saving") : t("template.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function EditDropPointDialog({
    config,
    open,
    onOpenChange,
    onSaved
}: {
    config: DropPointConfig;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: () => void;
}) {
    const t = useTranslations("drivePoints");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [geoCountries, setGeoCountries] = useState<string[]>(config.allowedCountries);
    const [geoContinents, setGeoContinents] = useState<string[]>(config.allowedContinents);
    const { formProps, changed: fieldsChanged } = useFormChanged();

    // The locations live outside the form, so they are compared separately;
    // together they decide whether there is anything to save at all.
    const sameList = (a: string[], b: string[]) =>
        a.length === b.length && [...a].sort().join() === [...b].sort().join();
    const changed =
        fieldsChanged ||
        !sameList(geoCountries, config.allowedCountries) ||
        !sameList(geoContinents, config.allowedContinents);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);

        const allowedExtensions = tokenList(String(form.get("extensions") ?? ""), /^\./);
        const deniedExtensions = tokenList(String(form.get("deniedExtensions") ?? ""), /^\./);
        const allowedUsers = tokenList(String(form.get("allowedUsers") ?? ""), /^@+/);
        const allowedCidrs = String(form.get("allowedCidrs") ?? "")
            .split(/[\s,]+/)
            .map((value) => value.trim())
            .filter(Boolean);
        const maxMb = Number(form.get("maxMb") ?? 0);
        const minMb = Number(form.get("minMb") ?? 0);
        const deleteWindowMin = Number(form.get("deleteWindowMin") ?? 0);
        const maxFiles = form.get("maxFiles");
        const removePin = form.get("removePin") === "on";
        const pin = String(form.get("password") ?? "");
        const startsRaw = String(form.get("startsAt") ?? "").trim();

        const result = await updateFileRequestAction(config.id, {
            title: String(form.get("title") ?? "").trim(),
            instructions: String(form.get("instructions") ?? "").trim() || null,
            requireLogin: form.get("requireLogin") === "on",
            password: removePin ? null : pin ? pin : undefined,
            maxSizeBytes: maxMb > 0 ? Math.floor(maxMb * 1024 * 1024) : undefined,
            minSizeBytes: minMb > 0 ? Math.floor(minMb * 1024 * 1024) : null,
            maxFiles: maxFiles ? Number(maxFiles) : null,
            allowedExtensions,
            deniedExtensions,
            allowedCidrs,
            allowedCountries: geoCountries,
            allowedContinents: geoContinents,
            allowedUsers,
            startsAt: startsRaw ? new Date(startsRaw).toISOString() : null,
            allowUploaderDelete: form.get("allowUploaderDelete") === "on",
            allowOverwrite: form.get("allowOverwrite") === "on",
            uploaderDeleteWindowSeconds:
                deleteWindowMin > 0 ? Math.floor(deleteWindowMin * 60) : null,
            expiresAt: String(form.get("expiresAt") ?? "") || null
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onSaved();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>{t("edit.title")}</DialogTitle>
                    <DialogDescription className="truncate">
                        {t("edit.description", { place: config.destinationPath || config.connectionName })}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3" {...formProps}>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("form.title")}
                        <Input
                            name="title"
                            required
                            defaultValue={config.title}
                            autoComplete="off"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("form.instructions")}
                        <Textarea
                            name="instructions"
                            rows={2}
                            defaultValue={config.instructions ?? ""}
                            className="max-h-48 min-h-[2.5rem] resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("form.extensions")}
                        <Input
                            name="extensions"
                            defaultValue={config.allowedExtensions.join(", ")}
                            placeholder={t("form.extensionsPlaceholder")}
                            autoComplete="off"
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("form.extensionsHint")}
                        </span>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("form.denied")}
                        <Input
                            name="deniedExtensions"
                            defaultValue={config.deniedExtensions.join(", ")}
                            placeholder={t("form.deniedPlaceholder")}
                            autoComplete="off"
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("form.deniedHint")}
                        </span>
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            {t("form.minSize")}
                            <Input
                                name="minMb"
                                type="number"
                                min="0"
                                defaultValue={
                                    config.minSizeBytes
                                        ? Math.max(
                                              1,
                                              Math.round(
                                                  Number(config.minSizeBytes) / (1024 * 1024)
                                              )
                                          )
                                        : ""
                                }
                                placeholder={t("detail.values.none")}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("form.maxSize")}
                            <Input
                                name="maxMb"
                                type="number"
                                min="1"
                                defaultValue={Math.max(
                                    1,
                                    Math.round(Number(config.maxSizeBytes) / (1024 * 1024))
                                )}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("form.maxFiles")}
                            <Input
                                name="maxFiles"
                                type="number"
                                min="1"
                                defaultValue={config.maxFiles ?? ""}
                                placeholder={t("detail.values.noLimit")}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("detail.fields.starts")}
                            <Input
                                name="startsAt"
                                type="datetime-local"
                                defaultValue={toLocalInput(config.startsAt)}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("detail.fields.expires")}
                            <Input
                                name="expiresAt"
                                type="date"
                                defaultValue={config.expiresAt ? config.expiresAt.slice(0, 10) : ""}
                            />
                        </label>
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("form.cidrs")}
                        <Input
                            name="allowedCidrs"
                            defaultValue={config.allowedCidrs.join(", ")}
                            placeholder={t("form.cidrsPlaceholder")}
                            autoComplete="off"
                        />
                    </label>
                    <div className="flex flex-col gap-1 text-sm">
                        {t("form.location")}
                        <GeoPicker
                            countries={geoCountries}
                            continents={geoContinents}
                            onCountries={setGeoCountries}
                            onContinents={setGeoContinents}
                        />
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("form.pin")}
                        <Input
                            name="password"
                            type="password"
                            placeholder={config.hasPassword ? t("form.pinKeep") : t("form.noPin")}
                            autoComplete="off"
                        />
                    </label>
                    {config.hasPassword ? (
                        <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" name="removePin" className="size-4" />
                            {t("form.removePin")}
                        </label>
                    ) : null}
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            name="requireLogin"
                            defaultChecked={config.requireLogin}
                            className="size-4"
                        />
                        {t("form.requireLogin")}
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            name="allowOverwrite"
                            defaultChecked={config.allowOverwrite}
                            className="size-4"
                        />
                        {t("form.overwrite")}
                    </label>
                    <div className="flex flex-col gap-1.5 text-sm">
                        <label className="flex items-center gap-2">
                            <input
                                type="checkbox"
                                name="allowUploaderDelete"
                                defaultChecked={config.allowUploaderDelete}
                                className="size-4"
                            />
                            {t("form.uploaderDelete")}
                        </label>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            {t.rich("form.deleteWindow", {
                                field: () => (
                                    <Input
                                        key="window"
                                        name="deleteWindowMin"
                                        type="number"
                                        min="1"
                                        defaultValue={
                                            config.uploaderDeleteWindowSeconds
                                                ? Math.round(config.uploaderDeleteWindowSeconds / 60)
                                                : ""
                                        }
                                        placeholder={t("form.anytime")}
                                        className="h-8 w-24"
                                    />
                                )
                            })}
                        </label>
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        {t("form.users")}
                        <AccountInput
                            multiple
                            name="allowedUsers"
                            defaultValue={config.allowedUsers.join(", ")}
                            placeholder={t("form.usersPlaceholder")}
                            aria-label={t("form.usersLabel")}
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("form.usersHint")}
                        </span>
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end">
                        <Button type="submit" disabled={pending || !changed}>
                            {pending ? t("form.saving") : t("form.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
