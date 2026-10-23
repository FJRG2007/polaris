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
 * name, a release that outlived its record, or an application uninstalled before
 * Polaris cleaned up after itself - each leaving a container, a private network,
 * a compose directory or an edge route that nothing in Polaris mentions again.
 * Finding those in `docker ps` is the one thing this product promises nobody has
 * to do.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ContainerStorage } from "./container-storage";
import { useConfirm } from "@/components/confirm-dialog";
import type { HostVolume } from "@/lib/deploy/host-volumes";
import type { ActiveMoveView } from "@/lib/storage-moves/service";
import { moveOfVolume, movePhaseText, moveTarget } from "@/components/storage-move-words";
import type { LeftoverContainer, Leftovers } from "@/lib/deploy/uninstall-leftovers";
import { useLiveRead } from "@/components/use-live-resource";
import { Badge, Button, EmptyState, Switch } from "@polaris/ui";
import { Boxes, HardDrive, Loader2, Trash2, FolderOpen } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import {
    hostVolumesAction,
    removeHostVolumeAction,
    setLeftoverAutoRemoveAction,
    removeStrayContainerAction,
    cleanUninstallLeftoversAction,
    uninstallLeftoversAction,
    volumeMovesAction
} from "./actions";
import * as polls from "./servers-polls";

