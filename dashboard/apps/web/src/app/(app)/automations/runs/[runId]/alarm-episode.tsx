"use client";

/**
 * The alarm a threshold trigger's crossing started a run for: the line it
 * crossed, when and from what value, the worst value since, and when it came
 * back and how long it lasted - or that it is still going on.
 */

import { Badge } from "@polaris/ui";
import { took } from "../runs-view";
import { when } from "@/app/(app)/automations/shared";
import type { EpisodeView } from "@/lib/automations/alarm-episodes";
import { comparatorSymbol } from "@/lib/automations/threshold-form";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { useSourceLabel } from "@/app/(app)/automations/[id]/threshold-fields";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate text-right tabular-nums">{children}</dd>
        </div>
    );
}

export function AlarmEpisodeCard({ episode }: { episode: EpisodeView }) {
    const t = useTranslations("automations");
    const locale = useLocale();
    const label = useSourceLabel();
    const number = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 2 });
    const ongoing = episode.resolvedAt === null;
    return (
        <section
            aria-label={t("episode.title")}
            className="min-w-0 space-y-2 rounded-md border border-border p-3 text-sm"
        >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <h2 className="min-w-0 truncate font-semibold">
                    {t("episode.title")}: {label(episode.source)}{" "}
                    {comparatorSymbol(episode.comparator)} {number(episode.threshold)}
                </h2>
                <Badge variant={ongoing ? "danger" : "success"}>
                    {t(ongoing ? "episode.ongoing" : "episode.resolved")}
                </Badge>
            </div>
            <dl className="space-y-1">
                <Row label={t("episode.started")}>
                    {when(episode.startedAt, locale)} ({number(episode.startValue)})
                </Row>
                <Row label={t("episode.worst")}>{number(episode.peakValue)}</Row>
                <Row label={t("episode.ended")}>
                    {ongoing
                        ? t("episode.notYet")
                        : `${when(episode.resolvedAt, locale)}${episode.endValue === null ? "" : ` (${number(episode.endValue)})`}`}
                </Row>
                <Row label={t("episode.duration")}>
                    {ongoing
                        ? t("episode.sinceStart", {
                              time: took(episode.startedAt, new Date().toISOString())
                          })
                        : took(episode.startedAt, episode.resolvedAt)}
                </Row>
            </dl>
        </section>
    );
}
