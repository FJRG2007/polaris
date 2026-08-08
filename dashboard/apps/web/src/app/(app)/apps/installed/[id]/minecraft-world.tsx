"use client";

/**
 * The map, and the copies of it.
 *
 * Two things an operator does here and they are not the same weight. Backing up
 * is routine and reversible, so it is one button and a list. Replacing the map is
 * neither, so it asks first and says plainly what survives it - which is the part
 * people get wrong: on Java the new world can be generated around everybody's
 * bag, stats and advancements, and the map being left behind is still on disk
 * afterwards. Nothing here destroys a world except the button that says so.
 *
 * The backups card is exported on its own because the Backups app shows the same
 * thing for every server at once, and a second copy of this list is a second
 * place for it to be wrong.
 */

import Link from "next/link";
import { formatBytes } from "@polaris/core";
import * as world from "@/lib/apps/minecraft/world";
import { CopyButton } from "@/components/copy-button";
import { useCallback, useEffect, useState } from "react";
import { useDisplayFormat } from "@/components/display-format";
import type { WorldView } from "@/lib/apps/minecraft/world-service";
import {
    Archive,
    Download,
    HardDriveDownload,
    Loader2,
    Play,
    RotateCcw,
    Sprout,
    Trash2,
    TriangleAlert
} from "lucide-react";
import {
    backUpWorldAction,
    deleteWorldAction,
    deleteWorldBackupAction,
    newWorldAction,
    restoreWorldBackupAction,
    switchWorldAction
} from "./minecraft-actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Checkbox,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton,
    cn
} from "@polaris/ui";

/** What every screen here needs: the view, and a way to ask for it again. */
export function useWorldView(installedAppId: string): {
    view: WorldView | null;
    error: string | null;
    reload: () => Promise<void>;
} {
    const [view, setView] = useState<WorldView | null>(null);
    const [error, setError] = useState<string | null>(null);

    const reload = useCallback(async () => {
        try {
            const response = await fetch(`/api/apps/installed/${installedAppId}/minecraft/world`, {
                cache: "no-store"
            });
            const data = (await response.json()) as WorldView & { error?: string };
            if (!response.ok) {
                setError(data.error ?? "Could not read the world");
                return;
            }
            setError(null);
            setView(data);
        } catch {
            setError("Could not read the world");
        }
    }, [installedAppId]);

    useEffect(() => {
        void reload();
    }, [reload]);

    return { view, error, reload };
}

export function MinecraftWorld({ installedAppId, name }: { installedAppId: string; name: string }) {
    const { view, error, reload } = useWorldView(installedAppId);

    return (
        <div className="flex flex-col gap-4">
            {/* One line for the whole screen: both cards are read out of the same
                container, so a server that cannot be reached is one fact about the
                page rather than the same sentence printed twice. */}
            <WorldMessage view={view} />
            <WorldsCard installedAppId={installedAppId} view={view} error={error} onChanged={reload} />
            <GameServerBackups installedAppId={installedAppId} serverName={name} view={view} onChanged={reload} />
        </div>
    );
}

/** Why the lists are empty, when they are. */
export function WorldMessage({ view }: { view: WorldView | null }) {
    if (!view?.message) return null;
    return (
        <p className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            {view.message}
        </p>
    );
}

