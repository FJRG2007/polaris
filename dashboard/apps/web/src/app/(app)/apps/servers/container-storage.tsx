"use client";

/**
 * What the container store is holding on this machine, and the button that hands
 * some of it back.
 *
 * It exists because of a deploy that stopped with a rename it could not finish,
 * deep inside the image store, ending "no such file or directory". The disk was
 * at 97%: the layer had nowhere to land. Nothing anywhere said so, and there was
 * nothing the operator could do about it from Polaris - the fix was a terminal
 * and two commands, on a product whose first rule is that the command line is
 * not a requirement for anything.
 *
 * Only the machine Polaris runs on. It is the one it can reach through its own
 * daemon, and the one whose disk filling up stops Polaris deploying at all.
 *
 * Draws nothing at all when the daemon cannot answer. A panel that reported
 * zeroes would be saying this machine is holding nothing, which is a different
 * and false claim.
 */

import { Button, cn } from "@polaris/ui";
import { useCallback, useState } from "react";
import { HardDrive, Loader2 } from "lucide-react";
import type { HostSpace } from "@/lib/deploy/host-space";
import { useLiveRead } from "@/components/use-live-resource";
import { hostSpaceAction, reclaimHostSpaceAction } from "./actions";

/** Slow: this is a picture of a disk, and a disk does not change between two
 *  glances at it. Re-read straight after a reclaim, which is when it does. */
const REFRESH_MS = 60_000;

/** Below this, offering to reclaim is offering to save nothing. */
const WORTH_RECLAIMING = 200 * 1024 * 1024;

function size(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function ContainerStorage() {
    const [freeing, setFreeing] = useState(false);
    const [freed, setFreed] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (): Promise<HostSpace> => {
        const space = await hostSpaceAction();
        // Thrown rather than resolved empty: the panel has to be able to tell
        // "this machine holds nothing" from "this machine would not say", and
        // only one of those is worth drawing.
        if (!space) throw new Error("unavailable");
        return space;
    }, []);

    const { data: space, refresh } = useLiveRead<HostSpace>({
        load,
        cacheKey: "servers.container-storage",
        intervalMs: REFRESH_MS
    });

    if (!space) return null;

    const rows = [
        { label: "Images", value: space.images },
        { label: "Volumes", value: space.volumes },
        { label: "Build cache", value: space.buildCache },
        { label: "Containers", value: space.containers }
    ];
    const worth = space.reclaimable >= WORTH_RECLAIMING;

    const free = async () => {
        setFreeing(true);
        setError(null);
        const result = await reclaimHostSpaceAction();
        setFreeing(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setFreed(result.freed ?? 0);
        await refresh();
    };

    return (
        <section className="flex flex-col gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-medium">
                <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                Container storage
            </h2>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {rows.map((row) => (
                    <div key={row.label} className="rounded-lg border border-border bg-surface px-3 py-2">
                        <p className="text-[15px] font-medium leading-none">{size(row.value)}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground">{row.label}</p>
                    </div>
                ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <p className={cn("text-xs", worth ? "text-foreground" : "text-muted-foreground")}>
                    {worth
                        ? `About ${size(space.reclaimable)} of that is build cache and untagged layers. Freeing it costs nothing but the time to build or pull them again - your volumes are not touched.`
                        : "There is nothing worth reclaiming here. Volumes are never touched by this."}
                </p>
                {worth ? (
                    <Button variant="secondary" size="sm" disabled={freeing} onClick={() => void free()}>
                        {freeing ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {freeing ? "Freeing" : "Free up space"}
                    </Button>
                ) : null}
            </div>

            {/* What was actually removed, which is not always the estimate above:
                the daemon decides when it runs, and it reports exactly. */}
            {freed !== null ? (
                <p className="text-xs text-success">
                    {freed > 0 ? `${size(freed)} given back.` : "Nothing was left to remove."}
                </p>
            ) : null}
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </section>
    );
}
