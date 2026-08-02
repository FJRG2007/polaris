"use client";

/**
 * The instance-wide half of the firewall: what it has been doing, who it is currently
 * holding, and the settings that produce those bans.
 *
 * Separate from the per-scope editor because it answers a different question. The
 * editor is "what should the rules be"; this is "what is happening, and to whom". An
 * operator opens this page after something went wrong far more often than before, so
 * the state comes first and the settings sit under it.
 *
 * Rendered only for `system.manage`: bans, jails and intelligence feeds apply to the
 * whole instance and are not a project's to change.
 */

import Link from "next/link";
import { useDisplayFormat } from "@/components/display-format";
import type { WafAnomalySettings } from "@/lib/waf-anomaly-service";
import { useCallback, useEffect, useState, useTransition } from "react";
import type { WafAnomaly, WafJail, WafTrafficSummary } from "@polaris/core";
import { Activity, Ban, Globe, RadarIcon, RefreshCw, ShieldOff, Timer, TriangleAlert } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Skeleton, Switch, TimeSeriesChart } from "@polaris/ui";
import {
    blockAnomalyAction,
    getWafOverviewAction,
    liftWafBanAction,
    setTorBlockedAction,
    setWafAnomalySettingsAction,
    setWafJailsAction,
    type WafBanView
} from "./actions";

type Overview = Awaited<ReturnType<typeof getWafOverviewAction>>;

/** Thousands separators without a locale. Deliberately hand-rolled: toLocaleString
 *  would pick a separator from the browser, which disagrees with the server on the
 *  first render and is not the operator's chosen format either. */
