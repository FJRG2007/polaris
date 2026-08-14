"use client";

/**
 * The analytics screen.
 *
 * Ordered by what somebody actually came here to find out: how many people, then the
 * shape of it over time, then where they came from and what they read, then who is
 * here right now. Setup sits at the bottom, because it is read once and the numbers
 * are read every day.
 *
 * Every figure names what it is measuring rather than leaving it to be assumed. A
 * bounce rate with no definition, or a "visitors" number that silently means
 * something different over a week than over a day, is the reason people stop
 * believing an analytics page - so the ones here say so where it matters.
 */

import Link from "next/link";
import { useAppUrl } from "@/components/app-url";
import { HeaderPortal } from "@/components/header-portal";
import { useRouter, useSearchParams } from "next/navigation";
import { useDisplayFormat } from "@/components/display-format";
import { useCallback, useEffect, useState, useTransition } from "react";
import { ANALYTICS_SCOPES, scopeNeedsTarget, type AnalyticsScope, type SiteOption } from "./site-catalog";
import { Activity, Check, Copy, Globe, MonitorSmartphone, RefreshCw, ShieldCheck, TrendingUp } from "lucide-react";
import { countryFlag, countryName, VISIT_RANGE_SPEC, type VisitDimension, type VisitRange, type VisitRow } from "@polaris/core";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select, Skeleton, Switch, TimeSeriesChart, cn } from "@polaris/ui";
import {
    getAnalyticsOverviewAction,
    rotateTrackerKeyAction,
    setAnalyticsSettingsAction,
    setTrackerEnabledAction,
    type AnalyticsOverview
} from "./actions";

/** Thousands separators without a locale: the browser's separator disagrees with the
 *  server on the first render, and it is not the reader's chosen format either. */
function grouped(value: number): string {
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function percent(value: number | null): string {
    return value === null ? "-" : `${Math.round(value * 100)}%`;
}

/** A duration as somebody would say it: "0s", "48s", "3m 12s", "1h 04m". */
function duration(seconds: number | null): string {
    if (seconds === null) return "-";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const RANGES: VisitRange[] = ["24h", "7d", "30d", "90d", "12m"];

export function AnalyticsView({
    scope,
    siteId,
    range,
    services,
    canOperate
}: {
    scope: AnalyticsScope;
    siteId: string;
    range: VisitRange;
    services: SiteOption[];
    canOperate: boolean;
}) {
    const [data, setData] = useState<AnalyticsOverview | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [, startLoad] = useTransition();

    const load = useCallback(() => {
        startLoad(async () => {
            const result = await getAnalyticsOverviewAction({ scopeType: scope, scopeId: siteId, range });
            if ("error" in result) {
                setFailure(result.error);
                setData(null);
                return;
            }
            setFailure(null);
            setData(result);
        });
    }, [scope, siteId, range]);

    useEffect(load, [load]);

    /** Move the screen first and let the server confirm, so a switch follows the
     *  finger. Only a real failure puts it back. */
    const mutate = useCallback(
        (patch: (current: AnalyticsOverview) => AnalyticsOverview, run: () => Promise<{ error?: string }>) => {
            setData((current) => {
                if (!current) return current;
                const previous = current;
                setFailure(null);
                void run().then((result) => {
                    if (result.error) {
                        setFailure(result.error);
                        setData(previous);
                    } else {
                        load();
                    }
                });
                return patch(current);
            });
        },
        [load]
    );

    const nothingToMeasure = scopeNeedsTarget(scope) && services.length === 0;

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
            <div className="flex flex-col gap-3">
                <div className="flex min-w-0 flex-wrap items-baseline gap-2">
                    <h1 className="text-[17px] font-semibold tracking-tight">Analytics</h1>
                    {data ? (
                        <span className="hidden min-w-0 truncate text-sm text-muted-foreground md:inline">
                            {data.site.name}
                        </span>
                    ) : null}
                    {data && data.view.online > 0 ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                            <span className="size-1.5 animate-pulse rounded-full bg-success" />
                            {grouped(data.view.online)} online
                        </span>
                    ) : null}
                </div>
                <SitePicker scope={scope} siteId={siteId} services={services} canOperate={canOperate} />
                <RangeTabs range={range} />
            </div>

            {failure ? (
                <p className="rounded-md border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">{failure}</p>
            ) : null}

            {nothingToMeasure ? (
                <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                    No services yet. Deploy one and its visitors appear here on their own - no script to add.
                </p>
            ) : (
                <>
                    <Overview data={data} range={range} />
                    <Breakdowns data={data} />
                    <Recent data={data} />
                    {data ? <TrackerPanel data={data} scope={scope} siteId={siteId} mutate={mutate} /> : null}
                    {data && canOperate ? <SettingsPanel data={data} mutate={mutate} /> : null}
                </>
            )}
        </div>
    );
}

