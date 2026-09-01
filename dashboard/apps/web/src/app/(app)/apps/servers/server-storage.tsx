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
 *
 * Two questions a list of names cannot answer on its own, and both are here.
 * What is holding a volume open - because "idle" is the wrong half of the answer
 * to a 22 GB row, and the useful half is which container has it and what is
 * inside it, which is a link into Drive through the app that mounts it. And what
 * Polaris itself left behind: a service removed, a stack recreated under another
 * name, a release that outlived its record, each leaving a container on the disk
 * that nothing in Polaris mentions again. Finding those in `docker ps` is the
 * one thing this product promises nobody has to do.
 */

import Link from "next/link";
import { useCallback, useState } from "react";
import { ContainerStorage } from "./container-storage";
import { useConfirm } from "@/components/confirm-dialog";
import type { HostVolume } from "@/lib/deploy/host-volumes";
import type { StrayContainer } from "@/lib/deploy/host-containers";
import { useLiveRead } from "@/components/use-live-resource";
import { Badge, Button, EmptyState } from "@polaris/ui";
import { Boxes, HardDrive, Loader2, Trash2, FolderOpen } from "lucide-react";
import {
    hostVolumesAction,
    removeHostVolumeAction,
    removeStrayContainerAction,
    strayContainersAction
} from "./actions";

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
                                                {volume.heldBy.length > 0 ? ` - ${holders(volume)}` : ""}
                                            </span>
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                                            {size(volume.bytes)}
                                        </td>
                                        <td className="text-muted-foreground hidden whitespace-nowrap px-3 py-2 md:table-cell">
                                            {age(volume.createdAt) ?? "unknown"}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                            <span className="flex items-center justify-end gap-0.5">
                                                {/* The way in is the app that mounts
                                                    it, at the path it mounts it on:
                                                    a volume is a directory under the
                                                    daemon's own root, and nothing
                                                    else on this machine is allowed
                                                    in there. */}
                                                {volume.browseHref ? (
                                                    <Button
                                                        asChild
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={`Open ${volume.name} in Drive`}
                                                        title="See what is inside"
                                                    >
                                                        <Link href={volume.browseHref}>
                                                            <FolderOpen className="size-4 shrink-0" />
                                                        </Link>
                                                    </Button>
                                                ) : null}
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
                                            </span>
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

            <StrayContainers />

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

/** What has a volume open, in a sentence rather than a count: "held by
 *  minecraft-a1b2" is the answer somebody looking at a large row is after, and a
 *  number is not. */
function holders(volume: HostVolume): string {
    const names = volume.heldBy.map((holder) => `${holder.name}${holder.running ? "" : " (stopped)"}`);
    if (names.length === 1) return `held by ${names[0]}`;
    const rest = names.length - 2;
    return `held by ${names.slice(0, 2).join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/**
 * What Polaris deployed here and stopped keeping track of.
 *
 * Its own section rather than a line in the volumes table, because it is a
 * different admission: a volume nothing uses may have been left by anything on
 * the machine, and these were left by Polaris. They are named, dated, and
 * removed one at a time - and never with their volumes, which are listed above
 * with their sizes and go on their own.
 *
 * Draws nothing at all when there is nothing to say, which is almost always: a
 * heading reading "Left behind: none" is a worry offered to somebody who did not
 * have one.
 */
function StrayContainers() {
    const [confirm, confirmElement] = useConfirm();
    const [removing, setRemoving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (): Promise<StrayContainer[]> => {
        const strays = await strayContainersAction();
        // Thrown rather than resolved empty, for the reason the volumes list does
        // it: "nothing was left behind" and "this machine would not say" are
        // different answers.
        if (!strays) throw new Error("unavailable");
        return strays;
    }, []);

    const { data: strays, refresh } = useLiveRead<StrayContainer[]>({
        load,
        cacheKey: "servers.stray-containers",
        intervalMs: REFRESH_MS
    });

    const remove = async (stray: StrayContainer) => {
        const ok = await confirm({
            title: `Remove "${stray.name}"?`,
            description: `Polaris deployed this and no longer has a record of it${
                stray.running ? ", and it is still running" : ""
            }. Removing it frees its image layer and its ports. Anything it wrote to a volume stays where it is - those are listed above, with their sizes.`,
            confirmLabel: "Remove it",
            danger: true
        });
        if (!ok) return;
        setRemoving(stray.id);
        setError(null);
        const result = await removeStrayContainerAction(stray.id);
        setRemoving(null);
        if (result.error) {
            setError(result.error);
            return;
        }
        await refresh();
    };

    if (!strays || strays.length === 0) return null;

    return (
        <section className="flex flex-col gap-2">
            <div>
                <h2 className="flex items-center gap-1.5 text-sm font-medium">
                    <Boxes className="size-4 shrink-0 text-muted-foreground" />
                    Left behind
                </h2>
                <p className="text-muted-foreground text-xs">
                    Polaris put {strays.length === 1 ? "this container" : `these ${strays.length} containers`} on
                    this machine and has no record of {strays.length === 1 ? "it" : "them"} any more - a service
                    removed, or a stack recreated under another name. Nothing else on the machine is touched.
                </p>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="w-full max-w-0 px-3 py-2 font-medium">Container</th>
                            <th className="hidden whitespace-nowrap px-3 py-2 font-medium md:table-cell">
                                Created
                            </th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {strays.map((stray) => (
                            <tr key={stray.id} className="border-t border-border">
                                <td className="w-full max-w-0 px-3 py-2">
                                    <span className="flex min-w-0 items-center gap-2">
                                        <span className="min-w-0 truncate font-medium" title={stray.name}>
                                            {stray.name}
                                        </span>
                                        {stray.running ? (
                                            <Badge variant="warning" className="shrink-0">
                                                Still running
                                            </Badge>
                                        ) : null}
                                    </span>
                                    <span className="text-muted-foreground block truncate text-xs">
                                        {stray.image}
                                        {stray.status ? ` - ${stray.status}` : ""}
                                    </span>
                                </td>
                                <td className="text-muted-foreground hidden whitespace-nowrap px-3 py-2 md:table-cell">
                                    {age(stray.createdAt) ?? "unknown"}
                                </td>
                                <td className="px-3 py-2 text-right">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        disabled={removing !== null}
                                        onClick={() => void remove(stray)}
                                        aria-label={`Remove ${stray.name}`}
                                        title="Remove"
                                    >
                                        {removing === stray.id ? (
                                            <Loader2 className="size-4 shrink-0 animate-spin" />
                                        ) : (
                                            <Trash2 className="size-4 shrink-0" />
                                        )}
                                    </Button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {error ? <p className="text-danger text-xs">{error}</p> : null}
            {confirmElement}
        </section>
    );
}
