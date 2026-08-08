"use client";

/**
 * Backups app view. Two targets are live: the Polaris database, as a gzipped
 * logical backup taken here, and every Minecraft world, as an archive taken
 * inside the server that runs it. NAS and other-app targets are shown as upcoming
 * so the platform's direction is visible, matching how the locked apps appear in
 * the switcher.
 *
 * The game cards are the server's own, imported rather than rebuilt: this page
 * and the server's World screen have to agree about what is on disk, and two
 * lists of the same archives would eventually not.
 */

import Link from "next/link";
import { useState } from "react";
import { formatBytes } from "@polaris/core";
import type { BackupInfo } from "@/lib/backup-service";
import { useDisplayFormat } from "@/components/display-format";
import { createBackupAction, deleteBackupAction } from "./actions";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { Boxes, Database, Download, Gamepad2, HardDriveDownload, Server, Trash2 } from "lucide-react";
import { GameServerBackups, WorldMessage, useWorldView } from "@/app/(app)/apps/installed/[id]/minecraft-world";

/** A game server there is a world to back up on. */
export interface BackupGameServer {
    readonly id: string;
    readonly name: string;
}

export function BackupsView({
    initialBackups,
    servers
}: {
    initialBackups: BackupInfo[];
    servers: BackupGameServer[];
}) {
    const format = useDisplayFormat();
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
        <div className="flex flex-col gap-4">
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
                                                {format.dateTime(backup.createdAt)}
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

            {servers.length > 0 && (
                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2">
                        <Gamepad2 className="size-4 text-muted-foreground" />
                        <h2 className="text-sm font-medium">Game worlds</h2>
                    </div>
                    {servers.map((server) => (
                        <GameServerCard key={server.id} id={server.id} name={server.name} />
                    ))}
                </div>
            )}

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

/**
 * One game server's worlds, on the page that manages every backup.
 *
 * The card is the same one the server's own screen shows, so backing up here and
 * backing up there are the same act rather than two that drift. It loads its own
 * view because measuring a world walks the whole folder: doing that for four
 * servers before the page rendered would hold the database backups - the thing
 * most people opened this page for - behind them.
 */
function GameServerCard({ id, name }: { id: string; name: string }) {
    const { view, reload } = useWorldView(id);
    return (
        <div className="flex flex-col gap-1">
            <WorldMessage view={view} />
            <GameServerBackups installedAppId={id} serverName={name} view={view} onChanged={reload} heading={name} />
            <Link
                href={`/apps/installed/${id}/world`}
                className="self-end text-xs text-muted-foreground hover:text-foreground"
            >
                Open {name}
            </Link>
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