/** Scope and site, in the app bar beside the switcher - the same place Deploy and
 *  the firewall put theirs, so the header always says what you are looking at. */
function SitePicker({
    scope,
    siteId,
    services,
    canOperate
}: {
    scope: AnalyticsScope;
    siteId: string;
    services: SiteOption[];
    canOperate: boolean;
}) {
    const router = useRouter();
    const params = useSearchParams();
    const scopes = ANALYTICS_SCOPES.filter((entry) => canOperate || entry.value !== "polaris");

    function go(nextScope: AnalyticsScope, nextId: string) {
        const next = new URLSearchParams(params.toString());
        next.set("scope", nextScope);
        if (nextId) next.set("id", nextId);
        else next.delete("id");
        router.push(`/apps/analytics?${next.toString()}`);
    }

    const scopeSelect = (
        <Select
            value={scope}
            aria-label="What to measure"
            className="h-8 min-w-0 flex-1 font-medium md:w-36 md:min-w-[9rem] md:flex-none"
            options={scopes.map((entry) => ({ value: entry.value, label: entry.label }))}
            onValueChange={(value) => {
                const next = value as AnalyticsScope;
                go(next, next === "application" ? (services[0]?.id ?? "") : "");
            }}
        />
    );

    const siteSelect = !scopeNeedsTarget(scope) ? null : services.length > 0 ? (
        <Select
            value={siteId || (services[0]?.id ?? "")}
            aria-label="Service"
            className="h-8 min-w-0 flex-1 md:w-60 md:min-w-[15rem] md:flex-none"
            options={services.map((service) => ({ value: service.id, label: service.label }))}
            onValueChange={(value) => go(scope, value)}
        />
    ) : (
        <span className="whitespace-nowrap text-sm text-muted-foreground">No services yet.</span>
    );

    return (
        <>
            <HeaderPortal>
                <span className="hidden text-muted-foreground/40 md:inline">/</span>
                <span className="hidden items-center gap-2 md:flex">
                    {scopeSelect}
                    {siteSelect ? <span className="text-muted-foreground/40">/</span> : null}
                    {siteSelect}
                </span>
            </HeaderPortal>
            <div className="flex items-center gap-2 md:hidden">
                {scopeSelect}
                {siteSelect}
            </div>
        </>
    );
}

function RangeTabs({ range }: { range: VisitRange }) {
    const params = useSearchParams();
    return (
        <div className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1">
            {RANGES.map((value) => {
                const next = new URLSearchParams(params.toString());
                next.set("range", value);
                const active = value === range;
                return (
                    <Link
                        key={value}
                        href={`/apps/analytics?${next.toString()}`}
                        scroll={false}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                            "shrink-0 rounded-md border px-2.5 py-1 text-xs transition-colors",
                            active
                                ? "border-primary/40 bg-primary/10 font-medium text-primary"
                                : "border-border text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {VISIT_RANGE_SPEC[value].label}
                    </Link>
                );
            })}
        </div>
    );
}

