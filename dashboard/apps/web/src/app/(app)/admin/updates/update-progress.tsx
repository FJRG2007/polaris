"use client";

/**
 * The bar under a running update: elapsed against what past updates on this
 * deployment took, with the time left - or, past the estimate, a plain "taking
 * longer than usual" while the bar keeps creeping instead of sitting at 99%.
 */

import { useTranslations } from "@/components/i18n/i18n-provider";
import { updateProgress } from "@/lib/update-timing";

export interface WatchedRun {
    readonly startedAt: number;
    readonly estimateMs: number;
    /** This browser's clock minus the server's, so elapsed is the server's. */
    readonly skew: number;
}

export function UpdateProgress({ run, now }: { run: WatchedRun; now: number }) {
    const t = useTranslations("admin");
    const progress = updateProgress(now - run.skew - run.startedAt, run.estimateMs);
    const percent = Math.floor(progress.fraction * 100);
    const minutes = Math.ceil(progress.remainingMs / 60_000);
    const label = progress.overdue
        ? t("settings.progress.longer")
        : progress.remainingMs < 60_000
          ? t("settings.progress.almost")
          : t("settings.progress.left", { minutes });
    return (
        <div className="flex flex-col gap-1" aria-live="polite">
            <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={t("settings.progress.label")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={label}
            >
                <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">{label}</p>
        </div>
    );
}
