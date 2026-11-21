"use client";

/**
 * A server pack or a world, brought from anywhere: a file dropped or chosen, or
 * a link to one (`lib/minecraft/archives/store.ts`).
 *
 * The file goes up in pieces, each one acknowledged with how much has arrived,
 * so a dropped connection or a proxy's request limit costs one piece rather
 * than the whole send. What arrives is read by the dashboard and summed up here
 * - the loader and release a pack is for, how many mods, what was left out -
 * before anything is done with it; the form that holds this decides what that
 * is.
 */

import { formatBytes } from "@polaris/core";
import type { GameKey } from "../../messages";
import { Button, Input, cn } from "@polaris/ui";
import { useGameText } from "../screens/game-text";
import type { ArchiveInfo } from "../lib/minecraft/archives/store";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { FileArchive, Link2, Loader2, Upload, X } from "lucide-react";
import type { ArchiveFailure, ArchiveJobView } from "../lib/minecraft/archives/store";

const BASE = "/api/apps/games/archives";
const PIECE_ATTEMPTS = 4;
const POLL_MS = 1000;

/** What each refusal says, by its code. */
const FAILURE_TEXT: Record<ArchiveFailure, GameKey<"games">> = {
    tooLarge: "archive.failures.tooLarge",
    noSpace: "archive.failures.noSpace",
    unreachable: "archive.failures.unreachable",
    notFound: "archive.failures.notFound",
    notZip: "archive.failures.notZip",
    encrypted: "archive.failures.encrypted",
    method: "archive.failures.method",
    tooMany: "archive.failures.tooMany",
    unsafePath: "archive.failures.unsafePath",
    empty: "archive.failures.empty",
    noContent: "archive.failures.noContent",
    isWorld: "archive.failures.isWorld",
    isPack: "archive.failures.isPack",
    ambiguous: "archive.failures.ambiguous",
    busy: "archive.failures.busy",
    failed: "archive.failures.failed"
};

function failureOf(value: unknown): ArchiveFailure {
    return typeof value === "string" && value in FAILURE_TEXT ? (value as ArchiveFailure) : "failed";
}

const LOADER_NAMES: Record<string, string> = {
    FORGE: "Forge",
    NEOFORGE: "NeoForge",
    FABRIC: "Fabric",
    QUILT: "Quilt"
};

type Progress =
    | { readonly state: "idle" }
    | { readonly state: "sending"; readonly done: number; readonly total: number }
    | { readonly state: "downloading"; readonly done: number; readonly total: number | null }
    | { readonly state: "processing" }
    | { readonly state: "failed"; readonly reason: ArchiveFailure };

