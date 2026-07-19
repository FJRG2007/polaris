"use client";

/**
 * Backups app view. The Polaris database target is live: take a gzipped logical
 * backup, then download or delete it. NAS and other-app targets are shown as
 * upcoming so the platform's direction is visible, matching how the locked apps
 * appear in the switcher.
 */

import { useState } from "react";
import { Boxes, Database, Download, HardDriveDownload, Server, Trash2 } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import type { BackupInfo } from "@/lib/backup-service";
import { createBackupAction, deleteBackupAction } from "./actions";

export function BackupsView({ initialBackups }: { initialBackups: BackupInfo[] }) {
    const [backups, setBackups] = useState(initialBackups);
    const [backingUp, setBackingUp] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    async function onBackup() {
        setBackingUp(true);
        setError(null);
        const result = await createBackupAction();
        setBackingUp(false);
        if (result.error) setError(result.error);
        else if (result.backups) setBackups(result.backups);
    }

    async function onDelete(name: string) {
        setBusy(name);
        const result = await deleteBackupAction(name);
        setBackups(result.backups);
        setBusy(null);
    }

    return (
        <div className="flex max-w-3xl flex-col gap-4">
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle className="flex items-center gap-2">
                            <Database className="size-4 text-primary" />
                            Polaris database
                        </CardTitle>
                        <Button size="sm" onClick={onBackup} disabled={backingUp}>
                            <HardDriveDownload className={`size-4 ${backingUp ? "animate-pulse" : ""}`} />
                            {backingUp ? "Backing up..." : "Back up now"}
                        </Button>
                    </div>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <p className="text-xs text-muted-foreground">
                        A gzipped snapshot of every table, taken through Prisma - no external tools, works on Postgres
                        and SQLite. Take one before an upgrade or a migration, then keep it somewhere safe.
                    </p>
                    {backups.some((backup) => backup.ephemeral) ? (
                        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                            The data dir isn&apos;t writable, so backups are kept in a temporary location and won&apos;t
                            survive a restart - download them now.
                        </p>
                    ) : null}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
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
                                            disabled={busy === backup.name}
                                            onClick={() => onDelete(backup.name)}
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

            <div className="grid gap-4 sm:grid-cols-2">
                <UpcomingTarget
                    icon={Server}
                    title="NAS backups"
                    description="Snapshot files from a storage connection to another location on a schedule."
                />
                <UpcomingTarget
                    icon={Boxes}
                    title="Other apps"
                    description="Back up data from other Polaris apps as they land."
                />
            </div>
        </div>
    );
}

function UpcomingTarget({
    icon: Icon,
    title,
    description
}: {
    icon: typeof Server;
    title: string;
    description: string;
}) {
    return (
        <Card className="opacity-70">
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-medium">
                        <Icon className="size-4 text-muted-foreground" />
                        {title}
                    </span>
                    <Badge variant="neutral">Coming soon</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{description}</p>
            </CardBody>
        </Card>
    );
}