/** The map being played, the seed behind it, and the ones still on disk. */
function WorldsCard({
    installedAppId,
    view,
    error,
    onChanged
}: {
    installedAppId: string;
    view: WorldView | null;
    error: string | null;
    onChanged: () => Promise<void>;
}) {
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);

    // Named `entry` rather than `world`, which is the module namespace in this
    // file: a callback that shadowed it would silently take the wrong `world`.
    const others = (view?.worlds ?? []).filter((entry) => !entry.current);
    const current = (view?.worlds ?? []).find((entry) => entry.current) ?? null;

    async function switchTo(level: string): Promise<void> {
        setBusy(level);
        setFailed(null);
        const result = await switchWorldAction(installedAppId, level);
        setBusy(null);
        if (result.error) setFailed(result.error);
        else await onChanged();
    }

    async function remove(level: string): Promise<void> {
        setBusy(level);
        setFailed(null);
        const result = await deleteWorldAction(installedAppId, level);
        setBusy(null);
        setDeleting(null);
        if (result.error) setFailed(result.error);
        else await onChanged();
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                        <Sprout className="size-4 text-primary" />
                        World
                    </CardTitle>
                    <Button size="sm" variant="secondary" onClick={() => setCreating(true)} disabled={view === null}>
                        New world
                    </Button>
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                {view === null ? (
                    <Skeleton className="h-16 w-full" />
                ) : (
                    <dl className="flex flex-col gap-1 text-sm">
                        <div className="flex items-baseline justify-between gap-3">
                            <dt className="text-muted-foreground">Playing on</dt>
                            <dd className="truncate font-mono" title={view.level}>{view.level}</dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-3">
                            <dt className="text-muted-foreground">Seed</dt>
                            {/* What the map was actually generated from, asked of
                                the server. The configured value only says what the
                                next world would use, and a world created without
                                one still has a seed - showing "Random" for it
                                answers nothing and cannot be used to make it
                                again. */}
                            <dd className="flex min-w-0 items-center gap-1">
                                {(view.worldSeed ?? view.seed) ? (
                                    <>
                                        <span
                                            className="truncate font-mono"
                                            title={view.worldSeed ?? view.seed}
                                        >
                                            {view.worldSeed ?? view.seed}
                                        </span>
                                        <CopyButton
                                            value={view.worldSeed ?? view.seed}
                                            label="Copy the world seed"
                                        />
                                    </>
                                ) : (
                                    <span className="text-muted-foreground">
                                        {view.edition === "bedrock" ? "Random" : "Not read yet"}
                                    </span>
                                )}
                            </dd>
                        </div>
                        <div className="flex items-baseline justify-between gap-3">
                            <dt className="text-muted-foreground">Size</dt>
                            <dd>{current?.sizeBytes != null ? formatBytes(current.sizeBytes) : "-"}</dd>
                        </div>
                    </dl>
                )}

                {(error ?? failed) && <p className="text-sm text-danger">{failed ?? error}</p>}

                {others.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                        <p className="text-xs text-muted-foreground">
                            Maps this server has played before. Switching restarts it.
                        </p>
                        {others.map((entry) => (
                            <div
                                key={entry.level}
                                className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
                            >
                                <div className="min-w-0">
                                    <p className="truncate font-mono" title={entry.level}>{entry.level}</p>
                                    <p className="text-xs text-muted-foreground">
                                        {entry.sizeBytes != null ? formatBytes(entry.sizeBytes) : "Size unknown"}
                                    </p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={`Play on ${entry.level}`}
                                        title="Play on this map"
                                        disabled={busy !== null}
                                        onClick={() => void switchTo(entry.level)}
                                    >
                                        {busy === entry.level ? (
                                            <Loader2 className="size-4 animate-spin" />
                                        ) : (
                                            <Play className="size-4" />
                                        )}
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label={`Delete ${entry.level}`}
                                        title="Delete this map"
                                        disabled={busy !== null}
                                        onClick={() => setDeleting(entry.level)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </CardBody>

            {creating && (
                <NewWorldDialog
                    installedAppId={installedAppId}
                    carriesPlayers={view?.carriesPlayers ?? false}
                    onClose={() => setCreating(false)}
                    onDone={onChanged}
                />
            )}

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting ?? ""}
                kind="world"
                description="Everything built on this map goes with it, and it is not the map the server is playing on. Back it up first if you might want it."
                pending={busy !== null}
                onConfirm={() => deleting && void remove(deleting)}
            />
        </Card>
    );
}

/** Generating a new map: the seed it comes from, and what carries over. */
function NewWorldDialog({
    installedAppId,
    carriesPlayers,
    onClose,
    onDone
}: {
    installedAppId: string;
    carriesPlayers: boolean;
    onClose: () => void;
    onDone: () => Promise<void>;
}) {
    const [seed, setSeed] = useState("");
    const [levelType, setLevelType] = useState(world.DEFAULT_LEVEL_TYPE);
    const [biome, setBiome] = useState(world.DEFAULT_BIOME);
    const [keepPlayers, setKeepPlayers] = useState(carriesPlayers);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit(): Promise<void> {
        setPending(true);
        setError(null);
        const result = await newWorldAction({
            installedAppId,
            ...(seed.trim() ? { seed: seed.trim() } : {}),
            // The shapes are Java's own names, so they are only sent for Java -
            // which is the same edition that can carry players across.
            ...(carriesPlayers ? { levelType } : {}),
            ...(carriesPlayers && world.usesBiome(levelType) ? { biome } : {}),
            keepPlayers: keepPlayers && carriesPlayers
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        await onDone();
        onClose();
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Sprout className="size-4" /> New world
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Seed</span>
                        <Input
                            value={seed}
                            onChange={(event) => setSeed(event.target.value)}
                            placeholder="Leave blank for a random world"
                        />
                        <span className="text-xs text-muted-foreground">
                            A number or any words. The same seed always generates the same map.
                        </span>
                    </label>

                    {carriesPlayers && (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">World type</span>
                            <Select
                                value={levelType}
                                onValueChange={setLevelType}
                                options={world.LEVEL_TYPES.map((entry) => ({
                                    value: entry.value,
                                    label: entry.label
                                }))}
                            />
                            <span className="text-xs text-muted-foreground">
                                {world.LEVEL_TYPES.find((entry) => entry.value === levelType)?.detail}
                            </span>
                        </label>
                    )}

                    {carriesPlayers && world.usesBiome(levelType) && (
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Biome</span>
                            <Select
                                value={biome}
                                onValueChange={setBiome}
                                options={world.BIOMES.map((entry) => ({ value: entry.value, label: entry.label }))}
                            />
                            <span className="text-xs text-muted-foreground">
                                The whole overworld is this one biome. The Nether and the End are unchanged.
                            </span>
                        </label>
                    )}

                    <label
                        className={cn(
                            "flex items-start gap-2 text-sm",
                            carriesPlayers ? "cursor-pointer" : "opacity-60"
                        )}
                    >
                        <Checkbox
                            checked={keepPlayers && carriesPlayers}
                            disabled={!carriesPlayers}
                            onChange={(event) => setKeepPlayers(event.target.checked)}
                            className="mt-0.5"
                        />
                        <span className="flex flex-col gap-0.5">
                            <span className="font-medium">Keep what players are carrying</span>
                            <span className="text-xs text-muted-foreground">
                                {carriesPlayers
                                    ? "Inventories, ender chests, stats and advancements come across. Everyone spawns fresh on the new map."
                                    : "Bedrock keeps player data inside the world itself, so a new map always starts everyone over."}
                            </span>
                        </span>
                    </label>

                    <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                        <span className="text-muted-foreground">
                            The server restarts to generate it, so anybody playing is disconnected. The map it is on now
                            is kept and you can switch back to it.
                        </span>
                    </p>

                    {error && <p className="text-sm text-danger">{error}</p>}

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button onClick={() => void submit()} disabled={pending}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Generate world
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/**
 * A server's world archives.
 *
 * Shown on the server's own screen and again on the Backups app, which is why it
 * takes its view from the caller: the Backups app loads one per server and would
 * otherwise measure every world twice.
 */
export function GameServerBackups({
    installedAppId,
    serverName,
    view,
    onChanged,
    heading
}: {
    installedAppId: string;
    serverName: string;
    view: WorldView | null;
    onChanged: () => Promise<void>;
    /** What the card is called. The Backups app names the server instead. */
    heading?: string;
}) {
    const format = useDisplayFormat();
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [restoring, setRestoring] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);

    async function backUp(): Promise<void> {
        setBusy("new");
        setError(null);
        setNote(null);
        const result = await backUpWorldAction(installedAppId);
        setBusy(null);
        if (result.error) setError(result.error);
        else {
            setNote("World backed up");
            await onChanged();
        }
    }

    async function restore(name: string): Promise<void> {
        setBusy(name);
        setError(null);
        setNote(null);
        const result = await restoreWorldBackupAction(installedAppId, name);
        setBusy(null);
        setRestoring(null);
        if (result.error) setError(result.error);
        else {
            setNote("Restored - the server is restarting onto it");
            await onChanged();
        }
    }

    async function remove(name: string): Promise<void> {
        setBusy(name);
        setError(null);
        const result = await deleteWorldBackupAction(installedAppId, name);
        setBusy(null);
        setDeleting(null);
        if (result.error) setError(result.error);
        else await onChanged();
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex min-w-0 items-center gap-2">
                        <Archive className="size-4 text-primary" />
                        <span className="truncate" title={heading ?? "Backups"}>
                            {heading ?? "Backups"}
                        </span>
                        {view && view.backups.length > 0 && (
                            <Badge variant="neutral">{view.backups.length}</Badge>
                        )}
                    </CardTitle>
                    <Button size="sm" onClick={() => void backUp()} disabled={busy !== null || view === null}>
                        <HardDriveDownload className={cn("size-4", busy === "new" && "animate-pulse")} />
                        {busy === "new" ? "Backing up..." : "Back up now"}
                    </Button>
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                    A copy of the world kept on the server&apos;s own disk, taken with saving paused so it is not caught
                    mid-write. That covers a mistake, not a dead disk - download the ones that matter.
                </p>

                {error && <p className="text-sm text-danger">{error}</p>}
                {note && <p className="text-xs text-muted-foreground">{note}</p>}

                {view === null ? (
                    <Skeleton className="h-16 w-full" />
                ) : view.backups.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                        No backups yet.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-1.5">
                        {view.backups.map((backup) => (
                            <li
                                key={backup.name}
                                className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2 text-sm"
                            >
                                <div className="min-w-0">
                                    <p className="truncate" title={format.dateTime(backup.createdAt)}>
                                        {format.dateTime(backup.createdAt)}
                                    </p>
                                    <p className="text-xs text-muted-foreground">{formatBytes(backup.sizeBytes)}</p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <Button size="icon" variant="ghost" asChild aria-label="Download this backup">
                                        <Link
                                            href={`/api/apps/installed/${installedAppId}/minecraft/world/${encodeURIComponent(backup.name)}`}
                                            title="Download this backup"
                                            download
                                        >
                                            <Download className="size-4" />
                                        </Link>
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label="Restore this backup"
                                        title="Restore this backup"
                                        disabled={busy !== null}
                                        onClick={() => setRestoring(backup.name)}
                                    >
                                        {busy === backup.name ? (
                                            <Loader2 className="size-4 animate-spin" />
                                        ) : (
                                            <RotateCcw className="size-4" />
                                        )}
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        aria-label="Delete this backup"
                                        title="Delete this backup"
                                        disabled={busy !== null}
                                        onClick={() => setDeleting(backup.name)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>

            {restoring && (
                <RestoreDialog
                    serverName={serverName}
                    pending={busy !== null}
                    onClose={() => setRestoring(null)}
                    onConfirm={() => void restore(restoring)}
                />
            )}

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting ?? ""}
                requireTyping={false}
                kind="backup"
                description="The archive goes; the world it was taken from is not touched."
                pending={busy !== null}
                onConfirm={() => deleting && void remove(deleting)}
            />
        </Card>
    );
}

/** Restoring is not a delete, so it does not borrow the delete dialog: nothing is
 *  destroyed by it, and saying so is what stops it reading as one. */
function RestoreDialog({
    serverName,
    pending,
    onClose,
    onConfirm
}: {
    serverName: string;
    pending: boolean;
    onClose: () => void;
    onConfirm: () => void;
}) {
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <RotateCcw className="size-4" /> Restore this backup
                    </DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-muted-foreground">
                        {serverName} restarts onto the world in this backup, so anybody playing is disconnected. The map
                        it is on now is kept as it is - if this was the wrong backup, switch back to it under World.
                    </p>
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button onClick={onConfirm} disabled={pending}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Restore
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
