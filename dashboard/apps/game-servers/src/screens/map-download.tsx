"use client";

/**
 * A map's world arriving on this instance, as the create and reset forms show it.
 *
 * Worlds are downloaded the first time a server is built on them
 * (`lib/minecraft/map-store.ts`), so a form that is about to build one asks for
 * it first and waits, showing how far it got; a download that failed says so
 * with a button that asks again. A map already here answers at once.
 */

import { Button } from "@polaris/ui";
import { useGameText } from "./game-text";
import { formatBytes } from "@polaris/core";
import { prepareMapAction } from "./actions";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import type { MapDownload, MapFailure } from "../lib/minecraft/map-store";

const POLL_MS = 1000;

type Waiting = Exclude<MapDownload, { state: "ready" }>;

/** `prepare(mapId)` resolves true once the world is here, false when it could
 *  not be had; `status` is what to show meanwhile, null when nothing is. */
export function useMapDownload(): {
    status: Waiting | null;
    prepare: (mapId: string) => Promise<boolean>;
} {
    const [status, setStatus] = useState<Waiting | null>(null);
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const prepare = useCallback(async (mapId: string) => {
        setStatus(null);
        for (;;) {
            const answer = await prepareMapAction(mapId).catch((): MapDownload => ({
                state: "failed",
                reason: "unreachable"
            }));
            if (!alive.current) return false;
            if (answer.state === "ready") {
                setStatus(null);
                return true;
            }
            setStatus(answer);
            if (answer.state === "failed") return false;
            await new Promise((done) => setTimeout(done, POLL_MS));
        }
    }, []);

    return { status, prepare };
}

const FAILURE_KEYS = {
    unreachable: "mapDownload.unreachable",
    notPublished: "mapDownload.notPublished",
    corrupt: "mapDownload.corrupt",
    noSpace: "mapDownload.noSpace",
    failed: "mapDownload.failed"
} as const satisfies Record<MapFailure, string>;

/** The progress of a map's download, or why it failed with a retry. */
export function MapDownloadNotice({
    status,
    onRetry,
    retrying
}: {
    status: Waiting | null;
    onRetry: () => void;
    retrying: boolean;
}) {
    const t = useGameText("games");
    if (!status) return null;
    if (status.state === "failed") {
        return (
            <div
                role="alert"
                className="flex flex-wrap items-center gap-2 rounded-md border border-danger-edge bg-danger-soft px-3 py-2 text-sm"
            >
                <TriangleAlert className="size-4 shrink-0 text-danger" />
                <span className="min-w-0 flex-1 text-danger">{t(FAILURE_KEYS[status.reason])}</span>
                <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
                    <RefreshCw className="size-4" /> {t("mapDownload.retry")}
                </Button>
            </div>
        );
    }
    const percent =
        status.total > 0 ? Math.min(100, Math.round((status.received / status.total) * 100)) : 0;
    return (
        <div role="status" className="flex flex-col gap-1.5 text-sm">
            <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 shrink-0 animate-spin" />
                <span className="min-w-0 truncate">
                    {t("mapDownload.downloading", {
                        received: formatBytes(status.received),
                        total: formatBytes(status.total)
                    })}
                </span>
            </span>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                <div
                    className="h-full bg-primary transition-[width]"
                    style={{ width: `${percent}%` }}
                />
            </div>
        </div>
    );
}
