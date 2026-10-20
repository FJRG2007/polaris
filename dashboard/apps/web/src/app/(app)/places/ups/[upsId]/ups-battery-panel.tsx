"use client";

/**
 * A UPS's battery: how healthy it is and why, the self-tests it can run
 * (behind a confirmation), every test result it reported, and its charge,
 * runtime and voltage over time.
 */

import { useMemo } from "react";
import * as upsReading from "@/lib/ups/ups-reading";
import { useUpsCommand } from "./ups-commands-panel";
import { useUpsStanding } from "./ups-standing";
import * as upsSettings from "@/lib/ups/ups-settings";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { UpsDetailAnswer, UpsEventsAnswer } from "../ups-words";
import { Badge, Button, MultiSeriesChart, Skeleton } from "@polaris/ui";

const TESTS = ["test.battery.start.quick", "test.battery.start.deep", "test.battery.stop"] as const;
const TEST_LABEL = {
    "test.battery.start.quick": "ups.test.quick",
    "test.battery.start.deep": "ups.test.deep",
    "test.battery.stop": "ups.test.stop"
} as const;
const HEALTH_TONE = {
    good: "success",
    fair: "warning",
    replace: "danger",
    unknown: "neutral"
} as const;

export function UpsBatteryPanel({
    upsId,
    answer,
    hours
}: {
    upsId: string;
    answer: UpsDetailAnswer | null;
    hours: number;
}) {
    const t = useTranslations("servers");
    const standing = useUpsStanding();
    const tests = useLiveResource<UpsEventsAnswer>({
        url: `/api/servers/ups/${upsId}/events?kinds=TEST&days=365`,
        cacheKey: `ups:${upsId}:tests`,
        intervalMs: 60_000,
        select: (body) => body as UpsEventsAnswer
    });
    const command = useUpsCommand(upsId, () => tests.refresh());
    const reading = answer?.result.ok ? answer.result.reading : null;
    const lastTest = tests.data?.events[0]?.detail ?? reading?.testResult ?? null;
    const health = reading
        ? upsSettings.batteryHealth({
              replaceFlag: reading.status.replaceBattery,
              lastTestFailed: upsReading.testOutcome(lastTest) === "failed",
              charge: reading.charge,
              batteryV: reading.batteryV,
              batteryVNominal: reading.batteryVNominal,
              batteryDate: reading.batteryDate,
              now: Date.now()
          })
        : null;
    const charts = useMemo(() => {
        if (!answer) return null;
        const points = answer.history.map((point) => ({ ...point, t: Date.parse(point.ts) }));
        return {
            runtime: [
                {
                    key: "runtime",
                    label: t("ups.metrics.runtime"),
                    points: points.map((point) => ({
                        t: point.t,
                        v: point.runtimeS === null ? null : point.runtimeS / 60
                    }))
                }
            ],
            voltage: [
                {
                    key: "battery",
                    label: t("ups.metrics.battery"),
                    points: points.map((point) => ({ t: point.t, v: point.batteryV }))
                }
            ],
            empty: points.length === 0
        };
    }, [answer, t]);
    const available = new Set(reading?.commands ?? []);
    const to = Date.now();
    const from = to - hours * 3_600_000;

    return (
        <div className="flex flex-col gap-6">
            <section aria-labelledby="ups-health" className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                    <h3 id="ups-health" className="text-sm font-medium">
                        {t("ups.battery.health")}
                    </h3>
                    {health === null ? (
                        <Skeleton className="h-5 w-16" />
                    ) : (
                        <Badge variant={HEALTH_TONE[health.state]}>
                            {t(`ups.battery.states.${health.state}`)}
                        </Badge>
                    )}
                </div>
                {health && health.reasons.length > 0 ? (
                    <ul className="list-disc pl-5 text-sm text-muted-foreground">
                        {health.reasons.map((reason) => (
                            <li key={reason}>{t(`ups.battery.reasons.${reason}`)}</li>
                        ))}
                    </ul>
                ) : null}
                {reading ? (
                    <dl className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 text-sm">
                        {[
                            {
                                key: "age",
                                value:
                                    health?.ageYears == null
                                        ? null
                                        : t("ups.battery.years", { value: health.ageYears })
                            },
                            { key: "date", value: reading.batteryDate },
                            { key: "type", value: reading.batteryType },
                            {
                                key: "nominal",
                                value:
                                    reading.batteryVNominal === null
                                        ? null
                                        : t("ups.units.volts", { value: reading.batteryVNominal })
                            },
                            {
                                key: "chargeLow",
                                value:
                                    reading.chargeLow === null
                                        ? null
                                        : t("ups.units.percent", { value: reading.chargeLow })
                            },
                            {
                                key: "runtimeLow",
                                value:
                                    reading.runtimeLowS === null
                                        ? null
                                        : t("ups.units.minutes", {
                                              count: Math.round(reading.runtimeLowS / 60)
                                          })
                            }
                        ]
                            .filter((one) => one.value !== null)
                            .map((one) => (
                                <div
                                    key={one.key}
                                    className="min-w-0 rounded-md bg-muted/50 px-3 py-2"
                                >
                                    <dt className="text-xs text-muted-foreground">
                                        {t(`ups.battery.facts.${one.key as "age"}`)}
                                    </dt>
                                    <dd
                                        className="truncate font-medium tabular-nums"
                                        title={one.value ?? undefined}
                                    >
                                        {one.value}
                                    </dd>
                                </div>
                            ))}
                    </dl>
                ) : null}
            </section>

            <section aria-labelledby="ups-tests" className="flex flex-col gap-3">
                <h3 id="ups-tests" className="text-sm font-medium">
                    {t("ups.battery.tests")}
                </h3>
                {answer === null ? (
                    <Skeleton className="h-8 w-64" />
                ) : standing.control && TESTS.some((one) => available.has(one)) ? (
                    <div className="flex flex-wrap gap-2">
                        {TESTS.filter((one) => available.has(one)).map((one) => (
                            <Button
                                key={one}
                                size="sm"
                                variant="outline"
                                disabled={command.busy}
                                onClick={() => command.ask(one)}
                            >
                                {t(TEST_LABEL[one])}
                            </Button>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">{t("ups.battery.noTests")}</p>
                )}
                {tests.data === null ? (
                    <Skeleton className="h-16 w-full" />
                ) : tests.data.events.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("ups.battery.noResults")}</p>
                ) : (
                    <ul className="flex max-h-60 flex-col divide-y overflow-auto overscroll-contain rounded-md border">
                        {tests.data.events.map((event) => {
                            const outcome = upsReading.testOutcome(event.detail);
                            return (
                                <li
                                    key={event.id}
                                    className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm"
                                >
                                    {outcome ? (
                                        <Badge
                                            variant={
                                                outcome === "passed"
                                                    ? "success"
                                                    : outcome === "failed"
                                                      ? "danger"
                                                      : "neutral"
                                            }
                                        >
                                            {t(`ups.test.outcome.${outcome}`)}
                                        </Badge>
                                    ) : null}
                                    <span
                                        className="min-w-0 flex-1 truncate"
                                        title={event.detail ?? undefined}
                                    >
                                        {event.detail ?? ""}
                                    </span>
                                    <time
                                        dateTime={event.ts}
                                        className="shrink-0 tabular-nums text-muted-foreground"
                                    >
                                        {new Date(event.ts).toLocaleString()}
                                    </time>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            <section aria-labelledby="ups-battery-history" className="flex flex-col gap-3">
                <h3 id="ups-battery-history" className="text-sm font-medium">
                    {t("ups.battery.history")}
                </h3>
                {charts === null ? (
                    <Skeleton className="h-48 w-full" />
                ) : charts.empty ? (
                    <p className="text-sm text-muted-foreground">{t("ups.chart.empty")}</p>
                ) : (
                    <div className="grid gap-4 lg:grid-cols-2">
                        <MultiSeriesChart
                            label={t("ups.chart.runtime")}
                            series={charts.runtime}
                            from={from}
                            to={to}
                            format={(value) => t("ups.units.minutes", { count: Math.round(value) })}
                        />
                        <MultiSeriesChart
                            label={t("ups.chart.batteryVoltage")}
                            series={charts.voltage}
                            from={from}
                            to={to}
                            format={(value) => t("ups.units.volts", { value: value.toFixed(1) })}
                        />
                    </div>
                )}
            </section>
            {command.dialog}
        </div>
    );
}
