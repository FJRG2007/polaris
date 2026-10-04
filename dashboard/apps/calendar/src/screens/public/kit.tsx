"use client";

/**
 * Small pieces the booking, proposal, answer, room, sharing and account screens
 * share: the frame a public page is drawn in, a refused value in the reader's
 * words, a time range in a zone, and a status line.
 */

import { cn } from "@polaris/ui";
import type { ReactNode } from "react";
import { useCalendarT } from "../i18n";
import { hostUi } from "@polaris/app-host/client";
import type { CalendarKey } from "../../../messages";
import { calendarCatalogs } from "../../../messages";
import { issueKey } from "../../lib/scheduling-schemas";

/** A schema's refusal as the sentence to show: our key, the engine's, or a
 *  plain "check what you entered". */
export function useIssueText(): (issues: readonly { message: string }[]) => string {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const rule = calendarCatalogs.translator(locale, "calendarRule");
    return (issues) => {
        const key = issueKey(issues);
        if (key && t.has(key)) return t(key as CalendarKey);
        const engineKey = `validation.${issues[0]?.message ?? ""}`;
        if (rule.has(engineKey)) return rule(engineKey as never);
        return t("errors.checkInput");
    };
}

/** "Tuesday 4 March, 10:00 - 10:30" in a zone, in the reader's language. */
export function formatRange(
    start: string,
    end: string,
    zone: string,
    locale: string,
    allDay = false
): string {
    const from = new Date(start);
    const to = new Date(end);
    if (allDay)
        return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).format(from);
    const day = new Intl.DateTimeFormat(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: zone
    }).format(from);
    const time = new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: zone
    });
    return `${day}, ${time.format(from)} - ${time.format(to)}`;
}

/** "10:00" in a zone. */
export function formatTime(instant: string, zone: string, locale: string): string {
    return new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: zone
    }).format(new Date(instant));
}

/** The frame of a page somebody outside Polaris opens from a link. */
export function PublicFrame({
    title,
    subtitle,
    children,
    wide = false
}: {
    title: ReactNode;
    subtitle?: ReactNode;
    children: ReactNode;
    wide?: boolean;
}) {
    return (
        <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:py-12">
            <div
                className={cn(
                    "mx-auto flex w-full flex-col gap-5",
                    wide ? "max-w-5xl" : "max-w-xl"
                )}
            >
                <header className="flex flex-col gap-1">
                    <h1 className="text-[17px] font-semibold tracking-tight">{title}</h1>
                    {subtitle ? <div className="text-muted-foreground">{subtitle}</div> : null}
                </header>
                {children}
            </div>
        </main>
    );
}

/** A line saying how something stands, in the status colours. */
export function StatusNote({
    tone,
    children,
    className
}: {
    tone: "success" | "warning" | "danger" | "neutral";
    children: ReactNode;
    className?: string;
}) {
    const tones = {
        success: "border-success-edge bg-success-soft text-success-ink",
        warning: "border-warning-edge bg-warning-soft text-warning-ink",
        danger: "border-danger-edge bg-danger-soft text-danger-ink",
        neutral: "border-border bg-card text-muted-foreground"
    } as const;
    return (
        <div
            role={tone === "danger" ? "alert" : "status"}
            className={cn("rounded-md border px-3 py-2 text-[13px]", tones[tone], className)}
        >
            {children}
        </div>
    );
}
