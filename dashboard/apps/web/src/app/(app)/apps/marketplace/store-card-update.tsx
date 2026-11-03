"use client";

/**
 * An installed Polaris app's update, on its store card, the way a phone's store
 * shows one: the new version under the summary and Update where Open was.
 *
 * The rows come from `useAppUpdates`, the hook the Settings card reads, so both
 * screens say the same thing and change it through the same actions. Only a
 * reader who may change apps is handed `onUpdate`; anyone else reads the state.
 */

import { ArrowUpCircle } from "lucide-react";
import { Button, Skeleton } from "@polaris/ui";
import type { AppUpdateRow } from "@/lib/app-bundles/actions";
import type { UpdateRefusal } from "@/lib/app-bundles/releases";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { buildLabel, newerBuild, progressPercent } from "@/components/app-bundles/use-app-updates";

export interface CardUpdateState {
    /** The rows have not answered yet. */
    readonly loading: boolean;
    /** This app's row, once they have; none for an app with no build of its own. */
    readonly row: AppUpdateRow | null;
    /** This app is the one being updated. */
    readonly busy: boolean;
    /** Another app is being updated: one at a time. */
    readonly locked: boolean;
    readonly refused?: UpdateRefusal;
    /** Present only for a reader who may change apps. */
    readonly onUpdate?: () => void;
}

/** The line under a card's summary: the new version, how far its update got, or why it did not. */
export function CardUpdateNote({ state }: { state: CardUpdateState }) {
    const t = useTranslations("components");
    const { row, busy, refused } = state;
    if (state.loading)
        return (
            <Skeleton
                className="h-4 w-32"
                role="status"
                aria-label={t("appUpdates.checking")}
                title={t("appUpdates.checking")}
            />
        );
    if (!row) return null;
    const newer = newerBuild(row);
    let line: string | null = null;
    if (newer && !newer.runs) line = t("appUpdates.needsPolaris", { version: buildLabel(newer) });
    else if (newer) line = t("appUpdates.available", { version: buildLabel(newer) });
    else if (row.checkFailed) line = t("appUpdates.checkFailed");
    else if (row.installed)
        line = t("appUpdates.installed", { version: buildLabel(row.installed) });
    const percent = progressPercent(row);

    return (
        <div className="flex min-w-0 flex-col gap-1">
            {line && !busy ? (
                <p
                    className={
                        newer
                            ? "truncate text-xs font-medium text-foreground"
                            : "truncate text-xs text-muted-foreground"
                    }
                    title={line}
                >
                    {line}
                </p>
            ) : null}
            {busy ? (
                <div className="flex min-w-0 flex-col gap-1" aria-live="polite">
                    <div
                        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                        aria-label={t("appUpdates.updating")}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent ?? undefined}
                    >
                        <div
                            className="h-full bg-primary transition-[width]"
                            style={{ width: `${percent ?? 10}%` }}
                        />
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                        {t(`appUpdates.phase.${row.progress?.phase ?? "checking"}`)}
                    </p>
                </div>
            ) : null}
            {refused ? (
                <p role="alert" className="break-words text-xs text-danger">
                    {t(`appUpdates.refused.${refused}`, { name: row.name })}
                </p>
            ) : null}
        </div>
    );
}

/** Whether the card leads with Update instead of its usual action. */
export function leadsWithUpdate(state: CardUpdateState | undefined): boolean {
    return Boolean(state?.onUpdate && state.row && newerBuild(state.row)?.runs);
}

/** Update, where the card's leading action was. */
export function CardUpdateButton({ state }: { state: CardUpdateState }) {
    const t = useTranslations("components");
    return (
        <Button
            size="sm"
            disabled={state.locked}
            aria-busy={state.busy || undefined}
            onClick={state.onUpdate}
        >
            <ArrowUpCircle className={state.busy ? "size-4 animate-pulse" : "size-4"} />
            {state.busy ? t("appUpdates.updating") : t("appUpdates.updateShort")}
        </Button>
    );
}
