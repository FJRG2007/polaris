"use client";

/**
 * One NAS: its status and fan mode, its drives bay by bay, its temperature and
 * usage history, and its backup tasks.
 *
 * The name, place and tabs paint at once; what the console says waits on
 * `/api/places/nas/<id>`, read again while the tab is visible, each region with
 * a skeleton of its own.
 */

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { formatBytes } from "@polaris/core";
import { ArrowLeft, HardDrive, Play, Share2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
    Badge,
    Button,
    Checkbox,
    MultiSeriesChart,
    PageHeader,
    SegmentedControl,
    Select,
    Skeleton,
    useToast
} from "@polaris/ui";
import { ShareDialog } from "@/components/access/share-dialog";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NasAnswer } from "@/lib/nas/nas-service";
import * as nasView from "@/lib/nas/nas-view";
import { runNasBackupAction, setNasFanAction, setNasPlaceAction } from "../actions";
import type { UnasFanProfile } from "@/lib/unifi-unas-control";

const POLL_MS = 30_000;
const TABS = ["overview", "storage", "backups"] as const;
type Tab = (typeof TABS)[number];
const FAN_PROFILES = ["quiet", "balanced", "cooling"] as const;
const OPTIONAL_COLUMNS = ["size", "pool", "powerOn", "serial"] as const;
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export interface NasReaderStanding {
    readonly manage: boolean;
    readonly fan: boolean;
    readonly backup: boolean;
}

export function NasDetailView({
    nas,
    standing,
    places
}: {
    nas: { id: string; name: string; placeId: string | null };
    standing: NasReaderStanding;
    places: { id: string; name: string }[];
}) {
    const t = useTranslations("servers");
    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();
    const asked = search.get("tab");
    const tab: Tab = (TABS as readonly string[]).includes(asked ?? "")
        ? (asked as Tab)
        : "overview";
    const [range, setRange] = useState<nasView.NasRange>("1d");
    const [sharing, setSharing] = useState(false);
    const toast = useToast();
    const live = useLiveResource<NasAnswer>({
        url: `/api/places/nas/${nas.id}?range=${range}`,
        cacheKey: `nas:${nas.id}:${range}`,
        intervalMs: POLL_MS,
        select: (body) => body as NasAnswer
    });
    const answer = live.data;
    const status = answer?.status.ok ? answer.status.value : null;

    // Optimistic: the picker shows the new place at once, and goes back if refused.
    const [placeId, setPlaceId] = useState<string | null>(nas.placeId);
    async function movePlace(next: string | null) {
        const before = placeId;
        if (next === before) return;
        setPlaceId(next);
        const outcome = await setNasPlaceAction(nas.id, next);
        if (!outcome.ok) {
            setPlaceId(before);
            toast.show({ key: `nas:${nas.id}:place`, title: t("nas.place.failed") });
        }
    }

    function openTab(next: Tab) {
        const params = new URLSearchParams(search.toString());
        if (next === "overview") params.delete("tab");
        else params.set("tab", next);
        const query = params.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }

    const rangePicker = (
        <SegmentedControl<nasView.NasRange>
            size="sm"
            aria-label={t("nas.chart.temperature")}
            value={range}
            onValueChange={setRange}
            options={nasView.NAS_RANGES.map((key) => ({
                value: key,
                label: t(`nas.ranges.${key}`)
            }))}
        />
    );

    return (
        <>
            <Link
                href="/places/nas"
                className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4 shrink-0" aria-hidden />
                {t("nas.back")}
            </Link>
            <PageHeader
                title={nas.name}
                description={status ? `${status.model} - ${status.firmware}` : undefined}
                actions={
                    <div className="flex flex-wrap gap-2">
                        {standing.manage && places.length > 0 ? (
                            <Select
                                aria-label={t("nas.place.label")}
                                className="w-48"
                                value={placeId ?? ""}
                                onValueChange={(value) => void movePlace(value || null)}
                                options={[
                                    { value: "", label: t("nas.place.none") },
                                    ...places.map((place) => ({
                                        value: place.id,
                                        label: place.name
                                    }))
                                ]}
                            />
                        ) : null}
                        {standing.manage ? (
                            <>
                                <Button variant="outline" asChild>
                                    <Link href={`/drive?c=${nas.id}`}>
                                        <HardDrive className="size-4 shrink-0" aria-hidden />
                                        {t("nas.openDrive")}
                                    </Link>
                                </Button>
                                <Button variant="outline" onClick={() => setSharing(true)}>
                                    <Share2 className="size-4 shrink-0" aria-hidden />
                                    {t("nas.share")}
                                </Button>
                            </>
                        ) : null}
                    </div>
                }
            />

            <div className="mb-4 overflow-x-auto">
                <SegmentedControl<Tab>
                    size="sm"
                    aria-label={t("nas.heading")}
                    value={tab}
                    onValueChange={openTab}
                    options={TABS.map((key) => ({ value: key, label: t(`nas.tabs.${key}`) }))}
                />
            </div>

            {answer && !answer.status.ok ? (
                <p role="status" className="mb-4 text-sm text-muted-foreground">
                    {t("nas.unreachable")}
                </p>
            ) : null}

            {tab === "overview" ? (
                <div className="flex flex-col gap-6">
                    <NasNow answer={answer} />
                    <NasFan
                        id={nas.id}
                        answer={answer}
                        canSet={standing.fan}
                        onChanged={live.refresh}
                    />
                    <section className="flex flex-col gap-3">
                        <div className="flex justify-end">{rangePicker}</div>
                        <NasHistory answer={answer} range={range} />
                    </section>
                </div>
            ) : null}
            {tab === "storage" ? (
                <div className="flex flex-col gap-6">
                    <NasBays disks={status?.disks ?? null} />
                    <section className="flex flex-col gap-3">
                        <div className="flex justify-end">{rangePicker}</div>
                        <NasBayHistory answer={answer} range={range} />
                    </section>
                </div>
            ) : null}
            {tab === "backups" ? (
                <NasTasks
                    id={nas.id}
                    answer={answer}
                    canRun={standing.backup}
                    onChanged={live.refresh}
                />
            ) : null}

            {standing.manage ? (
                <ShareDialog
                    open={sharing}
                    onOpenChange={setSharing}
                    subject="place.nas"
                    subjectId={nas.id}
                    name={nas.name}
                    bounded
                />
            ) : null}
        </>
    );
}

