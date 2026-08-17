"use client";

/**
 * The footage the house kept.
 *
 * A list of segments, newest first, each one playable where it sits. Pinning is
 * the important control and is why this screen exists at all: retention drops
 * everything eventually, and the clip somebody actually needs is the one they
 * have to be able to hold on to before it goes.
 *
 * It behaves like a file list because that is what it is. A night of motion is
 * forty rows and the person looking at them wants to keep six and throw the rest
 * away, which one row at a time is not a feature - it is a chore. So: click,
 * ctrl+click, shift+click, Ctrl+A, right-click, Delete. Nothing here is taught,
 * and the same three gestures work in Drive.
 *
 * A clip has no name, so there is no rename and no F2: it is a camera and a
 * moment, and both are already written on the row.
 */

import * as actions from "../actions";
import { runAction } from "@/lib/run-action";
import { useEffect, useRef, useState } from "react";
import type { ClipView } from "@/lib/home/recording";
import type { CameraView } from "@/lib/home/cameras";
import { afterClick, afterMove } from "@/lib/list-selection";
import { MediaPlayer } from "@/components/media-player";
import { useDisplayFormat } from "@/components/display-format";
import { Download, Loader2, Pin, PinOff, Play, Square, Trash2, Video, X } from "lucide-react";
import {
    cn,
    Badge,
    Button,
    Skeleton,
    EmptyState,
    ContextMenu,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuContent,
    ContextMenuTrigger,
    ContextMenuSeparator,
    ConfirmDeleteDialog,
    Select
} from "@polaris/ui";

const REASON_LABEL: Record<string, string> = {
    motion: "Something happened",
    continuous: "Recorded all day",
    manual: "Recorded by hand"
};

/** Bytes as somebody reads them. Kept here rather than pulled from a formatter,
 *  because this is the only screen that says it. */
