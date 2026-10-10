"use client";

/**
 * A Minecraft server's Sounds tab: the sounds the operator uploaded, how they
 * reach the players, and what the server does with them.
 *
 * Files are converted to Ogg Vorbis in the browser (`sound-encode.ts`) and sent
 * to the upload route as they are; the server checks them again. Every change
 * that alters the pack is followed, server side, by telling a running server to
 * hand the new pack out, so the players on it get it in seconds.
 */

import { useGameText } from "../game-text";
import { formatBytes } from "@polaris/core";
import * as actions from "./sounds-actions";
import { hostUi } from "@polaris/app-host/client";
import type { SoundsView } from "./sounds-actions";
import { soundUrl, usePreview } from "./sounds-parts";
import { SoundSettingsEditor } from "./sounds-moments";
import { restartGameNowAction } from "./restart-actions";
import { SoundEditDialog, SoundPlayDialog } from "./sound-dialogs";
import { EncodeError, toGameSound } from "../../lib/minecraft/sound-encode";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { LiveSounds, SoundEntry } from "../../lib/minecraft/sounds-service";
import {
    Copy,
    MoreHorizontal,
    Pencil,
    Play,
    Radio,
    Replace,
    Square,
    Trash2,
    Upload,
    Volume2
} from "lucide-react";
import {
    ACCEPTED_FILES,
    MAX_LIBRARY_BYTES,
    MAX_SOUND_BYTES,
    MAX_SOUNDS,
    soundId
} from "../../lib/minecraft/sounds";
import {
    Badge,
    Button,
    Card,
    CardBody,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Skeleton,
    cn
} from "@polaris/ui";

const { useConfirm } = hostUi.confirmDialog;
const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;

/** How old the kept library may be and still paint first on a revisit. */
const KEPT_VIEW_MS = 24 * 3_600_000;
/** How often the live state of the pack is asked while the tab is open. */
const LIVE_EVERY_MS = 15_000;

type UploadAnswer = { sound?: SoundEntry; pushed?: boolean; error?: string };

/** The file's name as the sound's: no extension, at most the name's length. */
function nameFromFile(file: File): string {
    return file.name
        .replace(/\.[^.]+$/, "")
        .replace(/[_-]+/g, " ")
        .trim()
        .slice(0, 48);
}

async function send(url: string, method: "POST" | "PUT", bytes: Uint8Array): Promise<UploadAnswer> {
    const answer = await fetch(url, {
        method,
        body: new Blob([bytes as BlobPart], { type: "audio/ogg" }),
        headers: { "content-type": "audio/ogg" },
        credentials: "same-origin"
    });
    const body = (await answer.json().catch(() => ({}))) as UploadAnswer;
    if (!answer.ok) return { error: typeof body.error === "string" ? body.error : undefined };
    return body;
}

