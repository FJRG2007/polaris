"use client";

/**
 * The account's connected TVs, the version each one runs, and the button that
 * asks it to update. The TV collects the request on its next check-in and
 * reports back, so a pending row refreshes itself until it settles. Each row
 * also carries its name, Block ads and trackers, and whether it reaches the
 * Network filter (`tv-preferences.tsx`).
 */

import { Tv } from "lucide-react";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { RelativeTime } from "@/components/relative-time";
import { compareTvVersions, tvTakesUpdates } from "@/lib/tv/version-order";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { TvFilterReach } from "@/lib/tv/filter-reach";
import type { TvRow, TvUpdateState } from "@/lib/tv/update-requests";
import { blockingWaiting, TvName, TvPreferences } from "./tv-preferences";
import {
    renameTvAction,
    requestTvUpdateAction,
    setTvBlockingAction,
    tvFilterReachAction,
    tvUpdatesAction,
    type TvUpdatesView
} from "./actions";

/** How often a pending row asks how it is going. */
const REFRESH_MS = 5000;

/** How long the list keeps asking after Block ads and trackers is waiting on a
 *  TV. A TV that is on answers within seconds; one that is off answers when it
 *  is turned on, and the page shows that once it is opened again. */
const BLOCKING_WAIT_MS = 2 * 60_000;

const PENDING: readonly TvUpdateState[] = [
    "queued",
    "downloading",
    "waiting-confirmation",
    "installing"
];

const STATE_WORDS = {
    queued: "tv.updates.state.queued",
    downloading: "tv.updates.state.downloading",
    "waiting-confirmation": "tv.updates.state.waitingConfirmation",
    installing: "tv.updates.state.installing",
    done: "tv.updates.state.done",
    failed: "tv.updates.state.failed"
} as const satisfies Record<TvUpdateState, `tv.updates.state.${string}`>;

function pending(row: TvRow): boolean {
    return Boolean(row.update && PENDING.includes(row.update.state));
}

/** Whether a TV runs the newest build (or newer). Unknown counts as not. */
export function upToDate(row: TvRow, latest: string | null): boolean {
    return Boolean(latest && row.versionName && compareTvVersions(row.versionName, latest) >= 0);
}

/** Whether the Update button has anything to do for this TV. */
export function canUpdate(row: TvRow, latest: string | null): boolean {
    return (
        Boolean(latest) &&
        tvTakesUpdates(row.versionCode) &&
        !upToDate(row, latest) &&
        !pending(row)
    );
}

/** The row with a request queued, as the server will show it once it lands. */
function queuedRow(row: TvRow, latest: string): TvRow {
    return {
        ...row,
        update: { versionName: latest, state: "queued", reason: null, at: new Date().toISOString() }
    };
}

export function TvUpdatesView({ initial }: { initial: TvUpdatesView }) {
    const t = useTranslations("account");
    const [view, setView] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [reach, setReach] = useState<Record<string, TvFilterReach> | null>(null);
    const waitingOn = view.tvs
        .filter(blockingWaiting)
        .map((row) => `${row.id}:${row.blocking.askedAt ?? ""}`)
        .join(",");
    const [waitedOut, setWaitedOut] = useState<string | null>(null);
    const anyPending =
        view.tvs.some(pending) || (waitingOn !== "" && waitingOn !== waitedOut);

    useEffect(() => {
        if (!waitingOn) return;
        const timer = window.setTimeout(() => setWaitedOut(waitingOn), BLOCKING_WAIT_MS);
        return () => window.clearTimeout(timer);
    }, [waitingOn]);

    useEffect(() => {
        let live = true;
        void runAction(tvFilterReachAction, () => undefined).then((found) => {
            if (live) setReach(found ?? {});
        });
        return () => {
            live = false;
        };
    }, []);

    useEffect(() => {
        if (!anyPending) return;
        const timer = window.setInterval(async () => {
            const fresh = await runAction(tvUpdatesAction, () => undefined);
            if (fresh) setView(fresh);
        }, REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [anyPending]);

    async function update(target: { keyId: string } | { all: true }) {
        const latest = view.latest;
        if (!latest || busy) return;
        const before = view;
        // Shown queued at once; put back as it was if the request is refused.
        setView({
            ...view,
            tvs: view.tvs.map((row) =>
                ("all" in target || row.id === target.keyId) && canUpdate(row, latest)
                    ? queuedRow(row, latest)
                    : row
            )
        });
        setError(null);
        setBusy(true);
        const answer = await runAction(() => requestTvUpdateAction(target), setError);
        setBusy(false);
        if (!answer) {
            setView(before);
            return;
        }
        if (answer.error) {
            setView(before);
            setError(answer.error);
            return;
        }
        setView({ tvs: answer.tvs, latest: answer.latest });
    }

    /** Shown at once; that row's switch goes back if the change is refused. */
    async function changeBlocking(row: TvRow, next: boolean) {
        const restore = (tvs: TvRow[]) =>
            tvs.map((r) => (r.id === row.id ? { ...r, blocking: row.blocking } : r));
        setView((current) => ({
            ...current,
            tvs: current.tvs.map((r) =>
                r.id === row.id
                    ? {
                          ...r,
                          blocking: { desired: next, applied: null, askedAt: new Date().toISOString() }
                      }
                    : r
            )
        }));
        setError(null);
        const answer = await runAction(
            () => setTvBlockingAction({ keyId: row.id, blocking: next }),
            setError
        );
        if (!answer || answer.error) {
            setView((current) => ({ ...current, tvs: restore(current.tvs) }));
            if (answer?.error) setError(answer.error);
            return;
        }
        setView({ tvs: answer.tvs, latest: answer.latest });
    }

    async function rename(row: TvRow, name: string): Promise<boolean> {
        setError(null);
        const answer = await runAction(() => renameTvAction({ keyId: row.id, name }), setError);
        if (!answer) return false;
        setView({ tvs: answer.tvs, latest: answer.latest });
        if (answer.error) setError(answer.error);
        return !answer.error;
    }

    const updatable = view.tvs.filter((row) => canUpdate(row, view.latest)).length;

    return (
        <section className="flex flex-col gap-2" aria-labelledby="tv-updates-title">
            <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="min-w-0">
                    <h2 id="tv-updates-title" className="text-sm font-semibold">
                        {t("tv.updates.title")}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                        {view.latest
                            ? t("tv.updates.latest", { version: view.latest })
                            : t("tv.updates.noRelease")}
                    </p>
                </div>
                {view.tvs.length > 1 ? (
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={updatable === 0 || busy}
                        title={updatable === 0 ? t("tv.updates.allCurrent") : undefined}
                        onClick={() => void update({ all: true })}
                    >
                        {t("tv.updates.updateAll")}
                    </Button>
                ) : null}
            </div>
            {error ? (
                <p role="alert" className="text-xs text-danger-ink">
                    {error}
                </p>
            ) : null}
            {view.tvs.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("tv.updates.empty")}</p>
            ) : (
                <Card>
                    <CardBody className="flex flex-col divide-y divide-border p-0">
                        {view.tvs.map((row) => (
                            <TvUpdateRow
                                key={row.id}
                                row={row}
                                latest={view.latest}
                                busy={busy}
                                reach={reach ? (reach[row.id] ?? "unknown") : undefined}
                                onUpdate={() => void update({ keyId: row.id })}
                                onBlocking={(next) => void changeBlocking(row, next)}
                                onRename={(name) => rename(row, name)}
                            />
                        ))}
                    </CardBody>
                </Card>
            )}
        </section>
    );
}