function size(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function duration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Save a clip to the machine the browser is on. Same origin, so the name given
 *  here is the name the file lands under. */
function download(clip: ClipView, when: string) {
    const anchor = document.createElement("a");
    anchor.href = `/api/home/clips/${clip.id}/video`;
    anchor.download = `${clip.cameraName} ${when}.mp4`.replace(/[\\/:*?"<>|]/g, "-");
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

export function ClipsView({ canManage }: { canManage: boolean }) {
    const format = useDisplayFormat();
    const [clips, setClips] = useState<ClipView[] | null>(null);
    const [cameras, setCameras] = useState<CameraView[]>([]);
    const [cameraId, setCameraId] = useState("");
    const [playing, setPlaying] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [removing, setRemoving] = useState<ClipView[] | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The row a shift extends from, and the one the arrows are on. Refs rather
    // than state: neither changes what is drawn on its own.
    const anchor = useRef<number | null>(null);
    const cursor = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const list = await actions.listCamerasAction();
            if (!cancelled) setCameras(list.cameras ?? []);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        setClips(null);
        setDone(false);
        setSelected(new Set());
        anchor.current = null;
        cursor.current = null;
        void (async () => {
            const result = await actions.listClipsAction({ cameraId: cameraId || null });
            if (cancelled) return;
            if (result.error) setError(result.error);
            setClips(result.clips ?? []);
        })();
        return () => {
            cancelled = true;
        };
    }, [cameraId]);

    const rows = clips ?? [];
    const keys = rows.map((clip) => clip.id);
    const chosen = rows.filter((clip) => selected.has(clip.id));

    const loadMore = async () => {
        if (!rows.length) return;
        setLoadingMore(true);
        const result = await runAction(
            () =>
                actions.listClipsAction({
                    cameraId: cameraId || null,
                    before: rows[rows.length - 1]?.startedAt ?? null
                }),
            setError
        );
        setLoadingMore(false);
        if (!result?.clips) return;
        if (result.clips.length === 0) setDone(true);
        setClips((current) => [...(current ?? []), ...(result.clips ?? [])]);
    };

    /** Keep, or stop keeping, every clip given. Applied on screen first and put
     *  back one by one if the server disagrees. */
    const keep = async (targets: ClipView[], next: boolean) => {
        const ids = new Set(targets.filter((clip) => clip.pinned !== next).map((clip) => clip.id));
        if (ids.size === 0) return;
        setClips((current) => (current ?? []).map((item) => (ids.has(item.id) ? { ...item, pinned: next } : item)));
        const failed: string[] = [];
        for (const id of ids) {
            const result = await runAction(() => actions.pinClipAction(id, next), setError);
            if (!result || result.error) failed.push(id);
        }
        if (failed.length === 0) return;
        const back = new Set(failed);
        setClips((current) => (current ?? []).map((item) => (back.has(item.id) ? { ...item, pinned: !next } : item)));
    };

    /** Delete every clip given, and drop the ones that went. A failure leaves its
     *  row where it was rather than pretending the file is gone. */
    const remove = async (targets: ClipView[]) => {
        setRemoving(null);
        const gone: string[] = [];
        for (const clip of targets) {
            const result = await runAction(() => actions.deleteClipAction(clip.id), setError);
            if (result && !result.error) gone.push(clip.id);
        }
        if (gone.length === 0) return;
        const dropped = new Set(gone);
        setClips((current) => (current ?? []).filter((item) => !dropped.has(item.id)));
        setSelected((current) => new Set([...current].filter((id) => !dropped.has(id))));
        if (playing && dropped.has(playing)) setPlaying(null);
    };

    const clickRow = (event: React.MouseEvent, index: number) => {
        const next = afterClick(selected, keys, index, anchor.current, event);
        setSelected(next.selected);
        anchor.current = next.anchor;
        cursor.current = index;
    };

    /** What a menu acts on: the whole selection when the row is part of it, and
     *  that row alone when it is not - which is also what right-clicking it
     *  selects, so the menu never acts on something off screen. */
    const targetsFor = (clip: ClipView, index: number): ClipView[] => {
        if (selected.has(clip.id)) return chosen;
        setSelected(new Set([clip.id]));
        anchor.current = index;
        cursor.current = index;
        return [clip];
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        const mod = event.ctrlKey || event.metaKey;
        if (mod && event.key.toLowerCase() === "a") {
            event.preventDefault();
            setSelected(new Set(keys));
            return;
        }
        if (event.key === "Escape" && selected.size > 0) {
            event.preventDefault();
            setSelected(new Set());
            cursor.current = null;
            return;
        }
        if (event.key === "Delete" && canManage && chosen.length > 0) {
            event.preventDefault();
            setRemoving(chosen);
            return;
        }
        if (event.key === "Enter" && chosen.length === 1 && chosen[0]) {
            event.preventDefault();
            const only = chosen[0];
            setPlaying((current) => (current === only.id ? null : only.id));
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const delta =
                event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowUp"
                      ? -1
                      : event.key === "End"
                        ? rows.length
                        : -rows.length;
            const next = afterMove(selected, keys, cursor.current, anchor.current, delta, event.shiftKey);
            setSelected(next.selected);
            anchor.current = next.anchor;
            cursor.current = next.cursor;
        }
    };

    if (clips === null) return <Skeleton className="h-64 w-full" />;

    const allKept = chosen.length > 0 && chosen.every((clip) => clip.pinned);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    value={cameraId}
                    onValueChange={setCameraId}
                    className="w-52"
                    aria-label="Camera"
                    options={[
                        { value: "", label: "Every camera" },
                        ...cameras.map((camera) => ({ value: camera.id, label: camera.name }))
                    ]}
                />
                {chosen.length > 0 ? (
                    <div className="flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1">
                        <span className="text-[12px] text-foreground-subtle">{chosen.length} selected</span>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={allKept ? "Stop keeping these" : "Keep these"}
                            title={allKept ? "Stop keeping these" : "Keep these"}
                            onClick={() => keep(chosen, !allKept)}
                        >
                            {allKept ? <PinOff className="size-4 shrink-0" /> : <Pin className="size-4 shrink-0" />}
                        </Button>
                        {canManage ? (
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Delete these clips"
                                title="Delete"
                                onClick={() => setRemoving(chosen)}
                            >
                                <Trash2 className="size-4 shrink-0" />
                            </Button>
                        ) : null}
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Clear the selection"
                            title="Clear"
                            onClick={() => setSelected(new Set())}
                        >
                            <X className="size-4 shrink-0" />
                        </Button>
                    </div>
                ) : null}
            </div>

            {error ? <p className="text-[12px] text-danger">{error}</p> : null}

            {rows.length === 0 ? (
                <EmptyState
                    icon={<Video />}
                    title="No footage yet"
                    description="A camera keeps footage once you tell it to, on its own settings screen."
                />
            ) : (
                <>
                    <ul
                        tabIndex={0}
                        onKeyDown={onKeyDown}
                        aria-label="Footage"
                        aria-multiselectable
                        className="flex flex-col divide-y divide-border rounded-lg border border-border"
                    >
                        {rows.map((clip, index) => {
                            const when = format.dateTime(clip.startedAt);
                            const isSelected = selected.has(clip.id);
                            return (
                                <ContextMenu key={clip.id}>
                                    <ContextMenuTrigger asChild>
                                        <li
                                            aria-selected={isSelected}
                                            onClick={(event) => clickRow(event, index)}
                                            onDoubleClick={() =>
                                                setPlaying((current) => (current === clip.id ? null : clip.id))
                                            }
                                            className={cn(
                                                "flex cursor-default flex-col gap-3 px-3 py-2",
                                                isSelected && "bg-primary/10"
                                            )}
                                        >
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate text-[13px] text-foreground">
                                                        {clip.cameraName} - {when}
                                                    </p>
                                                    <p className="truncate text-[11px] text-foreground-subtle">
                                                        {REASON_LABEL[clip.reason] ?? clip.reason} -{" "}
                                                        {duration(clip.durationMs)} - {size(clip.bytes)}
                                                    </p>
                                                </div>
                                                <div className="flex shrink-0 items-center gap-1">
                                                    {clip.pinned ? <Badge variant="neutral">Kept</Badge> : null}
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={playing === clip.id ? "Stop" : "Play this clip"}
                                                        title={playing === clip.id ? "Stop" : "Play"}
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            setPlaying((current) =>
                                                                current === clip.id ? null : clip.id
                                                            );
                                                        }}
                                                    >
                                                        {playing === clip.id ? (
                                                            <Square className="size-4 shrink-0" />
                                                        ) : (
                                                            <Play className="size-4 shrink-0" />
                                                        )}
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={
                                                            clip.pinned ? "Stop keeping this" : "Keep this one"
                                                        }
                                                        title={clip.pinned ? "Stop keeping this" : "Keep this one"}
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            keep([clip], !clip.pinned);
                                                        }}
                                                    >
                                                        {clip.pinned ? (
                                                            <PinOff className="size-4 shrink-0" />
                                                        ) : (
                                                            <Pin className="size-4 shrink-0" />
                                                        )}
                                                    </Button>
                                                    {canManage ? (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            aria-label="Delete this clip"
                                                            title="Delete"
                                                            onClick={(event) => {
                                                                event.stopPropagation();
                                                                setRemoving([clip]);
                                                            }}
                                                        >
                                                            <Trash2 className="size-4 shrink-0" />
                                                        </Button>
                                                    ) : null}
                                                </div>
                                            </div>
                                            {playing === clip.id ? (
                                                <MediaPlayer
                                                    kind="video"
                                                    autoPlay
                                                    src={`/api/home/clips/${clip.id}/video`}
                                                    className="overflow-hidden rounded-md border border-border bg-background"
                                                    onClick={(event) => event.stopPropagation()}
                                                />
                                            ) : null}
                                        </li>
                                    </ContextMenuTrigger>
                                    <ContextMenuContent>
                                        <ContextMenuLabel>
                                            {selected.has(clip.id) && chosen.length > 1
                                                ? `${chosen.length} clips selected`
                                                : `${clip.cameraName} - ${when}`}
                                        </ContextMenuLabel>
                                        <ContextMenuItem
                                            onSelect={() =>
                                                setPlaying((current) => (current === clip.id ? null : clip.id))
                                            }
                                        >
                                            <Play className="size-4 shrink-0" />
                                            {playing === clip.id ? "Stop" : "Play"}
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                            onSelect={() => {
                                                const targets = targetsFor(clip, index);
                                                keep(targets, !targets.every((item) => item.pinned));
                                            }}
                                        >
                                            <Pin className="size-4 shrink-0" />
                                            {clip.pinned ? "Stop keeping" : "Keep"}
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                            onSelect={() => {
                                                for (const target of targetsFor(clip, index)) {
                                                    download(target, format.dateTime(target.startedAt));
                                                }
                                            }}
                                        >
                                            <Download className="size-4 shrink-0" />
                                            Download
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem onSelect={() => setSelected(new Set(keys))}>
                                            Select all
                                        </ContextMenuItem>
                                        {canManage ? (
                                            <>
                                                <ContextMenuSeparator />
                                                <ContextMenuItem
                                                    variant="danger"
                                                    onSelect={() => setRemoving(targetsFor(clip, index))}
                                                >
                                                    <Trash2 className="size-4 shrink-0" />
                                                    Delete
                                                </ContextMenuItem>
                                            </>
                                        ) : null}
                                    </ContextMenuContent>
                                </ContextMenu>
                            );
                        })}
                    </ul>
                    {!done ? (
                        <div className="flex justify-center">
                            <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                                {loadingMore ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                                Show older
                            </Button>
                        </div>
                    ) : null}
                </>
            )}

            {removing?.length ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={
                        removing.length === 1 && removing[0]
                            ? `${removing[0].cameraName} - ${format.dateTime(removing[0].startedAt)}`
                            : `${removing.length} clips`
                    }
                    kind="clip"
                    requireTyping={false}
                    description="The file is removed from wherever it was written. There is no copy."
                    confirmLabel="Delete"
                    onConfirm={() => remove(removing)}
                />
            ) : null}
        </div>
    );
}
