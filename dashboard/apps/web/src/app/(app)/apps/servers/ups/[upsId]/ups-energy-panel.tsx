"use client";

/**
 * A UPS's energy: what it delivered and what that cost, in hour, day or
 * month buckets over a preset or typed range, read from the hourly rollups
 * in the reader's own time zone. The power drawn right now paints from the
 * live reading the page already has.
 */

import { useMemo, useState } from "react";
import type { UpsView } from "@/lib/ups/ups-service";
import * as upsSettings from "@/lib/ups/ups-settings";
import type { UpsReading } from "@/lib/ups/ups-reading";
import { useLiveResource } from "@/components/use-live-resource";
import { formatMoney, type UpsEnergyAnswer } from "../ups-words";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Input, MultiSeriesChart, SegmentedControl, Skeleton } from "@polaris/ui";

const PRESETS = {
    d1: { days: 1, unit: "hour" },
    d7: { days: 7, unit: "day" },
    d30: { days: 30, unit: "day" },
    m12: { days: 365, unit: "month" },
    custom: { days: 0, unit: "day" }
} as const;
type Preset = keyof typeof PRESETS;

function dayInput(at: number): string {
    return new Date(at).toISOString().slice(0, 10);
}

export function UpsEnergyPanel({ ups, reading }: { ups: UpsView; reading: UpsReading | null }) {
    const t = useTranslations("servers");
    const [preset, setPreset] = useState<Preset>("d7");
    const [from, setFrom] = useState(() => dayInput(Date.now() - 7 * 86_400_000));
    const [to, setTo] = useState(() => dayInput(Date.now()));
    const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
    const range = useMemo(() => {
        if (preset !== "custom") {
            const end = Date.now();
            return { unit: PRESETS[preset].unit, from: end - PRESETS[preset].days * 86_400_000, to: end };
        }
        const start = Date.parse(`${from}T00:00:00`);
        const end = Date.parse(`${to}T00:00:00`) + 86_400_000;
        return { unit: end - start <= 2 * 86_400_000 ? "hour" : end - start > 120 * 86_400_000 ? "month" : "day", from: start, to: end };
    }, [preset, from, to]);
    const valid = upsSettings.energyQuerySchema.safeParse({
        unit: range.unit,
        from: new Date(range.from).toISOString(),
        to: new Date(range.to).toISOString(),
        tz
    });
    const query = valid.success
        ? `unit=${range.unit}&from=${encodeURIComponent(new Date(range.from).toISOString())}&to=${encodeURIComponent(new Date(range.to).toISOString())}&tz=${encodeURIComponent(tz)}`
        : null;
    const live = useLiveResource<UpsEnergyAnswer>({
        url: `/api/servers/ups/${ups.id}/energy?${query ?? ""}`,
        cacheKey: `ups:${ups.id}:energy:${query ?? ""}`,
        intervalMs: 60_000,
        enabled: query !== null,
        select: (body) => body as UpsEnergyAnswer
    });
    const powerW = reading
        ? upsSettings.powerWatts({
              realPowerW: reading.realPowerW,
              load: reading.load,
              nominalPowerW: reading.nominalPowerW,
              overrideW: ups.settings.nominalPowerW
          })
        : null;
    const answer = live.data;
    const series = useMemo(() => {
        if (!answer) return null;
        return [
            {
                key: "kwh",
                label: t("ups.energy.kwh"),
                points: answer.buckets.map((one) => ({ t: Date.parse(one.ts), v: one.kwh }))
            }
        ];
    }, [answer, t]);

    const tiles = [
        {
            key: "now",
            label: t("ups.energy.powerNow"),
            value: reading === null ? null : powerW === null ? t("ups.energy.noRating") : t("ups.units.watts", { value: Math.round(powerW) })
        },
        {
            key: "kwh",
            label: t("ups.energy.used"),
            value: answer ? t("ups.units.kwh", { value: answer.totals.kwh.toFixed(2) }) : null
        },
        {
            key: "cost",
            label: t("ups.energy.cost"),
            value: answer
                ? ups.settings.pricePerKwh === null && answer.totals.costs.every((one) => one.cost === 0)
                    ? t("ups.energy.noPrice")
                    : answer.totals.costs.map((one) => formatMoney(one.cost, one.currency)).join(" + ") ||
                      formatMoney(0, ups.settings.currency)
                : null
        }
    ];

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
                <SegmentedControl<Preset>
                    size="sm"
                    aria-label={t("ups.energy.range")}
                    value={preset}
                    onValueChange={setPreset}
                    options={(Object.keys(PRESETS) as Preset[]).map((key) => ({ value: key, label: t(`ups.energy.presets.${key}`) }))}
                />
                {preset === "custom" ? (
                    <div className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            {t("ups.energy.from")}
                            <Input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            {t("ups.energy.to")}
                            <Input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
                        </label>
                    </div>
                ) : null}
            </div>
            {!valid.success ? (
                <p role="alert" className="text-sm text-danger-ink">
                    {t(`ups.energy.errors.${valid.error.issues[0]?.message === "rangeTooLong" ? "rangeTooLong" : "invalidRange"}`)}
                </p>
            ) : null}
            <dl className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
                {tiles.map((tile) => (
                    <div key={tile.key} className="min-w-0 rounded-md bg-muted/50 px-3 py-2">
                        <dt className="text-xs text-muted-foreground">{tile.label}</dt>
                        <dd className="truncate text-sm font-medium tabular-nums" title={tile.value ?? undefined}>
                            {tile.value ?? <Skeleton className="mt-1 h-4 w-16" />}
                        </dd>
                    </div>
                ))}
            </dl>
            {series === null ? (
                <Skeleton className="h-48 w-full" />
            ) : answer && answer.buckets.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("ups.energy.empty")}</p>
            ) : (
                <MultiSeriesChart
                    label={t("ups.energy.chart")}
                    series={series}
                    from={range.from}
                    to={range.to}
                    format={(value) => t("ups.units.kwh", { value: value.toFixed(2) })}
                />
            )}
            {answer && answer.buckets.length > 0 ? (
                <div className="max-h-64 overflow-auto rounded-md border">
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2 font-normal">{t("ups.energy.when")}</th>
                                <th className="px-3 py-2 text-right font-normal">{t("ups.energy.kwh")}</th>
                                <th className="px-3 py-2 text-right font-normal">{t("ups.energy.cost")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {[...answer.buckets].reverse().map((one) => (
                                <tr key={`${one.ts}:${one.currency}`} className="border-t">
                                    <td className="px-3 py-1.5 tabular-nums">
                                        {new Date(one.ts).toLocaleString(undefined, range.unit === "hour" ? { dateStyle: "short", timeStyle: "short" } : range.unit === "day" ? { dateStyle: "medium" } : { year: "numeric", month: "long" })}
                                    </td>
                                    <td className="px-3 py-1.5 text-right tabular-nums">{one.kwh.toFixed(3)}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(one.cost, one.currency)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : null}
        </div>
    );
}