function NasNow({ answer }: { answer: NasAnswer | null }) {
    const t = useTranslations("servers");
    if (!answer) return <Skeleton className="h-24 w-full" />;
    if (!answer.status.ok) return null;
    const status = answer.status.value;
    const usage =
        status.totalBytes > 0 ? Math.round((status.usedBytes / status.totalBytes) * 100) : null;
    const days = Math.floor(status.uptimeSeconds / 86_400);
    const hours = Math.floor((status.uptimeSeconds % 86_400) / 3_600);
    const tiles: { key: string; label: string; value: string }[] = [
        { key: "model", label: t("nas.status.model"), value: status.model || "-" },
        { key: "firmware", label: t("nas.status.firmware"), value: status.firmware || "-" },
        {
            key: "uptime",
            label: t("nas.status.uptime"),
            value:
                days > 0
                    ? t("nas.units.daysHours", { days, hours })
                    : t("nas.units.hours", { value: hours })
        },
        {
            key: "cpuTemp",
            label: t("nas.status.cpuTemp"),
            value:
                status.cpuTemp === null
                    ? "-"
                    : t("nas.units.celsius", { value: Math.round(status.cpuTemp) })
        },
        {
            key: "memory",
            label: t("nas.status.memory"),
            value:
                status.memoryTotalBytes > 0
                    ? `${formatBytes(status.memoryUsedBytes)} / ${formatBytes(status.memoryTotalBytes)}`
                    : "-"
        },
        {
            key: "usage",
            label: t("nas.status.usage"),
            value:
                usage === null
                    ? "-"
                    : `${formatBytes(status.usedBytes)} / ${formatBytes(status.totalBytes)} (${t("nas.units.percent", { value: usage })})`
        }
    ];
    return (
        <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t("nas.status.health")}</span>
                <Badge variant={status.health === "healthy" ? "success" : "warning"}>
                    {t(`nas.status.${status.health === "healthy" ? "healthy" : "atrisk"}`)}
                </Badge>
                {status.pools.map((pool) => (
                    <Badge key={pool.device} variant="neutral" title={pool.device}>
                        {pool.raidLevel ?? t("nas.status.unprotected")}
                    </Badge>
                ))}
            </div>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {tiles.map((tile) => (
                    <div key={tile.key} className="min-w-0 rounded-md border p-3">
                        <dt className="text-xs text-muted-foreground">{tile.label}</dt>
                        <dd className="truncate text-sm font-medium" title={tile.value}>
                            {tile.value}
                        </dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}

function NasFan({
    id,
    answer,
    canSet,
    onChanged
}: {
    id: string;
    answer: NasAnswer | null;
    canSet: boolean;
    onChanged: () => void;
}) {
    const t = useTranslations("servers");
    const toast = useToast();
    const [chosen, setChosen] = useState<{
        profile: UnasFanProfile;
        seen: NasAnswer | null;
    } | null>(null);
    const latest = useRef(answer);
    latest.current = answer;
    if (!answer) return <Skeleton className="h-10 w-72" />;
    const known = answer.fan.ok ? answer.fan.value : null;
    const shown =
        chosen && (chosen.seen === null || chosen.seen === answer) ? chosen.profile : known;
    async function choose(next: UnasFanProfile) {
        if (next === shown) return;
        setChosen({ profile: next, seen: null });
        const outcome = await setNasFanAction(id, next);
        if (!outcome.ok) {
            setChosen(null);
            toast.show({ key: `nas:${id}:fan`, title: t("nas.fan.failed") });
            return;
        }
        setChosen({ profile: next, seen: latest.current });
        toast.show({ key: `nas:${id}:fan`, title: t("nas.fan.saved") });
        onChanged();
    }
    return (
        <section className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">{t("nas.fan.label")}</span>
            {canSet && answer.fan.ok ? (
                <SegmentedControl<UnasFanProfile>
                    size="sm"
                    aria-label={t("nas.fan.label")}
                    value={shown}
                    onValueChange={(next) => void choose(next)}
                    options={FAN_PROFILES.map((key) => ({
                        value: key,
                        label: t(`nas.fan.${key}`)
                    }))}
                />
            ) : (
                <Badge variant="neutral">{t(`nas.fan.${shown ?? "unknown"}`)}</Badge>
            )}
        </section>
    );
}

function useWindow(range: nasView.NasRange) {
    const to = Date.now();
    return { from: to - nasView.NAS_RANGE_MS[range], to };
}

function NasHistory({ answer, range }: { answer: NasAnswer | null; range: nasView.NasRange }) {
    const t = useTranslations("servers");
    const { from, to } = useWindow(range);
    const charts = useMemo(() => {
        if (!answer) return null;
        const points = answer.history;
        return {
            empty: points.length === 0,
            temperature: [
                {
                    key: "hottest",
                    label: t("nas.chart.hottest"),
                    points: points.map((point) => ({ t: point.t, v: point.diskTempMaxC }))
                },
                {
                    key: "average",
                    label: t("nas.chart.average"),
                    points: points.map((point) => ({ t: point.t, v: point.diskTempAvgC }))
                },
                {
                    key: "cpu",
                    label: t("nas.chart.cpu"),
                    points: points.map((point) => ({ t: point.t, v: point.cpuTempC }))
                }
            ],
            usage: [
                {
                    key: "usage",
                    label: t("nas.chart.usage"),
                    points: points.map((point) => ({ t: point.t, v: point.usedPercent }))
                }
            ]
        };
    }, [answer, t]);
    if (!charts) return <Skeleton className="h-48 w-full" />;
    if (charts.empty)
        return <p className="text-sm text-muted-foreground">{t("nas.chart.empty")}</p>;
    return (
        <>
            <div className="grid gap-4 lg:grid-cols-2">
                <MultiSeriesChart
                    label={t("nas.chart.temperature")}
                    series={charts.temperature}
                    from={from}
                    to={to}
                    format={(value) => t("nas.units.celsius", { value: Math.round(value) })}
                />
                <MultiSeriesChart
                    label={t("nas.chart.usage")}
                    series={charts.usage}
                    from={from}
                    to={to}
                    max={100}
                    format={(value) => t("nas.units.percent", { value: Math.round(value) })}
                />
            </div>
            <p className="text-xs text-muted-foreground">{t("nas.chart.noThroughput")}</p>
        </>
    );
}

function NasBayHistory({ answer, range }: { answer: NasAnswer | null; range: nasView.NasRange }) {
    const t = useTranslations("servers");
    const { from, to } = useWindow(range);
    const series = useMemo(() => {
        if (!answer) return null;
        const bays = [...new Set(answer.history.flatMap((point) => Object.keys(point.bays)))].sort(
            (a, b) => Number(a) - Number(b)
        );
        return bays.map((bay) => ({
            key: `bay-${bay}`,
            label: t("nas.chart.bay", { bay }),
            points: answer.history.map((point) => ({ t: point.t, v: point.bays[bay] ?? null }))
        }));
    }, [answer, t]);
    if (!series) return <Skeleton className="h-48 w-full" />;
    if (series.length === 0)
        return <p className="text-sm text-muted-foreground">{t("nas.chart.empty")}</p>;
    return (
        <MultiSeriesChart
            label={t("nas.chart.bays")}
            series={series}
            from={from}
            to={to}
            format={(value) => t("nas.units.celsius", { value: Math.round(value) })}
        />
    );
}

function NasBays({ disks }: { disks: nasView.NasDisk[] | null }) {
    const t = useTranslations("servers");
    const [status, setStatus] = useState<nasView.BayStatusFilter>("any");
    const [temp, setTemp] = useState<nasView.BayTempFilter>("any");
    const [pool, setPool] = useState("");
    const [columns, setColumns] = useState<Set<OptionalColumn>>(new Set(["size", "pool"]));
    if (!disks) return <Skeleton className="h-64 w-full" />;
    const pools = [...new Set(disks.flatMap((disk) => (disk.pool ? [disk.pool] : [])))];
    const shown = nasView.filterBays(disks, status, temp, pool);
    const summary = nasView.allDisks(disks);
    const celsius = (value: number | null) =>
        value === null ? "-" : t("nas.units.celsius", { value: Math.round(value) });
    const has = (column: OptionalColumn) => columns.has(column);
    const toggle = (column: OptionalColumn) =>
        setColumns((before) => {
            const next = new Set(before);
            if (next.has(column)) next.delete(column);
            else next.add(column);
            return next;
        });
    return (
        <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">{t("nas.bays.title")}</h2>
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    aria-label={t("nas.bays.filterStatus")}
                    className="w-44"
                    value={status}
                    onValueChange={(value) => setStatus(value as nasView.BayStatusFilter)}
                    options={(["any", "optimal", "notOptimal", "empty"] as const).map((key) => ({
                        value: key,
                        label: key === "any" ? t("nas.bays.filterStatus") : t(`nas.bays.${key}`)
                    }))}
                />
                <Select
                    aria-label={t("nas.bays.filterTemp")}
                    className="w-44"
                    value={temp}
                    onValueChange={(value) => setTemp(value as nasView.BayTempFilter)}
                    options={(["any", "cool", "warm", "hot"] as const).map((key) => ({
                        value: key,
                        label: key === "any" ? t("nas.bays.filterTemp") : t(`nas.bays.${key}`)
                    }))}
                />
                {pools.length > 1 ? (
                    <Select
                        aria-label={t("nas.bays.filterPool")}
                        className="w-44"
                        value={pool}
                        onValueChange={setPool}
                        options={[
                            { value: "", label: t("nas.bays.filterPool") },
                            ...pools.map((name) => ({ value: name, label: name }))
                        ]}
                    />
                ) : null}
                <fieldset className="flex flex-wrap items-center gap-3 text-sm">
                    <legend className="sr-only">{t("nas.bays.columns")}</legend>
                    {OPTIONAL_COLUMNS.map((column) => (
                        <label key={column} className="inline-flex items-center gap-1.5">
                            <Checkbox checked={has(column)} onChange={() => toggle(column)} />
                            {t(`nas.bays.${column}`)}
                        </label>
                    ))}
                </fieldset>
            </div>
            <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">{t("nas.bays.bay")}</th>
                            <th className="px-3 py-2 font-medium">{t("nas.bays.drive")}</th>
                            <th className="px-3 py-2 font-medium">{t("nas.bays.status")}</th>
                            <th className="px-3 py-2 font-medium">{t("nas.bays.temperature")}</th>
                            {has("size") ? (
                                <th className="px-3 py-2 font-medium">{t("nas.bays.size")}</th>
                            ) : null}
                            {has("pool") ? (
                                <th className="px-3 py-2 font-medium">{t("nas.bays.pool")}</th>
                            ) : null}
                            {has("powerOn") ? (
                                <th className="px-3 py-2 font-medium">{t("nas.bays.powerOn")}</th>
                            ) : null}
                            {has("serial") ? (
                                <th className="px-3 py-2 font-medium">{t("nas.bays.serial")}</th>
                            ) : null}
                        </tr>
                    </thead>
                    <tbody className="divide-y">
                        <tr className="bg-muted/40">
                            <td className="px-3 py-2 font-medium" colSpan={2}>
                                {t("nas.bays.allDisks")}
                            </td>
                            <td className="px-3 py-2" colSpan={2 + columns.size}>
                                {t("nas.bays.allDisksValue", {
                                    count: summary.count,
                                    min: celsius(summary.minTemp),
                                    max: celsius(summary.maxTemp),
                                    hours: summary.avgPowerOnHours ?? "-"
                                })}
                            </td>
                        </tr>
                        {shown.map((disk) => (
                            <tr key={disk.slot}>
                                <td className="px-3 py-2 tabular-nums">{disk.slot}</td>
                                <td
                                    className="max-w-56 truncate px-3 py-2"
                                    title={disk.model ?? ""}
                                >
                                    {disk.present ? (disk.model ?? "-") : t("nas.bays.noDrive")}
                                </td>
                                <td className="px-3 py-2">
                                    {disk.present ? (
                                        <Badge variant={disk.healthy ? "success" : "warning"}>
                                            {t(
                                                `nas.bays.${disk.healthy ? "optimal" : "notOptimal"}`
                                            )}
                                        </Badge>
                                    ) : (
                                        "-"
                                    )}
                                </td>
                                <td className="px-3 py-2 tabular-nums">
                                    {celsius(disk.temperature)}
                                </td>
                                {has("size") ? (
                                    <td className="px-3 py-2 tabular-nums">
                                        {disk.present ? formatBytes(disk.sizeBytes) : "-"}
                                    </td>
                                ) : null}
                                {has("pool") ? (
                                    <td className="px-3 py-2">{disk.pool ?? "-"}</td>
                                ) : null}
                                {has("powerOn") ? (
                                    <td className="px-3 py-2 tabular-nums">
                                        {disk.powerOnHours === null
                                            ? "-"
                                            : t("nas.units.hours", { value: disk.powerOnHours })}
                                    </td>
                                ) : null}
                                {has("serial") ? (
                                    <td className="px-3 py-2 font-mono text-xs">
                                        {disk.serial ?? "-"}
                                    </td>
                                ) : null}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("nas.bays.noMatch")}</p>
            ) : null}
        </section>
    );
}

function NasTasks({
    id,
    answer,
    canRun,
    onChanged
}: {
    id: string;
    answer: NasAnswer | null;
    canRun: boolean;
    onChanged: () => void;
}) {
    const t = useTranslations("servers");
    const toast = useToast();
    const [busy, setBusy] = useState<string | null>(null);
    if (!answer) return <Skeleton className="h-32 w-full" />;
    if (!answer.tasks.ok)
        return <p className="text-sm text-muted-foreground">{t("nas.tasks.unavailable")}</p>;
    const tasks = answer.tasks.value;
    const now = new Date();
    const when = (value: string | null) => {
        const at = value ? Date.parse(value) : Number.NaN;
        return Number.isFinite(at) ? new Date(at).toLocaleString() : t("nas.tasks.never");
    };
    async function run(taskId: string) {
        setBusy(taskId);
        const outcome = await runNasBackupAction(id, taskId);
        setBusy(null);
        toast.show({
            key: `nas:${id}:task:${taskId}`,
            title: t(outcome.ok ? "nas.tasks.running" : "nas.tasks.failed")
        });
        if (outcome.ok) onChanged();
    }
    return (
        <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">{t("nas.tasks.title")}</h2>
            {tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("nas.tasks.none")}</p>
            ) : (
                <ul className="flex flex-col divide-y rounded-md border">
                    {tasks.map((task) => {
                        const failed = nasView.backupFailed(task);
                        const overdue = nasView.backupOverdue(task, now);
                        return (
                            <li
                                key={task.id}
                                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
                            >
                                <div className="flex min-w-0 flex-col gap-1">
                                    <span
                                        className="truncate text-sm font-medium"
                                        title={task.name}
                                    >
                                        {task.name}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {t("nas.tasks.lastRun")}:{" "}
                                        {when(task.lastFinishedAt ?? task.lastStartedAt)} -{" "}
                                        {t("nas.tasks.nextRun")}:{" "}
                                        {task.scheduleEnabled
                                            ? when(task.nextRun)
                                            : t("nas.tasks.scheduleOff")}
                                    </span>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                    {failed ? (
                                        <Badge variant="danger">{t("nas.tasks.error")}</Badge>
                                    ) : task.lastFinishedAt ? (
                                        <Badge variant="success">{t("nas.tasks.ok")}</Badge>
                                    ) : null}
                                    {overdue ? (
                                        <Badge variant="warning">{t("nas.tasks.overdue")}</Badge>
                                    ) : null}
                                    {canRun ? (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={busy !== null}
                                            onClick={() => void run(task.id)}
                                        >
                                            <Play className="size-4 shrink-0" aria-hidden />
                                            {t("nas.tasks.run")}
                                        </Button>
                                    ) : null}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
