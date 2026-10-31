"use client";

/**
 * A server, container or domain as a device in Places.
 *
 * Laid out the way Home Assistant's device page and Netdata's node view are: the
 * readings now, the charts over time with a way into what is behind each one,
 * and - as Uptime Kuma draws a monitor - the past as a strip of days shaded by
 * downtime over the list of incidents. Every chart and panel here is the one
 * Watch drew, moved to a shared home.
 */

import Link from "next/link";
import { Button, LanDetailsRegion } from "@polaris/ui";
import { machineNetworkAction } from "../../actions";
import { useMemo, useState } from "react";
import { formatBytes } from "@polaris/core";
import { ArrowLeft, ExternalLink, Share2 } from "lucide-react";
import { ShareDialog } from "@/components/access/share-dialog";
import type { WatchCard } from "@/lib/watch-overview-service";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { BreakdownMetric } from "@/lib/watch/breakdown-shape";
import type { DomainDevice } from "@/lib/machines/machines-service";
import { DowntimeHeatmap, spanWith } from "@/components/metrics/downtime-heatmap";
import { dailyDowntime, type DayDowntime } from "@/lib/connectivity/outages";
import { CONSUMPTION_METRICS, MetricsHistory } from "@/components/metrics-history";
import { episodesFrom, mergedSpans, type AlarmEventPoint } from "@/lib/machines/alarm-episodes";
import {
    breakdownTitle,
    MetricBreakdownDialog,
    type OpenBreakdown
} from "@/components/metrics/metric-breakdown";

type Kind = "server" | "container" | "domain";

