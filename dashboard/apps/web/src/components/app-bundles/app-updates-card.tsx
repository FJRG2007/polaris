"use client";

/**
 * Each installed app's own build, and the newest one published for it: update
 * one alone, or put back the one before, without restarting Polaris.
 *
 * Paints at once and asks for the rows after; an update in flight is polled
 * for how far it got, so the bar moves while the download runs.
 */

import { ArrowUpCircle, RotateCcw, RotateCw } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AppUpdateRow } from "@/lib/app-bundles/actions";
import type { UpdateRefusal } from "@/lib/app-bundles/releases";
import { Button, Card, CardBody, CardHeader, CardTitle, Skeleton } from "@polaris/ui";
import { buildLabel, newerBuild, progressPercent, useAppUpdates } from "./use-app-updates";

export function AppUpdatesCard() {
    const t = useTranslations("components");
    const { rows, failed, busy, refusals, load, change } = useAppUpdates();

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
    const newer = newerBuild(row);
    const progress = row.progress;
    const percent = progressPercent(row);

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
                        {row.installed
                            ? t("appUpdates.installed", { version: buildLabel(row.installed) })
                            : null}
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
