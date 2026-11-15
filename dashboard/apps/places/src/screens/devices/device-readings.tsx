"use client";

/**
 * A device's readings over time: one chart per measure, a window to read it
 * over, and the lowest, mean and highest in that window. Plus the switches, in
 * the device's settings, that say which measures are kept at all.
 *
 * The section's heading and pickers draw at once; only the chart waits on its
 * figures, and a window already seen is drawn from memory while it is asked
 * again.
 */

import * as actions from "../actions";
import { usePlacesT } from "../use-places-t";
import * as rk from "../../lib/reading-kinds";
import { useEffect, useMemo, useState } from "react";
import type { DeviceView } from "../../lib/device-kinds";
import { hostUi } from "@polaris/app-host/client";
import { Button, SegmentedControl, Skeleton, Switch, TimeSeriesChart } from "@polaris/ui";

const { useDisplayFormat } = hostUi.displayFormat;

/** The figures a device view carries, in the shape `measuresOf` reads. */
export function readingSourceOf(device: DeviceView): rk.ReadingSource {
    return {
        kind: device.kind,
        value: device.reading?.value ?? null,
        unit: device.reading?.unit ?? null,
        climate: device.climate,
        air: device.air
    };
}

/** The measures a device reports now, in the order they are listed. */
export function deviceMeasures(device: DeviceView): rk.ReadingMeasure[] {
    const now = rk.measuresOf(readingSourceOf(device));
    return rk.READING_MEASURES.filter((measure) => measure in now);
}

/** A window seen this session, by device, measure and window: drawn at once
 *  the next time while it is asked again. Kept for the page's life only. */
const seen = new Map<string, { history: rk.ReadingHistory; at: number }>();
const SEEN_TTL_MS = 30_000;

function unitOf(device: DeviceView, measure: rk.ReadingMeasure): string {
    // A figure read from the device's own reading is in the device's unit.
    if (measure === "reading" || (device.kind !== "air" && device.kind !== "dehumidifier")) {
        if (measure !== "target" && device.reading?.unit) return device.reading.unit;
    }
    return rk.READING_UNITS[measure];
}

function withUnit(value: number, unit: string): string {
    const figure = String(Math.round(value * 10) / 10);
    if (!unit) return figure;
    return /^[%°]/.test(unit) ? `${figure}${unit}` : `${figure} ${unit}`;
}

