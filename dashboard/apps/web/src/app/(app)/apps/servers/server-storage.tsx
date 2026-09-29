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
import { useCallback, useEffect, useState } from "react";
import { ContainerStorage } from "./container-storage";
import { useConfirm } from "@/components/confirm-dialog";
import type { HostVolume } from "@/lib/deploy/host-volumes";
import type { StrayContainer } from "@/lib/deploy/host-containers";
import { useLiveRead } from "@/components/use-live-resource";
import { Badge, Button, EmptyState, Switch } from "@polaris/ui";
import { Boxes, HardDrive, Loader2, Trash2, FolderOpen } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import {
    hostVolumesAction,
    leftoverAutoRemoveAction,
    removeHostVolumeAction,
    setLeftoverAutoRemoveAction,
    removeStrayContainerAction,
    strayContainersAction
} from "./actions";

/** A disk does not change between two glances at it. */
const REFRESH_MS = 60_000;

type Words = NamespaceTranslator<"servers">;

function size(bytes: number | null, t: Words): string {
    if (bytes === null) return t("storage.notMeasured");
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Whole days since then, or null when there is no sensible answer. */
function daysSince(iso: string | null): number | null {
    if (!iso) return null;
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return !Number.isFinite(days) || days < 0 ? null : days;
}

/** How long it has been sitting there, in the words somebody would use. */
function age(iso: string | null, t: Words): string | null {
    const days = daysSince(iso);
    if (days === null) return null;
    if (days === 0) return t("storage.age.today");
    if (days === 1) return t("storage.age.yesterday");
    if (days < 30) return t("storage.age.days", { days });
    const months = Math.round(days / 30);
    return months <= 1 ? t("storage.age.month") : t("storage.age.months", { months });
}

/**
 * How long a volume nothing has used has sat that way, or null when it is in
 * use. Counted from its last use, or - never seen in use since Polaris began
 * keeping notes - from when the notes began, which is said so.
 */
function unusedFor(volume: HostVolume, t: Words): string | null {
    if (volume.inUse) return null;
    const since = volume.lastUsedAt ?? volume.notedSince;
    const when = age(since, t);
    if (!when) return null;
    if (volume.lastUsedAt) return t("storage.lastUsed", { when });
    // "Since 3 days ago" read as a use 3 days ago; it is when watching began.
    return daysSince(since) === 0 ? t("storage.notSeenYet") : t("storage.neverSeen", { when });
}

export function ServerStorage() {
    const t = useTranslations("servers");
    const tcommon = useTranslations("common");
    const [confirm, confirmElement] = useConfirm();
    const [removing, setRemoving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [freed, setFreed] = useState<{ name: string; bytes: number | null } | null>(null);
    const [autoRemove, setAutoRemoveShown] = useState<boolean | null>(null);
    const [autoRemoveUnread, setAutoRemoveUnread] = useState(false);

    const readAutoRemove = useCallback(() => {
        setAutoRemoveUnread(false);
        void leftoverAutoRemoveAction()
            .then(setAutoRemoveShown)
            .catch(() => {
                setAutoRemoveShown(null);
                setAutoRemoveUnread(true);
            });
    }, []);

    useEffect(readAutoRemove, [readAutoRemove]);

    // Shown at once and put back if the server says no.
    const switchAutoRemove = async (on: boolean) => {
        const before = autoRemove;
        setAutoRemoveShown(on);
        setError(null);
        const result = await setLeftoverAutoRemoveAction(on).catch(() => ({
            error: t("storage.switchFailed")
        }));
        if (result.error) {
            setAutoRemoveShown(before);
            setError(result.error);
        }
    };

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
            title: t("storage.deleteTitle", { name: volume.name }),
            description: t("storage.deleteBody", {
                size: size(volume.bytes, t),
                dated: age(volume.createdAt, t) ? "yes" : "no",
                created: age(volume.createdAt, t) ?? ""
            }),
            confirmLabel: t("storage.deleteIt"),
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
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h2 className="flex items-center gap-1.5 text-sm font-medium">
                            <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                            {t("storage.volumes")}
                        </h2>
                        <p className="text-muted-foreground text-xs">
                            {t("storage.volumesIntro")}
                        </p>
                    </div>
                    <label className="flex max-w-sm items-start gap-2 text-xs">
                        <Switch
                            checked={autoRemove ?? false}
                            disabled={autoRemove === null}
                            onChange={(on) => void switchAutoRemove(on)}
                            aria-label={t("storage.autoRemove")}
                        />
                        <span>
                            <span className="block font-medium">{t("storage.autoRemove")}</span>
                            {autoRemoveUnread ? (
                                <span className="text-danger">
                                    {t("storage.autoRemoveUnread")}{" "}
                                    <button
                                        type="button"
                                        className="underline underline-offset-2"
                                        onClick={readAutoRemove}
                                    >
                                        {tcommon("pages.error.tryAgain")}
                                    </button>
                                </span>
                            ) : (
                                <span className="text-muted-foreground">
                                    {t("storage.autoRemoveHint")}
                                </span>
                            )}
                        </span>
                    </label>
                </div>

                {volumes === null ? (
                    <p className="text-muted-foreground flex items-center gap-2 px-3 py-6 text-sm">
                        <Loader2 className="size-4 shrink-0 animate-spin" />
                        {t("storage.reading")}
                    </p>
                ) : used.length === 0 && spare.length === 0 ? (
                    <EmptyState
                        icon={<HardDrive />}
                        title={t("storage.noVolumes")}
                        description={t("storage.noVolumesBody")}
                    />
                ) : (
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full text-sm">
                            <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                                <tr>
                                    <th className="w-full max-w-0 px-3 py-2 font-medium">
                                        {t("storage.columns.volume")}
                                    </th>
                                    <th className="whitespace-nowrap px-3 py-2 font-medium">
                                        {t("storage.columns.size")}
                                    </th>
                                    <th className="hidden whitespace-nowrap px-3 py-2 font-medium md:table-cell">
                                        {t("storage.columns.created")}
                                    </th>
                                    <th className="px-3 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {[...used, ...spare].map((volume) => (
                                    <tr key={volume.name} className="border-t border-border">
                                        <td className="w-full max-w-0 px-3 py-2">
                                            <span className="flex min-w-0 items-center gap-2">
                                                <span
                                                    className="min-w-0 truncate font-medium"
                                                    title={volume.name}
                                                >
                                                    {volume.name}
                                                </span>
                                                {/* The verdict first, because it is the
                                                    question: can this go. The reason is
                                                    in the title for anybody who wants it. */}
                                                {volume.verdict === "safe" ? (
                                                    <Badge
                                                        variant="success"
                                                        className="shrink-0"
                                                        title={volume.reason}
                                                    >
                                                        {t("storage.safe")}
                                                    </Badge>
                                                ) : volume.spare ? (
                                                    <Badge
                                                        variant="warning"
                                                        className="shrink-0"
                                                        title={volume.reason}
                                                    >
                                                        {t("storage.checkFirst")}
                                                    </Badge>
                                                ) : volume.inUse ? null : (
                                                    <Badge
                                                        variant="neutral"
                                                        className="shrink-0"
                                                        title={volume.reason}
                                                    >
                                                        {t("storage.idle")}
                                                    </Badge>
                                                )}
                                            </span>
                                            <span className="text-muted-foreground block truncate text-xs">
                                                {volume.owner
                                                    ? t("storage.belongsTo", { owner: volume.owner })
                                                    : volume.description
                                                      ? t("storage.gone", { what: volume.description })
                                                      : volume.project
                                                        ? t("storage.createdBy", { project: volume.project })
                                                        : t("storage.noRecord")}
                                                {volume.heldBy.length > 0
                                                    ? ` - ${holders(volume, t)}`
                                                    : ""}
                                                {unusedFor(volume, t) ? ` - ${unusedFor(volume, t)}` : ""}
                                            </span>
                                            {!volume.inUse && !volume.owner ? (
                                                <span className="text-muted-foreground block text-xs">
                                                    {volume.reason}
                                                </span>
                                            ) : null}
                                        </td>
                                        <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                                            {size(volume.bytes, t)}
                                        </td>
                                        <td className="text-muted-foreground hidden whitespace-nowrap px-3 py-2 md:table-cell">
                                            {age(volume.createdAt, t) ?? t("storage.unknown")}
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
                                                        aria-label={t("storage.openInDrive", { name: volume.name })}
                                                        title={t("storage.seeInside")}
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
                                                        aria-label={t("storage.deleteNamed", { name: volume.name })}
                                                        title={t("storage.delete")}
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
                        {t("storage.spare", { count: spare.length, size: size(spareBytes, t) })}
                    </p>
                ) : null}

                {freed ? (
                    <p className="text-success text-xs">
                        {freed.bytes
                            ? t("storage.freedBack", { name: freed.name, size: size(freed.bytes, t) })
                            : t("storage.freed", { name: freed.name })}
                    </p>
                ) : null}
                {error ? <p className="text-danger text-xs">{error}</p> : null}
            </section>

            <StrayContainers />

            <section className="flex flex-col gap-2">
                <div>
                    <h2 className="flex items-center gap-1.5 text-sm font-medium">
                        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                        {t("storage.files")}
                    </h2>
                    <p className="text-muted-foreground text-xs">
                        {t("storage.filesIntro")}
                    </p>
                </div>
                <Link href="/drive/insights" className="text-primary w-fit text-sm hover:underline">
                    {t("storage.driveRoom")}
                </Link>
            </section>

            {confirmElement}
        </div>
    );
}

/** What has a volume open, in a sentence rather than a count: "held by
 *  minecraft-a1b2" is the answer somebody looking at a large row is after, and a
 *  number is not. */
function holders(volume: HostVolume, t: Words): string {
    const names = volume.heldBy.map((holder) =>
        holder.running ? holder.name : t("storage.stopped", { name: holder.name })
    );
    if (names.length === 1) return t("storage.heldBy", { names: names[0]!, rest: 0 });
    return t("storage.heldBy", { names: names.slice(0, 2).join(", "), rest: names.length - 2 });
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
    const t = useTranslations("servers");
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
            title: t("storage.removeTitle", { name: stray.name }),
            description: t("storage.removeBody", { running: stray.running ? "yes" : "no" }),
            confirmLabel: t("storage.removeIt"),
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
                    {t("storage.leftBehind")}
                </h2>
                <p className="text-muted-foreground text-xs">
                    {t("storage.leftBehindIntro", { count: strays.length })}
                </p>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="w-full max-w-0 px-3 py-2 font-medium">
                                {t("storage.columns.container")}
                            </th>
                            <th className="hidden whitespace-nowrap px-3 py-2 font-medium md:table-cell">
                                {t("storage.columns.created")}
                            </th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {strays.map((stray) => (
                            <tr key={stray.id} className="border-t border-border">
                                <td className="w-full max-w-0 px-3 py-2">
                                    <span className="flex min-w-0 items-center gap-2">
                                        <span
                                            className="min-w-0 truncate font-medium"
                                            title={stray.name}
                                        >
                                            {stray.name}
                                        </span>
                                        {stray.running ? (
                                            <Badge variant="warning" className="shrink-0">
                                                {t("storage.stillRunning")}
                                            </Badge>
                                        ) : null}
                                    </span>
                                    <span className="text-muted-foreground block truncate text-xs">
                                        {stray.image}
                                        {stray.status ? ` - ${stray.status}` : ""}
                                    </span>
                                </td>
                                <td className="text-muted-foreground hidden whitespace-nowrap px-3 py-2 md:table-cell">
                                    {age(stray.createdAt, t) ?? t("storage.unknown")}
                                </td>
                                <td className="px-3 py-2 text-right">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        disabled={removing !== null}
                                        onClick={() => void remove(stray)}
                                        aria-label={t("list.removeNamed", { name: stray.name })}
                                        title={t("list.remove")}
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
