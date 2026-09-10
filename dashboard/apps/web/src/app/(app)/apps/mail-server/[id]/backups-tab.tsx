"use client";

/**
 * Backing the server up: its two volumes, protected in Backups like any other
 * service's data, where copies are scheduled, kept and restored.
 */

import Link from "next/link";
import { useState } from "react";
import { Archive } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import { backupsAction, protectAction } from "../actions";
import { Mono, PanelError, usePanelData } from "../ui-bits";
import { Badge, Button, EmptyState, Skeleton } from "@polaris/ui";

export function BackupsTab({ serverId }: { serverId: string }) {
    const panel = usePanelData(`backups:${serverId}`, () => backupsAction(serverId));
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function protect(): Promise<void> {
        setPending(true);
        setError(null);
        const answer = await protectAction(serverId);
        setPending(false);
        if (answer.error) setError(answer.error);
        await panel.reload();
    }

    const volumes = panel.data?.volumes ?? [];
    const unprotected = volumes.filter((volume) => !volume.resourceId).length;

    return (
        <div className="flex flex-col gap-4">
            <p className="text-xs text-muted-foreground">
                Copies are taken while the server runs, so one made during heavy delivery can miss the last few messages. Restoring puts a volume
                back as it was when copied.
            </p>
            {error ? <PanelError message={error} /> : null}
            {!panel.data ? (
                panel.error ? (
                    <PanelError message={panel.error} onRetry={() => void panel.reload()} />
                ) : (
                    <Skeleton className="h-32 w-full" />
                )
            ) : volumes.length === 0 ? (
                <EmptyState icon={<Archive />} title="No volumes yet" description="They exist once setup has created the service." />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {volumes.map((volume) => (
                        <li key={volume.volumeId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="text-[0.8125rem] text-foreground">{volume.volume}</span>
                                <Mono className="text-muted-foreground">{volume.mountPath}</Mono>
                            </div>
                            {volume.resourceId ? (
                                <>
                                    <span className="text-xs text-muted-foreground">
                                        {volume.lastBackupAt ? (
                                            <>
                                                Last copy <RelativeTime iso={volume.lastBackupAt} />, {volume.copyCount} kept
                                            </>
                                        ) : (
                                            "No copy yet"
                                        )}
                                    </span>
                                    {volume.lastStatus === "failed" ? (
                                        <Badge variant="danger" title={volume.lastError ?? undefined}>
                                            Last copy failed
                                        </Badge>
                                    ) : (
                                        <Badge variant="success">Protected</Badge>
                                    )}
                                    <Button asChild size="sm" variant="outline">
                                        <Link href={`/apps/backups/${volume.resourceId}`}>Copies and restore</Link>
                                    </Button>
                                </>
                            ) : (
                                <Badge>Not protected</Badge>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {unprotected > 0 ? (
                <div>
                    <Button size="sm" onClick={() => void protect()} disabled={pending}>
                        {pending ? "Protecting..." : "Protect with Backups"}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
