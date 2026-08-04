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
 * Rendered only for `system.manage`: bans, jails and the trusted list apply to the
 * whole instance and are not a project's to change. Rendered under the rule LIST rather
 * than beside the editor, so a rule opened from that list gets a page to itself instead
 * of one with the whole instance's traffic stapled underneath it.
 */

import Link from "next/link";
import { grouped } from "./page-parts";
import { ChipList, validAddress } from "./chip-list";
import { AddressAccounts } from "./address-accounts";
import { useDisplayFormat } from "@/components/display-format";
import type { WafAnomalySettings } from "@/lib/waf-anomaly-service";
import { useCallback, useEffect, useState, useTransition } from "react";
import type { WafAnomaly, WafJail, WafTrafficSummary } from "@polaris/core";
import { Activity, Ban, Globe, RadarIcon, RefreshCw, ShieldCheck, ShieldOff, Timer } from "lucide-react";
import {
    blockAnomalyAction,
    getWafAddressActivityAction,
    getWafOverviewAction,
    liftWafBanAction,
    setWafAnomalySettingsAction,
    setWafIgnoreListAction,
    setWafJailsAction,
    type WafBanView
} from "./actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Skeleton,
    Switch,
    TimeSeriesChart
} from "@polaris/ui";

type Overview = Awaited<ReturnType<typeof getWafOverviewAction>>;

/** What the address dialog is handed: the requests, and - for a reader allowed
 *  to be told - the accounts the address has been seen on. */
type AddressReport = Awaited<ReturnType<typeof getWafAddressActivityAction>>;

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

export function FirewallInstancePanels({
    /** The address this page is being read over. Marked wherever it appears, and
     *  offered to the trusted list in one click - "is that me?" is the first question
     *  anybody asks of a finding, and the page is the only thing that can answer it. */
    callerIp
}: {
    callerIp?: string | null;
}) {
    const [hours, setHours] = useState(24);
    const [data, setData] = useState<Overview | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    // The address whose requests are open. Held here rather than in each panel so an
    // address means the same thing wherever it appears - banned, anomalous, or just
    // near the top of the blocked list.
    const [inspecting, setInspecting] = useState<string | null>(null);
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

    /**
     * Add an address to the trusted list, from wherever it was judged.
     *
     * The other half of a finding: "block this" was already one click and "this one is
     * wrong" was a trip to a list somewhere else, so the only cheap answer to a false
     * positive was to switch the whole detector off.
     */
    const trust = useCallback(
        (ip: string) => {
            // Seeded from what the server holds, not from anything half-typed below:
            // the panel drops its draft when this lands, so the two cannot disagree.
            const next = [...new Set([...(data?.trusted ?? []), ip])];
            mutate(
                (current) => ({
                    ...current,
                    trusted: next,
                    anomalies: current.anomalies?.filter((entry) => entry.ip !== ip)
                }),
                () => setWafIgnoreListAction(next)
            );
        },
        [data, mutate]
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
                onInspect={setInspecting}
            />
            <AnomaliesPanel
                anomalies={data?.anomalies}
                settings={data?.anomalySettings}
                loading={!data}
                callerIp={callerIp}
                mutate={mutate}
                onTrust={trust}
                onInspect={setInspecting}
            />
            <TrustedPanel
                trusted={data?.trusted}
                loading={!data}
                callerIp={callerIp}
                onSaved={() => load(hours)}
            />
            <BansPanel
                bans={data?.bans}
                loading={!data}
                callerIp={callerIp}
                mutate={mutate}
                onInspect={setInspecting}
            />
            <JailsPanel jails={data?.jails} loading={!data} onSaved={() => load(hours)} />
            <IntelPanel />
            {failure ? <p className="text-sm text-danger">{failure}</p> : null}
            {data?.error ? <p className="text-sm text-danger">{data.error}</p> : null}
            <AddressDialog ip={inspecting} hours={hours} onClose={() => setInspecting(null)} />
        </div>
    );
}

/**
 * An address, wherever one is shown. It opens what that address did rather than
 * sitting there as text to be copied into a search somewhere else - the next question
 * after seeing an address on this page is always "what did it do", and this is the
 * only screen that can answer it.
 */
function AddressLink({
    ip,
    callerIp,
    onInspect
}: {
    ip: string;
    /** The address the page is being read over. Marked, because a home connection
     *  puts everyone behind one address and a finding about it is usually the
     *  operator looking at their own traffic. */
    callerIp?: string | null;
    onInspect: (ip: string) => void;
}) {
    const mine = callerIp !== null && callerIp !== undefined && callerIp === ip;
    return (
        <span className="inline-flex items-baseline gap-1.5">
            <button
                type="button"
                onClick={() => onInspect(ip)}
                title={`What ${ip} has been doing`}
                className="rounded font-mono underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                {ip}
            </button>
            {mine ? (
                <span
                    className="shrink-0 rounded bg-muted px-1 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground"
                    title="The address you are reading this page over. Everyone on your network shares it."
                >
                    You
                </span>
            ) : null}
        </span>
    );
}

