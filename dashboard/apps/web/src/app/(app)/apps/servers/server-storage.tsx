"use client";

/**
 * What is actually on the disk of the machine Polaris runs on.
 *
 * The Storage figure on the overview is a number and nothing else: 89 GB, of
 * what? This is the screen behind it. The split first, then the volumes largest
 * first with what each one belongs to, then the ones nothing needs any more -
 * which is where the disk actually goes.
 *
 * The cleaning is deliberately unlike the command everybody reaches for.
 * `docker system prune -a` frees a great deal and decides for itself what is
 * spare, at the moment it runs: an app that happens to be stopped is not spare,
 * and it cannot tell. So nothing here prunes. The two regenerable kinds - build
 * cache and untagged layers - go together from one button, because they come
 * back on the next build. A volume goes one at a time, named, from its own row,
 * after a confirmation that says how big it is: a volume does not come back.
 *
 * Only the machine Polaris runs on. It is the one it reaches through its own
 * daemon, and the one whose disk filling up stops Polaris deploying at all.
 */

import Link from "next/link";
import { useCallback, useState } from "react";
import { ContainerStorage } from "./container-storage";
import { useConfirm } from "@/components/confirm-dialog";
import type { HostVolume } from "@/lib/deploy/host-volumes";
import { useLiveRead } from "@/components/use-live-resource";
import { Badge, Button, EmptyState } from "@polaris/ui";
import { HardDrive, Loader2, Trash2, FolderOpen } from "lucide-react";
import { hostVolumesAction, removeHostVolumeAction } from "./actions";

/** A disk does not change between two glances at it. */
const REFRESH_MS = 60_000;

