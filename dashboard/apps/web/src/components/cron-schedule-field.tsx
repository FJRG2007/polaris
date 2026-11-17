"use client";

import { useMemo } from "react";
import * as core from "@polaris/core";
import { Input, cn } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** Schedules offered with one click, because most schedules are one of these. */
export const CRON_PRESETS = [
    { label: "cron.presets.every15", schedule: "*/15 * * * *" },
    { label: "cron.presets.hourly", schedule: "0 * * * *" },
    { label: "cron.presets.daily", schedule: "0 3 * * *" },
    { label: "cron.presets.mondays", schedule: "0 9 * * 1" },
    { label: "cron.presets.monthly", schedule: "0 0 1 * *" }
] as const;

/** The browser's own time zone, or UTC when it will not say. */
export function browserTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
}

/**
 * A cron schedule picked from presets or typed, with its time zone, read back
 * in words with its next firing. Shared by scheduled jobs and scheduled
 * sessions, so a schedule is written the same way everywhere.
 */
export function CronScheduleField({
    schedule,
    timezone,
    onSchedule,
    onTimezone,
    onBlurSchedule,
    onBlurTimezone,
    error
}: {
    schedule: string;
    timezone: string;
    onSchedule: (value: string) => void;
    onTimezone: (value: string) => void;
    onBlurSchedule?: () => void;
    onBlurTimezone?: () => void;
    /** The field's complaint, once it should be shown. */
    error?: string;
}) {
    const t = useTranslations("deployConfig");
    const format = useDisplayFormat();
    const next = useMemo(() => {
        try {
            return core.nextCronRun(core.parseCron(schedule), new Date(), timezone || "UTC");
        } catch {
            return null;
        }
    }, [schedule, timezone]);
    return (
        <>
            <div className="flex flex-wrap gap-1.5">
                {CRON_PRESETS.map((preset) => (
                    <button
                        key={preset.schedule}
                        type="button"
                        onClick={() => onSchedule(preset.schedule)}
                        className={cn(
                            "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                            schedule === preset.schedule
                                ? "border-primary/50 bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {t(preset.label)}
                    </button>
                ))}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_12rem]">
                <Input
                    value={schedule}
                    onChange={(event) => onSchedule(event.target.value)}
                    onBlur={onBlurSchedule}
                    className="font-mono"
                    spellCheck={false}
                    aria-label={t("cron.expression")}
                />
                <Input
                    value={timezone}
                    onChange={(event) => onTimezone(event.target.value)}
                    onBlur={onBlurTimezone}
                    spellCheck={false}
                    aria-label={t("cron.timezone")}
                    // i18n-ignore: a time zone name
                    placeholder="UTC"
                />
            </div>
            {error ? (
                <span className="text-xs text-danger">{error}</span>
            ) : (
                <span className="text-xs text-muted-foreground">
                    {core.describeCron(schedule)}
                    {next ? t("cron.next", { when: format.dateTime(next.toISOString()) }) : ""}
                </span>
            )}
        </>
    );
}
