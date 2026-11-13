"use client";

/**
 * A project's performance: its pages and requests, how long they take, and the
 * slow ones taken apart.
 *
 * The list is sorted, filtered and paged by the server, over percentiles the
 * telemetry-performance job has already worked out, so a project with
 * thousands of routes opens as fast as one with three. A route opens on its
 * Web Vitals, its slowest transactions and their spans, and the two things
 * somebody does about a slow page: hand its issue to a person, or to Polar.
 */

import Link from "next/link";
import * as paths from "./paths";
import * as actions from "./actions";
import * as polls from "./telemetry-polls";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { useDebounced } from "./use-debounced";
import { AssignDialog } from "./issue-dialogs";
import { useCursorList } from "./use-cursor-list";
import * as perf from "@/lib/telemetry/performance";
import type { NamespaceKey } from "@/lib/i18n/types";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowDown, ArrowLeft, Bot, Gauge, Target, UserPlus } from "lucide-react";
import type { RouteRow, RouteSort, SampleRow, VitalRow } from "@/lib/telemetry/performance-store";
import {
    Badge,
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";

type Key = NamespaceKey<"telemetry">;

/** The columns that sort, in the order they are drawn. */
const SORTABLE: readonly RouteSort[] = ["count", "p50", "p75", "p95"];
const ALL_OPS = "all";

/** How much slower than usual, as a signed percentage, or null with no history. */
export function trendOf(row: Pick<RouteRow, "p75" | "baselineP75">): number | null {
    if (row.p75 === null || row.baselineP75 === null || row.baselineP75 <= 0) return null;
    return Math.round((row.p75 / row.baselineP75 - 1) * 100);
}

export function PerformanceList({
    projectId,
    readOnly,
    hrefFor
}: {
    projectId: string;
    readOnly: boolean;
    hrefFor: (routeId: string) => string;
}) {
    const t = useTranslations("telemetry");
    const [sort, setSort] = useState<RouteSort>("p75");
    const [op, setOp] = useState(ALL_OPS);
    const [typed, setTyped] = useState("");
    const query = useDebounced(typed.trim(), 250);
    const [ops, setOps] = useState<readonly string[]>([]);
    const [projectTarget, setProjectTarget] = useState<number | null>(null);
    const [targeting, setTargeting] = useState(false);

    const list = useCursorList<RouteRow, Awaited<ReturnType<typeof actions.performancePageAction>>["data"] & object>(
        (cursor, signal) =>
            polls.telemetryPerformance(
                { projectId, sort, op: op === ALL_OPS ? null : op, query: query || null, cursor },
                signal
            ),
        `${projectId}|${sort}|${op}|${query}`,
        (page) => {
            if (page.ops.length > 0) setOps(page.ops);
            setProjectTarget(page.projectTarget);
        }
    );

    const filtered = op !== ALL_OPS || query !== "";

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Input
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    placeholder={t("performance.search")}
                    aria-label={t("performance.search")}
                    className="min-w-0 flex-1 sm:max-w-xs"
                />
                <Select
                    value={op}
                    onValueChange={setOp}
                    className="w-44"
                    aria-label={t("performance.kind")}
                    options={[
                        { value: ALL_OPS, label: t("performance.allKinds") },
                        ...ops.map((value) => ({ value, label: opLabel(t, value) }))
                    ]}
                />
                {!readOnly && (
                    <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={() => setTargeting(true)}>
                        <Target aria-hidden="true" />
                        {projectTarget === null
                            ? t("performance.projectTargetDefault")
                            : t("performance.projectTarget", { target: perf.formatMs(projectTarget) })}
                    </Button>
                )}
            </div>
            {list.error && (
                <p role="alert" className="text-sm text-danger">
                    {list.error}
                </p>
            )}

            {list.items !== null && list.items.length === 0 ? (
                <EmptyState
                    icon={<Gauge />}
                    title={filtered ? t("performance.noMatch") : t("performance.none")}
                    description={filtered ? t("performance.noMatchHint") : t("performance.noneHint")}
                />
            ) : (
                <div className="min-w-0 overflow-x-auto rounded-lg border border-border">
                    <table className="w-full min-w-[640px] text-sm">
                        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2 font-medium">{t("performance.route")}</th>
                                {SORTABLE.map((column) => (
                                    <th key={column} className="w-20 px-2 py-2 text-right font-medium">
                                        <button
                                            type="button"
                                            onClick={() => setSort(column)}
                                            aria-pressed={sort === column}
                                            className={cn(
                                                "inline-flex items-center gap-1 rounded hover:text-foreground",
                                                sort === column && "text-foreground"
                                            )}
                                        >
                                            {t(`performance.columns.${column}` as Key)}
                                            {sort === column && <ArrowDown className="size-3" aria-hidden="true" />}
                                        </button>
                                    </th>
                                ))}
                                <th className="w-20 px-2 py-2 text-right font-medium">{t("performance.target")}</th>
                                <th className="w-20 px-3 py-2 text-right font-medium">{t("performance.trend")}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {list.items === null
                                ? [0, 1, 2].map((index) => (
                                      <tr key={index}>
                                          <td colSpan={7} className="px-3 py-2">
                                              <Skeleton className="h-6 w-full" />
                                          </td>
                                      </tr>
                                  ))
                                : list.items.map((row) => <RouteLine key={row.id} row={row} href={hrefFor(row.id)} />)}
                        </tbody>
                    </table>
                </div>
            )}
            {list.more && (
                <Button variant="ghost" size="sm" className="self-center" disabled={list.paging} onClick={list.loadMore}>
                    {t("performance.more")}
                </Button>
            )}

            {targeting && (
                <TargetDialog
                    projectId={projectId}
                    routeId={null}
                    current={projectTarget}
                    onClose={(saved) => {
                        setTargeting(false);
                        if (saved) list.reload();
                    }}
                />
            )}
        </div>
    );
}

