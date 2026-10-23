"use client";

/**
 * A machine Polaris deploys to is running out of disk.
 *
 * Shown on every screen to whoever manages the system, because the one place a
 * person reliably looks is the screen they are already on - a host was found at
 * 99% with its database crash-looping, and nothing anywhere had said so. Names
 * the machine, how much is left and what is using it, and carries the button
 * that removes what Polaris can safely remove there. Never a volume: for those
 * it offers the way to move a service's data to another location.
 *
 * Hidden for this tab once dismissed, until the level gets worse.
 */

import Link from "next/link";
import { Button, cn } from "@polaris/ui";
import { useCallback, useEffect, useState } from "react";
import { HardDrive, Loader2, X } from "lucide-react";
import type { DiskReading } from "@/lib/deploy/disk-watch";
import { useLiveRead } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ActiveMoveView } from "@/lib/storage-moves/service";
import { moveSize, movePhaseText, moveTarget } from "@/components/storage-move-words";
import { diskMovesAction, freeDiskSpaceAction } from "@/app/(app)/disk-alert-actions";
import * as polls from "./shared-polls";

/** A disk does not change between two glances; re-read after a clean-up. */
const REFRESH_MS = 5 * 60_000;
/** A move's step changes far more often than a disk. */
const MOVES_REFRESH_MS = 30_000;
const DISMISSED = "polaris.diskAlert.dismissed";

const size = moveSize;

function dismissedKeys(): string[] {
    try {
        const raw = sessionStorage.getItem(DISMISSED);
        return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
        return [];
    }
}

