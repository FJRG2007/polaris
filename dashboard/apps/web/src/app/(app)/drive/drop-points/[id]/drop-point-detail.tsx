"use client";

/**
 * Drop-point detail view. Shows one drop point's config and the files it has
 * collected (which double as its activity log), and lets the owner edit the
 * guardrails at any time, reopen a closed one, clone it into a new drop point
 * with the same settings, close it, or jump to its folder in Drive. All mutations
 * are re-validated server-side; this view only reflects the result.
 */

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    Ban,
    ChevronLeft,
    Copy,
    FolderOpen,
    Inbox,
    Pencil,
    RotateCcw
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
    Input
} from "@polaris/ui";
import { GeoPicker } from "@/components/geo-picker";
import { useConfirm } from "@/components/confirm-dialog";
import { RequestDialog } from "../../request-dialog";
import {
    reopenFileRequestAction,
    revokeFileRequestAction,
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
    maxFiles: number | null;
    allowedExtensions: string[];
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
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

function status(config: DropPointConfig): { label: string; variant: "success" | "neutral" | "warning" } {
    if (config.revokedAt) return { label: "Closed", variant: "neutral" };
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

export function DropPointDetail({
    config,
    submissions,
    connections
}: {
    config: DropPointConfig;
    submissions: SubmissionRow[];
    connections: { id: string; name: string }[];
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [editing, setEditing] = useState(false);
    const [cloning, setCloning] = useState(false);
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
        if (!(await confirm({ title: "Close this drop point?", description: "It will stop accepting uploads immediately.", confirmLabel: "Close", danger: true }))) return;
        startTransition(async () => {
            await revokeFileRequestAction(config.id);
            router.refresh();
        });
    }

    // Clone opens the create dialog in picker mode, prefilled with this drop
    // point's guardrails; the owner only chooses where the new one collects.
    const cloneInitial = {
        title: `${config.title} (copy)`,
        instructions: config.instructions ?? "",
        extensions: config.allowedExtensions.join(", "),
        maxMb: Math.max(1, Math.round(Number(config.maxSizeBytes) / (1024 * 1024))),
        maxFiles: config.maxFiles ?? undefined,
        requireLogin: config.requireLogin,
        allowedCidrs: config.allowedCidrs.join(", "),
        geoCountries: config.allowedCountries,
        geoContinents: config.allowedContinents
    };

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

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <h2 className="text-sm font-medium">Configuration</h2>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                        <Field label="Max size">{formatBytes(BigInt(config.maxSizeBytes))}</Field>
                        <Field label="Max files">{config.maxFiles ?? "No limit"}</Field>
                        <Field label="Collected">{config.submissionCount}</Field>
                        <Field label="Expires">
                            {config.expiresAt ? new Date(config.expiresAt).toLocaleDateString() : "Never"}
                        </Field>
                        <Field label="Sign-in">{config.requireLogin ? "Required" : "Not required"}</Field>
                        <Field label="PIN">{config.hasPassword ? "Set" : "None"}</Field>
                        <Field label="File types">
                            {config.allowedExtensions.length > 0 ? config.allowedExtensions.join(", ") : "Any"}
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

            <div className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">Collected files ({submissions.length})</h2>
                <Card>
                    <CardBody className="p-0">
                        {submissions.length === 0 ? (
                            <p className="p-6 text-center text-sm text-muted-foreground">Nothing uploaded yet.</p>
                        ) : (
                            <div className="max-h-[55vh] overflow-auto">
                                <table className="w-full text-sm">
                                    <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                                        <tr>
                                            <th className="px-4 py-2 font-medium">File</th>
                                            <th className="px-4 py-2 font-medium">Size</th>
                                            <th className="px-4 py-2 font-medium">Uploaded by</th>
                                            <th className="px-4 py-2 font-medium">When</th>
                                            <th className="px-4 py-2 font-medium">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {submissions.map((row) => (
                                            <tr key={row.id} className="border-t border-border hover:bg-card-hover">
                                                <td className="max-w-[16rem] truncate px-4 py-2">{row.fileName}</td>
                                                <td className="px-4 py-2 text-muted-foreground">
                                                    {formatBytes(BigInt(row.size))}
                                                </td>
                                                <td className="px-4 py-2 text-muted-foreground">
                                                    {row.uploader ?? "Anonymous"}
                                                </td>
                                                <td className="px-4 py-2 text-muted-foreground">
                                                    {new Date(row.at).toLocaleString()}
                                                </td>
                                                <td className={`px-4 py-2 capitalize ${statusTone(row.status)}`}>
                                                    {row.status}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </CardBody>
                </Card>
            </div>

            <EditDropPointDialog
                config={config}
                open={editing}
                onOpenChange={setEditing}
                onSaved={() => {
                    setEditing(false);
                    router.refresh();
                }}
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

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate">{children}</dd>
        </div>
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

        const allowedExtensions = Array.from(
            new Set(
                String(form.get("extensions") ?? "")
                    .split(/[\s,]+/)
                    .map((value) => value.trim().replace(/^\./, "").toLowerCase())
                    .filter(Boolean)
            )
        );
        const allowedCidrs = String(form.get("allowedCidrs") ?? "")
            .split(/[\s,]+/)
            .map((value) => value.trim())
            .filter(Boolean);
        const maxMb = Number(form.get("maxMb") ?? 0);
        const maxFiles = form.get("maxFiles");
        const removePin = form.get("removePin") === "on";
        const pin = String(form.get("password") ?? "");

        const result = await updateFileRequestAction(config.id, {
            title: String(form.get("title") ?? "").trim(),
            instructions: String(form.get("instructions") ?? "").trim() || null,
            requireLogin: form.get("requireLogin") === "on",
            password: removePin ? null : pin ? pin : undefined,
            maxSizeBytes: maxMb > 0 ? Math.floor(maxMb * 1024 * 1024) : undefined,
            maxFiles: maxFiles ? Number(maxFiles) : null,
            allowedExtensions,
            allowedCidrs,
            allowedCountries: geoCountries,
            allowedContinents: geoContinents,
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
                        Uploads keep collecting into &quot;{config.destinationPath || config.connectionName}&quot;.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Title
                        <Input name="title" required defaultValue={config.title} autoComplete="off" />
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
                        <span className="text-xs text-muted-foreground">Leave empty to allow any file type.</span>
                    </label>
                    <div className="grid grid-cols-3 gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Max size (MB)
                            <Input
                                name="maxMb"
                                type="number"
                                min="1"
                                defaultValue={Math.max(1, Math.round(Number(config.maxSizeBytes) / (1024 * 1024)))}
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