function Overview({ data, range }: { data: AnalyticsOverview | null; range: VisitRange }) {
    const format = useDisplayFormat();
    const multiDay = range !== "24h";

    const cards: { label: string; value: string; hint: string }[] = data
        ? [
              {
                  label: multiDay ? "Daily visitors" : "Visitors",
                  value: grouped(data.view.overview.visitors),
                  // Sessions rotate daily and are cookieless, so there is no identity to
                  // deduplicate across days. Saying so beats quietly showing a number
                  // that means something different at every range.
                  hint: multiDay
                      ? "Distinct visits. Someone who came back on another day counts again - sessions are cookieless and rotate daily, so there is nothing to join them by."
                      : "Distinct visits in the last 24 hours."
              },
              { label: "Pageviews", value: grouped(data.view.overview.views), hint: "Pages read." },
              {
                  label: "Bounce rate",
                  value: percent(data.view.overview.bounceRate),
                  hint: "Visits that read exactly one page."
              },
              {
                  label: "Visit duration",
                  value: duration(data.view.overview.avgVisitSec),
                  hint: data.site.trackerEnabled
                      ? "Average, over the visits long enough to measure."
                      : "Only measurable with the tracker on. Without it, a visit is one line in a log with no end."
              }
          ]
        : [];

    return (
        <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {data
                    ? cards.map((card) => (
                          <Card key={card.label}>
                              <CardBody className="flex flex-col gap-1 p-4">
                                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                      {card.label}
                                  </span>
                                  <span className="text-2xl font-semibold tabular-nums">{card.value}</span>
                                  <span className="text-xs text-muted-foreground">{card.hint}</span>
                              </CardBody>
                          </Card>
                      ))
                    : Array.from({ length: 4 }, (_, index) => (
                          <Card key={index}>
                              <CardBody className="flex flex-col gap-2 p-4">
                                  <Skeleton className="h-3 w-20" />
                                  <Skeleton className="h-7 w-16" />
                                  <Skeleton className="h-3 w-full" />
                              </CardBody>
                          </Card>
                      ))}
            </div>

            <Card>
                <CardHeader className="flex-row items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                        <TrendingUp className="size-4 text-muted-foreground" /> Traffic
                    </CardTitle>
                    {data?.view.source === "daily" ? (
                        <span className="text-xs text-muted-foreground">From daily totals - one bar is a day</span>
                    ) : null}
                </CardHeader>
                <CardBody>
                    {data ? (
                        <TimeSeriesChart
                            points={data.view.series.map((point) => ({ t: point.t, v: point.views }))}
                            from={data.view.from}
                            to={data.view.to}
                            summary="sum"
                            label="Pageviews"
                            format={grouped}
                            formatTime={(at) => format.dateTime(at)}
                        />
                    ) : (
                        <Skeleton className="h-[132px] w-full" />
                    )}
                </CardBody>
            </Card>
        </div>
    );
}

/**
 * The breakdowns, grouped rather than stacked.
 *
 * Fourteen lists one under another is a page nobody scrolls to the bottom of, and
 * most of them are empty on any given site. Related ones share a card and a set of
 * tabs, which is how both Umami and Vercel lay this out - the tab labels double as
 * the answer to "can I see that here", so nothing is hidden by being grouped.
 */
interface Panel {
    label: string;
    rows: readonly VisitRow[] | null;
    empty: string;
    render?: (key: string) => React.ReactNode;
}

/** One card: a row of tabs and the list under whichever is chosen. The bar behind a
 *  row is its share of the top row, the only comparison that survives a list where
 *  the first entry is ten times the second. */
