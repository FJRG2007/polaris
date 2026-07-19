"use client";

/**
 * Settings client view. Shows the deployment facts and the update card. The
 * update card starts from the server-rendered status and can be refreshed on
 * demand; the refresh forces a fresh GitHub comparison via the server action.
 */

import { useState, useTransition } from "react";
import { CheckCircle2, Database, Download, DownloadCloud, HardDriveDownload, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import type { UpdateStatus } from "@/lib/update-service";
import type { BackupInfo } from "@/lib/backup-service";
import { checkUpdatesAction, createBackupAction, deleteBackupAction } from "./actions";

interface Deployment {
    readonly appUrl: string;
    readonly hostname: string;
    readonly repo: string;
    readonly branch: string;
    readonly autoUpdate: boolean;
}

function formatChecked(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "never" : date.toLocaleString();
}

export function SettingsView({
    initialStatus,
    initialBackups,
    deployment
}: {
    initialStatus: UpdateStatus;
    initialBackups: BackupInfo[];
    deployment: Deployment;
}) {
    const [status, setStatus] = useState(initialStatus);
    const [pending, startTransition] = useTransition();
    const [backups, setBackups] = useState(initialBackups);
    const [backingUp, setBackingUp] = useState(false);
    const [backupError, setBackupError] = useState<string | null>(null);
    const [busyBackup, setBusyBackup] = useState<string | null>(null);

    function onCheck() {
        startTransition(async () => {
            setStatus(await checkUpdatesAction());
        });
    }

    async function onBackup() {
        setBackingUp(true);
        setBackupError(null);
        const result = await createBackupAction();
        setBackingUp(false);
        if (result.error) setBackupError(result.error);
        else if (result.backups) setBackups(result.backups);
    }

    async function onDeleteBackup(name: string) {
        setBusyBackup(name);
        const result = await deleteBackupAction(name);
        setBackups(result.backups);
        setBusyBackup(null);
    }

    const behind = typeof status.behindBy === "number" && status.behindBy > 0;

    return (
        <div className="flex max-w-2xl flex-col gap-4">
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle>Updates</CardTitle>
                        <Button size="sm" variant="secondary" onClick={onCheck} disabled={pending}>
                            <RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} />
                            {pending ? "Checking..." : "Check for updates"}
                        </Button>
                    </div>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-center gap-2 text-sm">
                        {status.error ? (
                            <>
                                <TriangleAlert className="size-4 text-warning" />
                                <span className="text-warning">{status.error}</span>
                            </>
                        ) : behind ? (
                            <>
                                <DownloadCloud className="size-4 text-primary" />
                                <span>
                                    Update available - {status.behindBy} commit{status.behindBy === 1 ? "" : "s"}{" "}
                                    behind {deployment.branch}.
                                </span>
                            </>
                        ) : status.upToDate ? (
                            <>
                                <CheckCircle2 className="size-4 text-success" />
                                <span>Up to date.</span>
                            </>
                        ) : (
                            <>
                                <TriangleAlert className="size-4 text-muted-foreground" />
                                <span className="text-muted-foreground">
                                    Update state unknown (this build carries no commit reference).
                                </span>
                            </>
                        )}
                    </div>

                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <Row label="Running build" value={status.current ?? "unknown"} />
                        <Row label="Latest" value={status.latest ?? "-"} />
                        <Row label="Auto-update" value={deployment.autoUpdate ? "enabled" : "disabled"} />
                        <Row label="Last checked" value={formatChecked(status.checkedAt)} />
                    </dl>

                    {behind ? (
                        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                            Run <code className="text-foreground">polaris update</code> on the host to pull the latest
                            image and redeploy.{" "}
                            <a className="text-primary hover:underline" href={status.url} target="_blank" rel="noreferrer">
                                View changes
                            </a>
                        </div>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle>Backups</CardTitle>
                        <Button size="sm" onClick={onBackup} disabled={backingUp}>
                            <HardDriveDownload className={`size-4 ${backingUp ? "animate-pulse" : ""}`} />
                            {backingUp ? "Backing up..." : "Back up database"}
                        </Button>
                    </div>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <p className="text-xs text-muted-foreground">
                        Take a full copy of the Polaris database before an upgrade or a migration. Backups are kept on
                        the host and can be downloaded. NAS and other-app backups are coming next.
                    </p>
                    {backupError ? <p className="text-sm text-danger">{backupError}</p> : null}
                    {backups.length === 0 ? (
                        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                            No backups yet.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-1.5">
                            {backups.map((backup) => (
                                <li
                                    key={backup.name}
                                    className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
                                >
                                    <div className="flex min-w-0 items-center gap-2">
                                        <Database className="size-4 shrink-0 text-muted-foreground" />
                                        <div className="min-w-0">
                                            <p className="truncate font-medium">{backup.name}</p>
                                            <p className="text-xs text-muted-foreground">
                                                {formatBytes(BigInt(backup.sizeBytes))} -{" "}
                                                {new Date(backup.createdAt).toLocaleString()}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button size="icon" variant="ghost" asChild aria-label="Download backup">
                                            <a href={`/api/backups/${encodeURIComponent(backup.name)}`} download>
                                                <Download className="size-4" />
                                            </a>
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label="Delete backup"
                                            disabled={busyBackup === backup.name}
                                            onClick={() => onDeleteBackup(backup.name)}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Deployment</CardTitle>
                </CardHeader>
                <CardBody>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <Row label="App URL" value={deployment.appUrl} />
                        <Row label="Local hostname" value={`${deployment.hostname}.local`} />
                        <Row label="Repository" value={deployment.repo} />
                        <Row label="Release branch" value={deployment.branch} />
                    </dl>
                </CardBody>
            </Card>
        </div>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate font-medium">{value}</dd>
        </>
    );
}
