"use client";

/**
 * The printed report: the window's headline numbers, its trend and every
 * ranking the overview shows, black on white whatever the reader's theme is.
 * The print dialog opens on its own once the page has drawn; the button stays
 * for anybody who cancelled it and wants it back.
 */

import * as core from "@polaris/core";
import { Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { rowLabel } from "@/app/(app)/analytics/analytics-sections";
import { duration, grouped, percent } from "@/app/(app)/analytics/analytics-format";

/** A moment for the page to lay out before the dialog opens over it. */
const SETTLE_MS = 600;

/** The rankings, in the overview's order, with the title each one has there.
 *  Addresses are left off: a report is made to be passed on. */
const SECTIONS: readonly { dimension: core.VisitDimension; title: string }[] = [
    { dimension: "path", title: "breakdowns.pages" },
    { dimension: "entry", title: "breakdowns.entry" },
    { dimension: "exit", title: "breakdowns.exit" },
    { dimension: "channel", title: "breakdowns.channels" },
    { dimension: "referrer", title: "breakdowns.referrers" },
    { dimension: "campaign", title: "breakdowns.campaigns" },
    { dimension: "country", title: "breakdowns.countries" },
    { dimension: "language", title: "breakdowns.languages" },
    { dimension: "browser", title: "breakdowns.browsers" },
    { dimension: "os", title: "breakdowns.systems" },
    { dimension: "device", title: "breakdowns.devices" },
    { dimension: "screen", title: "breakdowns.screens" },
    { dimension: "event", title: "breakdowns.events" }
];

export interface ReportViewProps {
    name: string;
    range: core.VisitRange;
    filters: readonly core.VisitFilter[];
    from: number;
    to: number;
    overview: core.VisitOverview;
    series: readonly core.VisitPoint[];
    breakdowns: core.VisitReport["breakdowns"];
    unavailable: readonly core.VisitDimension[];
    filtersIgnored: boolean;
}

export function ReportView(props: ReportViewProps) {
    const t = useTranslations("analytics");
    const format = useDisplayFormat();
    const [asked, setAsked] = useState(false);

    useEffect(() => {
        if (asked) return;
        const timer = setTimeout(() => {
            setAsked(true);
            window.print();
        }, SETTLE_MS);
        return () => clearTimeout(timer);
    }, [asked]);

    const { overview } = props;
    const figures: readonly [string, string][] = [
        [t("cards.visitors"), grouped(overview.visitors)],
        [t("tabs.sessions"), grouped(overview.sessions)],
        [t("cards.pageviews"), grouped(overview.views)],
        [t("tabs.events"), grouped(overview.events)],
        [t("cards.bounce"), percent(overview.bounceRate)],
        [t("cards.duration"), duration(overview.avgVisitSec)]
    ];
    const peak = Math.max(1, ...props.series.map((point) => point.visitors));

    return (
        <div className="min-h-dvh bg-white">
            <main className="mx-auto max-w-3xl bg-white px-6 py-8 text-[#111111] print:max-w-none print:p-0">
                <header className="mb-6 flex items-start gap-4 border-b border-[#dddddd] pb-4">
                    <div className="min-w-0 flex-1">
                        <p className="text-[12px] text-[#555555]">{t("report.title")}</p>
                        <h1 className="break-words text-[22px] font-semibold leading-tight">{props.name}</h1>
                        <p className="mt-1 text-[12px] text-[#555555]">
                            {t(`ranges.r${props.range}` as never)} - {format.dateTime(props.from)} -{" "}
                            {format.dateTime(props.to)}
                        </p>
                        {props.filters.length > 0 ? (
                            <p className="mt-1 break-words text-[12px] text-[#555555]">
                                {props.filters
                                    .map(
                                        (filter) =>
                                            `${t(`filters.dims.${filter.dimension}` as never)} ${t(
                                                filter.negate ? "filters.isNot" : "filters.is"
                                            )} ${filter.dimension === "country" ? core.countryName(filter.value) : filter.value}`
                                    )
                                    .join(", ")}
                            </p>
                        ) : null}
                        {props.filtersIgnored ? (
                            <p className="mt-1 text-[12px] text-[#555555]">{t("filters.ignoredLong")}</p>
                        ) : null}
                    </div>
                    <button
                        type="button"
                        className="flex shrink-0 items-center gap-1.5 rounded-md border border-[#cccccc] px-3 py-1.5 text-[13px] print:hidden"
                        onClick={() => window.print()}
                    >
                        <Printer className="size-4 shrink-0" aria-hidden />
                        {t("report.print")}
                    </button>
                </header>

                <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 print:grid-cols-3">
                    {figures.map(([label, value]) => (
                        <div key={label} className="rounded-md border border-[#dddddd] px-3 py-2">
                            <dt className="text-[12px] text-[#555555]">{label}</dt>
                            <dd className="text-[20px] font-semibold tabular-nums">{value}</dd>
                        </div>
                    ))}
                </dl>

                {props.series.length > 0 ? (
                    <section className="mb-6 break-inside-avoid-page">
                        <h2 className="mb-2 text-[14px] font-semibold">{t("report.trend")}</h2>
                        <svg
                            viewBox={`0 0 ${props.series.length * 10} 100`}
                            preserveAspectRatio="none"
                            className="h-28 w-full"
                            role="img"
                            aria-label={t("report.trend")}
                        >
                            {props.series.map((point, index) => {
                                const height = (point.visitors / peak) * 96;
                                return (
                                    <rect
                                        key={point.t}
                                        x={index * 10 + 1}
                                        y={100 - height}
                                        width={8}
                                        height={height}
                                        fill="#6d28d9"
                                    >
                                        <title>{`${format.dateTime(point.t)}: ${grouped(point.visitors)}`}</title>
                                    </rect>
                                );
                            })}
                        </svg>
                        <div className="mt-1 flex justify-between gap-2 text-[11px] text-[#555555]">
                            <span>{format.date(props.series[0]!.t)}</span>
                            <span>{format.date(props.series[props.series.length - 1]!.t)}</span>
                        </div>
                    </section>
                ) : null}

                <div className="grid gap-6 sm:grid-cols-2 print:grid-cols-2">
                    {SECTIONS.map(({ dimension, title }) => {
                        const rows = props.breakdowns[dimension] ?? [];
                        const unkept = props.unavailable.includes(dimension);
                        return (
                            <section key={dimension} className="min-w-0 break-inside-avoid-page">
                                <h2 className="mb-1 text-[14px] font-semibold">{t(title as never)}</h2>
                                {unkept || rows.length === 0 ? (
                                    <p className="text-[12px] text-[#555555]">
                                        {unkept ? t("breakdowns.notKept") : t("report.none")}
                                    </p>
                                ) : (
                                    <table className="w-full table-fixed text-[12px]">
                                        <thead>
                                            <tr className="border-b border-[#dddddd] text-left text-[#555555]">
                                                <th className="py-1 font-normal" />
                                                <th className="w-20 py-1 text-right font-normal">
                                                    {t("cards.visitors")}
                                                </th>
                                                <th className="w-20 py-1 text-right font-normal">
                                                    {t("cards.pageviews")}
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {rows.map((row) => (
                                                <tr key={row.key} className="border-b border-[#eeeeee]">
                                                    <td className="truncate py-1 pr-2" title={row.key}>
                                                        {rowLabel(dimension, row.key)}
                                                    </td>
                                                    <td className="py-1 text-right tabular-nums">
                                                        {grouped(row.visitors)}
                                                    </td>
                                                    <td className="py-1 text-right tabular-nums">
                                                        {grouped(row.views)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                )}
                            </section>
                        );
                    })}
                </div>

                <p className="mt-8 text-[11px] text-[#777777]">
                    {t("report.generated", { at: format.dateTime(props.to) })}
                </p>
            </main>
        </div>
    );
}
