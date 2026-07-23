"use client";

/**
 * Drop-point detail view. Three tabs: Overview (config + schedule/delete policy),
 * Files (collected uploads, deletable by the owner), and Visitors (connected
 * sessions with IP, duration, and upload count). The owner can edit the
 * guardrails, reopen a closed drop point, clone it, save its config as a reusable
 * template, close it, or jump to its folder in Drive. All mutations are
 * re-validated server-side; this view only reflects the result.
 */

import { useMemo, useState, useTransition, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { formatBytes } from "@polaris/core";
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
    cn
} from "@polaris/ui";
import { GeoPicker } from "@/components/geo-picker";
import { useConfirm } from "@/components/confirm-dialog";
import { RequestDialog } from "../../request-dialog";
import {
    deleteSubmissionAction,
    reopenFileRequestAction,
    revokeFileRequestAction,
    saveDropPointTemplateAction,
    updateFileRequestAction
} from "../../request-actions";

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
    label: string;
    variant: "success" | "neutral" | "warning";
} {
    if (config.revokedAt) return { label: "Closed", variant: "neutral" };
    if (config.startsAt && new Date(config.startsAt).getTime() > Date.now()) {
        return { label: "Scheduled", variant: "warning" };
    }
    if (config.expiresAt && new Date(config.expiresAt).getTime() <= Date.now()) {
        return { label: "Expired", variant: "warning" };
    }
    if (config.maxFiles !== null && config.submissionCount >= config.maxFiles) {
        return { label: "Full", variant: "warning" };
    }
    return { label: "Open", variant: "success" };
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
    const [pending, startTransition] = useTransition();
    const [editing, setEditing] = useState(false);
    const [cloning, setCloning] = useState(false);
    const [savingTemplate, setSavingTemplate] = useState(false);
    const [tab, setTab] = useState<"overview" | "files" | "visitors">("overview");
    const [files, setFiles] = useState(submissions);
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
                title: "Close this drop point?",
                description: "It will stop accepting uploads immediately.",
                confirmLabel: "Close",
                danger: true
            }))
        )
            return;
        startTransition(async () => {
            await revokeFileRequestAction(config.id);
            router.refresh();
        });
    }

    async function onDeleteFile(row: SubmissionRow) {
        if (
            !(await confirm({
                title: "Delete this file?",
                description: `${row.fileName} will be permanently removed.`,
                confirmLabel: "Delete",
                danger: true
            }))
        )
            return;
        setFiles((prev) => prev.filter((item) => item.id !== row.id));
        startTransition(async () => {
            await deleteSubmissionAction(config.id, row.id);
        });
    }

    // Clone opens the create dialog in picker mode, prefilled with this drop
    // point's guardrails; the owner only chooses where the new one collects.
    const cloneInitial = {
        title: `${config.title} (copy)`,
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
        deleteWindowMin: config.uploaderDeleteWindowSeconds
            ? Math.round(config.uploaderDeleteWindowSeconds / 60)
            : undefined
    };

    const tabs = [
        { id: "overview" as const, label: "Overview", icon: Inbox, count: null },
        { id: "files" as const, label: "Files", icon: FileText, count: files.length },
        { id: "visitors" as const, label: "Visitors", icon: Users, count: visitors.length }
    ];

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <Link
                href="/drive/drop-points"
                className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ChevronLeft className="size-4" />
                Drop points
            </Link>

            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                    <Inbox className="size-5 shrink-0 text-primary" />
                    <div className="min-w-0">
                        <h1 className="flex items-center gap-2 truncate text-lg font-semibold">
                            {config.title}
                            <Badge variant={state.variant}>{state.label}</Badge>
                        </h1>
                        <p className="truncate text-sm text-muted-foreground">
                            {config.connectionName}
                            {config.destinationPath ? ` / ${config.destinationPath}` : ""}
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                        <Pencil className="size-4" />
                        Configure
                    </Button>
                    {config.revokedAt ? (
                        <Button size="sm" variant="ghost" onClick={onReopen} disabled={pending}>
                            <RotateCcw className="size-4" />
                            Reopen
                        </Button>
                    ) : (
                        <Button size="sm" variant="ghost" onClick={onClose} disabled={pending}>
                            <Ban className="size-4" />
                            Close
                        </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setSavingTemplate(true)}>
                        <Save className="size-4" />
                        Save as template
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setCloning(true)}>
                        <Copy className="size-4" />
                        Clone
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                        <Link href={driveHref}>
                            <FolderOpen className="size-4" />
                            Open folder
                        </Link>
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
            {confirmDialog}
        </div>
    );
}

