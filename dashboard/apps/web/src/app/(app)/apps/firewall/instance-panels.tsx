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
import type { WafJail, WafTrafficSummary } from "@polaris/core";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Activity, Ban, Globe, RefreshCw, ShieldOff, Timer, TriangleAlert } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Skeleton, Switch, TimeSeriesChart } from "@polaris/ui";
import {
    getWafOverviewAction,
    liftWafBanAction,
    setTorBlockedAction,
    setWafJailsAction,
    type WafBanView
} from "./actions";

type Overview = Awaited<ReturnType<typeof getWafOverviewAction>>;

/** Thousands separators without a locale. Deliberately hand-rolled: toLocaleString
 *  would pick a separator from the browser, which disagrees with the server on the
 *  first render and is not the operator's chosen format either. */
function grouped(value: number): string {
    return String(Math.round(value)).replace(/B(?=(d{3})+(?!d))/g, ",");
}

/** How far back the traffic panel looks. The edge log is the source, so a longer
 *  window is only as good as the log's own rotation - see wafTraffic. */
const WINDOWS = [
    { hours: 1, label: "1h" },
    { hours: 24, label: "24h" },
    { hours: 168, label: "7d" }
];

export function FirewallInstancePanels() {
    const [hours, setHours] = useState(24);
    const [data, setData] = useState<Overview | null>(null);
    const [refreshing, startRefresh] = useTransition();

    const load = useCallback(
        (window: number) => {
            startRefresh(async () => {
                setData(await getWafOverviewAction(window));
            });
        },
        [startRefresh]
    );

    useEffect(() => load(hours), [hours, load]);

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
            <BansPanel bans={data?.bans} loading={!data} onChanged={() => load(hours)} />
            <JailsPanel jails={data?.jails} loading={!data} onChanged={() => load(hours)} />
            <IntelPanel tor={data?.tor} loading={!data} onChanged={() => load(hours)} />
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

function BansPanel({
    bans,
    loading,
    onChanged
}: {
    bans: WafBanView[] | undefined;
    loading: boolean;
    onChanged: () => void;
}) {
    const format = useDisplayFormat();
    const [pending, start] = useTransition();

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Ban className="size-4 text-muted-foreground" />
                    Blocked right now
                    {bans && bans.length > 0 ? <Badge>{bans.length}</Badge> : null}
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
                                                disabled={pending}
                                                aria-label={`Lift the ban on ${ban.ip}`}
                                                title="Lift this ban"
                                                onClick={() =>
                                                    start(async () => {
                                                        await liftWafBanAction(ban.ip);
                                                        onChanged();
                                                    })
                                                }
                                                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
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
    onChanged
}: {
    jails: WafJail[] | undefined;
    loading: boolean;
    onChanged: () => void;
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
            onChanged();
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
    onChanged
}: {
    tor: { enabled: boolean; count: number; fetchedAt: string | null; error: string | null } | undefined;
    loading: boolean;
    onChanged: () => void;
}) {
    const format = useDisplayFormat();
    const [pending, start] = useTransition();

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
                            {tor?.enabled ? (
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
                            disabled={pending}
                            aria-label="Block the Tor network"
                            onChange={(on) =>
                                start(async () => {
                                    await setTorBlockedAction(on);
                                    onChanged();
                                })
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
