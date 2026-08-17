"use client";

/**
 * The footage the house kept.
 *
 * A list of segments, newest first, each one playable where it sits. Pinning is
 * the important control and is why this screen exists at all: retention drops
 * everything eventually, and the clip somebody actually needs is the one they
 * have to be able to hold on to before it goes.
 */

import * as actions from "../actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { ClipView } from "@/lib/home/recording";
import type { CameraView } from "@/lib/home/cameras";
import { useDisplayFormat } from "@/components/display-format";
import { Loader2, Pin, PinOff, Trash2, Video } from "lucide-react";
import { Badge, Button, ConfirmDeleteDialog, EmptyState, Select, Skeleton } from "@polaris/ui";

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

export function ClipsView({ canManage }: { canManage: boolean }) {
    const format = useDisplayFormat();
    const [clips, setClips] = useState<ClipView[] | null>(null);
    const [cameras, setCameras] = useState<CameraView[]>([]);
    const [cameraId, setCameraId] = useState("");
    const [playing, setPlaying] = useState<string | null>(null);
    const [removing, setRemoving] = useState<ClipView | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState<string | null>(null);

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

    const loadMore = async () => {
        if (!clips?.length) return;
        setLoadingMore(true);
        const result = await runAction(
            () =>
                actions.listClipsAction({
                    cameraId: cameraId || null,
                    before: clips[clips.length - 1]?.startedAt ?? null
                }),
            setError
        );
        setLoadingMore(false);
        if (!result?.clips) return;
        if (result.clips.length === 0) setDone(true);
        setClips((current) => [...(current ?? []), ...(result.clips ?? [])]);
    };

    const pin = async (clip: ClipView) => {
        const next = !clip.pinned;
        setClips((current) => (current ?? []).map((item) => (item.id === clip.id ? { ...item, pinned: next } : item)));
        const result = await runAction(() => actions.pinClipAction(clip.id, next), setError);
        if (result?.error) {
            setError(result.error);
            setClips((current) =>
                (current ?? []).map((item) => (item.id === clip.id ? { ...item, pinned: !next } : item))
            );
        }
    };

    const remove = async (clip: ClipView) => {
        const result = await runAction(() => actions.deleteClipAction(clip.id), setError);
        setRemoving(null);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setClips((current) => (current ?? []).filter((item) => item.id !== clip.id));
    };

    if (clips === null) return <Skeleton className="h-64 w-full" />;

    return (
        <div className="flex flex-col gap-4">
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

            {error ? <p className="text-[12px] text-danger">{error}</p> : null}

            {clips.length === 0 ? (
                <EmptyState
                    icon={<Video />}
                    title="No footage yet"
                    description="A camera keeps footage once you tell it to, on its own settings screen."
                />
            ) : (
                <>
                    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                        {clips.map((clip) => (
                            <li key={clip.id} className="flex flex-col gap-3 px-3 py-2">
                                <div className="flex items-center justify-between gap-3">
                                    <button
                                        type="button"
                                        className="min-w-0 flex-1 text-left"
                                        onClick={() => setPlaying(playing === clip.id ? null : clip.id)}
                                    >
                                        <p className="truncate text-[13px] text-foreground">
                                            {clip.cameraName} - {format.dateTime(clip.startedAt)}
                                        </p>
                                        <p className="truncate text-[11px] text-foreground-subtle">
                                            {REASON_LABEL[clip.reason] ?? clip.reason} - {duration(clip.durationMs)} -{" "}
                                            {size(clip.bytes)}
                                        </p>
                                    </button>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {clip.pinned ? <Badge variant="neutral">Kept</Badge> : null}
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            aria-label={clip.pinned ? "Stop keeping this" : "Keep this one"}
                                            title={clip.pinned ? "Stop keeping this" : "Keep this one"}
                                            onClick={() => pin(clip)}
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
                                                onClick={() => setRemoving(clip)}
                                            >
                                                <Trash2 className="size-4 shrink-0" />
                                            </Button>
                                        ) : null}
                                    </div>
                                </div>
                                {playing === clip.id ? (
                                    <video
                                        src={`/api/home/clips/${clip.id}/video`}
                                        className="w-full rounded-md border border-border bg-background"
                                        controls
                                        autoPlay
                                        playsInline
                                    />
                                ) : null}
                            </li>
                        ))}
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

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={`${removing.cameraName} - ${format.dateTime(removing.startedAt)}`}
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