function size(bytes: number | null): string {
    if (bytes === null) return "not measured";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** How long it has been sitting there, in the words somebody would use. */
function age(iso: string | null): string | null {
    if (!iso) return null;
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    if (!Number.isFinite(days) || days < 0) return null;
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    const months = Math.round(days / 30);
    return months <= 1 ? "a month ago" : `${months} months ago`;
}

export function ServerStorage() {
    const [confirm, confirmElement] = useConfirm();
    const [removing, setRemoving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [freed, setFreed] = useState<{ name: string; bytes: number | null } | null>(null);

    const load = useCallback(async (): Promise<HostVolume[]> => {
        const volumes = await hostVolumesAction();
        // Thrown rather than resolved empty: "this machine holds no volumes" and
        // "this machine would not say" are different answers, and only one of
        // them is worth drawing.
        if (!volumes) throw new Error("unavailable");
        return volumes;
    }, []);

    const { data: volumes, refresh } = useLiveRead<HostVolume[]>({
        load,
        cacheKey: "servers.host-volumes",
        intervalMs: REFRESH_MS
    });

    const remove = async (volume: HostVolume) => {
        const ok = await confirm({
            title: `Delete "${volume.name}"?`,
            description: `${size(volume.bytes)} of whatever was written in it, gone for good. Nothing on this machine references it${
                age(volume.createdAt) ? `, and it was created ${age(volume.createdAt)}` : ""
            }. A volume does not come back the way a rebuilt image does.`,
            confirmLabel: "Delete it",
            danger: true
        });
        if (!ok) return;
        setRemoving(volume.name);
        setError(null);
        const result = await removeHostVolumeAction(volume.name);
        setRemoving(null);
        if (result.error) {
            setError(result.error);
            return;
        }
        setFreed({ name: volume.name, bytes: volume.bytes });
        await refresh();
    };

    const held = volumes ?? [];
    const spare = held.filter((volume) => volume.spare);
    const used = held.filter((volume) => !volume.spare);
    const spareBytes = spare.reduce((total, volume) => total + (volume.bytes ?? 0), 0);

    return (
        <div className="flex flex-col gap-6">
            <ContainerStorage />

            <section className="flex flex-col gap-2">
                <div>
                    <h2 className="flex items-center gap-1.5 text-sm font-medium">
                        <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                        Volumes
                    </h2>
                    <p className="text-muted-foreground text-xs">
                        Largest first. A volume is where an app keeps what it wrote - a database, a
                        world, an upload - so nothing here is removed for you.
                    </p>
                </div>

                {volumes === null ? (
                    <p className="text-muted-foreground flex items-center gap-2 px-3 py-6 text-sm">
                        <Loader2 className="size-4 shrink-0 animate-spin" />
                        Reading what this machine is holding
                    </p>
                ) : used.length === 0 && spare.length === 0 ? (
                    <EmptyState
                        icon={<HardDrive />}
                        title="No volumes"
                        description="Nothing on this machine has stored anything in a volume yet."
                    />
                ) : (
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full text-sm">
                            <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="w-full max-w-0 px-3 py-2 font-medium">Volume</th>
                                    <th className="whitespace-nowrap px-3 py-2 font-medium">Size</th>
                                    <th className="hidden whitespace-nowrap px-3 py-2 font-medium md:table-cell">
                                        Created
                                    </th>
                                    <th className="px-3 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {[...used, ...spare].map((volume) => (
                                    <tr key={volume.name} className="border-t border-border">
                                        <td className="w-full max-w-0 px-3 py-2">
                                            <span className="flex min-w-0 items-center gap-2">
                                                <span className="min-w-0 truncate font-medium" title={volume.name}>
                                                    {volume.name}
                                                </span>
                                                {volume.spare ? (
                                                    <Badge variant="warning" className="shrink-0">
                                                        Nothing uses it
                                                    </Badge>
                                                ) : volume.inUse ? null : (
                                                    <Badge variant="neutral" className="shrink-0">
                                                        Idle
                                                    </Badge>
                                                )}
                                            </span>
                                            <span className="text-muted-foreground block truncate text-xs">
                                                {volume.owner
                                                    ? `Belongs to ${volume.owner}`
                                                    : volume.project
                                                      ? `Created by ${volume.project}`
                                                      : "Polaris has no record of this one"}
                                            </span>
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                                            {size(volume.bytes)}
                                        </td>
                                        <td className="text-muted-foreground hidden whitespace-nowrap px-3 py-2 md:table-cell">
                                            {age(volume.createdAt) ?? "unknown"}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                            {volume.spare ? (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    disabled={removing !== null}
                                                    onClick={() => void remove(volume)}
                                                    aria-label={`Delete ${volume.name}`}
                                                    title="Delete"
                                                >
                                                    {removing === volume.name ? (
                                                        <Loader2 className="size-4 shrink-0 animate-spin" />
                                                    ) : (
                                                        <Trash2 className="size-4 shrink-0" />
                                                    )}
                                                </Button>
                                            ) : null}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {spare.length > 0 ? (
                    <p className="text-muted-foreground text-xs">
                        {spare.length === 1 ? "One volume is" : `${spare.length} volumes are`} holding{" "}
                        {size(spareBytes)} that nothing on this machine references, that Polaris has no
                        record of, and that has been sitting there for more than a day. Delete them one
                        at a time, when you know what they were.
                    </p>
                ) : null}

                {freed ? (
                    <p className="text-success text-xs">
                        {freed.name} removed{freed.bytes ? `, ${size(freed.bytes)} back` : ""}.
                    </p>
                ) : null}
                {error ? <p className="text-danger text-xs">{error}</p> : null}
            </section>

            <section className="flex flex-col gap-2">
                <div>
                    <h2 className="flex items-center gap-1.5 text-sm font-medium">
                        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                        Files
                    </h2>
                    <p className="text-muted-foreground text-xs">
                        What the containers on this machine are holding is above. The files people put
                        here are Drive&apos;s side of the same disk, and it weighs its own folders.
                    </p>
                </div>
                <Link
                    href="/drive/insights"
                    className="text-primary w-fit text-sm hover:underline"
                >
                    What is taking up room in Drive
                </Link>
            </section>

            {confirmElement}
        </div>
    );
}