function opLabel(t: ReturnType<typeof useTranslations<"telemetry">>, op: string): string {
    const known = ["pageload", "navigation", "http.server", "http.client"];
    return known.includes(op) ? t(`performance.ops.${op.replace(".", "_")}` as Key) : op;
}

function RouteLine({ row, href }: { row: RouteRow; href: string }) {
    const t = useTranslations("telemetry");
    const over = row.p75 !== null && row.p75 > row.target;
    const trend = trendOf(row);
    return (
        <tr className="transition-colors hover:bg-muted">
            <td className="max-w-0 px-3 py-2">
                <Link href={href} className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-sm" title={row.name}>
                        {row.name}
                    </span>
                    <Badge variant="neutral" className="shrink-0">
                        {opLabel(t, row.op)}
                    </Badge>
                </Link>
            </td>
            <td className="px-2 py-2 text-right tabular-nums">{row.count.toLocaleString()}</td>
            <td className="px-2 py-2 text-right tabular-nums">{perf.formatMetric(row.metric, row.p50)}</td>
            <td className={cn("px-2 py-2 text-right tabular-nums", over && "font-medium text-danger")}>
                {perf.formatMetric(row.metric, row.p75)}
            </td>
            <td className="px-2 py-2 text-right tabular-nums">{perf.formatMetric(row.metric, row.p95)}</td>
            <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                {perf.formatMetric(row.metric, row.target)}
            </td>
            <td
                className={cn(
                    "px-3 py-2 text-right tabular-nums",
                    trend !== null && trend >= 50 ? "text-danger" : "text-muted-foreground"
                )}
            >
                {trend === null ? "-" : `${trend > 0 ? "+" : ""}${trend}%`}
            </td>
        </tr>
    );
}

/** What to ask Polar about a slow route: the route, its numbers, and where the
 *  slowest sample spent its time. */
export function fixPrompt(
    t: ReturnType<typeof useTranslations<"telemetry">>,
    route: RouteRow,
    sample: SampleRow | null
): string {
    const spans = [...(sample?.spans ?? [])]
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10)
        .map((span) => `- ${span.op} ${span.description}: ${perf.formatMs(span.durationMs)}`.trim())
        .join("\n");
    return t("performance.fixPrompt", {
        op: route.op,
        name: route.name,
        p50: perf.formatMetric(route.metric, route.p50),
        p75: perf.formatMetric(route.metric, route.p75),
        p95: perf.formatMetric(route.metric, route.p95),
        target: perf.formatMetric(route.metric, route.target),
        sample: perf.formatMs(sample?.durationMs),
        spans: spans || "-"
    });
}