function BreakdownCard({ icon: Icon, panels }: { icon?: typeof Globe; panels: Panel[]; }) {
    const [active, setActive] = useState(0);
    const panel = panels[Math.min(active, panels.length - 1)];
    if (!panel) return null;
    const rows = panel.rows;
    const top = rows && rows.length > 0 ? Math.max(...rows.map((row) => row.visitors)) : 0;

    return (
        <Card>
            <CardHeader className="pb-2">
                <div className="no-scrollbar -mx-1 flex items-center gap-1 overflow-x-auto px-1">
                    {Icon ? <Icon className="mr-1 size-4 shrink-0 text-muted-foreground" /> : null}
                    {panels.map((entry, index) => (
                        <button
                            key={entry.label}
                            type="button"
                            onClick={() => setActive(index)}
                            aria-pressed={index === active}
                            className={cn(
                                "shrink-0 rounded-md px-2 py-1 text-sm transition-colors",
                                index === active
                                    ? "bg-muted font-medium text-foreground"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {entry.label}
                        </button>
                    ))}
                </div>
            </CardHeader>
            <CardBody className="pt-0">
                {rows === null ? (
                    <div className="flex flex-col gap-2 py-1">
                        {Array.from({ length: 5 }, (_, index) => (
                            <Skeleton key={index} className="h-5 w-full" />
                        ))}
                    </div>
                ) : rows.length === 0 ? (
                    <p className="px-2 py-6 text-center text-sm text-muted-foreground">{panel.empty}</p>
                ) : (
                    <ul className="flex flex-col">
                        {rows.map((row) => (
                            <li key={row.key} className="relative flex items-center gap-3 py-1.5 text-sm">
                                <span
                                    aria-hidden
                                    className="absolute inset-y-0.5 left-0 rounded bg-primary/10"
                                    style={{ width: `${top > 0 ? Math.max(2, (row.visitors / top) * 100) : 0}%` }}
                                />
                                <span className="relative min-w-0 flex-1 truncate pl-2" title={row.key}>
                                    {panel.render ? panel.render(row.key) : row.key}
                                </span>
                                <span className="relative shrink-0 pr-2 tabular-nums">{grouped(row.visitors)}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}

function Breakdowns({ data }: { data: AnalyticsOverview | null; }) {
    const rows = data?.view.breakdowns ?? null;
    // Over a long range these come from the daily totals, which do not carry the
    // per-visit dimensions. Saying so beats an empty panel that reads as "nobody used
    // a screen size this quarter".
    const unavailable = new Set(data?.view.unavailable ?? []);
    const why = (dimension: VisitDimension, otherwise: string) =>
        unavailable.has(dimension)
            ? "Not kept in the daily totals this range is drawn from. Choose a shorter range to see it."
            : otherwise;

    return (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <BreakdownCard
                panels={[
                    { label: "Pages", rows: rows?.path ?? null, empty: "No pages read yet." },
                    { label: "Entry", rows: rows?.entry ?? null, empty: why("entry", "No visits yet.") },
                    { label: "Exit", rows: rows?.exit ?? null, empty: why("exit", "No visits yet.") }
                ]}
            />
            <BreakdownCard
                panels={[
                    { label: "Referrers", rows: rows?.referrer ?? null, empty: "Nowhere yet." },
                    { label: "Channels", rows: rows?.channel ?? null, empty: "Nothing yet." },
                    { label: "Campaigns", rows: rows?.campaign ?? null, empty: why("campaign", "No tagged links yet.") }
                ]}
            />
            <BreakdownCard
                icon={MonitorSmartphone}
                panels={[
                    { label: "Browsers", rows: rows?.browser ?? null, empty: "Nothing yet." },
                    { label: "Systems", rows: rows?.os ?? null, empty: "Nothing yet." },
                    { label: "Devices", rows: rows?.device ?? null, empty: "Nothing yet." },
                    {
                        label: "Screens",
                        rows: rows?.screen ?? null,
                        empty: why("screen", "A log cannot see a screen. Turn the tracker on for this one.")
                    }
                ]}
            />
            <BreakdownCard
                icon={Globe}
                panels={[
                    {
                        label: "Countries",
                        rows: rows?.country ?? null,
                        empty: "No location yet. It is read from the visitor's time zone, so it needs the tracker.",
                        render: (code) => `${countryFlag(code)} ${countryName(code)}`
                    },
                    { label: "Languages", rows: rows?.language ?? null, empty: why("language", "Nothing yet.") }
                ]}
            />
            <BreakdownCard
                panels={[
                    {
                        label: "Addresses",
                        rows: rows?.ip ?? null,
                        empty: why("ip", "Nothing yet."),
                        render: (ip) => <IpRow ip={ip} />
                    }
                ]}
            />
            <BreakdownCard
                panels={[
                    {
                        label: "Events",
                        rows: rows?.event ?? null,
                        empty: "No custom events. Call polaris.event('name') from your page."
                    }
                ]}
            />
        </div>
    );
}

/** An address is the start of a question, not the end of one - so it links at the
 *  place that can answer it. */
function IpRow({ ip }: { ip: string }) {
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-xs">{ip}</span>
            <Link
                href="/apps/firewall"
                title={`Block or inspect ${ip} in the firewall`}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            >
                <ShieldCheck className="size-3.5" />
            </Link>
        </span>
    );
}

function Recent({ data }: { data: AnalyticsOverview | null }) {
    const format = useDisplayFormat();
    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                    <Activity className="size-4 text-muted-foreground" /> Recent visits
                </CardTitle>
            </CardHeader>
            <CardBody>
                {!data ? (
                    <div className="flex flex-col gap-2">
                        {Array.from({ length: 6 }, (_, index) => (
                            <Skeleton key={index} className="h-6 w-full" />
                        ))}
                    </div>
                ) : data.recent.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        Nobody yet. A visit appears here within a minute of it happening.
                    </p>
                ) : (
                    <div className="-mx-2 overflow-x-auto">
                        <table className="w-full min-w-[40rem] text-sm">
                            <thead className="text-left text-xs text-muted-foreground">
                                <tr className="border-b border-border/60">
                                    <th className="px-2 py-1.5 font-medium">Last seen</th>
                                    <th className="px-2 py-1.5 font-medium">Address</th>
                                    <th className="px-2 py-1.5 font-medium">Where from</th>
                                    <th className="px-2 py-1.5 font-medium">Last page</th>
                                    <th className="px-2 py-1.5 font-medium">Client</th>
                                    <th className="px-2 py-1.5 text-right font-medium">Pages</th>
                                    <th className="px-2 py-1.5 text-right font-medium">Time</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border/40">
                                {data.recent.map((visit) => (
                                    <tr key={visit.id} className="hover:bg-muted/40">
                                        <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                                            {format.time(visit.lastSeenAt, { seconds: true })}
                                        </td>
                                        <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs">
                                            {visit.ip ?? "-"}
                                        </td>
                                        <td className="whitespace-nowrap px-2 py-1.5">
                                            {visit.country ? `${countryFlag(visit.country)} ` : ""}
                                            {visit.referrerSource ?? "Direct"}
                                        </td>
                                        <td className="max-w-[16rem] truncate px-2 py-1.5 font-mono text-xs" title={visit.lastPath ?? undefined}>
                                            {visit.lastPath ?? "-"}
                                        </td>
                                        <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                                            {visit.browser} on {visit.os}
                                        </td>
                                        <td className="px-2 py-1.5 text-right tabular-nums">{grouped(visit.views)}</td>
                                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                                            {visit.durationSec > 0 ? duration(visit.durationSec) : "-"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

type Mutate = (patch: (current: AnalyticsOverview) => AnalyticsOverview, run: () => Promise<{ error?: string }>) => void;

function TrackerPanel({
    data,
    scope,
    siteId,
    mutate
}: {
    data: AnalyticsOverview;
    scope: AnalyticsScope;
    siteId: string;
    mutate: Mutate;
}) {
    const [copied, setCopied] = useState(false);
    const [rotating, startRotate] = useTransition();
    // The snippet is pasted into somebody else's site, so it has to name the address
    // Polaris answers on publicly - a LAN hostname would load nothing out there.
    const baseUrl = useAppUrl();
    const snippet = `<script defer src="${baseUrl}/analytics.js" data-key="${data.site.publicKey}"></script>`;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">Tracker</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">
                    Pageviews, referrers and devices are already being counted from the edge - this service needed no
                    setup for that. The script adds the four things a server-side log cannot see: how long a visit
                    lasted, the screen it was read on, single-page route changes, and your own events.
                </p>

                <label className="flex items-start gap-3">
                    <Switch
                        checked={data.site.trackerEnabled}
                        onChange={(checked) =>
                            mutate(
                                (current) => ({ ...current, site: { ...current.site, trackerEnabled: checked } }),
                                () => setTrackerEnabledAction({ scopeType: scope, scopeId: siteId, enabled: checked })
                            )
                        }
                        aria-label="Accept beats from the tracker"
                    />
                    <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">Accept beats from the tracker</span>
                        <span className="text-xs text-muted-foreground">
                            While this is off the endpoint ignores this key, so a script left on a page after you turn
                            it off records nothing.
                        </span>
                    </span>
                </label>

                {data.site.trackerEnabled ? (
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                            Paste into the page&apos;s head
                        </span>
                        <div className="flex items-center gap-2">
                            <Input readOnly value={snippet} className="min-w-0 flex-1 font-mono text-xs" />
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="shrink-0"
                                onClick={() => {
                                    void navigator.clipboard.writeText(snippet).then(() => {
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 1500);
                                    });
                                }}
                            >
                                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                                {copied ? "Copied" : "Copy"}
                            </Button>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>
                                No cookies and nothing stored on the visitor&apos;s machine, so there is nothing here to
                                ask consent for.
                            </span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={rotating}
                                onClick={() =>
                                    startRotate(async () => {
                                        await rotateTrackerKeyAction({ scopeType: scope, scopeId: siteId });
                                    })
                                }
                            >
                                <RefreshCw className={cn("size-3.5", rotating && "animate-spin")} /> New key
                            </Button>
                        </div>
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}

function SettingsPanel({ data, mutate }: { data: AnalyticsOverview; mutate: Mutate }) {
    const settings = data.settings;
    const [retention, setRetention] = useState(String(settings.retentionDays));

    function save(next: typeof settings) {
        mutate(
            (current) => ({ ...current, settings: next }),
            () => setAnalyticsSettingsAction(next)
        );
    }

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
                <CardTitle className="text-sm">Collection</CardTitle>
                <Badge variant="neutral">Whole instance</Badge>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <label className="flex items-start gap-3">
                    <Switch
                        checked={settings.ingestEdgeLog}
                        onChange={(checked) => save({ ...settings, ingestEdgeLog: checked })}
                        aria-label="Count visits from the edge log"
                    />
                    <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">Count visits from the edge log</span>
                        <span className="text-xs text-muted-foreground">
                            How every deployed service gets analytics without a script. Turning this off leaves only
                            what the tracker sends.
                        </span>
                    </span>
                </label>

                <label className="flex items-start gap-3">
                    <Switch
                        checked={settings.countBots}
                        onChange={(checked) => save({ ...settings, countBots: checked })}
                        aria-label="Count recognised bots as visitors"
                    />
                    <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">Count recognised bots as visitors</span>
                        <span className="text-xs text-muted-foreground">
                            Off, because a dashboard where a crawler outranks every real page is one nobody reads. The
                            firewall is where bot traffic is worth looking at.
                        </span>
                    </span>
                </label>

                <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Keep per-visit detail for</span>
                    <span className="flex items-center gap-2">
                        <Input
                            type="number"
                            min={1}
                            max={3650}
                            value={retention}
                            onChange={(event) => setRetention(event.target.value)}
                            onBlur={() => {
                                const days = Number(retention);
                                if (!Number.isFinite(days) || days < 1 || days > 3650) {
                                    setRetention(String(settings.retentionDays));
                                    return;
                                }
                                if (days !== settings.retentionDays) save({ ...settings, retentionDays: Math.round(days) });
                            }}
                            className="w-28"
                        />
                        <span className="text-sm text-muted-foreground">days</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                        Addresses, individual visits and their pages are dropped after this. The daily totals behind the
                        charts are kept, so history stays comparable without keeping a row per request.
                    </span>
                </label>
            </CardBody>
        </Card>
    );
}
