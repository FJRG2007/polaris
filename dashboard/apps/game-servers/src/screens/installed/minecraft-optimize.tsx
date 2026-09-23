"use client";

/**
 * Taking the part of the world nobody has been in back off the disk.
 *
 * The card is deliberately two steps. The first measures and says what would go;
 * the second does it. That is not caution for its own sake - what this removes is
 * chunks, and the only honest way to ask somebody to agree to that is to tell
 * them how many and how much first, with the real number rather than an estimate.
 *
 * It says plainly that the server stops for it, because it does: a live server
 * holds its region files open and the optimizer will not touch a world underneath
 * one. A server that was running is started again afterwards, including when the
 * run failed.
 */

import { useState } from "react";
import { formatBytes } from "@polaris/core";
import { Loader2, Sparkles } from "lucide-react";
import { optimizeWorldAction, previewWorldTrimAction, saveWorldTrimAction } from "./minecraft-actions";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Checkbox, Input, Switch } from "@polaris/ui";
import {
    WORLD_TRIM_DEFAULTS,
    type WorldTrimRun,
    type WorldTrimSettings
} from "../../lib/minecraft/world-trim";

export function WorldOptimizeCard({
    installedAppId,
    settings: saved,
    lastRun
}: {
    installedAppId: string;
    settings: WorldTrimSettings;
    /** What the last run did, or null when there has not been one. */
    lastRun: WorldTrimRun | null;
}) {
    const [settings, setSettings] = useState<WorldTrimSettings>(saved ?? WORLD_TRIM_DEFAULTS);
    const [measuring, setMeasuring] = useState(false);
    const [running, setRunning] = useState(false);
    const [backup, setBackup] = useState(true);
    const [found, setFound] = useState<{ summary: string; removed: number } | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [failed, setFailed] = useState<string | null>(null);

    async function save(next: WorldTrimSettings): Promise<void> {
        setSettings(next);
        await saveWorldTrimAction({ installedAppId, ...next });
    }

    async function measure(): Promise<void> {
        setMeasuring(true);
        setFailed(null);
        setDone(null);
        const result = await previewWorldTrimAction(installedAppId);
        setMeasuring(false);
        if (result.error) setFailed(result.error);
        else setFound({ summary: result.summary ?? "", removed: result.removed ?? 0 });
    }

    async function run(): Promise<void> {
        setRunning(true);
        setFailed(null);
        const result = await optimizeWorldAction(installedAppId, { backup });
        setRunning(false);
        setFound(null);
        if (result.error) setFailed(result.error);
        else setDone(result.summary ?? "Done.");
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" />
                    Optimize the world
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                    A world keeps every chunk anybody has ever loaded, and most of what gets loaded is scenery
                    nobody walks into. Those chunks generate again, identically, the moment somebody goes there -
                    so removing them costs nothing and usually takes a world down by half or more. Anything a
                    player has stood in is kept, along with spawn, forced chunks and everywhere people log out.
                </p>

                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={measure} disabled={measuring || running}>
                        {measuring ? <Loader2 className="size-4 animate-spin" /> : null}
                        {measuring ? "Measuring" : "See what would go"}
                    </Button>
                    {found && found.removed > 0 && (
                        <Button size="sm" onClick={run} disabled={running}>
                            {running ? <Loader2 className="size-4 animate-spin" /> : null}
                            {running ? "Optimizing" : "Do it"}
                        </Button>
                    )}
                </div>

                {found && (
                    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
                        <p className="text-xs">{found.summary}</p>
                        {found.removed > 0 && (
                            <>
                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Checkbox checked={backup} onChange={(event) => setBackup(event.target.checked)} />
                                    Back the world up first
                                </label>
                                <p className="text-xs text-muted-foreground">
                                    The server stops while this runs and starts again afterwards.
                                </p>
                            </>
                        )}
                    </div>
                )}

                {done && <p className="text-xs text-success">{done}</p>}
                {failed && <p className="text-xs text-danger">{failed}</p>}

                <div className="flex flex-col gap-2 border-t border-border pt-3">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-sm font-medium">Keep it tidy on its own</p>
                            <p className="max-w-lg text-xs text-muted-foreground">
                                Runs while the server is already stopped and never stops one to do it, so a server
                                that is always up is never touched by this.
                            </p>
                        </div>
                        <Switch
                            checked={settings.enabled}
                            onChange={(enabled) => void save({ ...settings, enabled })}
                            aria-label="Optimize this world on its own"
                        />
                    </div>
                    {settings.enabled && (
                        <label className="flex max-w-xs items-center gap-2 text-xs">
                            <span className="shrink-0 text-muted-foreground">At most once every</span>
                            <Input
                                type="number"
                                min={1}
                                max={365}
                                value={String(settings.everyDays)}
                                aria-label="Days between automatic runs"
                                onChange={(event) =>
                                    void save({
                                        ...settings,
                                        everyDays: Number.parseInt(event.target.value, 10) || 1
                                    })
                                }
                            />
                            <span className="shrink-0 text-muted-foreground">days</span>
                        </label>
                    )}
                    {lastRun && (
                        <p className="text-xs text-muted-foreground">
                            {lastRun.ok ? (
                                <>
                                    Last run {new Date(lastRun.at).toLocaleDateString()}:{" "}
                                    {lastRun.removed > 0
                                        ? `${lastRun.removed.toLocaleString()} chunks, ${formatBytes(lastRun.freedBytes)}.`
                                        : "nothing to take out."}
                                </>
                            ) : (
                                <Badge variant="danger">{lastRun.detail || "The last run did not work"}</Badge>
                            )}
                        </p>
                    )}
                </div>
            </CardBody>
        </Card>
    );
}