export function RouteView({
    projectId,
    routeId,
    readOnly,
    viewerId,
    backHref
}: {
    projectId: string;
    routeId: string;
    readOnly: boolean;
    viewerId: string;
    backHref: string;
}) {
    const t = useTranslations("telemetry");
    const [detail, setDetail] = useState<Awaited<ReturnType<typeof actions.routeDetailAction>>["data"] | null>(null);
    const [error, setError] = useState("");
    const [round, setRound] = useState(0);
    const [picked, setPicked] = useState<string | null>(null);
    const [targeting, setTargeting] = useState(false);
    const [assigning, setAssigning] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        void runAction(() => polls.telemetryRoute({ projectId, routeId }, controller.signal), setError).then(
            (result) => {
                if (!result || controller.signal.aborted) return;
                if (result.error) setError(result.error);
                else setDetail(result.data ?? null);
            }
        );
        return () => controller.abort();
    }, [projectId, routeId, round]);

    const route = detail?.route ?? null;
    const sample = detail?.samples.find((one) => one.id === picked) ?? detail?.samples[0] ?? null;
    const assign = async (personId: string | null) => {
        if (!route?.issueId) return;
        const result = await runAction(
            () => actions.assignIssuesAction({ issueIds: [route.issueId], assigneeId: personId }),
            setError
        );
        if (result?.error) setError(result.error);
    };

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Link
                    href={backHref}
                    aria-label={t("performance.back")}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                {route ? (
                    <h3 className="min-w-0 flex-1 truncate font-mono text-sm font-medium" title={route.name}>
                        {route.name}
                    </h3>
                ) : (
                    <Skeleton className="h-4 w-48" />
                )}
                {route && <Badge variant="neutral">{opLabel(t, route.op)}</Badge>}
                {route?.issueId && !readOnly && (
                    <Button variant="outline" size="sm" onClick={() => setAssigning(true)}>
                        <UserPlus aria-hidden="true" />
                        {t("performance.assign")}
                    </Button>
                )}
                {route && (
                    <Button variant="outline" size="sm" asChild>
                        <Link href={`/polar?new=1&prompt=${encodeURIComponent(fixPrompt(t, route, sample))}`}>
                            <Bot aria-hidden="true" />
                            {t("performance.fix")}
                        </Link>
                    </Button>
                )}
            </div>
            {error && (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {error}
                </p>
            )}

            {route ? (
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <Fact label={t("performance.columns.count")} value={route.count.toLocaleString()} />
                    <Fact label={t("performance.columns.p50")} value={perf.formatMetric(route.metric, route.p50)} />
                    <Fact label={t("performance.columns.p75")} value={perf.formatMetric(route.metric, route.p75)} />
                    <Fact label={t("performance.columns.p95")} value={perf.formatMetric(route.metric, route.p95)} />
                    <Fact
                        label={t("performance.usual")}
                        value={perf.formatMetric(route.metric, route.baselineP75)}
                    />
                    <div className="flex min-w-0 flex-col gap-0.5">
                        <dt className="text-xs text-muted-foreground">{t("performance.target")}</dt>
                        <dd className="flex items-center gap-1 text-sm tabular-nums">
                            {perf.formatMetric(route.metric, route.target)}
                            {!readOnly && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-1.5 text-xs"
                                    onClick={() => setTargeting(true)}
                                >
                                    {t("performance.change")}
                                </Button>
                            )}
                        </dd>
                    </div>
                </dl>
            ) : (
                <Skeleton className="h-12 w-full" />
            )}

            {route?.issueId && (
                <Link href={paths.issueHref(projectId, route.issueId)} className="text-sm text-primary hover:underline">
                    {t("performance.openIssue")}
                    {detail?.issueStatus ? ` (${t(`view.statuses.${detail.issueStatus}` as Key)})` : ""}
                </Link>
            )}

            {detail && detail.vitals.length > 0 && <Vitals vitals={detail.vitals} />}

            <section className="flex min-w-0 flex-col gap-2">
                <h4 className="text-sm font-medium">{t("performance.samples")}</h4>
                {detail === null ? (
                    <Skeleton className="h-32 w-full" />
                ) : detail === undefined || detail.samples.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("performance.noSamples")}</p>
                ) : (
                    <div className="flex min-w-0 flex-col gap-3 lg:flex-row">
                        <ul className="flex shrink-0 flex-col divide-y divide-border overflow-hidden rounded-lg border border-border lg:w-64">
                            {detail.samples.map((one) => (
                                <li key={one.id}>
                                    <button
                                        type="button"
                                        onClick={() => setPicked(one.id)}
                                        aria-pressed={sample?.id === one.id}
                                        className={cn(
                                            "flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted",
                                            sample?.id === one.id && "bg-muted"
                                        )}
                                    >
                                        <span className="shrink-0 font-medium tabular-nums">
                                            {perf.formatMs(one.durationMs)}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                            {one.release ?? one.environment ?? ""}
                                        </span>
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            <RelativeTime iso={one.at} />
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {sample && <Waterfall sample={sample} />}
                    </div>
                )}
            </section>

            {targeting && route && (
                <TargetDialog
                    projectId={projectId}
                    routeId={route.id}
                    current={route.ownTarget ? route.target : null}
                    onClose={(saved) => {
                        setTargeting(false);
                        if (saved) setRound((value) => value + 1);
                    }}
                />
            )}
            <AssignDialog
                open={assigning}
                onOpenChange={setAssigning}
                projectId={projectId}
                current={null}
                count={1}
                viewerId={viewerId}
                onAssign={(person) => void assign(person?.id ?? null)}
            />
        </div>
    );
}