function OverviewTab({ config }: { config: DropPointConfig }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                    <Field label="Max size">{formatBytes(BigInt(config.maxSizeBytes))}</Field>
                    <Field label="Min size">
                        {config.minSizeBytes ? formatBytes(BigInt(config.minSizeBytes)) : "None"}
                    </Field>
                    <Field label="Max files">{config.maxFiles ?? "No limit"}</Field>
                    <Field label="Collected">{config.submissionCount}</Field>
                    <Field label="Starts">
                        {config.startsAt
                            ? new Date(config.startsAt).toLocaleString()
                            : "Immediately"}
                    </Field>
                    <Field label="Expires">
                        {config.expiresAt
                            ? new Date(config.expiresAt).toLocaleDateString()
                            : "Never"}
                    </Field>
                    <Field label="Sign-in">
                        {config.requireLogin ? "Required" : "Not required"}
                    </Field>
                    <Field label="PIN">{config.hasPassword ? "Set" : "None"}</Field>
                    <Field label="Uploader delete">
                        {config.allowUploaderDelete
                            ? config.uploaderDeleteWindowSeconds
                                ? `${Math.round(config.uploaderDeleteWindowSeconds / 60)} min`
                                : "Anytime"
                            : "Off"}
                    </Field>
                    <Field label="Users">
                        {config.allowedUsers.length > 0 ? config.allowedUsers.join(", ") : "Anyone"}
                    </Field>
                    <Field label="File types">
                        {config.allowedExtensions.length > 0
                            ? config.allowedExtensions.join(", ")
                            : "Any"}
                    </Field>
                    <Field label="Blocked types">
                        {config.deniedExtensions.length > 0
                            ? config.deniedExtensions.join(", ")
                            : "None"}
                    </Field>
                    <Field label="IP allowlist">
                        {config.allowedCidrs.length > 0 ? config.allowedCidrs.join(", ") : "Any"}
                    </Field>
                    <Field label="Locations">
                        {config.allowedContinents.length + config.allowedCountries.length > 0
                            ? [...config.allowedContinents, ...config.allowedCountries].join(", ")
                            : "Any"}
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
    if (files.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    Nothing uploaded yet.
                </CardBody>
            </Card>
        );
    }
    return (
        <Card>
            <CardBody className="p-0">
                <div className="max-h-[55vh] overflow-auto">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-4 py-2 font-medium">File</th>
                                <th className="px-4 py-2 font-medium">Size</th>
                                <th className="px-4 py-2 font-medium">Uploaded by</th>
                                <th className="px-4 py-2 font-medium">When</th>
                                <th className="px-4 py-2 font-medium">Status</th>
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
                                        {row.uploader ?? "Anonymous"}
                                    </td>
                                    <td className="px-4 py-2 text-muted-foreground">
                                        {new Date(row.at).toLocaleString()}
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
                                            aria-label="Delete file"
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
    // Compute "live" and duration relative to now on the client at render time.
    const now = useMemo(() => Date.now(), []);
    if (visitors.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    No one has opened this drop point yet.
                </CardBody>
            </Card>
        );
    }
    return (
        <Card>
            <CardBody className="p-0">
                <div className="max-h-[55vh] overflow-auto">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-4 py-2 font-medium">IP</th>
                                <th className="px-4 py-2 font-medium">User</th>
                                <th className="px-4 py-2 font-medium">First seen</th>
                                <th className="px-4 py-2 font-medium">Connected</th>
                                <th className="px-4 py-2 font-medium">Uploaded</th>
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
                                            {row.ip ?? "unknown"}
                                        </td>
                                        <td className="px-4 py-2 text-muted-foreground">
                                            {row.user ?? "Anonymous"}
                                        </td>
                                        <td className="px-4 py-2 text-muted-foreground">
                                            {new Date(row.firstSeenAt).toLocaleString()}
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
                                                    {live ? "Active now" : duration}
                                                </span>
                                            </span>
                                        </td>
                                        <td className="px-4 py-2 text-muted-foreground">
                                            {row.uploads > 0 ? `${row.uploads} file(s)` : "No"}
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
                    <DialogTitle>Save as template</DialogTitle>
                    <DialogDescription>
                        Reuse these guardrails when creating future drop points.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Template name
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="e.g. Client intake"
                            autoFocus
                        />
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end">
                        <Button type="submit" disabled={pending || !name.trim()}>
                            {pending ? "Saving..." : "Save template"}
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
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [geoCountries, setGeoCountries] = useState<string[]>(config.allowedCountries);
    const [geoContinents, setGeoContinents] = useState<string[]>(config.allowedContinents);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const form = new FormData(event.currentTarget);

        const tokens = (raw: string, stripLeading: RegExp) =>
            Array.from(
                new Set(
                    String(raw)
                        .split(/[\s,]+/)
                        .map((value) => value.trim().replace(stripLeading, "").toLowerCase())
                        .filter(Boolean)
                )
            );
        const allowedExtensions = tokens(String(form.get("extensions") ?? ""), /^\./);
        const deniedExtensions = tokens(String(form.get("deniedExtensions") ?? ""), /^\./);
        const allowedUsers = tokens(String(form.get("allowedUsers") ?? ""), /^@+/);
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
            <DialogContent className="max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Configure drop point</DialogTitle>
                    <DialogDescription className="truncate">
                        Uploads keep collecting into &quot;
                        {config.destinationPath || config.connectionName}&quot;.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Title
                        <Input
                            name="title"
                            required
                            defaultValue={config.title}
                            autoComplete="off"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Instructions (optional)
                        <textarea
                            name="instructions"
                            rows={2}
                            defaultValue={config.instructions ?? ""}
                            className="max-h-48 min-h-[2.5rem] resize-y rounded-md border border-input bg-surface px-3 py-2 text-sm"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Allowed extensions (optional)
                        <Input
                            name="extensions"
                            defaultValue={config.allowedExtensions.join(", ")}
                            placeholder="e.g. psd, ai, sketch"
                            autoComplete="off"
                        />
                        <span className="text-xs text-muted-foreground">
                            Leave empty to allow any file type.
                        </span>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Blocked extensions (optional)
                        <Input
                            name="deniedExtensions"
                            defaultValue={config.deniedExtensions.join(", ")}
                            placeholder="e.g. exe, bat, sh"
                            autoComplete="off"
                        />
                        <span className="text-xs text-muted-foreground">
                            Rejected even if also allowed.
                        </span>
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Min size (MB)
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
                                placeholder="None"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Max size (MB)
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
                            Max files
                            <Input
                                name="maxFiles"
                                type="number"
                                min="1"
                                defaultValue={config.maxFiles ?? ""}
                                placeholder="No limit"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Starts
                            <Input
                                name="startsAt"
                                type="datetime-local"
                                defaultValue={toLocalInput(config.startsAt)}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Expires
                            <Input
                                name="expiresAt"
                                type="date"
                                defaultValue={config.expiresAt ? config.expiresAt.slice(0, 10) : ""}
                            />
                        </label>
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        Restrict to IPs / ranges (optional)
                        <Input
                            name="allowedCidrs"
                            defaultValue={config.allowedCidrs.join(", ")}
                            placeholder="e.g. 203.0.113.4, 10.0.0.0/24"
                            autoComplete="off"
                        />
                    </label>
                    <div className="flex flex-col gap-1 text-sm">
                        Restrict by location (optional)
                        <GeoPicker
                            countries={geoCountries}
                            continents={geoContinents}
                            onCountries={setGeoCountries}
                            onContinents={setGeoContinents}
                        />
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        Access PIN
                        <Input
                            name="password"
                            type="password"
                            placeholder={config.hasPassword ? "Leave blank to keep" : "No PIN"}
                            autoComplete="off"
                        />
                    </label>
                    {config.hasPassword ? (
                        <label className="flex items-center gap-2 text-sm">
                            <input type="checkbox" name="removePin" className="size-4" />
                            Remove PIN
                        </label>
                    ) : null}
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            name="requireLogin"
                            defaultChecked={config.requireLogin}
                            className="size-4"
                        />
                        Require uploaders to sign in
                    </label>
                    <div className="flex flex-col gap-1.5 text-sm">
                        <label className="flex items-center gap-2">
                            <input
                                type="checkbox"
                                name="allowUploaderDelete"
                                defaultChecked={config.allowUploaderDelete}
                                className="size-4"
                            />
                            Let uploaders delete their own files
                        </label>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            Only within
                            <Input
                                name="deleteWindowMin"
                                type="number"
                                min="1"
                                defaultValue={
                                    config.uploaderDeleteWindowSeconds
                                        ? Math.round(config.uploaderDeleteWindowSeconds / 60)
                                        : ""
                                }
                                placeholder="anytime"
                                className="h-8 w-24"
                            />
                            minutes of upload (blank = anytime)
                        </label>
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        Restrict to specific users (optional)
                        <Input
                            name="allowedUsers"
                            defaultValue={config.allowedUsers.join(", ")}
                            placeholder="e.g. @alice, bob@example.com"
                            autoComplete="off"
                        />
                        <span className="text-xs text-muted-foreground">
                            Only these accounts may upload (sign-in required). Match by username or
                            email.
                        </span>
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end">
                        <Button type="submit" disabled={pending}>
                            {pending ? "Saving..." : "Save changes"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
