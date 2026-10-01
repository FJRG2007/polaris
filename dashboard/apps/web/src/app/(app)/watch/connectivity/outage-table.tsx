"use client";

/**
 * Every outage of the last year, filterable and exportable.
 *
 * The filters are the ones the data asks for: what kind it was, how long ago,
 * how long it lasted, and a day picked on the heatmap. They compose, live in the
 * address bar (see `useFilters`), and show as chips that can each be removed. The
 * export takes exactly what is listed, in the reader's language.
 *
 * Rows arrive fifty at a time: a year of a flaky line is thousands of them, and
 * nobody reads past the first screen without narrowing it first.
 */

import { useMemo, useState } from "react";
import { Download, X } from "lucide-react";
import { downloadBytes } from "@/lib/download";
import * as rules from "@/lib/connectivity/outages";
import * as list from "@/lib/connectivity/outage-list";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { OutageView } from "@/lib/connectivity/outage-tracker";
import {
    Badge,
    Button,
    Card,
    CardHeader,
    CardTitle,
    EmptyState,
    SegmentedControl,
    Select,
    Skeleton
} from "@polaris/ui";

const PAGE = 50;

export function OutageTable({
    outages,
    truncated,
    filters,
    onFilters,
    now,
    staleMs,
    span
}: {
    outages: readonly OutageView[] | null;
    truncated: boolean;
    filters: list.OutageFilters;
    onFilters: (next: list.OutageFilters) => void;
    now: number;
    staleMs: number;
    span: (ms: number) => string;
}) {
    const t = useTranslations("watch");
    const format = useDisplayFormat();
    const [shown, setShown] = useState(PAGE);

    const kept = useMemo(
        () => (outages ? list.filterOutages(outages, filters, now, staleMs) : null),
        [outages, filters, now, staleMs]
    );
    const filtered = filters.kinds.length > 0 || filters.min !== "any" || filters.day !== null;
    const kindName = (kind: rules.OutageKind) => t(`connectivity.kinds.${kind}`);
    const firstBackName = (value: string) =>
        value === rules.BACK_VIA_INTERNET ? t("connectivity.list.backInternet") : value;

    const exportCsv = () => {
        if (!kept || kept.length === 0) return;
        const csv = list.outagesCsv(
            kept,
            {
                headers: {
                    started: t("connectivity.list.started"),
                    ended: t("connectivity.list.ended"),
                    durationSeconds: t("connectivity.csv.durationSeconds"),
                    kind: t("connectivity.list.kind"),
                    detectedBy: t("connectivity.list.detectedBy"),
                    detail: t("connectivity.list.detail"),
                    firstBack: t("connectivity.list.firstBack"),
                    closedBy: t("connectivity.csv.closedBy")
                },
                kind: kindName,
                firstBack: firstBackName,
                closedBy: (value) =>
                    value === "unobserved"
                        ? t("connectivity.csv.unobserved")
                        : t("connectivity.csv.recovered"),
                ongoing: t("connectivity.list.ongoing")
            },
            now,
            staleMs
        );
        downloadBytes(
            new Blob([csv], { type: "text/csv;charset=utf-8" }),
            list.csvFileName(kept, filters)
        );
    };

    const toggleKind = (kind: rules.OutageKind) => {
        const kinds = filters.kinds.includes(kind)
            ? filters.kinds.filter((entry) => entry !== kind)
            : [...filters.kinds, kind];
        setShown(PAGE);
        onFilters({ ...filters, kinds });
    };

    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-baseline gap-2">
                    <CardTitle>{t("connectivity.list.title")}</CardTitle>
                    {kept && outages ? (
                        <span className="text-xs text-muted-foreground tabular">
                            {t("connectivity.list.shown", {
                                shown: kept.length,
                                total: outages.length
                            })}
                        </span>
                    ) : null}
                </div>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={exportCsv}
                    aria-disabled={!kept || kept.length === 0}
                    aria-label={t("connectivity.list.exportTitle")}
                    title={t("connectivity.list.export")}
                >
                    <Download aria-hidden="true" />
                </Button>
            </CardHeader>

            <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                    <div
                        role="group"
                        aria-label={t("connectivity.filters.kind")}
                        className="flex flex-wrap gap-1"
                    >
                        {rules.OUTAGE_KINDS.map((kind) => {
                            const active = filters.kinds.includes(kind);
                            return (
                                <Button
                                    key={kind}
                                    variant={active ? "secondary" : "outline"}
                                    size="sm"
                                    aria-pressed={active}
                                    onClick={() => toggleKind(kind)}
                                    title={t(`connectivity.kindHints.${kind}`)}
                                >
                                    {kindName(kind)}
                                </Button>
                            );
                        })}
                    </div>
                    <SegmentedControl<list.Range>
                        size="sm"
                        aria-label={t("connectivity.filters.range")}
                        value={filters.range}
                        onValueChange={(range) => {
                            setShown(PAGE);
                            onFilters({ ...filters, range, day: null });
                        }}
                        options={list.RANGES.map((range) => ({
                            value: range,
                            label: t(`connectivity.filters.range${range}`)
                        }))}
                    />
                    <Select
                        className="h-7 w-auto min-w-[8.5rem]"
                        aria-label={t("connectivity.filters.min")}
                        value={filters.min}
                        onValueChange={(min) => {
                            setShown(PAGE);
                            onFilters({ ...filters, min: min as list.MinLength });
                        }}
                        options={list.MIN_LENGTHS.map((min) => ({
                            value: min,
                            label: t(`connectivity.filters.min${min === "any" ? "Any" : min}`)
                        }))}
                    />
                </div>
                {filtered ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                        {filters.day ? (
                            <Chip
                                label={t("connectivity.filters.day", {
                                    date: format.date(filters.day.start)
                                })}
                                remove={t("connectivity.filters.removeDay")}
                                onRemove={() => onFilters({ ...filters, day: null })}
                            />
                        ) : null}
                        {filters.kinds.map((kind) => (
                            <Chip
                                key={kind}
                                label={kindName(kind)}
                                remove={kindName(kind)}
                                onRemove={() => toggleKind(kind)}
                            />
                        ))}
                        {filters.min !== "any" ? (
                            <Chip
                                label={t(`connectivity.filters.min${filters.min}`)}
                                remove={t(`connectivity.filters.min${filters.min}`)}
                                onRemove={() => onFilters({ ...filters, min: "any" })}
                            />
                        ) : null}
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => onFilters(list.DEFAULT_FILTERS)}
                        >
                            {t("connectivity.list.clear")}
                        </Button>
                    </div>
                ) : null}
            </div>

            <div className="overflow-x-auto">
                <table className="w-full min-w-[20rem] text-[0.8125rem]">
                    <thead>
                        <tr className="border-b border-border text-left">
                            <th className="px-4 py-2">{t("connectivity.list.started")}</th>
                            <th className="hidden px-4 py-2 lg:table-cell">
                                {t("connectivity.list.ended")}
                            </th>
                            <th className="px-4 py-2 text-right">
                                {t("connectivity.list.duration")}
                            </th>
                            <th className="hidden px-4 py-2 sm:table-cell">
                                {t("connectivity.list.kind")}
                            </th>
                            <th className="hidden px-4 py-2 xl:table-cell">
                                {t("connectivity.list.detectedBy")}
                            </th>
                            <th className="hidden px-4 py-2 xl:table-cell">
                                {t("connectivity.list.firstBack")}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {kept === null
                            ? [0, 1, 2].map((row) => (
                                  <tr key={row} className="border-b border-border last:border-0">
                                      <td className="px-4 py-2.5" colSpan={6}>
                                          <Skeleton className="h-4 w-full" />
                                      </td>
                                  </tr>
                              ))
                            : kept
                                  .slice(0, shown)
                                  .map((outage) => (
                                      <OutageRow
                                          key={outage.id}
                                          outage={outage}
                                          length={list.outageLength(outage, now, staleMs)}
                                          span={span}
                                          kindName={kindName}
                                          firstBackName={firstBackName}
                                      />
                                  ))}
                    </tbody>
                </table>
            </div>

            {kept && kept.length === 0 ? (
                filtered || (outages?.length ?? 0) > 0 ? (
                    <EmptyState
                        bare
                        title={t("connectivity.list.emptyFiltered")}
                        action={
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => onFilters(list.DEFAULT_FILTERS)}
                            >
                                {t("connectivity.list.clear")}
                            </Button>
                        }
                    />
                ) : (
                    <EmptyState
                        bare
                        title={t("connectivity.list.empty")}
                        description={t("connectivity.list.emptyHint")}
                    />
                )
            ) : null}

            {kept && kept.length > shown ? (
                <div className="flex justify-center border-t border-border p-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShown((count) => count + PAGE)}
                    >
                        {t("connectivity.list.showMore")}
                    </Button>
                </div>
            ) : null}
            {truncated ? (
                <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                    {t("connectivity.list.truncated", { count: outages?.length ?? 0 })}
                </p>
            ) : null}
        </Card>
    );
}