function TvUpdateRow({
    row,
    latest,
    busy,
    reach,
    onUpdate,
    onBlocking,
    onRename
}: {
    row: TvRow;
    latest: string | null;
    busy: boolean;
    reach: TvFilterReach | undefined;
    onUpdate: () => void;
    onBlocking: (next: boolean) => void;
    onRename: (name: string) => Promise<boolean>;
}) {
    const t = useTranslations("account");
    const current = upToDate(row, latest);
    const status = row.update;
    const showStatus = status && (pending(row) || status.state === "failed" || !current);
    const tone =
        status?.state === "failed"
            ? "danger"
            : status?.state === "done"
              ? "success"
              : status?.state === "waiting-confirmation"
                ? "warning"
                : "neutral";
    return (
        <div className="flex min-w-0 flex-col gap-2.5 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
                <Tv className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <TvName row={row} onRename={onRename} />
                    <span className="truncate text-xs text-muted-foreground">
                        {row.versionName
                            ? t("tv.updates.runs", { version: row.versionName })
                            : t("tv.updates.versionUnknown")}
                        {row.lastSeenAt ? (
                            <>
                                {" - "}
                                {t("tv.updates.seen")} <RelativeTime iso={row.lastSeenAt} />
                            </>
                        ) : null}
                    </span>
                    {showStatus && status ? (
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <Badge variant={tone}>
                                {t(STATE_WORDS[status.state], { version: status.versionName })}
                            </Badge>
                            {status.state === "failed" && status.reason ? (
                                <span
                                    className="min-w-0 truncate text-xs text-muted-foreground"
                                    title={status.reason}
                                >
                                    {status.reason}
                                </span>
                            ) : null}
                        </span>
                    ) : null}
                </div>
                {current ? (
                    <Badge variant="success" className="shrink-0">
                        {t("tv.updates.current")}
                    </Badge>
                ) : !tvTakesUpdates(row.versionCode) ? (
                    <span
                        className="min-w-0 max-w-[45%] shrink truncate text-right text-xs text-muted-foreground"
                        title={t("tv.updates.updateOnTv")}
                    >
                        {t("tv.updates.updateOnTv")}
                    </span>
                ) : (
                    <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        disabled={!canUpdate(row, latest) || busy}
                        title={
                            !latest
                                ? t("tv.updates.noRelease")
                                : pending(row)
                                  ? t("tv.updates.alreadyAsked")
                                  : undefined
                        }
                        onClick={onUpdate}
                    >
                        {status?.state === "failed"
                            ? t("tv.updates.retry")
                            : t("tv.updates.update")}
                    </Button>
                )}
            </div>
            <div className="pl-7">
                <TvPreferences row={row} reach={reach} onBlocking={onBlocking} />
            </div>
        </div>
    );
}