function grouped(value: number): string {
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** How far back the traffic panel looks. The edge log is the source, so a longer
 *  window is only as good as the log's own rotation - see wafTraffic. */
const WINDOWS = [
    { hours: 1, label: "1h" },
    { hours: 24, label: "24h" },
    { hours: 168, label: "7d" }
];

/**
 * Applies a change to what is on screen, then confirms it with the server. Handed
 * down so every control here behaves the same way: the switch moves under the
 * finger, and only a real failure moves it back.
 */
export type Mutate = (
    patch: (current: Overview) => Overview,
    run: () => Promise<{ error?: string }>
) => void;

export function FirewallInstancePanels() {
    const [hours, setHours] = useState(24);
    const [data, setData] = useState<Overview | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [refreshing, startRefresh] = useTransition();

    const load = useCallback((window: number) => {
        startRefresh(async () => {
            setData(await getWafOverviewAction(window));
        });
    }, []);

    useEffect(() => load(hours), [hours, load]);

    const mutate = useCallback<Mutate>(
        (patch, run) => {
            setData((current) => {
                if (!current) return current;
                const previous = current;
                setFailure(null);
                void run().then((result) => {
                    if (result.error) {
                        // Put back exactly what was there. Rolling back to a refetch
                        // instead would also undo anything else changed meanwhile.
                        setData(previous);
                        setFailure(result.error);
                        return;
                    }
                    // Re-read so the figures the server derives - ban counts, the size
                    // of a feed - catch up with the change that was just made.
                    load(hours);
                });
                return patch(current);
            });
        },
        [hours, load]
    );

    return (
        <div className="flex flex-col gap-4">
            <TrafficPanel
                traffic={data?.traffic}
                hours={hours}
                onHours={setHours}
                loading={!data}
                refreshing={refreshing}
                onRefresh={() => load(hours)}
            />
            <AnomaliesPanel
                anomalies={data?.anomalies}
                settings={data?.anomalySettings}
                loading={!data}
                mutate={mutate}
            />
            <BansPanel bans={data?.bans} loading={!data} mutate={mutate} />
            <JailsPanel jails={data?.jails} loading={!data} onSaved={() => load(hours)} />
            <IntelPanel tor={data?.tor} loading={!data} mutate={mutate} />
            {failure ? <p className="text-sm text-danger">{failure}</p> : null}
            {data?.error ? <p className="text-sm text-danger">{data.error}</p> : null}
        </div>
    );
}

function TrafficPanel({
    traffic,
    hours,
    onHours,
    loading,
    refreshing,
    onRefresh
}: {
    traffic: WafTrafficSummary | undefined;
    hours: number;
    onHours: (hours: number) => void;
    loading: boolean;
    refreshing: boolean;
    onRefresh: () => void;
}) {
    const format = useDisplayFormat();
    return (
        <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                    <Activity className="size-4 text-muted-foreground" />
                    Traffic
                </CardTitle>
                <div className="flex items-center gap-1">
                    {WINDOWS.map((window) => (
                        <button
                            key={window.hours}
                            type="button"
                            onClick={() => onHours(window.hours)}
                            className={`rounded-md px-2 py-1 text-xs transition-colors ${
                                window.hours === hours
                                    ? "bg-muted font-medium text-foreground"
                                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                            }`}
                        >
                            {window.label}
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={onRefresh}
                        aria-label="Refresh"
                        title="Refresh"
                        className="ml-1 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
                    </button>
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                {loading ? (
                    <Skeleton className="h-32 w-full" />
                ) : !traffic || traffic.total === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        Nothing recorded in this window. The figures come from the edge&apos;s own request log, so a
                        service reached directly on its port does not appear here.
                    </p>
                ) : (
                    <>
                        <div className="flex flex-wrap gap-6">
                            <Stat label="Requests" value={grouped(traffic.total)} />
                            <Stat label="Blocked" value={grouped(traffic.blocked)} tone="danger" />
                            <Stat
                                label="Share blocked"
                                value={traffic.blockedRate === null ? "-" : `${traffic.blockedRate.toFixed(1)}%`}
                            />
                        </div>
                        <TimeSeriesChart
                            points={traffic.series.map((point) => ({ t: point.t, v: point.blocked }))}
                            from={traffic.from}
                            to={traffic.to}
                            tone="danger"
                            summary="sum"
                            label="Blocked"
                            formatTime={(at) => format.dateTime(at)}
                        />
                        <div className="grid gap-4 md:grid-cols-3">
                            <TopList title="Addresses" entries={traffic.topAddresses} />
                            <TopList title="Paths" entries={traffic.topPaths} />
                            <TopList title="User agents" entries={traffic.topAgents} />
                        </div>
                    </>
                )}
            </CardBody>
        </Card>
    );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
    return (
        <div>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className={`text-xl font-semibold ${tone === "danger" ? "text-danger" : ""}`}>{value}</div>
        </div>
    );
}

function TopList({ title, entries }: { title: string; entries: readonly { value: string; count: number }[] }) {
    return (
        <div className="min-w-0">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">Top blocked {title.toLowerCase()}</div>
            {entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">None.</p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {entries.map((entry) => (
                        <li key={entry.value} className="flex items-baseline justify-between gap-2 text-xs">
                            <span className="truncate font-mono" title={entry.value}>
                                {entry.value}
                            </span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">{entry.count}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * What the detector currently sees in the traffic: addresses using a route in a way
 * the rest of its traffic does not.
 *
 * The evidence is shown, not just the verdict. "198.51.100.9 made 200 requests where
 * everyone else made about 5" is something an operator can agree or disagree with;
 * "suspicious activity detected" is not, and it is why nobody trusts that kind of
 * panel. Automatic blocking is off until they have seen it be right a few times.
 */
function AnomaliesPanel({
    anomalies,
    settings,
    loading,
    mutate
}: {
    anomalies: WafAnomaly[] | undefined;
    settings: WafAnomalySettings | undefined;
    loading: boolean;
    mutate: Mutate;
}) {
    const high = (anomalies ?? []).filter((anomaly) => anomaly.severity === "high").length;

    function patchSettings(next: WafAnomalySettings) {
        mutate(
            (current) => ({ ...current, anomalySettings: next }),
            () => setWafAnomalySettingsAction(next)
        );
    }

    return (
        <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                    <RadarIcon className="size-4 text-muted-foreground" />
                    Anomalies
                    {high > 0 ? <Badge variant="danger">{String(high)}</Badge> : null}
                </CardTitle>
                {settings ? (
                    <Switch
                        checked={settings.enabled}
                        aria-label="Detect route abuse"
                        onChange={(on) => patchSettings({ ...settings, enabled: on })}
                    />
                ) : null}
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                    Traffic that is fine one request at a time and wrong in aggregate: a file pulled hundreds of times,
                    a route walked rather than used, a payload in a query string. Each address is judged against what
                    the rest of that route&apos;s visitors do, so a busy endpoint is not an anomaly just for being busy.
                </p>

                {loading ? (
                    <Skeleton className="h-20 w-full" />
                ) : !settings?.enabled ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">Detection is off.</p>
                ) : !anomalies || anomalies.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                        Nothing unusual in the last ten minutes.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {anomalies.slice(0, 12).map((anomaly) => (
                            <li
                                key={`${anomaly.kind}:${anomaly.ip}:${anomaly.route}`}
                                className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2"
                            >
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2 text-sm">
                                        <span className="font-mono text-xs">{anomaly.ip}</span>
                                        <Badge variant={anomaly.severity === "high" ? "danger" : "neutral"}>
                                            {anomaly.kind.replace(/-/g, " ")}
                                        </Badge>
                                        <span className="truncate font-mono text-xs text-muted-foreground">
                                            {anomaly.route}
                                        </span>
                                    </div>
                                    <p className="mt-0.5 text-xs text-muted-foreground">{anomaly.detail}</p>
                                </div>
                                <button
                                    type="button"
                                    aria-label={`Block ${anomaly.ip}`}
                                    title="Block this address"
                                    onClick={() =>
                                        mutate(
                                            (current) => ({
                                                ...current,
                                                anomalies: current.anomalies?.filter((entry) => entry.ip !== anomaly.ip)
                                            }),
                                            () => blockAnomalyAction(anomaly.ip, `${anomaly.route}: ${anomaly.detail}`)
                                        )
                                    }
                                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                                >
                                    <Ban className="size-3.5" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}

                {settings?.enabled ? (
                    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-sm">Block automatically</div>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                    Bans the address behind anything scored high, without waiting for you. Leave it off
                                    until the findings above have been right a few times.
                                </p>
                            </div>
                            <Switch
                                checked={settings.autoBlock}
                                aria-label="Block anomalies automatically"
                                onChange={(on) => patchSettings({ ...settings, autoBlock: on })}
                            />
                        </div>
                        <div className="flex flex-wrap gap-3">
                            <NumberField
                                label="Times the norm"
                                value={settings.overBaseline}
                                min={2}
                                max={1000}
                                onChange={(value) => patchSettings({ ...settings, overBaseline: value })}
                            />
                            <NumberField
                                label="Asset fetches"
                                value={settings.assetMax}
                                min={5}
                                max={100000}
                                onChange={(value) => patchSettings({ ...settings, assetMax: value })}
                            />
                            <NumberField
                                label="Query variants"
                                value={settings.variantMax}
                                min={5}
                                max={100000}
                                onChange={(value) => patchSettings({ ...settings, variantMax: value })}
                            />
                            <NumberField
                                label="Ban for (min)"
                                value={Math.round(settings.banTimeSec / 60)}
                                min={1}
                                max={43200}
                                onChange={(value) => patchSettings({ ...settings, banTimeSec: value * 60 })}
                            />
                        </div>
                    </div>
                ) : null}
            </CardBody>
        </Card>
    );
}

function BansPanel({ bans, loading, mutate }: { bans: WafBanView[] | undefined; loading: boolean; mutate: Mutate }) {
    const format = useDisplayFormat();

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Ban className="size-4 text-muted-foreground" />
                    Blocked right now
                    {bans && bans.length > 0 ? <Badge>{String(bans.length)}</Badge> : null}
                </CardTitle>
            </CardHeader>
            <CardBody>
                {loading ? (
                    <Skeleton className="h-20 w-full" />
                ) : !bans || bans.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                        Nobody is banned. Addresses appear here when they trip a jail below or a reputation provider
                        flags them.
                    </p>
                ) : (
                    <div className="-mx-2 overflow-x-auto">
                        <table className="w-full min-w-[36rem] text-sm">
                            <thead>
                                <tr className="text-left text-xs text-muted-foreground">
                                    <th className="px-2 pb-2 font-medium">Address</th>
                                    <th className="px-2 pb-2 font-medium">Why</th>
                                    <th className="px-2 pb-2 font-medium">Until</th>
                                    <th className="px-2 pb-2 font-medium sr-only">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {bans.map((ban) => (
                                    <tr key={ban.ip} className="border-t border-border">
                                        <td className="px-2 py-2 font-mono text-xs">
                                            {ban.ip}
                                            {ban.offences > 1 ? (
                                                <span className="ml-2 text-muted-foreground">
                                                    {ban.offences}x
                                                </span>
                                            ) : null}
                                        </td>
                                        <td className="px-2 py-2 text-xs text-muted-foreground">
                                            {ban.note ?? ban.source}
                                        </td>
                                        <td className="px-2 py-2 text-xs text-muted-foreground">
                                            {ban.until ? format.dateTime(ban.until) : "Until removed"}
                                        </td>
                                        <td className="px-2 py-2 text-right">
                                            <button
                                                type="button"
                                                aria-label={`Lift the ban on ${ban.ip}`}
                                                title="Lift this ban"
                                                onClick={() =>
                                                    mutate(
                                                        (current) => ({
                                                            ...current,
                                                            bans: current.bans?.filter((row) => row.ip !== ban.ip)
                                                        }),
                                                        () => liftWafBanAction(ban.ip)
                                                    )
                                                }
                                                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                            >
                                                <ShieldOff className="size-3.5" />
                                            </button>
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

function JailsPanel({
    jails,
    loading,
    onSaved
}: {
    jails: WafJail[] | undefined;
    loading: boolean;
    onSaved: () => void;
}) {
    const [draft, setDraft] = useState<WafJail[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, start] = useTransition();
    const current = draft ?? jails ?? [];
    const dirty = draft !== null && jails !== undefined && JSON.stringify(draft) !== JSON.stringify(jails);

    function update(id: string, patch: Partial<WafJail>) {
        setDraft(current.map((jail) => (jail.id === id ? { ...jail, ...patch } : jail)));
    }

    function save() {
        setError(null);
        start(async () => {
            const result = await setWafJailsAction(
                current.map((jail) => ({
                    id: jail.id,
                    enabled: jail.enabled,
                    maxRetry: jail.maxRetry,
                    findTimeSec: jail.findTimeSec,
                    banTimeSec: jail.banTimeSec
                }))
            );
            if (result.error) {
                setError(result.error);
                return;
            }
            setDraft(null);
            onSaved();
        });
    }

    return (
        <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2">
                    <Timer className="size-4 text-muted-foreground" />
                    Automatic bans
                </CardTitle>
                {dirty ? (
                    <Button type="button" size="sm" disabled={pending} onClick={save}>
                        Save
                    </Button>
                ) : null}
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                    Counted from the edge&apos;s request log, not per request, so watching an address over five minutes
                    costs a visitor nothing. A repeat offender is held progressively longer.
                </p>
                {loading ? (
                    <Skeleton className="h-32 w-full" />
                ) : (
                    current.map((jail) => (
                        <div key={jail.id} className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-sm">{jail.label}</div>
                                    <p className="mt-0.5 text-xs text-muted-foreground">{jail.description}</p>
                                </div>
                                <Switch
                                    checked={jail.enabled}
                                    onChange={(on) => update(jail.id, { enabled: on })}
                                    aria-label={jail.label}
                                />
                            </div>
                            {jail.enabled ? (
                                <div className="flex flex-wrap gap-3">
                                    <NumberField
                                        label="Requests"
                                        value={jail.maxRetry}
                                        min={1}
                                        max={1000}
                                        onChange={(value) => update(jail.id, { maxRetry: value })}
                                    />
                                    <NumberField
                                        label="Within (min)"
                                        value={Math.round(jail.findTimeSec / 60)}
                                        min={1}
                                        max={1440}
                                        onChange={(value) => update(jail.id, { findTimeSec: value * 60 })}
                                    />
                                    <NumberField
                                        label="Ban for (min)"
                                        value={Math.round(jail.banTimeSec / 60)}
                                        min={1}
                                        max={43200}
                                        onChange={(value) => update(jail.id, { banTimeSec: value * 60 })}
                                    />
                                </div>
                            ) : null}
                        </div>
                    ))
                )}
                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

function NumberField({
    label,
    value,
    min,
    max,
    onChange
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
}) {
    return (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {label}
            <input
                type="number"
                value={value}
                min={min}
                max={max}
                onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, Math.round(next))));
                }}
                className="h-8 w-24 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            />
        </label>
    );
}

function IntelPanel({
    tor,
    loading,
    mutate
}: {
    tor: { enabled: boolean; count: number; fetchedAt: string | null; error: string | null } | undefined;
    loading: boolean;
    mutate: Mutate;
}) {
    const format = useDisplayFormat();

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Globe className="size-4 text-muted-foreground" />
                    Threat intelligence
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                {loading ? (
                    <Skeleton className="h-16 w-full" />
                ) : (
                    <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5">
                        <div className="min-w-0">
                            <div className="text-sm">Block the Tor network</div>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                                Refuses every Tor exit node. The list is fetched hourly and held at the edge, so a
                                request is never delayed by looking one up.
                            </p>
                            {/* Only once there is a list. Between switching it on and
                                the first fetch landing there is no count to show, and
                                "0 exit nodes" would read as a broken feed. */}
                            {tor?.enabled && tor.count > 0 ? (
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {grouped(tor.count)} exit nodes
                                    {tor.fetchedAt ? `, updated ${format.dateTime(tor.fetchedAt)}` : ""}
                                </p>
                            ) : null}
                            {tor?.error ? (
                                <p className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                                    <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                                    Last refresh failed ({tor.error}). The previous list is still being enforced.
                                </p>
                            ) : null}
                        </div>
                        <Switch
                            checked={tor?.enabled ?? false}
                            aria-label="Block the Tor network"
                            onChange={(on) =>
                                mutate(
                                    (current) => ({
                                        ...current,
                                        tor: { count: 0, fetchedAt: null, error: null, ...current.tor, enabled: on }
                                    }),
                                    () => setTorBlockedAction(on)
                                )
                            }
                        />
                    </div>
                )}
                <p className="text-xs text-muted-foreground">
                    Reputation providers block addresses already known for scanning or attacks. Connect{" "}
                    <Link href="/integrations" className="text-primary underline-offset-2 hover:underline">
                        Dymo API or Criminal IP
                    </Link>{" "}
                    to switch them on. They are asked in the background about addresses seen in your traffic, never
                    while a request is waiting.
                </p>
            </CardBody>
        </Card>
    );
}