async function json(response: Response): Promise<Record<string, unknown>> {
    return ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function ArchiveIntake({
    kind,
    value,
    onChange,
    disabled = false
}: {
    kind: "pack" | "world";
    /** The archive this form holds, or null before one is brought. */
    value: ArchiveInfo | null;
    onChange: (archive: ArchiveInfo | null) => void;
    disabled?: boolean;
}) {
    const t = useGameText("games");
    const [progress, setProgress] = useState<Progress>({ state: "idle" });
    const [link, setLink] = useState("");
    const [dragging, setDragging] = useState(false);
    const job = useRef<{ id: string; stopped: boolean } | null>(null);
    const input = useRef<HTMLInputElement>(null);

    // A form closed half-way through stops sending and throws away what arrived.
    useEffect(
        () => () => {
            const current = job.current;
            if (current && !current.stopped) {
                current.stopped = true;
                void fetch(`${BASE}/${current.id}`, { method: "DELETE" }).catch(() => undefined);
            }
        },
        []
    );

    const busy =
        progress.state === "sending" ||
        progress.state === "downloading" ||
        progress.state === "processing";

    async function follow(id: string): Promise<void> {
        for (;;) {
            if (job.current?.id !== id || job.current.stopped) return;
            const response = await fetch(`${BASE}/${id}`, { cache: "no-store" }).catch(() => null);
            const answer = response?.ok ? ((await json(response)) as unknown as ArchiveJobView) : null;
            if (!answer) {
                setProgress({ state: "failed", reason: response?.status === 404 ? "notFound" : "failed" });
                return;
            }
            if (answer.state === "ready") {
                job.current = null;
                setProgress({ state: "idle" });
                onChange(answer.archive);
                return;
            }
            if (answer.state === "failed") {
                job.current = null;
                setProgress({ state: "failed", reason: failureOf(answer.reason) });
                return;
            }
            if (answer.state === "downloading")
                setProgress({ state: "downloading", done: answer.received, total: answer.total });
            else if (answer.state === "processing") setProgress({ state: "processing" });
            await wait(POLL_MS);
        }
    }

    async function begin(body: Record<string, unknown>): Promise<{ id: string; chunk: number } | null> {
        const response = await fetch(BASE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        }).catch(() => null);
        const answer = response ? await json(response) : {};
        if (!response?.ok || typeof answer.id !== "string") {
            setProgress({ state: "failed", reason: failureOf(answer.error) });
            return null;
        }
        return {
            id: answer.id,
            chunk: typeof answer.chunkBytes === "number" ? answer.chunkBytes : 8 * 1024 * 1024
        };
    }

    async function send(file: File): Promise<void> {
        if (disabled || busy) return;
        onChange(null);
        setProgress({ state: "sending", done: 0, total: file.size });
        const started = await begin({ from: "file", kind, name: file.name, size: file.size });
        if (!started) return;
        job.current = { id: started.id, stopped: false };
        let offset = 0;
        while (offset < file.size) {
            if (job.current?.stopped) return;
            const piece = file.slice(offset, Math.min(file.size, offset + started.chunk));
            let received: number | null = null;
            for (let attempt = 0; attempt < PIECE_ATTEMPTS && received === null; attempt += 1) {
                const response = await fetch(`${BASE}/${started.id}?offset=${offset}`, {
                    method: "PUT",
                    headers: { "content-type": "application/octet-stream" },
                    body: piece
                }).catch(() => null);
                if (response?.ok) {
                    const answer = await json(response);
                    if (typeof answer.received === "number") received = answer.received;
                } else if (response && response.status < 500) {
                    setProgress({ state: "failed", reason: failureOf((await json(response)).error) });
                    return;
                } else {
                    await wait(1000 * (attempt + 1));
                }
            }
            if (received === null) {
                setProgress({ state: "failed", reason: "unreachable" });
                return;
            }
            // What arrived, which is where the next piece starts - the same
            // offset again if this one was already there.
            offset = received;
            setProgress({ state: "sending", done: offset, total: file.size });
        }
        const finished = await fetch(`${BASE}/${started.id}`, { method: "POST" }).catch(() => null);
        if (!finished?.ok) {
            setProgress({ state: "failed", reason: failureOf((finished ? await json(finished) : {}).error) });
            return;
        }
        setProgress({ state: "processing" });
        await follow(started.id);
    }

    async function download(): Promise<void> {
        const url = link.trim();
        if (disabled || busy || url.length === 0) return;
        onChange(null);
        setProgress({ state: "downloading", done: 0, total: null });
        const started = await begin({ from: "link", kind, url });
        if (!started) return;
        job.current = { id: started.id, stopped: false };
        await follow(started.id);
    }

    function stop(): void {
        const current = job.current;
        job.current = null;
        setProgress({ state: "idle" });
        if (current) {
            current.stopped = true;
            void fetch(`${BASE}/${current.id}`, { method: "DELETE" }).catch(() => undefined);
        }
    }

    function dropped(event: DragEvent<HTMLDivElement>): void {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) void send(file);
    }

    const linkValid = /^https:\/\/\S+$/i.test(link.trim());

    if (value) return <ArchiveSummary archive={value} onRemove={disabled ? null : () => onChange(null)} />;

    return (
        <div className="flex flex-col gap-2">
            <div
                onDragOver={(event) => {
                    event.preventDefault();
                    if (!busy && !disabled) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={dropped}
                className={cn(
                    "flex flex-col items-center gap-2 rounded-md border border-dashed p-4 text-center transition-colors",
                    dragging ? "border-primary bg-primary/5" : "border-border"
                )}
            >
                <input
                    ref={input}
                    type="file"
                    accept=".zip,application/zip,application/x-zip-compressed"
                    className="hidden"
                    onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void send(file);
                    }}
                />
                {busy ? (
                    <div className="flex w-full min-w-0 flex-col gap-2">
                        <div className="flex min-w-0 items-center gap-2 text-sm">
                            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                            <span className="min-w-0 truncate">
                                {progress.state === "sending"
                                    ? t("archive.sending", {
                                          done: formatBytes(progress.done),
                                          total: formatBytes(progress.total)
                                      })
                                    : progress.state === "downloading"
                                      ? progress.total
                                          ? t("archive.downloadingOf", {
                                                done: formatBytes(progress.done),
                                                total: formatBytes(progress.total)
                                            })
                                          : t("archive.downloading", { done: formatBytes(progress.done) })
                                      : t("archive.processing")}
                            </span>
                            <Button size="sm" variant="ghost" className="ms-auto" onClick={stop}>
                                {t("archive.cancel")}
                            </Button>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                                className={cn(
                                    "h-full bg-primary transition-[width]",
                                    progress.state === "processing" && "w-full animate-pulse"
                                )}
                                style={
                                    progress.state === "sending"
                                        ? { width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }
                                        : progress.state === "downloading" && progress.total
                                          ? { width: `${(progress.done / progress.total) * 100}%` }
                                          : undefined
                                }
                            />
                        </div>
                    </div>
                ) : (
                    <>
                        <Upload className="size-5 shrink-0 text-muted-foreground" />
                        <p className="text-sm">{t("archive.dropOrChoose")}</p>
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={disabled}
                            onClick={() => input.current?.click()}
                        >
                            {t("archive.chooseFile")}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            {t(kind === "pack" ? "archive.packHint" : "archive.worldHint")}
                        </p>
                    </>
                )}
            </div>

            {!busy && (
                <div className="flex min-w-0 items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                        <Link2 className="pointer-events-none absolute start-2 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={link}
                            onChange={(event) => setLink(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && linkValid) {
                                    event.preventDefault();
                                    void download();
                                }
                            }}
                            placeholder={t("archive.linkPlaceholder")}
                            aria-label={t("archive.orLink")}
                            className="ps-8"
                            disabled={disabled}
                            spellCheck={false}
                        />
                    </div>
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={disabled || !linkValid}
                        onClick={() => void download()}
                    >
                        {t("archive.download")}
                    </Button>
                </div>
            )}

            {progress.state === "failed" && (
                <p className="text-xs text-danger">
                    {t(FAILURE_TEXT[progress.reason])}
                </p>
            )}
        </div>
    );
}