export function MinecraftSounds({
    installedAppId,
    canManage,
    canPlay,
    running,
    players,
    edition
}: {
    installedAppId: string;
    canManage: boolean;
    canPlay: boolean;
    running: boolean;
    players: readonly string[];
    edition: "java" | "bedrock";
}) {
    const t = useGameText("minecraft");
    const viewKey = `minecraft-sounds:${installedAppId}`;
    const [view, setView] = useState<SoundsView | null>(null);
    useKeptSnapshot<SoundsView>(viewKey, KEPT_VIEW_MS, (kept) =>
        setView((current) => current ?? kept.value)
    );
    const [heard, setHeard] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [live, setLive] = useState<LiveSounds | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [failures, setFailures] = useState<string[]>([]);
    const [editing, setEditing] = useState<SoundEntry | null>(null);
    const [playing, setPlaying] = useState<SoundEntry | null>(null);
    const [dragging, setDragging] = useState(false);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();
    const preview = usePreview();
    const fileInput = useRef<HTMLInputElement>(null);
    const replaceInput = useRef<HTMLInputElement>(null);
    const replacing = useRef<SoundEntry | null>(null);

    const reload = useCallback(async () => {
        const answer = await actions.soundsAction(installedAppId);
        if (answer.view) {
            setView(answer.view);
            setHeard(true);
            setLoadError(null);
            writeSnapshot(viewKey, answer.view);
        } else setLoadError(answer.error ?? t("sounds.refused.failed"));
    }, [installedAppId, viewKey]);

    const reloadLive = useCallback(async () => {
        const answer = await actions.liveSoundsAction(installedAppId);
        if (answer.live) setLive(answer.live);
    }, [installedAppId]);

    useEffect(() => {
        void reload();
    }, [reload]);

    const jar = view?.delivery.mode === "jar" && view.delivery.ready;
    useEffect(() => {
        if (!jar || !running) {
            setLive(null);
            return;
        }
        void reloadLive();
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") void reloadLive();
        }, LIVE_EVERY_MS);
        return () => window.clearInterval(timer);
    }, [jar, running, reloadLive]);

    function said(message: string): void {
        setError(null);
        setNote(message);
    }

    function failed(message: string): void {
        setNote(null);
        setError(message);
    }

    function encodeWords(reason: EncodeError["reason"]): string {
        switch (reason) {
            case "tooLarge":
                return t("sounds.encode.tooLarge");
            case "unreadable":
                return t("sounds.encode.unreadable");
            case "tooLong":
                return t("sounds.encode.tooLong");
            default:
                return t("sounds.encode.encoder");
        }
    }

    async function convert(file: File): Promise<Uint8Array | string> {
        try {
            return (await toGameSound(file)).bytes;
        } catch (caught) {
            return caught instanceof EncodeError
                ? encodeWords(caught.reason)
                : t("sounds.encode.encoder");
        }
    }

    async function upload(files: readonly File[]): Promise<void> {
        if (!canManage || busy || files.length === 0) return;
        setNote(null);
        setError(null);
        setFailures([]);
        const missed: string[] = [];
        let added = 0;
        let last = "";
        for (const file of files) {
            const name = nameFromFile(file);
            setBusy(t("sounds.library.converting", { name }));
            const bytes = await convert(file);
            if (typeof bytes === "string") {
                missed.push(t("sounds.library.failedFile", { name: file.name, reason: bytes }));
                continue;
            }
            setBusy(t("sounds.library.uploading", { name }));
            const answer = await send(
                `/api/apps/installed/${installedAppId}/minecraft/sounds?name=${encodeURIComponent(name)}`,
                "POST",
                bytes
            ).catch(() => ({ error: t("sounds.refused.failed") }) as UploadAnswer);
            if (answer.sound) {
                added += 1;
                last = answer.sound.name;
            } else
                missed.push(
                    t("sounds.library.failedFile", {
                        name: file.name,
                        reason: answer.error ?? t("sounds.refused.failed")
                    })
                );
        }
        setBusy(null);
        setFailures(missed);
        if (added > 0) {
            said(
                added === 1
                    ? t("sounds.library.added", { name: last })
                    : t("sounds.library.addedMany", { count: added })
            );
            await reload();
        }
    }

    async function replaceFile(entry: SoundEntry, file: File): Promise<void> {
        if (busy) return;
        setNote(null);
        setError(null);
        setFailures([]);
        setBusy(t("sounds.library.converting", { name: entry.name }));
        const bytes = await convert(file);
        if (typeof bytes === "string") {
            setBusy(null);
            failed(t("sounds.library.failedFile", { name: file.name, reason: bytes }));
            return;
        }
        setBusy(t("sounds.library.uploading", { name: entry.name }));
        const answer = await send(
            `/api/apps/installed/${installedAppId}/minecraft/sounds/${entry.id}`,
            "PUT",
            bytes
        ).catch(() => ({ error: t("sounds.refused.failed") }) as UploadAnswer);
        setBusy(null);
        if (answer.error || !answer.sound) {
            failed(answer.error ?? t("sounds.refused.failed"));
            return;
        }
        said(t("sounds.library.replaced", { name: entry.name }));
        await reload();
    }

    async function remove(entry: SoundEntry): Promise<void> {
        // Asked before the transition: a dialog opened inside one is never drawn.
        const sure = await confirm({
            title: t("sounds.library.deleteTitle", { name: entry.name }),
            description: t("sounds.library.deleteBody"),
            confirmLabel: t("sounds.library.delete"),
            danger: true
        });
        if (!sure) return;
        if (preview.playing === entry.id) preview.stop();
        // Gone from the list at once; back if the server says no.
        const before = view;
        setView((current) =>
            current
                ? {
                      ...current,
                      library: {
                          ...current.library,
                          sounds: current.library.sounds.filter((one) => one.id !== entry.id),
                          totalBytes: current.library.totalBytes - entry.size
                      }
                  }
                : current
        );
        startTransition(async () => {
            const result = await actions.deleteSoundAction({ installedAppId, soundId: entry.id });
            if (result.error) {
                setView(before);
                failed(result.error);
                return;
            }
            said(t("sounds.library.deleted", { name: entry.name }));
            await reload();
        });
    }

    async function setUp(): Promise<void> {
        const sure = await confirm({
            title: t("sounds.delivery.setUpTitle"),
            description: t("sounds.delivery.setUpBody"),
            confirmLabel: t("sounds.delivery.setUp")
        });
        if (!sure) return;
        startTransition(async () => {
            const result = await actions.enableSoundsAction(installedAppId);
            if (result.error) return failed(result.error);
            said(
                result.restarted ? t("sounds.delivery.setUpDone") : t("sounds.delivery.setUpReady")
            );
            await reload();
        });
    }

    async function restart(): Promise<void> {
        const sure = await confirm({
            title: t("sounds.delivery.restartTitle"),
            description: t("sounds.delivery.restartBody"),
            confirmLabel: t("sounds.delivery.restart")
        });
        if (!sure) return;
        startTransition(async () => {
            const result = await restartGameNowAction(installedAppId);
            if (result.error) return failed(result.error);
            said(t("sounds.delivery.restarting"));
        });
    }

    async function serverPack(on: boolean): Promise<void> {
        const sure = await confirm({
            title: on ? t("sounds.delivery.offerTitle") : t("sounds.delivery.stopTitle"),
            description: t("sounds.delivery.offerBody"),
            confirmLabel: on ? t("sounds.delivery.offer") : t("sounds.delivery.stopOffering")
        });
        if (!sure) return;
        startTransition(async () => {
            const result = await actions.serverPackAction({ installedAppId, on });
            if (result.error) return failed(result.error);
            said(on ? t("sounds.delivery.serverPackOn") : t("sounds.delivery.restarting"));
            await reload();
        });
    }

    function sendAgain(): void {
        startTransition(async () => {
            const result = await actions.pushSoundsAction(installedAppId);
            if (result.error) return failed(result.error);
            said(result.pushed ? t("sounds.pushed") : t("sounds.delivery.notPushed"));
            await reloadLive();
        });
    }

    async function copyId(entry: SoundEntry): Promise<void> {
        try {
            await navigator.clipboard.writeText(soundId(entry.key));
            said(t("sounds.library.copied", { id: soundId(entry.key) }));
        } catch {
            failed(t("sounds.library.copyFailed"));
        }
    }

    if (edition === "bedrock")
        return (
            <Card>
                <CardBody className="py-10 text-center text-sm text-muted-foreground">
                    {t("sounds.delivery.bedrock")}
                </CardBody>
            </Card>
        );

    const sounds = view?.library.sounds ?? [];
    const delivery = view?.delivery ?? null;
    const working = pending || busy !== null;
    const online = live?.players.length ?? 0;
    const loaded = live?.players.filter((one) => one.state === "loaded").length ?? 0;
    const declined =
        live?.players.filter((one) => one.state === "declined" || one.state === "failed").length ??
        0;

    return (
        <div className="flex flex-col gap-4">
            <div>
                <h2 className="text-base font-semibold">{t("sounds.title")}</h2>
                <p className="text-sm text-muted-foreground">{t("sounds.about")}</p>
            </div>

            {loadError && !view ? (
                <p role="alert" className="text-sm text-danger">
                    {loadError}
                </p>
            ) : null}

            {/* How the sounds reach the players. */}
            <Card>
                <CardBody className="flex flex-col gap-2">
                    {!delivery ? (
                        <>
                            <Skeleton className="h-4 w-48" />
                            <Skeleton className="h-3 w-full max-w-md" />
                        </>
                    ) : delivery.mode === "jar" && delivery.ready ? (
                        <>
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0 flex-1 basis-60">
                                    <p className="flex items-center gap-2 text-sm font-medium">
                                        <Radio className="size-4 shrink-0" />{" "}
                                        {t("sounds.delivery.liveTitle")}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {t("sounds.delivery.liveBody")}
                                    </p>
                                </div>
                                {canManage && running && live?.loaded ? (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={working}
                                        onClick={sendAgain}
                                    >
                                        {t("sounds.delivery.sendAgain")}
                                    </Button>
                                ) : null}
                            </div>
                            {!running ? (
                                <p className="text-xs text-muted-foreground">
                                    {t("sounds.delivery.stopped")}
                                </p>
                            ) : live && !live.loaded ? (
                                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2">
                                    <div className="min-w-0 flex-1 basis-60">
                                        <p className="text-sm">{t("sounds.delivery.oldTitle")}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {t("sounds.delivery.oldBody")}
                                        </p>
                                    </div>
                                    {canManage ? (
                                        <Button
                                            type="button"
                                            size="sm"
                                            disabled={working}
                                            onClick={() => void restart()}
                                        >
                                            {t("sounds.delivery.restart")}
                                        </Button>
                                    ) : null}
                                </div>
                            ) : live ? (
                                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                                    <p>
                                        {online === 0
                                            ? t("sounds.delivery.nobodyOnline")
                                            : t("sounds.delivery.loadedCount", { loaded, online })}
                                    </p>
                                    {declined > 0 ? (
                                        <p>
                                            {t("sounds.delivery.declinedCount", {
                                                count: declined
                                            })}
                                        </p>
                                    ) : null}
                                    {online > 0 ? (
                                        <ul className="flex flex-wrap gap-1">
                                            {live.players.map((one) => (
                                                <li key={one.name}>
                                                    <Badge
                                                        variant={
                                                            one.state === "loaded"
                                                                ? "success"
                                                                : one.state === "pending"
                                                                  ? "neutral"
                                                                  : "danger"
                                                        }
                                                        className="max-w-40 truncate"
                                                        title={`${one.name}: ${stateWords(one.state)}`}
                                                    >
                                                        {one.name} - {stateWords(one.state)}
                                                    </Badge>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : null}
                                </div>
                            ) : (
                                <Skeleton className="h-3 w-56" />
                            )}
                        </>
                    ) : delivery.mode === "jar" ? (
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1 basis-60">
                                <p className="text-sm font-medium">
                                    {t("sounds.delivery.setupTitle")}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {delivery.kind === "mod"
                                        ? t("sounds.delivery.setupMod")
                                        : t("sounds.delivery.setupPlugin")}
                                </p>
                            </div>
                            {canManage ? (
                                <Button
                                    type="button"
                                    size="sm"
                                    disabled={working || !delivery.reachable}
                                    onClick={() => void setUp()}
                                >
                                    {t("sounds.delivery.setUp")}
                                </Button>
                            ) : null}
                        </div>
                    ) : (
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1 basis-60">
                                <p className="text-sm font-medium">
                                    {t("sounds.delivery.serverPackTitle")}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {delivery.serverPackOn
                                        ? t("sounds.delivery.serverPackOn")
                                        : delivery.serverPackFree
                                          ? t("sounds.delivery.serverPackBody")
                                          : t("sounds.delivery.serverPackTaken")}
                                </p>
                            </div>
                            {canManage && delivery.serverPackOn ? (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={working}
                                    onClick={() => void serverPack(false)}
                                >
                                    {t("sounds.delivery.stopOffering")}
                                </Button>
                            ) : canManage && delivery.serverPackFree ? (
                                <Button
                                    type="button"
                                    size="sm"
                                    disabled={working || sounds.length === 0}
                                    title={
                                        sounds.length === 0
                                            ? t("sounds.delivery.needsSounds")
                                            : undefined
                                    }
                                    onClick={() => void serverPack(true)}
                                >
                                    {t("sounds.delivery.offer")}
                                </Button>
                            ) : null}
                        </div>
                    )}
                    {delivery && !delivery.reachable ? (
                        <p className="text-xs text-warning">{t("sounds.delivery.notPublic")}</p>
                    ) : null}
                </CardBody>
            </Card>

            {/* The library. */}
            <Card>
                <CardBody
                    className={cn("flex flex-col gap-3", dragging && "ring-2 ring-primary")}
                    onDragOver={(event) => {
                        if (!canManage || !event.dataTransfer.types.includes("Files")) return;
                        event.preventDefault();
                        setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                        if (!canManage) return;
                        event.preventDefault();
                        setDragging(false);
                        void upload([...event.dataTransfer.files]);
                    }}
                >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 basis-60">
                            <p className="text-sm font-medium">{t("sounds.library.title")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("sounds.library.hint", { size: formatBytes(MAX_SOUND_BYTES) })}
                            </p>
                            {view ? (
                                <p className="text-xs text-muted-foreground">
                                    {t("sounds.library.used", {
                                        used: formatBytes(view.library.totalBytes),
                                        limit: formatBytes(MAX_LIBRARY_BYTES)
                                    })}{" "}
                                    -{" "}
                                    {t("sounds.library.count", {
                                        count: sounds.length,
                                        limit: MAX_SOUNDS
                                    })}
                                </p>
                            ) : null}
                        </div>
                        {canManage ? (
                            <Button
                                type="button"
                                size="sm"
                                disabled={working || !heard || sounds.length >= MAX_SOUNDS}
                                onClick={() => fileInput.current?.click()}
                            >
                                <Upload className="size-4" /> {t("sounds.library.upload")}
                            </Button>
                        ) : null}
                        <input
                            ref={fileInput}
                            type="file"
                            multiple
                            accept={ACCEPTED_FILES}
                            className="hidden"
                            onChange={(event) => {
                                const files = [...(event.target.files ?? [])];
                                event.target.value = "";
                                void upload(files);
                            }}
                        />
                        <input
                            ref={replaceInput}
                            type="file"
                            accept={ACCEPTED_FILES}
                            className="hidden"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                event.target.value = "";
                                const entry = replacing.current;
                                replacing.current = null;
                                if (file && entry) void replaceFile(entry, file);
                            }}
                        />
                    </div>

                    {busy ? <p className="text-xs text-muted-foreground">{busy}</p> : null}
                    {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                    {failures.length > 0 ? (
                        <ul role="alert" className="flex flex-col gap-0.5 text-xs text-danger">
                            {failures.map((line, at) => (
                                <li key={at} className="break-words">
                                    {line}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {preview.unplayable ? (
                        <p className="text-xs text-muted-foreground">
                            {t("sounds.library.cannotPlay")}
                        </p>
                    ) : null}

                    {!view ? (
                        <div className="flex flex-col gap-2">
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                        </div>
                    ) : sounds.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                            {canManage ? t("sounds.library.drop") : t("sounds.library.empty")}
                        </div>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {sounds.map((entry) => {
                                const listening = preview.playing === entry.id;
                                return (
                                    <li key={entry.id} className="flex items-center gap-2 py-2">
                                        <Button
                                            type="button"
                                            size="icon"
                                            variant="ghost"
                                            onClick={() =>
                                                listening
                                                    ? preview.stop()
                                                    : preview.play(
                                                          entry.id,
                                                          soundUrl(
                                                              installedAppId,
                                                              entry.id,
                                                              entry.updatedAt
                                                          )
                                                      )
                                            }
                                            aria-label={
                                                listening
                                                    ? t("sounds.library.stop")
                                                    : t("sounds.library.listen")
                                            }
                                            title={
                                                listening
                                                    ? t("sounds.library.stop")
                                                    : t("sounds.library.listen")
                                            }
                                        >
                                            {listening ? (
                                                <Square className="size-4" />
                                            ) : (
                                                <Play className="size-4" />
                                            )}
                                        </Button>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm" title={entry.name}>
                                                {entry.name}
                                            </p>
                                            <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                                                <code
                                                    className="truncate"
                                                    title={soundId(entry.key)}
                                                >
                                                    {soundId(entry.key)}
                                                </code>
                                                <span>
                                                    {t("sounds.library.seconds", {
                                                        seconds: entry.seconds.toFixed(1)
                                                    })}
                                                </span>
                                                <span>{formatBytes(entry.size)}</span>
                                                {entry.stream ? (
                                                    <Badge>{t("sounds.library.streamed")}</Badge>
                                                ) : null}
                                                {entry.replaces ? (
                                                    <Badge
                                                        className="max-w-56 truncate"
                                                        title={entry.replaces}
                                                    >
                                                        {t("sounds.library.replacesBadge", {
                                                            id: entry.replaces
                                                        })}
                                                    </Badge>
                                                ) : null}
                                            </p>
                                        </div>
                                        {canPlay && running ? (
                                            <Button
                                                type="button"
                                                size="icon"
                                                variant="ghost"
                                                onClick={() => setPlaying(entry)}
                                                aria-label={t("sounds.library.playInGame")}
                                                title={t("sounds.library.playInGame")}
                                            >
                                                <Volume2 className="size-4" />
                                            </Button>
                                        ) : null}
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    type="button"
                                                    size="icon"
                                                    variant="ghost"
                                                    aria-label={t("sounds.library.more")}
                                                    title={t("sounds.library.more")}
                                                >
                                                    <MoreHorizontal className="size-4" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuItem
                                                    onSelect={() => void copyId(entry)}
                                                >
                                                    <Copy className="size-4" />{" "}
                                                    {t("sounds.library.copyId")}
                                                </DropdownMenuItem>
                                                {canManage ? (
                                                    <>
                                                        <DropdownMenuItem
                                                            disabled={working}
                                                            onSelect={() => setEditing(entry)}
                                                        >
                                                            <Pencil className="size-4" />{" "}
                                                            {t("sounds.library.edit")}
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem
                                                            disabled={working}
                                                            onSelect={() => {
                                                                replacing.current = entry;
                                                                replaceInput.current?.click();
                                                            }}
                                                        >
                                                            <Replace className="size-4" />{" "}
                                                            {t("sounds.library.replace")}
                                                        </DropdownMenuItem>
                                                        <DropdownMenuSeparator />
                                                        <DropdownMenuItem
                                                            disabled={working}
                                                            className="text-danger"
                                                            onSelect={() => void remove(entry)}
                                                        >
                                                            <Trash2 className="size-4" />{" "}
                                                            {t("sounds.library.delete")}
                                                        </DropdownMenuItem>
                                                    </>
                                                ) : null}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </CardBody>
            </Card>

            {view ? (
                <SoundSettingsEditor
                    installedAppId={installedAppId}
                    sounds={sounds}
                    settings={view.library.settings}
                    canManage={canManage}
                    jar={jar}
                    preview={preview}
                    onSaved={(settings) => {
                        setView((current) =>
                            current
                                ? { ...current, library: { ...current.library, settings } }
                                : current
                        );
                        void reload();
                    }}
                />
            ) : null}

            <SoundEditDialog
                installedAppId={installedAppId}
                sound={editing}
                onClose={() => setEditing(null)}
                onSaved={(message) => {
                    setEditing(null);
                    said(message);
                    void reload();
                }}
            />
            <SoundPlayDialog
                installedAppId={installedAppId}
                sound={playing}
                players={players}
                onClose={() => setPlaying(null)}
            />
            {confirmElement}
        </div>
    );

    function stateWords(state: LiveSounds["players"][number]["state"]): string {
        switch (state) {
            case "loaded":
                return t("sounds.delivery.stateLoaded");
            case "pending":
                return t("sounds.delivery.statePending");
            case "declined":
                return t("sounds.delivery.stateDeclined");
            default:
                return t("sounds.delivery.stateFailed");
        }
    }
}
