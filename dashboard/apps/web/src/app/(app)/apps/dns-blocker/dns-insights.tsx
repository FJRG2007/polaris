"use client";

/**
 * Today on the Ad blocker: how many lookups, how many blocked, who asks most,
 * the query log, and pausing blocking for a while.
 *
 * The card's chrome and filters paint at once; only the numbers and the rows
 * wait for the engine. A domain or device in a row is a button that filters the
 * log by it, which is what a reader reaches for next.
 */

import { Loader2, Pause, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";
import type { DnsInsights } from "@/lib/dns-blocker/insights";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NameCount, QueryFilter } from "@/lib/dns-blocker/query-log";
import {
    dnsInsightsAction,
    pauseDnsBlockingAction,
    resumeDnsBlockingAction,
    turnOnDnsBlockerAction
} from "./actions";

const PAUSES = [5, 15, 30, 60] as const;

export function DnsInsightsCard({ onApplied }: { onApplied: () => void }) {
    const t = useTranslations("dnsBlocker");
    const [filter, setFilter] = useState<QueryFilter>({ search: "", outcome: "all", client: "" });
    const [typed, setTyped] = useState("");
    const [data, setData] = useState<DnsInsights | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [minutes, setMinutes] = useState("15");
    const [loading, setLoading] = useState(true);
    const [pending, startTransition] = useTransition();
    const [applying, startApplying] = useTransition();
    const latest = useRef(0);

    const load = useCallback(async (next: QueryFilter, fresh = false) => {
        const request = ++latest.current;
        setLoading(true);
        const result = await dnsInsightsAction(next, fresh);
        if (request !== latest.current) return;
        setLoading(false);
        if (result.error !== undefined) {
            setError(result.error);
            return;
        }
        setError(null);
        setData(result.insights);
    }, []);

    useEffect(() => {
        void load(filter);
    }, [filter, load]);

    useEffect(() => {
        const timer = setTimeout(() => {
            setFilter((current) =>
                current.search === typed.trim().toLowerCase()
                    ? current
                    : { ...current, search: typed.trim().toLowerCase() }
            );
        }, 300);
        return () => clearTimeout(timer);
    }, [typed]);

    const togglePause = () =>
        startTransition(async () => {
            const result =
                data?.pause.enabled === false
                    ? await resumeDnsBlockingAction()
                    : await pauseDnsBlockingAction({ minutes: Number(minutes) });
            if (result.error !== undefined) setError(result.error);
            await load(filter, true);
        });

    const applySettings = () =>
        startApplying(async () => {
            const result = await turnOnDnsBlockerAction();
            if (result.error !== undefined) setError(result.error);
            onApplied();
            await load(filter, true);
        });

    const stats = data?.stats;
    const pause = data?.pause;
    const pauseLabel = !pause
        ? null
        : pause.enabled
          ? t("insights.active")
          : pause.secondsLeft
            ? t("insights.pausedFor", { minutes: Math.ceil(pause.secondsLeft / 60) })
            : t("insights.paused");

    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <CardTitle className="truncate">{t("insights.title")}</CardTitle>
                    {pauseLabel ? (
                        <Badge variant={pause?.enabled ? "success" : "warning"}>{pauseLabel}</Badge>
                    ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {pause?.enabled === false ? null : (
                        <Select
                            className="w-28"
                            value={minutes}
                            aria-label={t("insights.pauseFor")}
                            onValueChange={setMinutes}
                            options={PAUSES.map((value) => ({
                                value: String(value),
                                label:
                                    value === 60
                                        ? t("insights.hour")
                                        : t("insights.minutes", { count: value })
                            }))}
                        />
                    )}
                    <Button variant="secondary" disabled={pending || !data} onClick={togglePause}>
                        {pending ? (
                            <Loader2 className="size-4 shrink-0 animate-spin" />
                        ) : pause?.enabled === false ? (
                            <Play className="size-4 shrink-0" />
                        ) : (
                            <Pause className="size-4 shrink-0" />
                        )}
                        {pause?.enabled === false ? t("insights.resume") : t("insights.pause")}
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("insights.refresh")}
                        title={t("insights.refresh")}
                        disabled={loading}
                        onClick={() => void load(filter, true)}
                    >
                        <RefreshCw className={`size-4 shrink-0 ${loading ? "animate-spin" : ""}`} />
                    </Button>
                </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-5">
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                {data?.logOff ? (
                    <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3 sm:flex-row sm:items-center">
                        <p className="min-w-0 flex-1 text-sm">{t("insights.logOff")}</p>
                        <Button
                            variant="secondary"
                            className="shrink-0"
                            disabled={applying}
                            onClick={applySettings}
                        >
                            {applying ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                            {t("insights.apply")}
                        </Button>
                    </div>
                ) : null}
                {!data && !loading ? null : (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <Figure
                            label={t("insights.queries")}
                            value={stats?.queries.toLocaleString()}
                        />
                        <Figure
                            label={t("insights.blocked")}
                            value={stats?.blocked.toLocaleString()}
                        />
                        <Figure
                            label={t("insights.blockedPercent")}
                            value={stats ? `${stats.blockedPercent}%` : undefined}
                        />
                    </div>
                )}
                {stats && stats.queries === 0 && !data?.logOff ? (
                    <p className="text-sm text-muted-foreground">{t("insights.empty")}</p>
                ) : null}
                {!data && !loading ? null : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                        <TopList
                            title={t("insights.topDomains")}
                            items={stats?.topDomains}
                            empty={t("insights.none")}
                            hint={t("insights.filterDomain")}
                            onPick={(name) => setTyped(name)}
                        />
                        <TopList
                            title={t("insights.topBlocked")}
                            items={stats?.topBlocked}
                            empty={t("insights.none")}
                            hint={t("insights.filterDomain")}
                            onPick={(name) => setTyped(name)}
                        />
                        <TopList
                            title={t("insights.topClients")}
                            items={stats?.topClients}
                            empty={t("insights.none")}
                            hint={t("insights.filterClient")}
                            onPick={(name) =>
                                setFilter((current) => ({ ...current, client: name }))
                            }
                        />
                    </div>
                )}
                {!data && !loading ? null : (
                    <div className="flex flex-col gap-3">
                        <h3 className="text-sm font-medium">{t("insights.log")}</h3>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                                className="min-w-0 flex-1"
                                value={typed}
                                placeholder={t("insights.search")}
                                aria-label={t("insights.search")}
                                onChange={(event) => setTyped(event.target.value)}
                            />
                            <Select
                                className="w-full sm:w-36"
                                value={filter.outcome}
                                aria-label={t("insights.outcome")}
                                onValueChange={(value) =>
                                    setFilter((current) => ({
                                        ...current,
                                        outcome: value as QueryFilter["outcome"]
                                    }))
                                }
                                options={[
                                    { value: "all", label: t("insights.all") },
                                    { value: "blocked", label: t("insights.blockedOnly") },
                                    { value: "allowed", label: t("insights.allowedOnly") }
                                ]}
                            />
                            <Select
                                className="w-full sm:w-44"
                                value={filter.client || "*"}
                                aria-label={t("insights.client")}
                                onValueChange={(value) =>
                                    setFilter((current) => ({
                                        ...current,
                                        client: value === "*" ? "" : value
                                    }))
                                }
                                options={[
                                    { value: "*", label: t("insights.allClients") },
                                    ...(stats?.clients ?? []).map((client) => ({
                                        value: client,
                                        label: client
                                    }))
                                ]}
                            />
                        </div>
                        <QueryRows
                            data={data}
                            t={t}
                            onClient={(client) => setFilter((current) => ({ ...current, client }))}
                            onDomain={setTyped}
                        />
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

function Figure({ label, value }: { label: string; value: string | undefined }) {
    return (
        <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/40 p-3">
            <span className="truncate text-xs text-muted-foreground" title={label}>
                {label}
            </span>
            {value === undefined ? (
                <Skeleton className="h-7 w-20" />
            ) : (
                <span className="truncate text-2xl font-semibold tabular-nums" title={value}>
                    {value}
                </span>
            )}
        </div>
    );
}

function TopList({
    title,
    items,
    empty,
    hint,
    onPick
}: {
    title: string;
    items: readonly NameCount[] | undefined;
    empty: string;
    hint: string;
    onPick: (name: string) => void;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-medium">{title}</h3>
            {!items ? (
                <Skeleton className="h-24 w-full" />
            ) : items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{empty}</p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {items.map((item) => (
                        <li key={item.name} className="flex min-w-0 items-center gap-2 text-sm">
                            <button
                                type="button"
                                title={hint}
                                className="min-w-0 flex-1 truncate text-left hover:underline"
                                onClick={() => onPick(item.name)}
                            >
                                {item.name}
                            </button>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                                {item.count.toLocaleString()}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function QueryRows({
    data,
    t,
    onClient,
    onDomain
}: {
    data: DnsInsights | null;
    t: ReturnType<typeof useTranslations<"dnsBlocker">>;
    onClient: (client: string) => void;
    onDomain: (domain: string) => void;
}) {
    if (!data) return <Skeleton className="h-40 w-full" />;
    if (data.rows.length === 0)
        return <p className="text-sm text-muted-foreground">{t("insights.noMatches")}</p>;
    return (
        <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">
                {t("insights.showing", { count: data.rows.length })}
            </p>
            <div className="max-h-96 overflow-auto rounded-md border border-border">
                <table className="w-full table-fixed text-sm">
                    <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="w-40 p-2 font-medium">{t("insights.time")}</th>
                            <th className="p-2 font-medium">{t("insights.domain")}</th>
                            <th className="hidden w-16 p-2 font-medium sm:table-cell">
                                {t("insights.type")}
                            </th>
                            <th className="hidden w-36 p-2 font-medium md:table-cell">
                                {t("insights.client")}
                            </th>
                            <th className="w-28 p-2 font-medium">{t("insights.outcome")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.rows.map((row, index) => (
                            <tr key={`${row.time}-${index}`} className="border-t border-border">
                                <td className="truncate p-2 tabular-nums text-muted-foreground">
                                    {row.time}
                                </td>
                                <td className="p-2">
                                    <button
                                        type="button"
                                        title={row.domain}
                                        className="block w-full truncate text-left hover:underline"
                                        onClick={() => onDomain(row.domain)}
                                    >
                                        {row.domain}
                                    </button>
                                </td>
                                <td className="hidden truncate p-2 sm:table-cell" title={row.type}>
                                    {row.type}
                                </td>
                                <td className="hidden p-2 md:table-cell">
                                    <button
                                        type="button"
                                        title={t("insights.filterClient")}
                                        className="block w-full truncate text-left hover:underline"
                                        onClick={() => onClient(row.client)}
                                    >
                                        {row.client}
                                    </button>
                                </td>
                                <td className="p-2">
                                    <Badge
                                        variant={row.outcome === "blocked" ? "danger" : "neutral"}
                                    >
                                        {row.outcome === "blocked"
                                            ? t("insights.blockedOnly")
                                            : t("insights.allowedOnly")}
                                    </Badge>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