function TrafficPanel({
    traffic,
    hours,
    onHours,
    loading,
    refreshing,
    onRefresh,
    onInspect
}: {
    traffic: WafTrafficSummary | undefined;
    hours: number;
    onHours: (hours: number) => void;
    loading: boolean;
    refreshing: boolean;
    onRefresh: () => void;
    onInspect: (ip: string) => void;
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
                            <TopList title="Addresses" entries={traffic.topAddresses} onInspect={onInspect} />
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

function TopList({
    title,
    entries,
    onInspect
}: {
    title: string;
    entries: readonly { value: string; count: number }[];
    /** Given only for the address list; a path is not something to open. */
    onInspect?: (ip: string) => void;
}) {
    return (
        <div className="min-w-0">
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">Top blocked {title.toLowerCase()}</div>
            {entries.length === 0 ? (
                <p className="text-xs text-muted-foreground">None.</p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {entries.map((entry) => (
                        <li key={entry.value} className="flex items-baseline justify-between gap-2 text-xs">
                            {onInspect ? (
                                <AddressLink ip={entry.value} onInspect={onInspect} />
                            ) : (
                                <span className="truncate font-mono" title={entry.value}>
                                    {entry.value}
                                </span>
                            )}
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
    callerIp,
    mutate,
    onTrust,
    onInspect
}: {
    anomalies: WafAnomaly[] | undefined;
    settings: WafAnomalySettings | undefined;
    loading: boolean;
    callerIp?: string | null;
    mutate: Mutate;
    onTrust: (ip: string) => void;
    onInspect: (ip: string) => void;
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
                    Traffic that is fine one request at a time and wrong in aggregate. Each address is judged against
                    what the rest of that route&apos;s visitors do, so a busy endpoint is not an anomaly for being busy.
                    Trusted addresses are never judged.
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
                                        <span className="text-xs text-muted-foreground">
                                            <AddressLink ip={anomaly.ip} callerIp={callerIp} onInspect={onInspect} />
                                        </span>
                                        <Badge variant={anomaly.severity === "high" ? "danger" : "neutral"}>
                                            {anomaly.kind.replace(/-/g, " ")}
                                        </Badge>
                                        <span className="truncate font-mono text-xs text-muted-foreground">
                                            {anomaly.route}
                                        </span>
                                    </div>
                                    <p className="mt-0.5 text-xs text-muted-foreground">{anomaly.detail}</p>
                                </div>
                                {/* Both verdicts, because a finding an operator
                                    disagrees with is as common as one they act on -
                                    and with only the ban here, the cheapest way to
                                    say "this is wrong" was to switch detection off. */}
                                <div className="flex shrink-0 items-center gap-1">
                                    <button
                                        type="button"
                                        aria-label={`Trust ${anomaly.ip}`}
                                        title="This is not an attack: never judge this address"
                                        onClick={() => onTrust(anomaly.ip)}
                                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <ShieldCheck className="size-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={`Block ${anomaly.ip}`}
                                        title="Block this address"
                                        onClick={() =>
                                            mutate(
                                                (current) => ({
                                                    ...current,
                                                    anomalies: current.anomalies?.filter(
                                                        (entry) => entry.ip !== anomaly.ip
                                                    )
                                                }),
                                                () =>
                                                    blockAnomalyAction(
                                                        anomaly.ip,
                                                        `${anomaly.route}: ${anomaly.detail}`
                                                    )
                                            )
                                        }
                                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                                    >
                                        <Ban className="size-3.5" />
                                    </button>
                                </div>
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

function BansPanel({
    bans,
    loading,
    callerIp,
    mutate,
    onInspect
}: {
    bans: WafBanView[] | undefined;
    loading: boolean;
    callerIp?: string | null;
    mutate: Mutate;
    onInspect: (ip: string) => void;
}) {
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
                        Nobody is banned. Addresses appear here when they trip a jail below, or when a reputation
                        provider flags them.
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
                                        <td className="px-2 py-2 text-xs">
                                            <AddressLink ip={ban.ip} callerIp={callerIp} onInspect={onInspect} />
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
                                            {/* A ban with no expiry is the strictest verdict the
                                                firewall issues, so it says what it is rather than
                                                leaving a blank where a date goes. */}
                                            {ban.until ? (
                                                format.dateTime(ban.until)
                                            ) : (
                                                <Badge variant="danger">Until you lift it</Badge>
                                            )}
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
                    Counted from the edge&apos;s request log rather than per request, so watching an address costs a
                    visitor nothing. A repeat offender is held progressively longer.
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

/**
 * The addresses the firewall leaves alone.
 *
 * The list the jails already had, finally on screen - and now governing the anomaly
 * detector too, which is what the operator's own address needed. A home connection puts
 * a whole household behind one public address, and the person configuring the firewall
 * is by far its heaviest user: every page, every reload, every asset. Against a route's
 * ordinary visitor that is a flood, and a detector that reports it is a detector nobody
 * believes the day it is right.
 */
function TrustedPanel({
    trusted,
    loading,
    callerIp,
    onSaved
}: {
    trusted: string[] | undefined;
    loading: boolean;
    callerIp?: string | null;
    onSaved: () => void;
}) {
    const [draft, setDraft] = useState<string[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, start] = useTransition();
    const current = draft ?? trusted ?? [];
    const dirty = draft !== null && trusted !== undefined && JSON.stringify(draft) !== JSON.stringify(trusted);
    const canAddSelf = callerIp !== null && callerIp !== undefined && !current.includes(callerIp);

    // The list can also be added to from a finding in the panel above, and a draft
    // typed here would then be a stale copy that took the new address back out again
    // the moment somebody pressed Save. The server's answer wins; what was half-typed
    // was never a decision.
    const saved = JSON.stringify(trusted ?? []);
    useEffect(() => {
        setDraft(null);
    }, [saved]);

    function save(entries: string[]) {
        setError(null);
        start(async () => {
            const result = await setWafIgnoreListAction(entries);
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
                    <ShieldCheck className="size-4 text-muted-foreground" />
                    Trusted addresses
                </CardTitle>
                {dirty ? (
                    <Button type="button" size="sm" disabled={pending} onClick={() => save(current)}>
                        Save
                    </Button>
                ) : null}
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-xs text-muted-foreground">
                    Never banned and never reported as an anomaly. Loopback is always trusted. Add your own address or
                    range so your everyday use of the instance is not read as an attack on it.
                </p>
                {loading ? (
                    <Skeleton className="h-16 w-full" />
                ) : (
                    <>
                        <ChipList
                            entries={current}
                            placeholder="203.0.113.4 or 203.0.113.0/24"
                            disabled={pending}
                            validate={validAddress}
                            invalidMessage="Enter an IP address or a CIDR range."
                            onChange={setDraft}
                        />
                        {canAddSelf ? (
                            <button
                                type="button"
                                disabled={pending}
                                onClick={() => save([...current, callerIp])}
                                className="w-fit text-xs text-primary underline-offset-2 hover:underline disabled:opacity-50"
                            >
                                Trust this device (<span className="font-mono">{callerIp}</span>)
                            </button>
                        ) : null}
                    </>
                )}
                {error ? <p className="text-xs text-danger">{error}</p> : null}
            </CardBody>
        </Card>
    );
}

function IntelPanel() {
    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Globe className="size-4 text-muted-foreground" />
                    Reputation providers
                </CardTitle>
            </CardHeader>
            <CardBody>
                <p className="text-xs text-muted-foreground">
                    Blocks addresses already known for scanning or attacks. Connect{" "}
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

/** A response code, coloured by what it means: refused, missing, or served. */
function statusTone(status: number): string {
    if (status === 403 || status === 429) return "text-danger";
    if (status >= 400) return "text-warning";
    return "text-muted-foreground";
}

/**
 * What one address did, opened from wherever that address was shown.
 *
 * A ban reads as a claim - "Exploit probing: 37 in 1m" - and a claim an operator
 * cannot check is one they either believe or disable. So the requests behind it are
 * here in full: what was asked for, what it got back, and when. It is also how the
 * other direction gets settled, when the address turns out to be a monitoring probe
 * or an office that should never have been banned at all - which the accounts
 * panel above the requests answers directly, for the reader it is willing to name
 * accounts to.
 */
function AddressDialog({ ip, hours, onClose }: { ip: string | null; hours: number; onClose: () => void }) {
    const format = useDisplayFormat();
    const [loaded, setLoaded] = useState<AddressReport | null>(null);
    const [error, setError] = useState<string | null>(null);
    const windowLabel = WINDOWS.find((entry) => entry.hours === hours)?.label ?? `${hours}h`;
    const activity = loaded?.activity ?? null;

    useEffect(() => {
        if (!ip) return;
        let active = true;
        setLoaded(null);
        setError(null);
        void getWafAddressActivityAction(ip, hours).then((result) => {
            if (!active) return;
            if (result.error) setError(result.error);
            else setLoaded(result);
        });
        return () => {
            active = false;
        };
    }, [ip, hours]);

    return (
        <Dialog open={ip !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-3xl">
                <DialogHeader className="pr-8">
                    <DialogTitle className="font-mono">{ip}</DialogTitle>
                    <DialogDescription>
                        Every request from this address in the last {windowLabel}, read from the edge&apos;s own log.
                    </DialogDescription>
                </DialogHeader>

                {/* Who was signed in from here does not come from the log and does not
                    depend on the window, so it sits above the requests and is still
                    there when the window held nothing at all. */}
                {loaded?.accounts ? (
                    <div className="mb-4">
                        <AddressAccounts accounts={loaded.accounts} />
                    </div>
                ) : null}

                {error ? (
                    <p className="text-sm text-danger">{error}</p>
                ) : !activity ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-40 w-full" />
                    </div>
                ) : activity.total === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        Nothing from this address in that window. A ban outlives the log it was made from, so an older
                        one can be enforced with nothing left here to show for it.
                    </p>
                ) : (
                    <div className="flex flex-col gap-4">
                        <div className="flex flex-wrap gap-6">
                            <Stat label="Requests" value={grouped(activity.total)} />
                            <Stat label="Blocked" value={grouped(activity.blocked)} tone="danger" />
                            {activity.firstSeen ? (
                                <Stat label="First seen" value={format.dateTime(activity.firstSeen)} />
                            ) : null}
                            {activity.lastSeen ? (
                                <Stat label="Last seen" value={format.dateTime(activity.lastSeen)} />
                            ) : null}
                        </div>

                        {/* What it collected, at a glance. Thirty-seven 404s and one 200
                            is a sweep that found something, which is not visible from a
                            list you have to scroll. */}
                        {activity.statuses.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                                {activity.statuses.map((entry) => (
                                    <span
                                        key={entry.value}
                                        className="rounded-md border border-border px-1.5 py-0.5 font-mono text-xs"
                                    >
                                        <span className={statusTone(Number(entry.value))}>{entry.value}</span>
                                        <span className="ml-1.5 text-muted-foreground">{grouped(entry.count)}</span>
                                    </span>
                                ))}
                            </div>
                        ) : null}

                        <div className="grid gap-4 sm:grid-cols-2">
                            {activity.topPaths.length > 0 ? (
                                <div className="min-w-0">
                                    <div className="mb-1 text-xs font-medium text-muted-foreground">
                                        Most asked for
                                    </div>
                                    <ul className="flex flex-col gap-0.5">
                                        {activity.topPaths.map((entry) => (
                                            <li
                                                key={entry.value}
                                                className="flex items-baseline justify-between gap-2 text-xs"
                                            >
                                                <span className="truncate font-mono" title={entry.value}>
                                                    {entry.value}
                                                </span>
                                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                                    {grouped(entry.count)}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null}
                            {activity.agents.length > 0 ? (
                                <div className="min-w-0">
                                    <div className="mb-1 text-xs font-medium text-muted-foreground">Calling itself</div>
                                    <ul className="flex flex-col gap-0.5">
                                        {activity.agents.map((agent) => (
                                            <li
                                                key={agent.value}
                                                className="truncate font-mono text-xs"
                                                title={agent.value}
                                            >
                                                {agent.value}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null}
                        </div>

                        <div className="max-h-80 overflow-auto rounded-md border border-border">
                            <table className="w-full min-w-[34rem] text-xs">
                                <thead className="sticky top-0 bg-card">
                                    <tr className="text-left text-muted-foreground">
                                        <th className="px-2 py-1.5 font-medium">When</th>
                                        <th className="px-2 py-1.5 font-medium">Method</th>
                                        <th className="px-2 py-1.5 font-medium">Status</th>
                                        <th className="px-2 py-1.5 font-medium">Path</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {activity.requests.map((request, index) => (
                                        <tr
                                            key={`${request.at}:${request.path}:${index}`}
                                            className="border-t border-border"
                                        >
                                            {/* With seconds: a sweep puts dozens of these
                                                inside one minute, and a column where every
                                                row reads the same says nothing about it. */}
                                            <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                                                {format.dateTime(request.at, { seconds: true })}
                                            </td>
                                            <td className="px-2 py-1.5 font-mono text-muted-foreground">
                                                {request.method}
                                            </td>
                                            <td className={`px-2 py-1.5 font-mono tabular-nums ${statusTone(request.status)}`}>
                                                {request.status}
                                            </td>
                                            <td className="max-w-0 truncate px-2 py-1.5 font-mono" title={request.path}>
                                                {request.path}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {activity.truncated ? (
                            <p className="text-xs text-muted-foreground">
                                Showing the {grouped(activity.requests.length)} most recent of {grouped(activity.total)}.
                                The counts above cover all of them.
                            </p>
                        ) : null}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