export function MachineDetailView({
    kind,
    id,
    name,
    detail,
    owned = false,
    lent = false,
    shareable = false,
    breakdowns = [],
    history,
    container,
    domain
}: {
    kind: Kind;
    id: string;
    name: string;
    detail: string | null;
    /** The reader owns it, so may be told where it is on the network. */
    owned?: boolean;
    /** Lent to the reader to watch: nothing that leads into the owner's apps. */
    lent?: boolean;
    /** The owner may lend it. The machine Polaris runs on never is. */
    shareable?: boolean;
    breakdowns?: BreakdownMetric[];
    history?: { since: number; events: AlarmEventPoint[] };
    container?: WatchCard;
    domain?: DomainDevice;
}) {
    const t = useTranslations("servers");
    const tw = useTranslations("watch");
    const [opened, setOpened] = useState<OpenBreakdown | null>(null);
    const [sharing, setSharing] = useState(false);
    const shareSubject =
        kind === "server" ? "place.server" : kind === "domain" ? "place.domain" : null;

    const metrics = useMemo(
        () =>
            CONSUMPTION_METRICS.map((metric) => {
                const offered = breakdowns.find((entry) => entry === metric.key);
                if (!offered) return metric;
                return {
                    ...metric,
                    breakdown: {
                        label: breakdownTitle(tw, offered),
                        open: (window: { from: number; to: number }) =>
                            setOpened({ metric: offered, ...window })
                    }
                };
            }),
        [breakdowns, tw]
    );

    const elsewhere = lent
        ? null
        : kind === "server"
          ? { href: "/apps/servers", label: t("machines.openServers") }
          : kind === "container"
            ? { href: container?.href ?? "/apps/containers", label: t("machines.openContainers") }
            : domain
              ? {
                    href: `/apps/deploy/${domain.projectId}?service=${domain.serviceId}`,
                    label: t("machines.openDeploy")
                }
              : null;

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <Link
                        href="/places/machines"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="size-3 shrink-0" /> {t("machines.back")}
                    </Link>
                    <h1
                        title={name}
                        className="mt-1 truncate text-[1.0625rem] font-semibold tracking-tight"
                    >
                        {name}
                    </h1>
                    {detail ? (
                        <p title={detail} className="truncate text-sm text-muted-foreground">
                            {detail}
                        </p>
                    ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                    {elsewhere ? (
                        <Button asChild variant="ghost" size="sm">
                            <Link href={elsewhere.href}>
                                <ExternalLink className="size-4 shrink-0" /> {elsewhere.label}
                            </Link>
                        </Button>
                    ) : null}
                    {shareSubject && shareable ? (
                        <Button variant="ghost" size="sm" onClick={() => setSharing(true)}>
                            <Share2 className="size-4 shrink-0" aria-hidden /> {t("machines.share")}
                        </Button>
                    ) : null}
                </div>
            </div>
            {kind === "server" && !lent && !shareable ? (
                <p className="-mt-3 text-xs text-muted-foreground">{t("machines.localNotLent")}</p>
            ) : null}

            {kind === "server" && owned ? (
                <section className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium">{t("network.title")}</h2>
                    <LanDetailsRegion
                        load={() => machineNetworkAction(id)}
                        labels={{ address: t("network.address"), mac: t("network.mac") }}
                    />
                </section>
            ) : null}

            {kind === "server" ? (
                <section className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium">{t("machines.metrics")}</h2>
                    <MetricsHistory
                        endpoint={`/api/watch/hosts/${id}/metrics/history`}
                        live={`/api/watch/hosts/${id}/metrics/stream`}
                        metrics={metrics}
                    />
                    <MetricBreakdownDialog
                        subject={{ kind: "server", id }}
                        open={opened}
                        onClose={() => setOpened(null)}
                    />
                </section>
            ) : null}

            {container ? <ContainerNow card={container} /> : null}
            {domain ? <DomainNow domain={domain} /> : null}
            {history ? <AlarmHistory history={history} /> : null}

            {shareSubject && shareable ? (
                <ShareDialog
                    open={sharing}
                    onOpenChange={setSharing}
                    subject={shareSubject}
                    subjectId={id}
                    name={name}
                    bounded
                />
            ) : null}
        </div>
    );
}

function Reading({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 rounded-lg border border-border/60 px-3 py-2">
            <p className="truncate text-xs text-muted-foreground" title={label}>
                {label}
            </p>
            <p className="truncate text-sm font-medium" title={value}>
                {value}
            </p>
        </div>
    );
}

function ContainerNow({ card }: { card: WatchCard }) {
    const t = useTranslations("servers");
    const none = t("machines.notMeasured");
    return (
        <div className="grid gap-2 sm:grid-cols-3">
            <Reading label={t("machines.status")} value={card.stateLabel} />
            <Reading
                label={t("machines.cpu")}
                value={card.cpuPercent == null ? none : `${card.cpuPercent}%`}
            />
            <Reading
                label={t("machines.memory")}
                value={card.memUsedBytes == null ? none : formatBytes(card.memUsedBytes)}
            />
        </div>
    );
}

function DomainNow({ domain }: { domain: DomainDevice }) {
    const t = useTranslations("servers");
    const display = useDisplayFormat();
    const none = t("machines.unknown");
    return (
        <div className="grid gap-2 sm:grid-cols-4">
            <Reading
                label={t("machines.status")}
                value={t(`machines.${domain.status ?? "unknown"}`)}
            />
            <Reading
                label={t("machines.code")}
                value={domain.code == null ? none : String(domain.code)}
            />
            <Reading
                label={t("machines.latency")}
                value={domain.latencyMs == null ? none : `${domain.latencyMs} ms`}
            />
            <Reading
                label={t("machines.checked")}
                value={domain.checkedAt ? display.dateTime(domain.checkedAt) : none}
            />
        </div>
    );
}

function AlarmHistory({ history }: { history: { since: number; events: AlarmEventPoint[] } }) {
    const t = useTranslations("servers");
    const tw = useTranslations("watch");
    const display = useDisplayFormat();
    const span = useMemo(() => spanWith(tw), [tw]);
    const [selected, setSelected] = useState<DayDowntime | null>(null);
    const [now] = useState(() => Date.now());
    const episodes = useMemo(() => episodesFrom(history.events, history.since), [history]);
    const days = useMemo(
        () => dailyDowntime(mergedSpans(episodes, now), now, 90, 0, display.preferences.timeZone),
        [episodes, now, display.preferences.timeZone]
    );
    const shown = selected
        ? episodes.filter(
              (episode) =>
                  episode.startedAt < selected.end && (episode.endedAt ?? now) > selected.start
          )
        : episodes;

    return (
        <section className="flex flex-col gap-3">
            <div className="min-w-0">
                <h2 className="text-sm font-medium">{t("machines.history")}</h2>
                <p className="text-xs text-muted-foreground">{t("machines.historyHint")}</p>
            </div>
            <DowntimeHeatmap
                days={days}
                since={history.since}
                selected={selected?.day ?? null}
                onSelect={setSelected}
                span={span}
            />
            {shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("machines.noHistory")}</p>
            ) : (
                <div className="overflow-x-auto rounded-md border border-border/60">
                    <table className="w-full text-sm">
                        <thead className="text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2 font-normal">{t("machines.alarm")}</th>
                                <th className="px-3 py-2 font-normal">{t("machines.started")}</th>
                                <th className="px-3 py-2 font-normal">{t("machines.ended")}</th>
                                <th className="px-3 py-2 font-normal">{t("machines.length")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((episode) => (
                                <tr
                                    key={`${episode.alarmId}-${episode.startedAt}`}
                                    className="border-t border-border/40"
                                >
                                    <td
                                        className="max-w-56 truncate px-3 py-2"
                                        title={episode.alarmName}
                                    >
                                        {episode.alarmName}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2">
                                        {display.dateTime(
                                            new Date(episode.startedAt).toISOString()
                                        )}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2">
                                        {episode.endedAt === null
                                            ? t("machines.ongoing")
                                            : display.dateTime(
                                                  new Date(episode.endedAt).toISOString()
                                              )}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-2">
                                        {span((episode.endedAt ?? now) - episode.startedAt)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