/** What an archive that arrived turned out to be. */
export function ArchiveSummary({
    archive,
    onRemove
}: {
    archive: ArchiveInfo;
    onRemove: (() => void) | null;
}) {
    const t = useGameText("games");
    const loader = archive.loader;
    const facts: string[] = [formatBytes(archive.bytes)];
    if (archive.kind === "pack") {
        if (loader) {
            facts.push(
                [LOADER_NAMES[loader.type] ?? loader.type, loader.version].filter(Boolean).join(" ")
            );
            if (loader.minecraft) facts.push(t("archive.minecraft", { version: loader.minecraft }));
        }
        if (archive.mods > 0) facts.push(t("archive.mods", { count: archive.mods }));
        if (archive.plugins > 0) facts.push(t("archive.plugins", { count: archive.plugins }));
    } else if (archive.datapacks > 0) {
        facts.push(t("archive.datapacks", { count: archive.datapacks }));
    }
    return (
        <div className="flex flex-col gap-1 rounded-md border border-border p-3">
            <div className="flex min-w-0 items-center gap-2">
                <FileArchive className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 truncate text-sm font-medium" title={archive.name}>
                    {archive.name}
                </span>
                {onRemove && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="ms-auto"
                        onClick={onRemove}
                        aria-label={t("archive.remove")}
                    >
                        <X className="size-4 shrink-0" />
                    </Button>
                )}
            </div>
            <p className="text-xs text-muted-foreground">{facts.join(" - ")}</p>
            {archive.kind === "pack" && !loader && (
                <p className="text-xs text-warning">{t("archive.loaderUnknown")}</p>
            )}
            {archive.dropped.length > 0 && (
                <p className="text-xs text-muted-foreground/80">
                    {t("archive.leftOut", { names: archive.dropped.join(", ") })}
                </p>
            )}
        </div>
    );
}
