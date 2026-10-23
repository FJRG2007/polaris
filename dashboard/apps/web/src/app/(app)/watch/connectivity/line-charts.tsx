"use client";

/**
 * The line, measured: latency, packet loss and uptime over a chosen range, and
 * the public address's history, from the connectivity sampler's minutes.
 *
 * Its own card and its own read (`/api/watch/connectivity/line`), so the rest
 * of the page paints and fills without waiting on it, and a range change
 * redraws only this. A shared view gets no address history (the route leaves it
 * out), and the card shows nothing in its place.
 */

import Link from "next/link";
import { BellRing } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import * as rules from "@/lib/connectivity/line-samples";
import { useDisplayFormat } from "@/components/display-format";
import { useLiveResource } from "@/components/use-live-resource";
import type { LineReport } from "@/lib/connectivity/line-samples";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { createAutomationAction } from "@/app/(app)/automations/actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    SegmentedControl,
    Skeleton,
    TimeSeriesChart
} from "@polaris/ui";

/** The sampler writes a minute at a time; asking more often redraws the same chart. */
const POLL_MS = 60_000;

export function LineCharts({ admin }: { admin: boolean }) {
    const t = useTranslations("watch");
    const format = useDisplayFormat();
    const [range, setRange] = useState<rules.LineRange>("24h");
    const { data, loading, error } = useLiveResource<LineReport>({
        url: `/api/watch/connectivity/line?range=${range}`,
        cacheKey: `watch.connectivity.line.${range}`,
        intervalMs: POLL_MS,
        select: (body) => body as LineReport
    });
    const report = data && data.range === range ? data : null;
    const formatTime = (at: number) => (range === "24h" ? format.time(at) : format.dateTime(at));
    const ms = (value: number) =>
        t("connectivity.line.ms", { value: format.number(value, { maximumFractionDigits: 0 }) });
    const pct = (value: number) => `${format.number(value, { maximumFractionDigits: 1 })}%`;

    const series = (pick: (point: rules.LinePoint) => number | null) =>
        (report?.points ?? []).map((point) => ({ t: point.t, v: pick(point) }));
    const empty = report !== null && report.totals.samples === 0;

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <CardTitle>{t("connectivity.line.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                        {t("connectivity.line.description")}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {report?.now ? <LineNow now={report.now} /> : null}
                    <SegmentedControl
                        aria-label={t("connectivity.line.range")}
                        value={range}
                        onValueChange={(value) => setRange(value as rules.LineRange)}
                        options={rules.LINE_RANGES.map((value) => ({
                            value,
                            label: t(`connectivity.periods.${value}`)
                        }))}
                    />
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                {error && !report ? (
                    <p className="text-sm text-danger">{t("connectivity.line.error")}</p>
                ) : loading && !report ? (
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                        {[0, 1, 2].map((index) => (
                            <Skeleton key={index} className="h-[132px] w-full" />
                        ))}
                    </div>
                ) : empty ? (
                    <p className="text-sm text-muted-foreground">{t("connectivity.line.empty")}</p>
                ) : report ? (
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                        <TimeSeriesChart
                            label={t("connectivity.line.latency")}
                            points={series((point) => point.latencyMs)}
                            from={report.from}
                            to={report.to}
                            format={ms}
                            formatTime={formatTime}
                            summary="avg"
                        />
                        <TimeSeriesChart
                            label={t("connectivity.line.loss")}
                            points={series((point) => point.lossPct)}
                            from={report.from}
                            to={report.to}
                            max={100}
                            tone="warning"
                            format={pct}
                            formatTime={formatTime}
                            summary="avg"
                        />
                        <TimeSeriesChart
                            label={t("connectivity.line.uptime")}
                            points={series((point) => point.upPct)}
                            from={report.from}
                            to={report.to}
                            max={100}
                            tone="success"
                            format={pct}
                            formatTime={formatTime}
                            summary="avg"
                        />
                    </div>
                ) : null}

                {report?.ipChanges ? <IpHistory changes={report.ipChanges} /> : null}
                {admin ? <InternetBackShortcut /> : null}
            </CardBody>
        </Card>
    );
}

function LineNow({ now }: { now: NonNullable<LineReport["now"]> }) {
    const t = useTranslations("watch");
    if (now.up) return <Badge variant="success">{t("connectivity.line.now.up")}</Badge>;
    return (
        <Badge variant="danger">
            {now.kind === "dns" ? t("connectivity.line.now.dns") : t("connectivity.line.now.down")}
        </Badge>
    );
}

function IpHistory({ changes }: { changes: NonNullable<LineReport["ipChanges"]> }) {
    const t = useTranslations("watch");
    const format = useDisplayFormat();
    return (
        <section aria-labelledby="connectivity-ip-history" className="flex flex-col gap-2">
            <h3 id="connectivity-ip-history" className="text-sm font-medium">
                {t("connectivity.line.ips.title")}
            </h3>
            {changes.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("connectivity.line.ips.empty")}</p>
            ) : (
                <ul className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
                    {changes.map((change) => {
                        const label = change.previous
                            ? t("connectivity.line.ips.changed", {
                                  previous: change.previous,
                                  current: change.current
                              })
                            : t("connectivity.line.ips.first", { current: change.current });
                        return (
                            <li
                                key={`${change.at}-${change.current}`}
                                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm"
                            >
                                <span className="min-w-0 truncate font-mono" title={label}>
                                    {label}
                                </span>
                                <time
                                    className="shrink-0 text-xs text-muted-foreground"
                                    dateTime={change.at}
                                >
                                    {format.dateTime(Date.parse(change.at))}
                                </time>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

/** "Tell me when the internet comes back": a ready-made automation, opened in the editor. */
function InternetBackShortcut() {
    const t = useTranslations("watch");
    const ta = useTranslations("automations");
    const router = useRouter();
    const [pending, start] = useTransition();
    const [failed, setFailed] = useState<string | null>(null);
    const create = () => {
        if (pending) return;
        start(async () => {
            setFailed(null);
            const result = await createAutomationAction(
                { name: ta("templates.internetBack.name"), template: "internetBack" },
                Intl.DateTimeFormat().resolvedOptions().timeZone
            );
            if (result.ok) router.push(`/automations/${result.id}`);
            else setFailed(result.error);
        });
    };
    return (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <p className="min-w-0 text-xs text-muted-foreground">
                {t("connectivity.line.automate")}{" "}
                <Link href="/automations" className="underline underline-offset-2">
                    {t("connectivity.line.automations")}
                </Link>
            </p>
            <Button variant="outline" size="sm" onClick={create} aria-disabled={pending}>
                <BellRing aria-hidden="true" />
                {ta("templates.internetBack.action")}
            </Button>
            {failed ? <p className="w-full text-xs text-danger">{failed}</p> : null}
        </div>
    );
}
