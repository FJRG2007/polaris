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
import { useTranslations } from "@/components/i18n/i18n-provider";

export function BackupsTab({ serverId }: { serverId: string }) {
    const t = useTranslations("mailServer");
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
                {t("backups.intro")}
            </p>
            {error ? <PanelError message={error} /> : null}
            {!backups ? (
                panel.error ? (
                    <PanelError message={panel.error} onRetry={() => void panel.reload()} />
                ) : (
                    <Skeleton className="h-20 w-full" />
                )
            ) : !backups.ready ? (
                <EmptyState icon={<Archive />} title={t("backups.notRunning")} description={t("backups.notRunningBody")} />
            ) : (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2">
                    <span className="min-w-0 flex-1 text-[0.8125rem] text-foreground">{t("backups.whole")}</span>
                    {backups.resourceId ? (
                        <>
                            <span className="text-xs text-muted-foreground">
                                {backups.lastBackupAt ? (
                                    t.rich("backups.lastCopy", {
                                        count: backups.copyCount,
                                        when: () => <RelativeTime key="when" iso={backups.lastBackupAt!} />
                                    })
                                ) : (
                                    t("backups.noCopy")
                                )}
                            </span>
                            {backups.lastStatus === "failed" ? (
                                <Badge variant="danger" title={backups.lastError ?? undefined}>
                                    {t("backups.lastFailed")}
                                </Badge>
                            ) : (
                                <Badge variant="success">{t("backups.protected")}</Badge>
                            )}
                            <Button asChild size="sm" variant="outline">
                                <Link href={`/apps/backups/${backups.resourceId}`}>{t("backups.copies")}</Link>
                            </Button>
                        </>
                    ) : (
                        <>
                            <Badge>{t("backups.unprotected")}</Badge>
                            <Button size="sm" onClick={() => void protect()} disabled={pending}>
                                {pending ? t("backups.protecting") : t("backups.protect")}
                            </Button>
                        </>
                    )}
                </div>
            )}
            {backups && backups.volumeResources.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                    {t("backups.volumes")}{" "}
                    {backups.volumeResources.map((resource, index) => (
                        <span key={resource.id}>
                            {index > 0 ? ", " : ""}
                            <Link href={`/apps/backups/${resource.id}`} className="text-primary hover:underline">
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
