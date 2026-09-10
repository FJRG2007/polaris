"use client";

/**
 * Backing the server up: protected in Backups as one thing, where copies are
 * scheduled, kept, encrypted and restored.
 */

import Link from "next/link";
import { useState } from "react";
import { Archive } from "lucide-react";
import { PanelError, usePanelData } from "../ui-bits";
import { RelativeTime } from "@/components/relative-time";
import { backupsAction, protectAction } from "../actions";
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

    const backups = panel.data?.backups;

    return (
        <div className="flex flex-col gap-4">
            <p className="text-xs text-muted-foreground">
                Each copy is the engine&apos;s own export, taken with the server paused for as long
                as it runs, so every mailbox is caught at the same moment. Mail sent meanwhile is
                retried by the sender. Restoring pauses it again and puts the whole server back.
            </p>
            {error ? <PanelError message={error} /> : null}
            {!backups ? (
                panel.error ? (
                    <PanelError message={panel.error} onRetry={() => void panel.reload()} />
                ) : (
                    <Skeleton className="h-20 w-full" />
                )
            ) : !backups.ready ? (
                <EmptyState
                    icon={<Archive />}
                    title="Not running yet"
                    description="It can be protected once setup has finished."
                />
            ) : (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2">
                    <span className="min-w-0 flex-1 text-[0.8125rem] text-foreground">
                        Whole server
                    </span>
                    {backups.resourceId ? (
                        <>
                            <span className="text-xs text-muted-foreground">
                                {backups.lastBackupAt ? (
                                    <>
                                        Last copy <RelativeTime iso={backups.lastBackupAt} />,{" "}
                                        {backups.copyCount} kept
                                    </>
                                ) : (
                                    "No copy yet"
                                )}
                            </span>
                            {backups.lastStatus === "failed" ? (
                                <Badge variant="danger" title={backups.lastError ?? undefined}>
                                    Last copy failed
                                </Badge>
                            ) : (
                                <Badge variant="success">Protected</Badge>
                            )}
                            <Button asChild size="sm" variant="outline">
                                <Link href={`/apps/backups/${backups.resourceId}`}>
                                    Copies and restore
                                </Link>
                            </Button>
                        </>
                    ) : (
                        <>
                            <Badge>Not protected</Badge>
                            <Button size="sm" onClick={() => void protect()} disabled={pending}>
                                {pending ? "Protecting..." : "Protect with Backups"}
                            </Button>
                        </>
                    )}
                </div>
            )}
            {backups && backups.volumeResources.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                    Its volumes are also still copied as files, from before:{" "}
                    {backups.volumeResources.map((resource, index) => (
                        <span key={resource.id}>
                            {index > 0 ? ", " : ""}
                            <Link
                                href={`/apps/backups/${resource.id}`}
                                className="text-primary hover:underline"
                            >
                                {resource.name}
                            </Link>
                        </span>
                    ))}
                    .
                </p>
            ) : null}
        </div>
    );
}