export function DeviceReadings({ device }: { device: DeviceView }) {
    const t = usePlacesT();
    const format = useDisplayFormat();
    const measures = useMemo(() => {
        const off = device.readingsOff ?? [];
        return deviceMeasures(device).filter((measure) => !off.includes(measure));
    }, [device]);
    const [picked, setPicked] = useState<rk.ReadingMeasure | null>(null);
    const [range, setRange] = useState<rk.ReadingRange>("24h");
    const measure = picked && measures.includes(picked) ? picked : (measures[0] ?? null);
    const key = measure ? `${device.id}:${measure}:${range}` : "";
    const [history, setHistory] = useState<rk.ReadingHistory | null>(
        () => seen.get(key)?.history ?? null
    );
    const [failed, setFailed] = useState("");

    useEffect(() => {
        if (!measure) return;
        const cached = seen.get(key);
        setHistory(cached?.history ?? null);
        setFailed("");
        if (cached && Date.now() - cached.at < SEEN_TTL_MS) return;
        let live = true;
        void actions
            .readingHistoryAction({ deviceId: device.id, measure, range })
            .then((result) => {
                if (!live) return;
                if (result.history) {
                    seen.set(key, { history: result.history, at: Date.now() });
                    setHistory(result.history);
                } else if (!cached) {
                    setFailed(result.error ?? t("readings.failed"));
                }
            })
            .catch(() => live && !cached && setFailed(t("readings.failed")));
        return () => {
            live = false;
        };
    }, [device.id, key, measure, range, t]);

    if (!measure) return null;
    const unit = unitOf(device, measure);
    const show = (value: number) => withUnit(value, unit);

    return (
        <section className="flex flex-col gap-2 border-t border-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{t("readings.title")}</h3>
                <SegmentedControl<rk.ReadingRange>
                    size="sm"
                    value={range}
                    onValueChange={setRange}
                    aria-label={t("readings.range")}
                    options={rk.READING_RANGES.map((value) => ({
                        value,
                        label: t(`readings.ranges.${value}`)
                    }))}
                />
            </div>
            {measures.length > 1 && (
                <SegmentedControl<rk.ReadingMeasure>
                    size="sm"
                    value={measure}
                    onValueChange={setPicked}
                    aria-label={t("readings.measure")}
                    options={measures.map((value) => ({
                        value,
                        label: t(`readings.measures.${value}`)
                    }))}
                />
            )}
            {failed ? (
                <p role="alert" className="text-sm text-danger">
                    {failed}
                </p>
            ) : history === null ? (
                <Skeleton className="h-40 w-full" />
            ) : history.points.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("readings.empty")}</p>
            ) : (
                <>
                    <TimeSeriesChart
                        label={t(`readings.measures.${measure}`)}
                        points={history.points.map((point) => ({ t: point.t, v: point.avg }))}
                        from={history.from}
                        to={history.to}
                        summary="last"
                        formatTime={(at) =>
                            range === "24h" ? format.time(at) : format.date(at)
                        }
                        format={show}
                    />
                    {history.stats && (
                        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            {(["min", "avg", "max"] as const).map((stat) => (
                                <div key={stat} className="flex gap-1">
                                    <dt>{t(`readings.stats.${stat}`)}</dt>
                                    <dd className="tabular-nums text-foreground">
                                        {show(history.stats![stat])}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    )}
                </>
            )}
        </section>
    );
}

/**
 * Which measures of a device are kept, each a switch. Turning one off asks
 * first, in place of the list, since it deletes what was stored; the switch
 * moves at once and moves back if the change is refused.
 */
export function ReadingTracking({
    device,
    onChange
}: {
    device: DeviceView;
    onChange: (readingsOff: string[]) => void;
}) {
    const t = usePlacesT();
    const [off, setOff] = useState<string[]>(() => [...(device.readingsOff ?? [])]);
    const [asking, setAsking] = useState<rk.ReadingMeasure | null>(null);
    const [error, setError] = useState("");
    const measures = useMemo(() => {
        const reported = deviceMeasures(device);
        return rk.READING_MEASURES.filter(
            (measure) => reported.includes(measure) || off.includes(measure)
        );
    }, [device, off]);

    useEffect(() => setOff([...(device.readingsOff ?? [])]), [device.id, device.readingsOff]);

    if (measures.length === 0) return null;

    const apply = async (measure: rk.ReadingMeasure, on: boolean) => {
        const before = off;
        const next = on ? off.filter((word) => word !== measure) : [...off, measure];
        setOff(next);
        setError("");
        try {
            const result = await actions.setReadingTrackingAction({
                deviceId: device.id,
                measure,
                on
            });
            if (result.error || !result.readingsOff) {
                setOff(before);
                setError(result.error ?? t("readings.failed"));
                return;
            }
            for (const key of [...seen.keys()]) {
                if (key.startsWith(`${device.id}:${measure}:`)) seen.delete(key);
            }
            setOff(result.readingsOff);
            onChange(result.readingsOff);
        } catch {
            setOff(before);
            setError(t("readings.failed"));
        }
    };

    if (asking) {
        return (
            <div role="alertdialog" aria-labelledby="readings-off-title" className="flex flex-col gap-2 rounded-lg bg-muted p-3">
                <p id="readings-off-title" className="text-sm font-medium">
                    {t("readings.offTitle", { measure: t(`readings.measures.${asking}`) })}
                </p>
                <p className="text-xs text-muted-foreground">{t("readings.offBody")}</p>
                <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
                        {t("common.cancel")}
                    </Button>
                    <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                            const measure = asking;
                            setAsking(null);
                            void apply(measure, false);
                        }}
                    >
                        {t("readings.offConfirm")}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            <span className="flex flex-col gap-0.5">
                <span className="text-sm">{t("readings.tracking")}</span>
                <span className="text-xs text-foreground-subtle">{t("readings.trackingHint")}</span>
            </span>
            {measures.map((measure) => (
                <label key={measure} className="flex min-w-0 items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-sm">{t(`readings.measures.${measure}`)}</span>
                    <Switch
                        checked={!off.includes(measure)}
                        onChange={(on: boolean) => (on ? void apply(measure, true) : setAsking(measure))}
                        aria-label={t("readings.trackName", {
                            measure: t(`readings.measures.${measure}`)
                        })}
                    />
                </label>
            ))}
            {error && (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}