/** A disk does not change between two glances at it. */
const REFRESH_MS = 60_000;
/** A data move changes by the second; its progress is read this often. */
const MOVE_REFRESH_MS = 10_000;

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
    const tmove = useTranslations("components");
    const [confirm, confirmElement] = useConfirm();
    const [removing, setRemoving] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [freed, setFreed] = useState<{ name: string; bytes: number | null } | null>(null);
    const [autoRemove, setAutoRemoveShown] = useState<boolean | null>(null);
    const [autoRemoveUnread, setAutoRemoveUnread] = useState(false);

    const readAutoRemove = useCallback(() => {
        setAutoRemoveUnread(false);
        void polls
            .leftoverAutoRemove()
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

    // Read beside the volumes, not after them, and far more often: a copy of a
    // large volume runs for hours, and a minute-old figure is the difference
    // between "it is moving" and "it is stuck". One indexed query, usually empty.
    const loadMoves = useCallback(async () => {
        return (await volumeMovesAction()) ?? { moves: [] as ActiveMoveView[], canAnswer: false };
    }, []);
    const { data: movesRead } = useLiveRead({
        load: loadMoves,
        cacheKey: "servers.volume-moves",
        intervalMs: MOVE_REFRESH_MS
    });
    const local = (movesRead?.moves ?? []).filter((move) => move.machine === "local");
    const canAnswer = movesRead?.canAnswer ?? false;

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
                        <p className="text-muted-foreground text-xs">{t("storage.volumesIntro")}</p>
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
                                {[...used, ...spare].map((volume) => {
                                    const move = moveOfVolume(volume, local);
                                    return (
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
                                                    {move ? (
                                                        <Badge
                                                            variant={
                                                                move.phase === "waiting"
                                                                    ? "warning"
                                                                    : "neutral"
                                                            }
                                                            className="min-w-0 shrink"
                                                            title={moveTarget(move, tmove)}
                                                        >
                                                            {move.phase === "waiting" ? null : (
                                                                <Loader2
                                                                    className="mr-1 size-3 shrink-0 animate-spin"
                                                                    aria-hidden
                                                                />
                                                            )}
                                                            <span className="truncate">
                                                                {tmove(
                                                                    move.phase === "waiting"
                                                                        ? "storageMove.movedTo"
                                                                        : "storageMove.moving",
                                                                    {
                                                                        target: moveTarget(
                                                                            move,
                                                                            tmove
                                                                        )
                                                                    }
                                                                )}
                                                            </span>
                                                        </Badge>
                                                    ) : volume.verdict === "safe" ? (
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
                                                        ? t("storage.belongsTo", {
                                                              owner: volume.owner
                                                          })
                                                        : volume.description
                                                          ? t("storage.gone", {
                                                                what: volume.description
                                                            })
                                                          : volume.removedApp && volume.project
                                                            ? `${t("storage.removedApp")} (${volume.project})`
                                                            : volume.project
                                                              ? t("storage.createdBy", {
                                                                    project: volume.project
                                                                })
                                                              : t("storage.noRecord")}
                                                    {/* A move's copier is what holds it: the
                                                    step it is on says more than its name. */}
                                                    {move
                                                        ? ` - ${movePhaseText(move, tmove)}`
                                                        : volume.heldBy.length > 0
                                                          ? ` - ${holders(volume, t)}`
                                                          : ""}
                                                    {unusedFor(volume, t)
                                                        ? ` - ${unusedFor(volume, t)}`
                                                        : ""}
                                                </span>
                                                {move?.percent !== null &&
                                                move?.percent !== undefined ? (
                                                    <span
                                                        role="progressbar"
                                                        aria-valuemin={0}
                                                        aria-valuemax={100}
                                                        aria-valuenow={move.percent}
                                                        aria-label={movePhaseText(move, tmove)}
                                                        className="mt-1 block h-1 overflow-hidden rounded-full bg-muted"
                                                    >
                                                        <span
                                                            className="block h-full rounded-full bg-primary transition-[width]"
                                                            style={{ width: `${move.percent}%` }}
                                                        />
                                                    </span>
                                                ) : null}
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
                                                            aria-label={t("storage.openInDrive", {
                                                                name: volume.name
                                                            })}
                                                            title={t("storage.seeInside")}
                                                        >
                                                            <Link href={volume.browseHref}>
                                                                <FolderOpen className="size-4 shrink-0" />
                                                            </Link>
                                                        </Button>
                                                    ) : null}
                                                    {/* An original a move left behind goes the
                                                    way the move was checked, not as a loose
                                                    volume: the storage screen removes it. */}
                                                    {move?.phase === "waiting" && canAnswer ? (
                                                        <Button asChild variant="outline" size="sm">
                                                            <Link href="/admin/storage">
                                                                {tmove(
                                                                    "storageMove.banner.removeOriginal"
                                                                )}
                                                            </Link>
                                                        </Button>
                                                    ) : null}
                                                    {volume.spare && !move ? (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            disabled={removing !== null}
                                                            onClick={() => void remove(volume)}
                                                            aria-label={t("storage.deleteNamed", {
                                                                name: volume.name
                                                            })}
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
                                    );
                                })}
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
                            ? t("storage.freedBack", {
                                  name: freed.name,
                                  size: size(freed.bytes, t)
                              })
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
                    <p className="text-muted-foreground text-xs">{t("storage.filesIntro")}</p>
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

/** One non-data leftover, as a row shows it. */
interface LeftoverRow {
    readonly key: string;
    readonly kind: "container" | "network" | "dir" | "route";
    readonly name: string;
    readonly detail: string | null;
    readonly container: LeftoverContainer | null;
}

function rowsOf(found: Leftovers): LeftoverRow[] {
    return [
        ...found.containers.map((container) => ({
            key: `container:${container.id}`,
            kind: "container" as const,
            name: container.name,
            detail: `${container.image}${container.status ? ` - ${container.status}` : ""}`,
            container
        })),
        ...found.networks.map((name) => ({
            key: `network:${name}`,
            kind: "network" as const,
            name,
            detail: null,
            container: null
        })),
        ...found.dirs.map((name) => ({
            key: `dir:${name}`,
            kind: "dir" as const,
            name,
            detail: null,
            container: null
        })),
        ...found.routes.map((id) => ({
            key: `route:${id}`,
            kind: "route" as const,
            name: `polaris-app-${id}`,
            detail: null,
            container: null
        }))
    ];
}

/**
 * What Polaris deployed here for apps that are gone, and stopped keeping track
 * of: containers, the private networks they were on, the folders the daemon
 * deployed them from, and edge routes for their domains.
 *
 * Its own section rather than a line in the volumes table, because none of it is
 * data: it all goes together from one button. A container can still go on its
 * own from its row. Volumes are never part of it - they are listed above with
 * their sizes and go one at a time.
 *
 * Draws nothing at all when there is nothing to say, which is almost always.
 */
function StrayContainers() {
    const t = useTranslations("servers");
    const [confirm, confirmElement] = useConfirm();
    const [removing, setRemoving] = useState<string | null>(null);
    const [cleaning, setCleaning] = useState(false);
    const [cleaned, setCleaned] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (): Promise<Leftovers> => {
        const found = await uninstallLeftoversAction();
        // Thrown rather than resolved empty, for the reason the volumes list does
        // it: "nothing was left behind" and "this machine would not say" are
        // different answers.
        if (!found) throw new Error("unavailable");
        return found;
    }, []);

    const { data: found, refresh } = useLiveRead<Leftovers>({
        load,
        cacheKey: "servers.uninstall-leftovers",
        intervalMs: REFRESH_MS
    });

    const remove = async (stray: LeftoverContainer) => {
        const ok = await confirm({
            title: t("storage.removeTitle", { name: stray.name }),
            description: t("storage.removeBody", { running: stray.running ? "yes" : "no" }),
            confirmLabel: t("storage.removeIt"),
            danger: true
        });
        if (!ok) return;
        setRemoving(stray.id);
        setError(null);
        setCleaned(null);
        const result = await removeStrayContainerAction(stray.id);
        setRemoving(null);
        if (result.error) {
            setError(result.error);
            return;
        }
        await refresh();
    };

    const rows = found ? rowsOf(found) : [];

    const cleanUp = async () => {
        const ok = await confirm({
            title: t("storage.leftovers.confirmTitle", { count: rows.length }),
            description: t("storage.leftovers.confirmBody"),
            confirmLabel: t("storage.leftovers.cleanUp"),
            danger: true
        });
        if (!ok) return;
        setCleaning(true);
        setError(null);
        setCleaned(null);
        const result = await cleanUninstallLeftoversAction().catch(() => ({
            error: t("errors.wouldNotAnswer"),
            removed: undefined
        }));
        setCleaning(false);
        if (result.removed) {
            const { containers, networks, dirs, routes } = result.removed;
            setCleaned(containers + networks + dirs + routes);
        }
        if (result.error) setError(result.error);
        await refresh();
    };

    if (rows.length === 0) {
        return cleaned ? (
            <p className="text-success text-xs">
                {t("storage.leftovers.cleaned", { count: cleaned })}
            </p>
        ) : null;
    }

    const containers = rows.filter((row) => row.kind === "container").length;

    return (
        <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="flex items-center gap-1.5 text-sm font-medium">
                        <Boxes className="size-4 shrink-0 text-muted-foreground" />
                        {t("storage.leftBehind")}
                    </h2>
                    <p className="text-muted-foreground text-xs">
                        {containers > 0 && containers === rows.length
                            ? t("storage.leftBehindIntro", { count: containers })
                            : t("storage.leftovers.intro")}
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={cleaning || removing !== null}
                    onClick={() => void cleanUp()}
                >
                    {cleaning ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                    {t("storage.leftovers.cleanUp")}
                </Button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="w-full max-w-0 px-3 py-2 font-medium">
                                {t("storage.columns.leftover")}
                            </th>
                            <th className="hidden whitespace-nowrap px-3 py-2 font-medium md:table-cell">
                                {t("storage.columns.created")}
                            </th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.key} className="border-t border-border">
                                <td className="w-full max-w-0 px-3 py-2">
                                    <span className="flex min-w-0 items-center gap-2">
                                        <Badge variant="neutral" className="shrink-0">
                                            {t(`storage.leftovers.kind.${row.kind}`)}
                                        </Badge>
                                        <span
                                            className="min-w-0 truncate font-medium"
                                            title={row.name}
                                        >
                                            {row.name}
                                        </span>
                                        {row.container?.running ? (
                                            <Badge variant="warning" className="shrink-0">
                                                {t("storage.stillRunning")}
                                            </Badge>
                                        ) : null}
                                    </span>
                                    {row.detail ? (
                                        <span
                                            className="text-muted-foreground block truncate text-xs"
                                            title={row.detail}
                                        >
                                            {row.detail}
                                        </span>
                                    ) : null}
                                </td>
                                <td className="text-muted-foreground hidden whitespace-nowrap px-3 py-2 md:table-cell">
                                    {row.container
                                        ? (age(row.container.createdAt, t) ?? t("storage.unknown"))
                                        : null}
                                </td>
                                <td className="px-3 py-2 text-right">
                                    {row.container ? (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            disabled={removing !== null || cleaning}
                                            onClick={() => void remove(row.container!)}
                                            aria-label={t("list.removeNamed", { name: row.name })}
                                            title={t("list.remove")}
                                        >
                                            {removing === row.container.id ? (
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

            {cleaned ? (
                <p className="text-success text-xs">
                    {t("storage.leftovers.cleaned", { count: cleaned })}
                </p>
            ) : null}
            {error ? <p className="text-danger text-xs">{error}</p> : null}
            {confirmElement}
        </section>
    );
}