export function DiskAlertBanner() {
    const t = useTranslations("components");
    const [dismissed, setDismissed] = useState<string[]>([]);
    useEffect(() => setDismissed(dismissedKeys()), []);
    const [busy, setBusy] = useState<string | null>(null);
    const [said, setSaid] = useState<Record<string, { text: string; ok: boolean }>>({});

    const load = useCallback(() => polls.diskAlerts(), []);
    const { data, refresh } = useLiveRead<DiskReading[]>({
        load,
        cacheKey: "disk-alerts",
        intervalMs: REFRESH_MS
    });

    const shown = (data ?? []).filter((one) => !dismissed.includes(`${one.machine}:${one.level}`));
    // Asked only while a warning is up: a move under way is why the disk is about
    // to get room back, and an original left behind is why it has not.
    const loadMoves = useCallback(() => diskMovesAction(), []);
    const { data: movesRead } = useLiveRead({
        load: loadMoves,
        cacheKey: "disk-alerts.moves",
        intervalMs: MOVES_REFRESH_MS,
        enabled: shown.length > 0
    });
    if (shown.length === 0) return null;
    const canAnswer = movesRead?.canAnswer ?? false;

    const dismiss = (reading: DiskReading) => {
        const next = [...dismissed, `${reading.machine}:${reading.level}`];
        setDismissed(next);
        try {
            sessionStorage.setItem(DISMISSED, JSON.stringify(next));
        } catch {
            // Private mode: it is hidden for as long as the page lives.
        }
    };

    const free = async (reading: DiskReading) => {
        setBusy(reading.machine);
        const result = await freeDiskSpaceAction(reading.machine).catch(() => ({
            error: t("diskAlert.unreachable")
        }));
        setBusy(null);
        setSaid((previous) => ({
            ...previous,
            [reading.machine]:
                "error" in result && result.error
                    ? { text: result.error, ok: false }
                    : "busy" in result && result.busy
                      ? { text: t("diskAlert.busy"), ok: false }
                      : {
                            text:
                                "freed" in result && result.freed
                                    ? t("diskAlert.freed", { size: size(result.freed) })
                                    : t("diskAlert.nothingFreed"),
                            ok: true
                        }
        }));
        refresh();
    };

    return (
        <div className="flex flex-col gap-2">
            {shown.map((reading) => {
                const critical = reading.level === "critical";
                const percent = Math.round(((reading.total - reading.free) / reading.total) * 100);
                const name = reading.name || t("diskAlert.thisServer");
                const usage = reading.usage;
                const message = said[reading.machine];
                return (
                    <div
                        key={reading.machine}
                        role="alert"
                        className={cn(
                            "flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-lg border px-2.5 py-1.5 text-sm sm:gap-y-2 sm:px-3 sm:py-2",
                            critical
                                ? "border-danger-edge bg-danger-soft text-danger-ink"
                                : "border-warning-edge bg-warning-soft text-warning-ink"
                        )}
                    >
                        <HardDrive className="mt-0.5 size-4 shrink-0" aria-hidden />
                        <div className="min-w-0 grow basis-56">
                            <p className="font-medium">
                                {t(critical ? "diskAlert.critical" : "diskAlert.low", {
                                    name,
                                    percent,
                                    free: size(reading.free)
                                })}
                            </p>
                            <p className="mt-0.5 hidden text-xs opacity-90 sm:block">
                                {usage
                                    ? t("diskAlert.usage", {
                                          images: size(usage.images),
                                          cache: size(usage.buildCache),
                                          volumes: size(usage.volumes),
                                          reclaimable: size(usage.reclaimable)
                                      })
                                    : t("diskAlert.usageUnknown")}
                            </p>
                            {(movesRead?.moves ?? [])
                                .filter((move) => move.machine === reading.machine)
                                .map((move) => (
                                    <MoveLine key={move.id} move={move} canAnswer={canAnswer} />
                                ))}
                            {message ? (
                                <p className={cn("mt-1 text-xs", message.ok ? "" : "font-medium")}>
                                    {message.text}
                                </p>
                            ) : null}
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-1">
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy !== null}
                                title={t("diskAlert.freeHint")}
                                onClick={() => void free(reading)}
                            >
                                {busy === reading.machine ? (
                                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                                ) : null}
                                {busy === reading.machine
                                    ? t("diskAlert.freeing")
                                    : t("diskAlert.free")}
                            </Button>
                            <Button size="sm" variant="secondary" asChild>
                                <Link href="/admin/storage" title={t("diskAlert.moveHint")}>
                                    {t("diskAlert.move")}
                                </Link>
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="hidden sm:inline-flex"
                                asChild
                            >
                                <Link href="/apps/servers">{t("diskAlert.details")}</Link>
                            </Button>
                            <button
                                type="button"
                                aria-label={t("diskAlert.dismiss")}
                                title={t("diskAlert.dismiss")}
                                className="rounded p-1 opacity-70 hover:opacity-100"
                                onClick={() => dismiss(reading)}
                            >
                                <X className="size-4 shrink-0" aria-hidden />
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

/**
 * One move off this disk: under way, with when its room comes back - at the end
 * when Polaris empties the original itself, otherwise only once somebody says
 * the original can go - or done and still holding the original's room, with the
 * way to remove it after the check the storage screen asks for.
 */
function MoveLine({ move, canAnswer }: { move: ActiveMoveView; canAnswer: boolean }) {
    const t = useTranslations("components");
    const volume = move.volumeName || move.appName;
    const target = moveTarget(move, t);
    if (move.phase !== "waiting")
        return (
            <p className="mt-1 text-xs">
                {t("storageMove.banner.inProgress", {
                    volume,
                    target,
                    phase: movePhaseText(move, t)
                })}{" "}
                {t(
                    move.auto
                        ? "storageMove.banner.freesAfter"
                        : "storageMove.banner.freesAfterAnswer"
                )}
            </p>
        );
    return (
        <p className="mt-1 text-xs">
            {move.totalBytes !== null
                ? t("storageMove.banner.waiting", { volume, target, size: size(move.totalBytes) })
                : t("storageMove.banner.waitingNoSize", { volume, target })}{" "}
            {canAnswer ? (
                <Link href="/admin/storage" className="font-medium underline underline-offset-2">
                    {t("storageMove.banner.removeOriginal")}
                </Link>
            ) : (
                t("storageMove.banner.askAdmin")
            )}
        </p>
    );
}