function OutageRow({
    outage,
    length,
    span,
    kindName,
    firstBackName
}: {
    outage: OutageView;
    length: number;
    span: (ms: number) => string;
    kindName: (kind: rules.OutageKind) => string;
    firstBackName: (value: string) => string;
}) {
    const t = useTranslations("watch");
    const format = useDisplayFormat();
    const ongoing = outage.endedAt === null;
    const startNote = outage.lastUpAt
        ? t("connectivity.list.startWindow", {
              from: format.dateTime(outage.lastUpAt),
              to: format.dateTime(outage.startedAt)
          })
        : undefined;
    return (
        <tr className="border-b border-border align-top last:border-0">
            <td className="w-full max-w-0 px-4 py-2 sm:w-auto sm:max-w-none">
                <span className="block truncate tabular" title={startNote}>
                    {format.dateTime(outage.startedAt)}
                </span>
                {/* Folded into the first column where their own are hidden. */}
                <span className="block truncate text-xs text-muted-foreground sm:hidden">
                    {kindName(outage.kind)}
                    {outage.detectedBy ? ` - ${outage.detectedBy}` : ""}
                </span>
                {outage.detail ? (
                    <span
                        className="block truncate text-xs text-foreground-subtle"
                        title={outage.detail}
                    >
                        {outage.detail}
                    </span>
                ) : null}
            </td>
            <td className="hidden whitespace-nowrap px-4 py-2 tabular lg:table-cell">
                {ongoing ? (
                    <Badge variant="danger">{t("connectivity.list.ongoing")}</Badge>
                ) : (
                    format.dateTime(outage.endedAt)
                )}
                {outage.closedBy === "unobserved" ? (
                    <span
                        className="block text-xs text-warning-ink"
                        title={t("connectivity.list.unobserved")}
                    >
                        {t("connectivity.csv.unobserved")}
                    </span>
                ) : null}
            </td>
            <td className="whitespace-nowrap px-4 py-2 text-right tabular">
                {span(length)}
                {ongoing ? (
                    <span className="block text-xs text-danger-ink lg:hidden">
                        {t("connectivity.list.ongoing")}
                    </span>
                ) : null}
                {outage.blips > 0 ? (
                    <span className="block text-xs text-muted-foreground">
                        {t("connectivity.list.merged", { count: outage.blips })}
                    </span>
                ) : null}
            </td>
            <td className="hidden px-4 py-2 sm:table-cell">
                <span title={t(`connectivity.kindHints.${outage.kind}`)}>
                    {kindName(outage.kind)}
                </span>
            </td>
            <td className="hidden max-w-[14rem] px-4 py-2 xl:table-cell">
                <span className="block truncate" title={outage.detectedBy ?? undefined}>
                    {outage.detectedBy ?? t("connectivity.list.resolvers")}
                </span>
            </td>
            <td className="hidden max-w-[14rem] px-4 py-2 xl:table-cell">
                {outage.firstBack ? (
                    <span
                        className="block truncate"
                        title={outage.firstBackAt ? format.dateTime(outage.firstBackAt) : undefined}
                    >
                        {firstBackName(outage.firstBack)}
                    </span>
                ) : (
                    "-"
                )}
            </td>
        </tr>
    );
}

function Chip({
    label,
    remove,
    onRemove
}: {
    label: string;
    remove: string;
    onRemove: () => void;
}) {
    return (
        <span className="inline-flex items-center gap-1 rounded border border-border bg-muted py-px pl-1.5 pr-0.5 text-xs">
            {label}
            <button
                type="button"
                onClick={onRemove}
                aria-label={remove}
                title={remove}
                className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-card-hover hover:text-foreground"
            >
                <X className="size-3" aria-hidden="true" />
            </button>
        </span>
    );
}