function Fact({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="truncate text-xs text-muted-foreground" title={label}>{label}</dt>
            <dd className="text-sm tabular-nums">{value}</dd>
        </div>
    );
}

function Vitals({ vitals }: { vitals: readonly VitalRow[] }) {
    const t = useTranslations("telemetry");
    return (
        <section className="flex min-w-0 flex-col gap-2">
            <h4 className="text-sm font-medium">{t("performance.vitals")}</h4>
            <div className="flex flex-wrap gap-2">
                {vitals.map((vital) => {
                    const over = vital.target !== null && vital.p75 !== null && vital.p75 > vital.target;
                    return (
                        <div
                            key={vital.metric}
                            className="flex min-w-28 flex-col gap-0.5 rounded-md bg-muted/50 px-3 py-2"
                        >
                            <span className="text-xs text-muted-foreground">
                                {t(`performance.metrics.${vital.metric}` as Key)}
                            </span>
                            <span className={cn("text-sm font-medium tabular-nums", over && "text-danger")}>
                                {perf.formatMetric(vital.metric, vital.p75)}
                            </span>
                            {vital.target !== null && (
                                <span className="text-xs text-muted-foreground">
                                    {t("performance.goodUnder", { target: perf.formatMetric(vital.metric, vital.target) })}
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

/** The spans of one transaction, laid out against its length. */
export function Waterfall({ sample }: { sample: SampleRow }) {
    const t = useTranslations("telemetry");
    const span = Math.max(
        sample.durationMs,
        ...sample.spans.map((one) => one.offsetMs + one.durationMs),
        1
    );
    if (sample.spans.length === 0) {
        return <p className="text-sm text-muted-foreground">{t("performance.noSpans")}</p>;
    }
    return (
        <ol className="flex min-w-0 flex-1 flex-col gap-1" aria-label={t("performance.spans")}>
            {sample.spans.map((one) => (
                <li key={one.id} className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-2">
                    <span className="min-w-0 truncate text-xs" title={`${one.op} ${one.description}`}>
                        <span className="font-medium">{one.op}</span>{" "}
                        <span className="text-muted-foreground">{one.description}</span>
                    </span>
                    <span className="relative h-4 min-w-0 rounded bg-muted/50">
                        <span
                            className="absolute inset-y-0 rounded bg-primary/70"
                            style={{
                                left: `${(one.offsetMs / span) * 100}%`,
                                width: `${Math.max(0.5, (one.durationMs / span) * 100)}%`
                            }}
                            title={perf.formatMs(one.durationMs)}
                        />
                    </span>
                </li>
            ))}
        </ol>
    );
}

/** Set how long a route, or every route of the project, should take. */
function TargetDialog({
    projectId,
    routeId,
    current,
    onClose
}: {
    projectId: string;
    routeId: string | null;
    current: number | null;
    onClose: (saved: boolean) => void;
}) {
    const t = useTranslations("telemetry");
    const [value, setValue] = useState(current === null ? "" : String(current));
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const parsed = value.trim() === "" ? null : Number(value);
    const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1 && parsed <= 600_000);
    const unchanged = parsed === current;

    const save = async () => {
        if (!valid || unchanged) return;
        setSaving(true);
        const result = await runAction(
            () => actions.setPerformanceTargetAction({ projectId, routeId, targetMs: parsed }),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        onClose(true);
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose(false)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{routeId ? t("performance.routeTargetTitle") : t("performance.projectTargetTitle")}</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-2">
                    <label className="text-sm" htmlFor="performance-target">
                        {t("performance.targetLabel")}
                    </label>
                    <Input
                        id="performance-target"
                        inputMode="numeric"
                        value={value}
                        onChange={(event) => setValue(event.target.value.replace(/[^\d]/g, ""))}
                        placeholder={t("performance.targetPlaceholder")}
                        aria-invalid={!valid}
                    />
                    <p className={cn("text-xs", valid ? "text-muted-foreground" : "text-danger")}>
                        {valid ? t("performance.targetHint") : t("performance.targetInvalid")}
                    </p>
                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onClose(false)}>
                        {t("performance.cancel")}
                    </Button>
                    <Button onClick={() => void save()} disabled={!valid || unchanged || saving}>
                        {t("performance.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
