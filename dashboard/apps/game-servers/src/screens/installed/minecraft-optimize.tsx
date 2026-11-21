"use client";

/**
 * Taking the generated land nobody touched back off the disk.
 *
 * The card is deliberately two steps. The first measures and says what would go;
 * the second does it. That is not caution for its own sake - what this removes is
 * chunks, and the only honest way to ask somebody to agree to that is to tell
 * them how many and how much first, with the real number rather than an estimate.
 * A world the script will not touch (BUG-0009) says why at the first step, and
 * the second is never offered.
 *
 * There is no way to run it without a backup, and no way to have it run on its
 * own: the script copies the world and checks the copy before it rewrites
 * anything, and the result offers that copy back.
 *
 * It says plainly that the server stops for it, because it does: a live server
 * holds its region files open and the optimizer will not touch a world underneath
 * one. A server that was running is started again afterwards, including when the
 * run failed.
 */

import { useState } from "react";
import { useGameText, useSchemaText } from "../game-text";
import { formatBytes } from "@polaris/core";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { optimizeWorldAction, previewWorldTrimAction, restoreWorldBackupAction } from "./minecraft-actions";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import type { WorldTrimRun } from "../../lib/minecraft/world-trim";
import { RestoreDialog } from "./world-restore-dialog";

export function WorldOptimizeCard({
    installedAppId,
    serverName,
    lastRun,
    onChanged
}: {
    installedAppId: string;
    serverName: string;
    /** What the last run did, or null when there has not been one. */
    lastRun: WorldTrimRun | null;
    /** Reload the screen after a restore, which switches the level. */
    onChanged: () => void | Promise<void>;
}) {
    const schemaText = useSchemaText();
    const t = useGameText("minecraft");
    const [measuring, setMeasuring] = useState(false);
    const [running, setRunning] = useState(false);
    const [found, setFound] = useState<{ summary: string; removed: number; refused: boolean } | null>(null);
    const [done, setDone] = useState<{ summary: string; backup: string | null } | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [restoring, setRestoring] = useState(false);
    const [restoreBusy, setRestoreBusy] = useState(false);
    const [restored, setRestored] = useState(false);

    async function measure(): Promise<void> {
        setMeasuring(true);
        setFailed(null);
        setDone(null);
        setRestored(false);
        const result = await previewWorldTrimAction(installedAppId);
        setMeasuring(false);
        if (result.error) setFailed(result.error);
        else
            setFound({
                summary: schemaText(result.summary) ?? "",
                removed: result.removed ?? 0,
                refused: result.refused === true
            });
    }

    async function run(): Promise<void> {
        setRunning(true);
        setFailed(null);
        const result = await optimizeWorldAction(installedAppId);
        setRunning(false);
        setFound(null);
        if (result.error) setFailed(result.error);
        else if (result.refused) setFailed(schemaText(result.summary) ?? t("optimize.done"));
        else setDone({ summary: schemaText(result.summary) ?? t("optimize.done"), backup: result.backup ?? null });
    }

    async function restore(name: string): Promise<void> {
        setRestoreBusy(true);
        setFailed(null);
        const result = await restoreWorldBackupAction(installedAppId, name);
        setRestoreBusy(false);
        setRestoring(false);
        if (result.error) setFailed(result.error);
        else {
            setRestored(true);
            await onChanged();
        }
    }

    const canRun = found !== null && found.removed > 0 && !found.refused;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" />
                    {t("optimize.optimizeTheWorld")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">{t("optimize.aWorldKeepsEveryChunk")}</p>

                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={measure} disabled={measuring || running}>
                        {measuring ? <Loader2 className="size-4 animate-spin" /> : null}
                        {measuring ? t("optimize.measuring") : t("optimize.seeWhatWouldGo")}
                    </Button>
                    {canRun && (
                        <Button size="sm" onClick={run} disabled={running}>
                            {running ? <Loader2 className="size-4 animate-spin" /> : null}
                            {running ? t("optimize.optimizing") : t("optimize.doIt")}
                        </Button>
                    )}
                </div>

                {found && (
                    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
                        <p className={found.refused ? "text-xs text-warning" : "text-xs"}>{found.summary}</p>
                        {canRun && (
                            <>
                                <p className="text-xs text-muted-foreground">{t("optimize.backupFirst")}</p>
                                <p className="text-xs text-muted-foreground">{t("optimize.theServerStopsWhileThis")}</p>
                            </>
                        )}
                    </div>
                )}

                {done && (
                    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
                        <p className="text-xs text-success">{done.summary}</p>
                        {done.backup && !restored && (
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="min-w-0 text-xs text-muted-foreground">{t("optimize.backupTaken")}</p>
                                <Button size="sm" variant="secondary" onClick={() => setRestoring(true)}>
                                    <RotateCcw className="size-4" />
                                    {t("optimize.restoreBackup")}
                                </Button>
                            </div>
                        )}
                        {restored && <p className="text-xs text-muted-foreground">{t("world.restored")}</p>}
                    </div>
                )}
                {failed && <p className="text-xs text-danger">{failed}</p>}

                {lastRun && !done && (
                    <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                        {lastRun.ok ? (
                            lastRun.removed > 0 ? (
                                t("optimize.lastRunRemoved", {
                                    date: new Date(lastRun.at).toLocaleDateString(),
                                    count: lastRun.removed,
                                    size: formatBytes(lastRun.freedBytes)
                                })
                            ) : (
                                t("optimize.lastRunNothing", { date: new Date(lastRun.at).toLocaleDateString() })
                            )
                        ) : (
                            <Badge variant="danger">{schemaText(lastRun.detail) || t("optimize.theLastRunDidNot")}</Badge>
                        )}
                    </p>
                )}
            </CardBody>

            {restoring && done?.backup && (
                <RestoreDialog
                    serverName={serverName}
                    pending={restoreBusy}
                    onClose={() => setRestoring(false)}
                    onConfirm={() => void restore(done.backup!)}
                />
            )}
        </Card>
    );
}
