"use client";

/**
 * Each installed app's own build, and the newest one published for it: update
 * one alone, or put back the one before, without restarting Polaris.
 *
 * Paints at once and asks for the rows after; an update in flight is polled
 * for how far it got, so the bar moves while the download runs.
 */

import { z } from "zod";
import { isNativeApp } from "@/lib/apps/native-apps";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpCircle, RotateCcw, RotateCw } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle, Skeleton } from "@polaris/ui";
import {
    appUpdatesAction,
    changeAppBuildAction,
    type AppUpdateRow
} from "@/lib/app-bundles/actions";
import type { UpdateRefusal } from "@/lib/app-bundles/releases";

const POLL_MS = 1_000;

const Progress = z.record(
    z.string(),
    z.object({
        phase: z.enum(["checking", "downloading", "starting"]),
        received: z.number().nonnegative(),
        total: z.number().nonnegative()
    })
);

/** A build as a reader tells two apart: its version and the start of its digest. */
function buildLabel(build: { version?: string; digest: string }): string {
    const short = build.digest.replace(/^sha256:/, "").slice(0, 7);
    return build.version ? `${build.version} (${short})` : short;
}

export function AppUpdatesCard() {
    const t = useTranslations("components");
    const [rows, setRows] = useState<AppUpdateRow[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [refusals, setRefusals] = useState<Record<string, UpdateRefusal>>({});
    const poll = useRef<ReturnType<typeof setInterval> | null>(null);

    const load = useCallback(async (check: boolean) => {
        try {
            setRows(await appUpdatesAction(check));
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, []);

    const track = useCallback(async (id: string) => {
        try {
            const response = await fetch("/api/app-bundles/progress", { cache: "no-store" });
            if (!response.ok) return;
            const parsed = Progress.safeParse(await response.json());
            if (!parsed.success) return;
            const progress = parsed.data[id];
            if (!progress || !poll.current) return;
            setRows(
                (all) => all?.map((row) => (row.id === id ? { ...row, progress } : row)) ?? all
            );
        } catch {
            return;
        }
    }, []);

    useEffect(() => {
        void load(true);
        return () => {
            if (poll.current) clearInterval(poll.current);
        };
    }, [load]);

    async function change(id: string, kind: "update" | "rollback") {
        setBusy(id);
        setRefusals(({ [id]: _dropped, ...rest }) => rest);
        poll.current = setInterval(() => void track(id), POLL_MS);
        try {
            const result = await changeAppBuildAction(id, kind);
            setRows(result.rows);
            if (result.refused) setRefusals((all) => ({ ...all, [id]: result.refused! }));
        } catch {
            setRefusals((all) => ({ ...all, [id]: "failed" }));
        } finally {
            if (poll.current) clearInterval(poll.current);
            poll.current = null;
            setBusy(null);
        }
    }

    return (
        <Card className="mt-4" id="app-updates">
            <CardHeader className="flex flex-row items-center justify-between gap-3">
                <CardTitle>{t("appUpdates.title")}</CardTitle>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("appUpdates.check")}
                    title={t("appUpdates.check")}
                    disabled={busy !== null}
                    onClick={() => void load(true)}
                >
                    <RotateCw />
                </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{t("appUpdates.body")}</p>
                {rows === null && !failed ? (
                    <div className="flex flex-col gap-2" aria-hidden>
                        <Skeleton className="h-12 w-full" />
                        <Skeleton className="h-12 w-full" />
                    </div>
                ) : null}
                {failed && rows === null ? (
                    <p role="alert" className="text-sm text-danger">
                        {t("appUpdates.loadFailed")}
                    </p>
                ) : null}
                {rows?.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("appUpdates.none")}</p>
                ) : null}
                {rows?.map((row) => (
                    <AppRow
                        key={row.id}
                        row={row}
                        busy={busy === row.id}
                        locked={busy !== null}
                        refused={refusals[row.id]}
                        onChange={(kind) => void change(row.id, kind)}
                    />
                ))}
            </CardBody>
        </Card>
    );
}

function AppRow({
    row,
    busy,
    locked,
    refused,
    onChange
}: {
    row: AppUpdateRow;
    busy: boolean;
    locked: boolean;
    refused?: UpdateRefusal;
    onChange: (kind: "update" | "rollback") => void;
}) {
    const t = useTranslations("components");
    const newer =
        row.available && row.available.digest !== row.installed?.digest ? row.available : null;
    const progress = row.progress;
    const percent =
        progress && progress.total > 0
            ? Math.min(100, Math.round((progress.received / progress.total) * 100))
            : null;

    // A native app is part of every Polaris: it runs a build, nobody installed it.
    const running = isNativeApp(row.id) ? "appUpdates.builtIn" : "appUpdates.installed";
    let status: string;
    if (!row.installed) status = t("appUpdates.notHere");
    else if (newer && !newer.runs)
        status = t("appUpdates.needsPolaris", { version: buildLabel(newer) });
    else if (newer) status = t("appUpdates.available", { version: buildLabel(newer) });
    else if (row.checkFailed) status = t("appUpdates.checkFailed");
    else status = t("appUpdates.upToDate");

    return (
        <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={row.name}>
                        {row.name}
                    </p>
                    <p className="break-words text-xs text-muted-foreground">
                        {row.installed ? t(running, { version: buildLabel(row.installed) }) : null}
                        {row.installed ? " - " : null}
                        {status}
                    </p>
                    {newer?.notes ? (
                        <p className="mt-1 break-words text-xs text-muted-foreground">
                            {newer.notes}
                        </p>
                    ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {row.previous ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t("appUpdates.rollback", {
                                version: buildLabel(row.previous)
                            })}
                            title={t("appUpdates.rollback", { version: buildLabel(row.previous) })}
                            disabled={locked}
                            onClick={() => onChange("rollback")}
                        >
                            <RotateCcw />
                        </Button>
                    ) : null}
                    {newer?.runs ? (
                        <Button size="sm" disabled={locked} onClick={() => onChange("update")}>
                            <ArrowUpCircle className={busy ? "animate-pulse" : undefined} />
                            {busy ? t("appUpdates.updating") : t("appUpdates.update")}
                        </Button>
                    ) : null}
                </div>
            </div>
            {busy ? (
                <div className="flex flex-col gap-1" aria-live="polite">
                    <div
                        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent ?? undefined}
                    >
                        <div
                            className="h-full bg-primary transition-[width]"
                            style={{ width: `${percent ?? 10}%` }}
                        />
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {t(`appUpdates.phase.${progress?.phase ?? "checking"}`)}
                    </p>
                </div>
            ) : null}
            {refused ? (
                <p role="alert" className="text-xs text-danger">
                    {t(`appUpdates.refused.${refused}`, { name: row.name })}
                </p>
            ) : null}
        </div>
    );
}
