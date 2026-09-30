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
import type { HostSpace } from "@/lib/deploy/host-space";
import { useConfirm } from "@/components/confirm-dialog";
import { HardDrive, Loader2, Trash2 } from "lucide-react";
import { useLiveRead } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { hostSpaceAction, reclaimBuildCacheAction, reclaimHostSpaceAction } from "./actions";

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
    const t = useTranslations("servers");
    const [freeing, setFreeing] = useState(false);
    const [freed, setFreed] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirm, confirmElement] = useConfirm();

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
        { id: "images", label: t("space.images"), value: space.images },
        { id: "volumes", label: t("storage.volumes"), value: space.volumes },
        { id: "buildCache", label: t("space.buildCache"), value: space.buildCache },
        { id: "containers", label: t("detail.containers"), value: space.containers }
    ];
    const worth = space.reclaimable >= WORTH_RECLAIMING;

    const free = async (what: "everything" | "build-cache" = "everything") => {
        setFreeing(true);
        setError(null);
        const result =
            what === "build-cache" ? await reclaimBuildCacheAction() : await reclaimHostSpaceAction();
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
                {t("space.title")}
            </h2>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {rows.map((row) => (
                    <div
                        key={row.id}
                        className="flex items-start justify-between gap-1 rounded-lg border border-border bg-surface px-3 py-2"
                    >
                        <div className="min-w-0">
                            <p className="text-[0.9375rem] font-medium leading-none">{size(row.value)}</p>
                            <p className="mt-1 truncate text-[0.6875rem] text-muted-foreground" title={row.label}>
                                {row.label}
                            </p>
                        </div>
                        {/* The build cache on its own, for somebody who looked at
                            the number and wants exactly that gone. Nothing in it is
                            data: the next build makes it again, more slowly. */}
                        {row.id === "buildCache" && row.value > 0 ? (
                            <button
                                type="button"
                                disabled={freeing}
                                aria-label={t("space.deleteCache")}
                                title={t("space.deleteCache")}
                                className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-foreground-subtle hover:text-danger disabled:opacity-50"
                                onClick={() =>
                                    void confirm({
                                        title: t("space.deleteCacheTitle", { size: size(row.value) }),
                                        description: t("space.deleteCacheBody"),
                                        confirmLabel: t("space.deleteCacheConfirm"),
                                        danger: true
                                    }).then((agreed) => {
                                        if (agreed) void free("build-cache");
                                    })
                                }
                            >
                                <Trash2 className="size-3.5 shrink-0" />
                            </button>
                        ) : null}
                    </div>
                ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <p className={cn("text-xs", worth ? "text-foreground" : "text-muted-foreground")}>
                    {worth
                        ? t("space.reclaimable", { size: size(space.reclaimable) })
                        : t("space.nothingWorth")}
                </p>
                {worth ? (
                    <Button variant="secondary" size="sm" disabled={freeing} onClick={() => void free()}>
                        {freeing ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        {freeing ? t("space.freeing") : t("space.free")}
                    </Button>
                ) : null}
            </div>

            {/* What was actually removed, which is not always the estimate above:
                the daemon decides when it runs, and it reports exactly. */}
            {freed !== null ? (
                <p className="text-xs text-success">
                    {freed > 0 ? t("space.freed", { size: size(freed) }) : t("space.nothingLeft")}
                </p>
            ) : null}
            {error ? <p className="text-xs text-danger">{error}</p> : null}
            {confirmElement}
        </section>
    );
}
