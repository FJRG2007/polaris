"use client";

/**
 * The Overview's "Ad blocker" card: today's lookups on the network, how many
 * were blocked, the day hour by hour, and a quick pause. Administrators only,
 * like the app's own screen, so whoever sees the card may also pause it.
 */

import Link from "next/link";
import type { Loaded } from "./infrastructure";
import { useState, useTransition } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { Badge, Button, Skeleton } from "@polaris/ui";
import type { HourCount } from "@/lib/dns-blocker/insights";
import { WidgetEmpty, WidgetUnavailable } from "../widget-card";
import type { OverviewDnsBlocker } from "@/lib/overview/overview-service";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    pauseDnsBlockingAction,
    resumeDnsBlockingAction
} from "@/app/(app)/apps/dns-blocker/actions";

const APP_HREF = "/apps/dns-blocker";

/** How long the card's pause lasts; the app's own screen offers the rest. */
const QUICK_PAUSE_MINUTES = 15;

type Pause = NonNullable<OverviewDnsBlocker["today"]>["pause"];

/** Permitted and blocked over the same scale, so the gap between them reads. */
export function DnsSparkline({ hourly }: { hourly: readonly HourCount[] }) {
    if (hourly.length < 2) return <div className="h-8" />;
    const max = Math.max(1, ...hourly.map((hour) => Math.max(hour.allowed, hour.blocked)));
    const step = 100 / (hourly.length - 1);
    const path = (pick: (hour: HourCount) => number) =>
        hourly
            .map(
                (hour, index) =>
                    `${index === 0 ? "M" : "L"} ${(index * step).toFixed(2)} ${(100 - (pick(hour) / max) * 100).toFixed(2)}`
            )
            .join(" ");
    return (
        <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="h-8 w-full"
            aria-hidden="true"
        >
            {[
                { d: path((hour) => hour.allowed), tone: "text-primary" },
                { d: path((hour) => hour.blocked), tone: "text-danger" }
            ].map((line) => (
                <path
                    key={line.tone}
                    d={line.d}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={line.tone}
                />
            ))}
        </svg>
    );
}

function Figure({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-w-0 flex-col">
            <span className="truncate text-xs text-muted-foreground" title={label}>
                {label}
            </span>
            <span className="truncate text-lg font-semibold tabular-nums" title={value}>
                {value}
            </span>
        </div>
    );
}

/** Shaped like the figures and the line, so the card does not move when they land. */
function DnsBlockerSkeleton() {
    return (
        <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
            <Skeleton className="h-5 w-24" />
            <div className="grid grid-cols-3 gap-3">
                {[0, 1, 2].map((index) => (
                    <div key={index} className="flex flex-col gap-1.5">
                        <Skeleton className="h-3 w-3/4" />
                        <Skeleton className="h-5 w-1/2" />
                    </div>
                ))}
            </div>
            <Skeleton className="h-8 w-full" />
        </div>
    );
}

export function DnsBlockerWidget({ data }: { data: Loaded<OverviewDnsBlocker> }) {
    const t = useTranslations("home");
    const locale = useLocale();
    // The pause as this card last set it, ahead of the next read. Tied to the
    // read it was set over, so a newer one replaces it.
    const [override, setOverride] = useState<{ over: OverviewDnsBlocker; pause: Pause } | null>(
        null
    );
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    if (data === undefined) return <DnsBlockerSkeleton />;
    if (data === null) return <WidgetUnavailable>{t("dnsBlocker.unavailable")}</WidgetUnavailable>;
    const read = data;
    const today = read.today;
    if (!today) {
        return (
            <WidgetEmpty
                action={
                    <Link
                        href={APP_HREF}
                        className="text-xs font-medium text-primary hover:underline"
                    >
                        {t("dnsBlocker.open")}
                    </Link>
                }
            >
                {t("dnsBlocker.off")}
            </WidgetEmpty>
        );
    }

    const pause = override?.over === read ? override.pause : today.pause;
    const paused = !pause.enabled;
    const number = new Intl.NumberFormat(locale);
    const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    const state = !paused
        ? t("dnsBlocker.active")
        : pause.secondsLeft
          ? t("dnsBlocker.pausedFor", { minutes: Math.ceil(pause.secondsLeft / 60) })
          : t("dnsBlocker.paused");

    function toggle(): void {
        const previous = pause;
        const next: Pause = paused
            ? { enabled: true, secondsLeft: null }
            : { enabled: false, secondsLeft: QUICK_PAUSE_MINUTES * 60 };
        setError(null);
        setOverride({ over: read, pause: next });
        startTransition(async () => {
            const result = paused
                ? await resumeDnsBlockingAction()
                : await pauseDnsBlockingAction({ seconds: QUICK_PAUSE_MINUTES * 60 });
            if (result.error !== undefined) {
                setOverride({ over: read, pause: previous });
                setError(result.error);
            }
        });
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <Badge variant={paused ? "warning" : "success"}>{state}</Badge>
                <Button
                    variant="secondary"
                    size="xs"
                    disabled={pending}
                    onClick={toggle}
                    title={paused ? t("dnsBlocker.resume") : t("dnsBlocker.pauseHint")}
                >
                    {pending ? (
                        <Loader2 className="size-3.5 shrink-0 animate-spin" />
                    ) : paused ? (
                        <Play className="size-3.5 shrink-0" />
                    ) : (
                        <Pause className="size-3.5 shrink-0" />
                    )}
                    {paused ? t("dnsBlocker.resume") : t("dnsBlocker.pause")}
                </Button>
            </div>
            {error ? (
                <p role="alert" className="text-xs text-danger-ink">
                    {error}
                </p>
            ) : null}
            <div className="grid grid-cols-3 gap-3">
                <Figure label={t("dnsBlocker.queries")} value={number.format(today.queries)} />
                <Figure label={t("dnsBlocker.blocked")} value={number.format(today.blocked)} />
                <Figure
                    label={t("dnsBlocker.share")}
                    value={`${percent.format(today.blockedPercent)}%`}
                />
            </div>
            <div className="flex flex-col gap-1">
                <DnsSparkline hourly={today.hourly} />
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                        <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full bg-primary"
                        />
                        {t("dnsBlocker.permitted")}
                    </span>
                    <span className="flex items-center gap-1.5">
                        <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full bg-danger"
                        />
                        {t("dnsBlocker.blocked")}
                    </span>
                </div>
            </div>
        </div>
    );
}
