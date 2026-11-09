"use client";

/**
 * Everything in Analytics past the overview: the filter bar, the section tabs,
 * and one panel per question - visits one by one, events and their properties,
 * funnels, journeys, goals, retention, revenue, and the site's own settings.
 *
 * Each panel asks for its own answer when it is opened (`/api/analytics/report`),
 * so the overview never waits on a funnel nobody looked at. What a reader may
 * change follows `level`, the same check every action makes on the server.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useConfirm } from "@/components/confirm-dialog";
import { useRouter, useSearchParams } from "next/navigation";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowDown, ArrowUp, ChevronRight, Download, Filter, Plus, Trash2, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useTransition } from "react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    cn,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    ScrollRow,
    Select,
    Skeleton,
    Textarea
} from "@polaris/ui";
import * as polls from "./analytics-polls";
import {
    deleteAnalyticsReportAction,
    resetSiteDataAction,
    saveAnalyticsReportAction,
    setSiteRulesAction,
    type AnalyticsOverview,
    type AnalyticsReportAnswer,
    type AnalyticsReportRequest
} from "./actions";
import type { SiteLevel } from "./site-access";
import type { AnalyticsScope } from "./site-catalog";

export const ANALYTICS_TABS = [
    "overview",
    "sessions",
    "events",
    "funnels",
    "journeys",
    "goals",
    "retention",
    "revenue",
    "site"
] as const;
export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

export function isAnalyticsTab(value: string | null | undefined): value is AnalyticsTab {
    return (ANALYTICS_TABS as readonly string[]).includes(value ?? "");
}

function grouped(value: number): string {
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function share(part: number, whole: number): string {
    return whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : "-";
}

/** Whether a level allows `needed`; the screen's half of `allows` on the server. */
function may(level: SiteLevel, needed: SiteLevel): boolean {
    const rank = { view: 0, edit: 1, own: 2 } as const;
    return rank[level] >= rank[needed];
}

// --- the address: tab and filters ---------------------------------------------------

/** The filters live in the URL (`f`, JSON), so a narrowed view is a link. */
export function useFilterNav() {
    const params = useSearchParams();
    const router = useRouter();
    const raw = params.get("f") ?? "";
    const filters = useMemo(() => core.parseVisitFilters(raw), [raw]);
    const set = useCallback(
        (next: readonly core.VisitFilter[]) => {
            const search = new URLSearchParams(params.toString());
            if (next.length) search.set("f", JSON.stringify(next));
            else search.delete("f");
            router.replace(`/apps/analytics?${search.toString()}`, { scroll: false });
        },
        [params, router]
    );
    const add = useCallback(
        (dimension: core.VisitFilterDimension, value: string, negate = false) => {
            const parsed = core.visitFilterSchema.safeParse({ dimension, value, negate });
            if (!parsed.success) return;
            const rest = filters.filter((one) => one.dimension !== dimension || one.value !== parsed.data.value);
            set([...rest, parsed.data].slice(-10));
        },
        [filters, set]
    );
    return { filters, filtersParam: filters.length ? JSON.stringify(filters) : "", set, add };
}

/** What a breakdown row calls when it is picked: narrow everything to it. */
export const FilterPick = createContext<((dimension: core.VisitFilterDimension, value: string) => void) | null>(
    null
);
export const useFilterPick = () => useContext(FilterPick);

/** The breakdown each list answers, as the filter that narrows to one of its rows. */
export const BREAKDOWN_FILTER: Partial<Record<core.VisitDimension, core.VisitFilterDimension>> = {
    path: "path",
    entry: "path",
    exit: "path",
    referrer: "referrer",
    channel: "channel",
    campaign: "campaign",
    browser: "browser",
    os: "os",
    device: "device",
    country: "country",
    language: "language",
    screen: "screen",
    event: "event",
    ip: "ip"
};

export function SectionTabs({ tab }: { tab: AnalyticsTab }) {
    const t = useTranslations("analytics");
    const params = useSearchParams();
    return (
        <ScrollRow className="no-scrollbar -mx-1 flex gap-1 border-b border-border px-1">
            {ANALYTICS_TABS.map((value) => {
                const next = new URLSearchParams(params.toString());
                if (value === "overview") next.delete("tab");
                else next.set("tab", value);
                const active = value === tab;
                return (
                    <Link
                        key={value}
                        href={`/apps/analytics?${next.toString()}`}
                        scroll={false}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                            "-mb-px shrink-0 border-b-2 px-2.5 py-1.5 text-sm transition-colors",
                            active
                                ? "border-primary font-medium text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {t(`tabs.${value}` as NamespaceKey<"analytics">)}
                    </Link>
                );
            })}
        </ScrollRow>
    );
}

/** The change against the window before, as a signed share. */
export function Delta({
    current,
    previous,
    lowerIsBetter = false
}: {
    current: number | null;
    previous: number | null | undefined;
    lowerIsBetter?: boolean;
}) {
    const t = useTranslations("analytics");
    if (current === null || previous === null || previous === undefined) return null;
    if (previous === 0) return current === 0 ? null : <span className="text-xs text-muted-foreground">{t("compare.new")}</span>;
    const change = (current - previous) / previous;
    if (Math.abs(change) < 0.005) return <span className="text-xs text-muted-foreground">{t("compare.same")}</span>;
    const good = lowerIsBetter ? change < 0 : change > 0;
    const Icon = change > 0 ? ArrowUp : ArrowDown;
    return (
        <span
            className={cn("inline-flex items-center gap-0.5 text-xs font-medium", good ? "text-success-ink" : "text-danger-ink")}
            title={t("compare.hint")}
        >
            <Icon className="size-3 shrink-0" aria-hidden />
            {`${Math.round(Math.abs(change) * 100)}%`}
        </span>
    );
}

// --- the filter bar --------------------------------------------------------------

export function FilterBar({
    filters,
    set,
    data,
    scope,
    siteId,
    onSaved
}: {
    filters: readonly core.VisitFilter[];
    set: (next: readonly core.VisitFilter[]) => void;
    data: AnalyticsOverview | null;
    scope: AnalyticsScope;
    siteId: string;
    onSaved: () => void;
}) {
    const t = useTranslations("analytics");
    const [adding, setAdding] = useState(false);
    const [dimension, setDimension] = useState<core.VisitFilterDimension>("path");
    const [negate, setNegate] = useState(false);
    const [value, setValue] = useState("");
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState("");
    const [failure, setFailure] = useState<string | null>(null);
    const [saving, startSave] = useTransition();

    const candidate = core.visitFilterSchema.safeParse({ dimension, value, negate });
    const valueProblem = value.trim() && !candidate.success ? t("filters.tooLong") : null;
    const segments = (data?.reports ?? []).filter((report) => report.kind === "segment");
    const canEdit = data ? may(data.level, "edit") : false;
    const nameOk = core.analyticsReportSchema.safeParse({ kind: "segment", name, definition: { filters } }).success;

    const label = (one: core.VisitFilterDimension) => t(`filters.dims.${one}` as NamespaceKey<"analytics">);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Filter className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                {filters.length === 0 ? (
                    <span className="text-sm text-muted-foreground">{t("filters.none")}</span>
                ) : (
                    filters.map((filter, index) => (
                        <span
                            key={`${filter.dimension}:${filter.value}:${index}`}
                            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-muted/40 py-0.5 pl-2 pr-1 text-xs"
                        >
                            <span className="shrink-0 text-muted-foreground">
                                {label(filter.dimension)} {filter.negate ? t("filters.isNot") : t("filters.is")}
                            </span>
                            <span className="min-w-0 truncate font-medium" title={filter.value}>
                                {filter.value}
                            </span>
                            <button
                                type="button"
                                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                                aria-label={t("filters.remove")}
                                title={t("filters.remove")}
                                onClick={() => set(filters.filter((_, at) => at !== index))}
                            >
                                <X className="size-3" aria-hidden />
                            </button>
                        </span>
                    ))
                )}
                <Button size="sm" variant="ghost" onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
                    <Plus aria-hidden /> {t("filters.add")}
                </Button>
                {filters.length ? (
                    <Button size="sm" variant="ghost" onClick={() => set([])}>
                        {t("filters.clear")}
                    </Button>
                ) : null}
                {filters.length && canEdit && !naming ? (
                    <Button size="sm" variant="ghost" onClick={() => setNaming(true)}>
                        {t("filters.saveSegment")}
                    </Button>
                ) : null}
                {segments.map((segment) => (
                    <button
                        key={segment.id}
                        type="button"
                        className="max-w-[12rem] truncate rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                        title={segment.name}
                        onClick={() => set((segment.definition as core.SegmentDefinition).filters)}
                    >
                        {segment.name}
                    </button>
                ))}
            </div>
            {adding ? (
                <form
                    className="flex flex-col gap-2 sm:flex-row sm:items-start"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!candidate.success) return;
                        set([...filters, candidate.data].slice(-10));
                        setValue("");
                        setAdding(false);
                    }}
                >
                    <Select
                        value={dimension}
                        aria-label={t("filters.dimension")}
                        className="h-8 sm:w-40"
                        options={core.VISIT_FILTER_DIMENSIONS.map((one) => ({ value: one, label: label(one) }))}
                        onValueChange={(next) => setDimension(next as core.VisitFilterDimension)}
                    />
                    <Select
                        value={negate ? "not" : "is"}
                        aria-label={t("filters.mode")}
                        className="h-8 sm:w-28"
                        options={[
                            { value: "is", label: t("filters.is") },
                            { value: "not", label: t("filters.isNot") }
                        ]}
                        onValueChange={(next) => setNegate(next === "not")}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <Input
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            aria-label={t("filters.value")}
                            placeholder={dimension === "path" ? "/pricing" : t("filters.value")}
                            aria-invalid={valueProblem ? true : undefined}
                            className="h-8"
                        />
                        {valueProblem ? <span className="text-xs text-danger-ink">{valueProblem}</span> : null}
                    </div>
                    <Button type="submit" size="sm" aria-disabled={!candidate.success} disabled={!candidate.success}>
                        {t("filters.apply")}
                    </Button>
                </form>
            ) : null}
            {naming ? (
                <form
                    className="flex flex-col gap-2 sm:flex-row sm:items-center"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!nameOk) return;
                        startSave(async () => {
                            const result = await saveAnalyticsReportAction({
                                scopeType: scope,
                                scopeId: siteId,
                                report: { kind: "segment", name, definition: { filters } }
                            });
                            if (result.error) return setFailure(result.error);
                            setFailure(null);
                            setNaming(false);
                            setName("");
                            onSaved();
                        });
                    }}
                >
                    <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        aria-label={t("reports.name")}
                        placeholder={t("reports.name")}
                        maxLength={80}
                        className="h-8 sm:w-64"
                    />
                    <div className="flex gap-2">
                        <Button type="submit" size="sm" disabled={!nameOk || saving} aria-disabled={!nameOk || saving}>
                            {t("reports.save")}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setNaming(false)}>
                            {t("reports.cancel")}
                        </Button>
                    </div>
                </form>
            ) : null}
            {failure ? <p className="text-sm text-danger-ink">{failure}</p> : null}
            {data?.view.filtersIgnored ? (
                <p className="text-xs text-muted-foreground">{t("filters.ignoredLong")}</p>
            ) : null}
        </div>
    );
}

// --- one panel's answer -------------------------------------------------------------

interface PanelProps {
    data: AnalyticsOverview;
    scope: AnalyticsScope;
    siteId: string;
    filtersParam: string;
    onSaved: () => void;
}

function useReport<K extends AnalyticsReportAnswer["kind"]>(
    props: PanelProps,
    request: AnalyticsReportRequest | null,
    /** Anything else that makes the answer stale, such as the saved goals changing. */
    nonce: string | number = ""
): { answer: Extract<AnalyticsReportAnswer, { kind: K }> | null; error: string | null; loading: boolean } {
    const [answer, setAnswer] = useState<AnalyticsReportAnswer | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const key = request ? JSON.stringify(request) : "";
    const { scope, siteId, filtersParam } = props;
    const range = props.data.range;
    useEffect(() => {
        if (!key) return;
        const controller = new AbortController();
        setLoading(true);
        polls
            .analyticsReport({ scopeType: scope, scopeId: siteId, range, filters: filtersParam, request: key }, controller.signal)
            .then((result) => {
                if ("error" in result) {
                    setError(result.error);
                    setAnswer(null);
                } else {
                    setError(null);
                    setAnswer(result);
                }
            })
            .catch(() => {
                if (!controller.signal.aborted) setError(null);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [key, scope, siteId, range, filtersParam, nonce]);
    return { answer: answer as Extract<AnalyticsReportAnswer, { kind: K }> | null, error, loading };
}

function Rows({ count = 5 }: { count?: number }) {
    return (
        <div className="flex flex-col gap-2 py-1">
            {Array.from({ length: count }, (_, index) => (
                <Skeleton key={index} className="h-5 w-full" />
            ))}
        </div>
    );
}

function Empty({ children }: { children: React.ReactNode }) {
    return <p className="px-2 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function Failure({ message }: { message: string | null }) {
    return message ? <p className="text-sm text-danger-ink">{message}</p> : null;
}

/** A bar list: the shape every ranked answer here takes. */
function BarList({ rows }: { rows: readonly { key: string; label: React.ReactNode; value: number; note?: string }[] }) {
    const top = rows.reduce((best, row) => Math.max(best, row.value), 0);
    return (
        <ul className="flex flex-col">
            {rows.map((row) => (
                <li key={row.key} className="relative flex items-center gap-3 py-1.5 text-sm">
                    <span
                        aria-hidden
                        className="absolute inset-y-0.5 left-0 rounded bg-primary/10"
                        style={{ width: `${top > 0 ? Math.max(2, (row.value / top) * 100) : 0}%` }}
                    />
                    <span className="relative min-w-0 flex-1 truncate pl-2">{row.label}</span>
                    {row.note ? (
                        <span className="relative shrink-0 text-xs text-muted-foreground tabular-nums">{row.note}</span>
                    ) : null}
                    <span className="relative shrink-0 pr-2 tabular-nums">{grouped(row.value)}</span>
                </li>
            ))}
        </ul>
    );
}

export function ReportPanel(props: PanelProps & { tab: Exclude<AnalyticsTab, "overview"> }) {
    switch (props.tab) {
        case "sessions":
            return <SessionsPanel {...props} />;
        case "events":
            return <EventsPanel {...props} />;
        case "funnels":
            return <FunnelsPanel {...props} />;
        case "journeys":
            return <JourneysPanel {...props} />;
        case "goals":
            return <GoalsPanel {...props} />;
        case "retention":
            return <RetentionPanel {...props} />;
        case "revenue":
            return <RevenuePanel {...props} />;
        case "site":
            return <SitePanel {...props} />;
    }
}

// --- visits ------------------------------------------------------------------------

type SessionRow = Extract<AnalyticsReportAnswer, { kind: "sessions" }>["rows"][number];

function SessionsPanel(props: PanelProps) {
    const t = useTranslations("analytics");
    const format = useDisplayFormat();
    const [before, setBefore] = useState<string | undefined>(undefined);
    const [pages, setPages] = useState<SessionRow[]>([]);
    const [open, setOpen] = useState<string | null>(null);
    const { answer, error, loading } = useReport<"sessions">(props, { kind: "sessions", before });

    useEffect(() => setPages([]), [props.filtersParam, props.data.range]);
    useEffect(() => {
        if (!answer) return;
        setPages((current) => (before ? [...current, ...answer.rows.filter((row) => !current.some((one) => one.id === row.id))] : answer.rows));
    }, [answer, before]);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{t("sessions.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-2 pt-0">
                <Failure message={error} />
                {!answer && loading ? (
                    <Rows />
                ) : pages.length === 0 ? (
                    <Empty>{t("sessions.none")}</Empty>
                ) : (
                    <ul className="flex flex-col divide-y divide-border">
                        {pages.map((row) => (
                            <li key={row.id}>
                                <button
                                    type="button"
                                    onClick={() => setOpen(row.id)}
                                    className="flex w-full min-w-0 flex-col gap-0.5 py-2 text-left text-sm hover:bg-muted/40 sm:flex-row sm:items-center sm:gap-3"
                                >
                                    <span className="min-w-0 flex-1 truncate font-medium">
                                        {row.country ? `${core.countryFlag(row.country)} ` : ""}
                                        {row.distinctId ?? `${row.browser} / ${row.os}`}
                                    </span>
                                    <span className="min-w-0 truncate text-xs text-muted-foreground sm:max-w-[14rem]" title={row.lastPath ?? ""}>
                                        {row.lastPath ?? "-"}
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                        {t("sessions.pages", { count: grouped(row.views) })}
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {format.dateTime(new Date(row.lastSeenAt).getTime())}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                {answer?.more ? (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={loading}
                        onClick={() => setBefore(pages[pages.length - 1]?.lastSeenAt)}
                    >
                        {t("sessions.more")}
                    </Button>
                ) : null}
            </CardBody>
            {open ? <SessionDialog {...props} id={open} onClose={() => setOpen(null)} /> : null}
        </Card>
    );
}

function SessionDialog(props: PanelProps & { id: string; onClose: () => void }) {
    const t = useTranslations("analytics");
    const format = useDisplayFormat();
    const { answer, error, loading } = useReport<"session">(props, { kind: "session", id: props.id });
    const session = answer?.session ?? null;
    const facts: [string, string | null][] = session
        ? [
              [t("filters.dims.distinctId"), session.distinctId],
              [t("filters.dims.country"), session.country ? core.countryName(session.country) : null],
              [t("filters.dims.browser"), `${session.browser} / ${session.os} / ${session.device}`],
              [t("filters.dims.screen"), session.screen],
              [t("filters.dims.language"), session.language],
              [t("filters.dims.referrer"), session.referrerSource ?? session.referrerKind],
              [t("filters.dims.campaign"), session.campaign],
              [t("filters.dims.ip"), session.ip]
          ]
        : [];
    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : props.onClose())}>
            <DialogContent className="flex max-h-[85vh] w-[min(100vw-2rem,40rem)] max-w-none flex-col gap-4 overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{t("sessions.journey")}</DialogTitle>
                </DialogHeader>
                <Failure message={error} />
                {loading && !session ? (
                    <Rows />
                ) : !session ? (
                    <Empty>{t("sessions.gone")}</Empty>
                ) : (
                    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain">
                        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                            {facts
                                .filter((fact): fact is [string, string] => Boolean(fact[1]))
                                .map(([label, value]) => (
                                    <div key={label} className="flex min-w-0 gap-2">
                                        <dt className="shrink-0 text-muted-foreground">{label}</dt>
                                        <dd className="min-w-0 truncate" title={value}>
                                            {value}
                                        </dd>
                                    </div>
                                ))}
                        </dl>
                        {session.data ? <Props props={session.data} /> : null}
                        <ol className="flex flex-col gap-2 border-l border-border pl-4">
                            {session.events.map((event, index) => (
                                <li key={`${event.at}:${index}`} className="flex min-w-0 flex-col text-sm">
                                    <span className="text-xs text-muted-foreground">
                                        {format.dateTime(new Date(event.at).getTime())}
                                    </span>
                                    <span className="min-w-0 truncate" title={event.path}>
                                        {event.kind === "event" ? (
                                            <Badge variant="neutral" className="mr-1">
                                                {event.name}
                                            </Badge>
                                        ) : null}
                                        {event.path}
                                    </span>
                                    {event.props ? <Props props={event.props} /> : null}
                                </li>
                            ))}
                        </ol>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

function Props({ props }: { props: Record<string, string | number | boolean> }) {
    return (
        <div className="flex flex-wrap gap-1">
            {Object.entries(props).map(([key, value]) => (
                <span key={key} className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs" title={`${key}: ${String(value)}`}>
                    {key}: {String(value)}
                </span>
            ))}
        </div>
    );
}

// --- events ------------------------------------------------------------------------

function EventsPanel(props: PanelProps) {
    const t = useTranslations("analytics");
    const [chosen, setChosen] = useState<string | null>(null);
    const names = useReport<"events">(props, { kind: "events" });
    const properties = useReport<"properties">(props, chosen ? { kind: "properties", name: chosen } : null);
    const byKey = useMemo(() => {
        const map = new Map<string, { key: string; label: string; value: number }[]>();
        for (const row of properties.answer?.rows ?? []) {
            const list = map.get(row.key) ?? [];
            if (list.length < 10) list.push({ key: `${row.key}=${row.value}`, label: row.value, value: row.events });
            map.set(row.key, list);
        }
        return [...map];
    }, [properties.answer]);

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
                <CardHeader>
                    <CardTitle className="text-sm">{t("events.title")}</CardTitle>
                </CardHeader>
                <CardBody className="pt-0">
                    <Failure message={names.error} />
                    {!names.answer ? (
                        <Rows />
                    ) : names.answer.rows.length === 0 ? (
                        <Empty>{t("events.none")}</Empty>
                    ) : (
                        <BarList
                            rows={names.answer.rows.map((row) => ({
                                key: row.name,
                                value: row.events,
                                note: t("events.visitors", { count: grouped(row.visitors) }),
                                label: (
                                    <button
                                        type="button"
                                        className={cn("truncate text-left hover:underline", chosen === row.name && "font-medium")}
                                        aria-pressed={chosen === row.name}
                                        onClick={() => setChosen(row.name)}
                                        title={row.name}
                                    >
                                        {row.name}
                                    </button>
                                )
                            }))}
                        />
                    )}
                </CardBody>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle className="min-w-0 truncate text-sm">
                        {chosen ? t("events.propertiesOf", { name: chosen }) : t("events.properties")}
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4 pt-0">
                    <Failure message={properties.error} />
                    {!chosen ? (
                        <Empty>{t("events.pick")}</Empty>
                    ) : !properties.answer ? (
                        <Rows />
                    ) : byKey.length === 0 ? (
                        <Empty>{t("events.noProperties")}</Empty>
                    ) : (
                        byKey.map(([key, rows]) => (
                            <div key={key} className="flex flex-col gap-1">
                                <span className="font-mono text-xs text-muted-foreground">{key}</span>
                                <BarList rows={rows} />
                            </div>
                        ))
                    )}
                </CardBody>
            </Card>
        </div>
    );
}

// --- matches: one step, one goal ------------------------------------------------------

function MatchFields({
    match,
    onChange,
    label
}: {
    match: { type: "path" | "event"; value: string };
    onChange: (next: { type: "path" | "event"; value: string }) => void;
    label: string;
}) {
    const t = useTranslations("analytics");
    const parsed = core.visitMatchSchema.safeParse(match);
    const problem = match.value.trim() && !parsed.success ? (match.type === "path" ? t("reports.pathHint") : t("filters.tooLong")) : null;
    return (
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-start sm:gap-2">
            <Select
                value={match.type}
                aria-label={t("reports.stepKind")}
                className="h-8 sm:w-28"
                options={[
                    { value: "path", label: t("reports.page") },
                    { value: "event", label: t("reports.event") }
                ]}
                onValueChange={(next) => onChange({ ...match, type: next as "path" | "event" })}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Input
                    value={match.value}
                    onChange={(event) => onChange({ ...match, value: event.target.value })}
                    aria-label={label}
                    placeholder={match.type === "path" ? "/checkout*" : "signup"}
                    aria-invalid={problem ? true : undefined}
                    className="h-8"
                />
                {problem ? <span className="text-xs text-danger-ink">{problem}</span> : null}
            </div>
        </div>
    );
}

/** Saved reports of one kind: load one, or delete it. */
function SavedList({
    props,
    kind,
    onLoad
}: {
    props: PanelProps;
    kind: core.AnalyticsReportKind;
    onLoad: (definition: unknown) => void;
}) {
    const t = useTranslations("analytics");
    const [confirm, confirmDialog] = useConfirm();
    const [failure, setFailure] = useState<string | null>(null);
    const saved = props.data.reports.filter((report) => report.kind === kind);
    const canEdit = may(props.data.level, "edit");
    if (saved.length === 0) return null;
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{t("reports.saved")}</span>
            <div className="flex flex-wrap gap-1.5">
                {saved.map((report) => (
                    <span key={report.id} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border pl-2 pr-1 text-xs">
                        <button type="button" className="min-w-0 truncate py-1 hover:underline" title={report.name} onClick={() => onLoad(report.definition)}>
                            {report.name}
                        </button>
                        {canEdit ? (
                            <button
                                type="button"
                                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-danger-ink"
                                aria-label={t("reports.delete")}
                                title={t("reports.delete")}
                                onClick={async () => {
                                    const ok = await confirm({
                                        title: t("reports.deleteTitle", { name: report.name }),
                                        confirmLabel: t("reports.delete"),
                                        danger: true
                                    });
                                    if (!ok) return;
                                    const result = await deleteAnalyticsReportAction({ scopeType: props.scope, scopeId: props.siteId, id: report.id });
                                    if (result.error) return setFailure(result.error);
                                    props.onSaved();
                                }}
                            >
                                <Trash2 className="size-3" aria-hidden />
                            </button>
                        ) : null}
                    </span>
                ))}
            </div>
            <Failure message={failure} />
            {confirmDialog}
        </div>
    );
}

/** Name the report on screen and keep it. Only offered to whoever may edit the site. */
function SaveForm({ props, report }: { props: PanelProps; report: { kind: core.AnalyticsReportKind; definition: unknown } }) {
    const t = useTranslations("analytics");
    const [name, setName] = useState("");
    const [failure, setFailure] = useState<string | null>(null);
    const [saving, startSave] = useTransition();
    if (!may(props.data.level, "edit")) return null;
    const ok = core.analyticsReportSchema.safeParse({ ...report, name }).success;
    return (
        <form
            className="flex flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(event) => {
                event.preventDefault();
                if (!ok) return;
                startSave(async () => {
                    const result = await saveAnalyticsReportAction({
                        scopeType: props.scope,
                        scopeId: props.siteId,
                        report: { ...report, name }
                    });
                    if (result.error) return setFailure(result.error);
                    setFailure(null);
                    setName("");
                    props.onSaved();
                });
            }}
        >
            <Input value={name} onChange={(event) => setName(event.target.value)} aria-label={t("reports.name")} placeholder={t("reports.name")} maxLength={80} className="h-8 sm:w-64" />
            <Button type="submit" size="sm" variant="outline" disabled={!ok || saving} aria-disabled={!ok || saving}>
                {t("reports.save")}
            </Button>
            <Failure message={failure} />
        </form>
    );
}

// --- funnels -----------------------------------------------------------------------

function FunnelsPanel(props: PanelProps) {
    const t = useTranslations("analytics");
    const [steps, setSteps] = useState<{ type: "path" | "event"; value: string }[]>([
        { type: "path", value: "/" },
        { type: "path", value: "" }
    ]);
    const [windowText, setWindowText] = useState("60");
    const [asked, setAsked] = useState<core.FunnelDefinition | null>(null);
    const definition = core.funnelDefinitionSchema.safeParse({ steps, windowMinutes: Number(windowText) });
    const windowProblem = windowText && !core.funnelDefinitionSchema.shape.windowMinutes.safeParse(Number(windowText)).success;
    const { answer, error, loading } = useReport<"funnel">(props, asked ? { kind: "funnel", definition: asked } : null);
    const first = answer?.steps[0]?.visitors ?? 0;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{t("funnels.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 pt-0">
                <p className="text-sm text-muted-foreground">{t("funnels.intro")}</p>
                <SavedList
                    props={props}
                    kind="funnel"
                    onLoad={(saved) => {
                        const parsed = core.funnelDefinitionSchema.safeParse(saved);
                        if (!parsed.success) return;
                        setSteps(parsed.data.steps);
                        setWindowText(String(parsed.data.windowMinutes));
                        setAsked(parsed.data);
                    }}
                />
                <ol className="flex flex-col gap-2">
                    {steps.map((step, index) => (
                        <li key={index} className="flex items-start gap-2">
                            <span className="mt-1.5 w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                            <MatchFields
                                match={step}
                                label={t("funnels.step", { n: String(index + 1) })}
                                onChange={(next) => setSteps(steps.map((one, at) => (at === index ? next : one)))}
                            />
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t("funnels.removeStep")}
                                title={t("funnels.removeStep")}
                                disabled={steps.length <= 2}
                                onClick={() => setSteps(steps.filter((_, at) => at !== index))}
                            >
                                <X aria-hidden />
                            </Button>
                        </li>
                    ))}
                </ol>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Button size="sm" variant="ghost" disabled={steps.length >= 8} onClick={() => setSteps([...steps, { type: "path", value: "" }])}>
                        <Plus aria-hidden /> {t("funnels.addStep")}
                    </Button>
                    <label className="flex items-center gap-2 text-sm">
                        <span className="text-muted-foreground">{t("funnels.window")}</span>
                        <Input
                            value={windowText}
                            inputMode="numeric"
                            onChange={(event) => setWindowText(event.target.value.replace(/\D/g, "").slice(0, 5))}
                            aria-invalid={windowProblem ? true : undefined}
                            className="h-8 w-20"
                        />
                        <span className="text-muted-foreground">{t("funnels.minutes")}</span>
                    </label>
                    <Button size="sm" className="sm:ml-auto" disabled={!definition.success} aria-disabled={!definition.success} onClick={() => definition.success && setAsked(definition.data)}>
                        {t("reports.run")}
                    </Button>
                </div>
                {windowProblem ? <span className="text-xs text-danger-ink">{t("funnels.windowHint")}</span> : null}
                <Failure message={error} />
                {loading && !answer ? <Rows count={3} /> : null}
                {answer ? (
                    <ol className="flex flex-col gap-2">
                        {answer.steps.map((step, index) => {
                            const prior = index === 0 ? step.visitors : answer.steps[index - 1]!.visitors;
                            return (
                                <li key={index} className="flex flex-col gap-1">
                                    <div className="flex min-w-0 items-center gap-2 text-sm">
                                        <span className="min-w-0 flex-1 truncate" title={step.step.value}>
                                            {index + 1}. {step.step.type === "event" ? `${t("reports.event")}: ` : ""}
                                            {step.step.value}
                                        </span>
                                        <span className="shrink-0 tabular-nums">{grouped(step.visitors)}</span>
                                        <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{share(step.visitors, first)}</span>
                                    </div>
                                    <div className="h-2 overflow-hidden rounded bg-muted">
                                        <div className="h-full rounded bg-primary" style={{ width: `${first > 0 ? (step.visitors / first) * 100 : 0}%` }} />
                                    </div>
                                    {index > 0 && prior > step.visitors ? (
                                        <span className="text-xs text-muted-foreground">
                                            {t("funnels.dropped", { count: grouped(prior - step.visitors), share: share(prior - step.visitors, prior) })}
                                        </span>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ol>
                ) : null}
                {asked ? <SaveForm props={props} report={{ kind: "funnel", definition: asked }} /> : null}
            </CardBody>
        </Card>
    );
}

// --- journeys ----------------------------------------------------------------------

function JourneysPanel(props: PanelProps) {
    const t = useTranslations("analytics");
    const [steps, setSteps] = useState("4");
    const [start, setStart] = useState("");
    const [asked, setAsked] = useState<core.JourneyDefinition>({ steps: 4 });
    const definition = core.journeyDefinitionSchema.safeParse({ steps: Number(steps), start: start.trim() || undefined });
    const { answer, error, loading } = useReport<"journey">(props, { kind: "journey", definition: asked });

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{t("journeys.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 pt-0">
                <p className="text-sm text-muted-foreground">{t("journeys.intro")}</p>
                <SavedList
                    props={props}
                    kind="journey"
                    onLoad={(saved) => {
                        const parsed = core.journeyDefinitionSchema.safeParse(saved);
                        if (!parsed.success) return;
                        setSteps(String(parsed.data.steps));
                        setStart(parsed.data.start ?? "");
                        setAsked(parsed.data);
                    }}
                />
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <Select
                        value={steps}
                        aria-label={t("journeys.steps")}
                        className="h-8 sm:w-36"
                        options={[2, 3, 4, 5, 6, 7].map((n) => ({ value: String(n), label: t("journeys.stepCount", { count: String(n) }) }))}
                        onValueChange={setSteps}
                    />
                    <Input value={start} onChange={(event) => setStart(event.target.value)} aria-label={t("journeys.start")} placeholder={t("journeys.start")} maxLength={240} className="h-8 sm:w-64" />
                    <Button size="sm" disabled={!definition.success} aria-disabled={!definition.success} onClick={() => definition.success && setAsked(definition.data)}>
                        {t("reports.run")}
                    </Button>
                </div>
                <Failure message={error} />
                {!answer && loading ? (
                    <Rows />
                ) : !answer || answer.rows.length === 0 ? (
                    <Empty>{t("journeys.none")}</Empty>
                ) : (
                    <BarList
                        rows={answer.rows.map((row) => ({
                            key: row.paths.join("\u0000"),
                            value: row.visits,
                            label: (
                                <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1" title={row.paths.join(" > ")}>
                                    {row.paths.map((path, index) => (
                                        <span key={index} className="inline-flex min-w-0 items-center gap-1">
                                            {index > 0 ? <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
                                            <span className="min-w-0 truncate">{path}</span>
                                        </span>
                                    ))}
                                </span>
                            )
                        }))}
                    />
                )}
                <SaveForm props={props} report={{ kind: "journey", definition: asked }} />
            </CardBody>
        </Card>
    );
}

// --- goals ---------------------------------------------------------------------------

function GoalsPanel(props: PanelProps) {
    const t = useTranslations("analytics");
    const [goal, setGoal] = useState<{ type: "path" | "event"; value: string }>({ type: "event", value: "" });
    const [name, setName] = useState("");
    const [failure, setFailure] = useState<string | null>(null);
    const [saving, startSave] = useTransition();
    const { answer, error, loading } = useReport<"goals">(
        props,
        { kind: "goals" },
        props.data.reports
            .filter((report) => report.kind === "goal")
            .map((report) => `${report.id}:${report.updatedAt}`)
            .join(",")
    );
    const ok = core.analyticsReportSchema.safeParse({ kind: "goal", name, definition: goal }).success;
    const canEdit = may(props.data.level, "edit");
    const [confirm, confirmDialog] = useConfirm();

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{t("goals.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 pt-0">
                <p className="text-sm text-muted-foreground">{t("goals.intro")}</p>
                <Failure message={error ?? failure} />
                {!answer && loading ? (
                    <Rows count={3} />
                ) : !answer || answer.results.length === 0 ? (
                    <Empty>{t("goals.none")}</Empty>
                ) : (
                    <ul className="flex flex-col divide-y divide-border">
                        {answer.results.map((result) => (
                            <li key={result.id} className="flex min-w-0 items-center gap-3 py-2 text-sm">
                                <div className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate font-medium" title={result.name}>
                                        {result.name}
                                    </span>
                                    <span className="truncate text-xs text-muted-foreground" title={result.goal.value}>
                                        {result.goal.type === "event" ? t("reports.event") : t("reports.page")}: {result.goal.value}
                                    </span>
                                </div>
                                <span className="shrink-0 tabular-nums">{grouped(result.visitors)}</span>
                                <span className="w-14 shrink-0 text-right text-xs font-medium tabular-nums">{share(result.visitors, answer.total)}</span>
                                {canEdit ? (
                                    <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        aria-label={t("reports.delete")}
                                        title={t("reports.delete")}
                                        onClick={async () => {
                                            const yes = await confirm({ title: t("reports.deleteTitle", { name: result.name }), confirmLabel: t("reports.delete"), danger: true });
                                            if (!yes) return;
                                            const done = await deleteAnalyticsReportAction({ scopeType: props.scope, scopeId: props.siteId, id: result.id });
                                            if (done.error) return setFailure(done.error);
                                            props.onSaved();
                                        }}
                                    >
                                        <Trash2 aria-hidden />
                                    </Button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
                {canEdit ? (
                    <form
                        className="flex flex-col gap-2 border-t border-border pt-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (!ok) return;
                            startSave(async () => {
                                const result = await saveAnalyticsReportAction({
                                    scopeType: props.scope,
                                    scopeId: props.siteId,
                                    report: { kind: "goal", name, definition: goal }
                                });
                                if (result.error) return setFailure(result.error);
                                setFailure(null);
                                setName("");
                                setGoal({ type: goal.type, value: "" });
                                props.onSaved();
                            });
                        }}
                    >
                        <span className="text-xs font-medium text-muted-foreground">{t("goals.add")}</span>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                            <Input value={name} onChange={(event) => setName(event.target.value)} aria-label={t("reports.name")} placeholder={t("reports.name")} maxLength={80} className="h-8 sm:w-48" />
                            <MatchFields match={goal} onChange={setGoal} label={t("goals.target")} />
                            <Button type="submit" size="sm" disabled={!ok || saving} aria-disabled={!ok || saving}>
                                {t("reports.save")}
                            </Button>
                        </div>
                    </form>
                ) : null}
                {confirmDialog}
            </CardBody>
        </Card>
    );
}

// --- retention -----------------------------------------------------------------------

function RetentionPanel(props: PanelProps) {
    const t = useTranslations("analytics");
    const format = useDisplayFormat();
    const { answer, error, loading } = useReport<"retention">(props, { kind: "retention" });
    const grid = useMemo(() => {
        const cohorts = new Map<number, Map<number, number>>();
        for (const cell of answer?.cells ?? []) {
            const row = cohorts.get(cell.cohort) ?? new Map<number, number>();
            row.set(cell.offset, cell.visitors);
            cohorts.set(cell.cohort, row);
        }
        const width = Math.min(15, 1 + Math.max(0, ...(answer?.cells ?? []).map((cell) => cell.offset)));
        return { rows: [...cohorts].sort((a, b) => a[0] - b[0]), width };
    }, [answer]);

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{t("retention.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 pt-0">
                <p className="text-sm text-muted-foreground">{t("retention.intro")}</p>
                <Failure message={error} />
                {!answer && loading ? (
                    <Rows />
                ) : grid.rows.length === 0 ? (
                    <Empty>{t("retention.none")}</Empty>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-max min-w-full border-separate border-spacing-0.5 text-xs">
                            <thead>
                                <tr>
                                    <th className="px-2 py-1 text-left font-medium text-muted-foreground">{t("retention.cohort")}</th>
                                    <th className="px-2 py-1 text-right font-medium text-muted-foreground">{t("retention.people")}</th>
                                    {Array.from({ length: grid.width }, (_, day) => (
                                        <th key={day} className="px-2 py-1 text-right font-medium text-muted-foreground">
                                            {t("retention.day", { n: String(day) })}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {grid.rows.map(([cohort, row]) => {
                                    const size = row.get(0) ?? 0;
                                    return (
                                        <tr key={cohort}>
                                            <td className="whitespace-nowrap px-2 py-1">{format.date(cohort)}</td>
                                            <td className="px-2 py-1 text-right tabular-nums">{grouped(size)}</td>
                                            {Array.from({ length: grid.width }, (_, day) => {
                                                const value = row.get(day);
                                                const ratio = value && size ? value / size : 0;
                                                return (
                                                    <td
                                                        key={day}
                                                        className="rounded px-2 py-1 text-right tabular-nums"
                                                        style={{ background: value ? `color-mix(in oklab, var(--color-primary) ${Math.round(ratio * 60) + 8}%, transparent)` : undefined }}
                                                        title={value ? `${grouped(value)} (${share(value, size)})` : undefined}
                                                    >
                                                        {value ? share(value, size) : ""}
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

// --- revenue -------------------------------------------------------------------------

function money(total: string, currency: string): string {
    const amount = Number(total);
    if (/^[A-Z]{3}$/.test(currency)) {
        try {
            return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
        } catch {
            /* an unknown code: shown as written */
        }
    }
    return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}

function RevenuePanel(props: PanelProps) {
    const t = useTranslations("analytics");
    const { answer, error, loading } = useReport<"revenue">(props, { kind: "revenue" });
    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{t("revenue.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 pt-0">
                <p className="text-sm text-muted-foreground">{t("revenue.intro")}</p>
                <Failure message={error} />
                {!answer && loading ? (
                    <Rows count={3} />
                ) : !answer || answer.report.totals.length === 0 ? (
                    <Empty>{t("revenue.none")}</Empty>
                ) : (
                    <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            {answer.report.totals.map((row) => (
                                <div key={row.currency} className="flex flex-col gap-0.5 rounded-md border border-border p-3">
                                    <span className="text-xs text-muted-foreground">{row.currency || t("revenue.noCurrency")}</span>
                                    <span className="truncate text-xl font-semibold tabular-nums">{money(row.total, row.currency)}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {t("revenue.counts", { events: grouped(row.events), visitors: grouped(row.visitors) })}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <BarList
                            rows={answer.report.byEvent.map((row) => ({
                                key: `${row.name}:${row.currency}`,
                                value: row.events,
                                note: money(row.total, row.currency),
                                label: <span title={row.name}>{row.name}</span>
                            }))}
                        />
                    </>
                )}
            </CardBody>
        </Card>
    );
}

// --- the site itself ---------------------------------------------------------------

function lines(text: string): string[] {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function SitePanel(props: PanelProps) {
    const t = useTranslations("analytics");
    const rules = props.data.site.rules;
    const [paths, setPaths] = useState(rules.excludedPaths.join("\n"));
    const [ips, setIps] = useState(rules.ignoredIps.join("\n"));
    const [failure, setFailure] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [saving, startSave] = useTransition();
    const [confirm, confirmDialog] = useConfirm();
    const canEdit = may(props.data.level, "edit");
    const next = { excludedPaths: lines(paths), ignoredIps: lines(ips) };
    const parsed = core.analyticsSiteSettingsSchema.safeParse(next);
    const badPath = next.excludedPaths.find((one) => !core.analyticsSiteSettingsSchema.shape.excludedPaths.element.safeParse(one).success);
    const badIp = next.ignoredIps.find((one) => !core.analyticsSiteSettingsSchema.shape.ignoredIps.element.safeParse(one).success);
    const dirty = JSON.stringify(next) !== JSON.stringify(rules);
    const exportHref = `/api/analytics/export?${new URLSearchParams({
        scopeType: props.scope,
        scopeId: props.siteId,
        range: props.data.range,
        ...(props.filtersParam ? { filters: props.filtersParam } : {})
    }).toString()}`;

    return (
        <div className="flex flex-col gap-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-sm">{t("site.ignoreTitle")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4 pt-0">
                    <p className="text-sm text-muted-foreground">{t("site.ignoreIntro")}</p>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("site.paths")}</span>
                        <Textarea value={paths} onChange={(event) => setPaths(event.target.value)} rows={4} placeholder={"/admin*\n/health"} disabled={!canEdit} aria-invalid={badPath ? true : undefined} className="font-mono text-xs" />
                        <span className={cn("text-xs", badPath ? "text-danger-ink" : "text-muted-foreground")}>
                            {badPath ? t("site.badPath", { value: badPath }) : t("site.pathsHint")}
                        </span>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("site.ips")}</span>
                        <Textarea value={ips} onChange={(event) => setIps(event.target.value)} rows={3} placeholder={"203.0.113.7\n198.51.100.0/24"} disabled={!canEdit} aria-invalid={badIp ? true : undefined} className="font-mono text-xs" />
                        <span className={cn("text-xs", badIp ? "text-danger-ink" : "text-muted-foreground")}>
                            {badIp ? t("site.badIp", { value: badIp }) : t("site.ipsHint")}
                        </span>
                    </label>
                    {canEdit ? (
                        <div className="flex items-center gap-3">
                            <Button
                                size="sm"
                                disabled={!dirty || !parsed.success || saving}
                                aria-disabled={!dirty || !parsed.success || saving}
                                onClick={() =>
                                    parsed.success &&
                                    startSave(async () => {
                                        const result = await setSiteRulesAction({ scopeType: props.scope, scopeId: props.siteId, rules: parsed.data });
                                        if (result.error) return setFailure(result.error);
                                        setFailure(null);
                                        setSaved(true);
                                        props.onSaved();
                                    })
                                }
                            >
                                {t("site.save")}
                            </Button>
                            {saved && !dirty ? <span className="text-xs text-muted-foreground">{t("site.saved")}</span> : null}
                        </div>
                    ) : (
                        <p className="text-xs text-muted-foreground">{t("site.viewOnly")}</p>
                    )}
                    <Failure message={failure} />
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-sm">{t("site.dataTitle")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-3 pt-0">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm text-muted-foreground">{t("site.exportHint")}</p>
                        <a href={exportHref} download className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
                            <Download className="size-4" aria-hidden /> {t("site.export")}
                        </a>
                    </div>
                    {canEdit ? (
                        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-sm text-muted-foreground">{t("site.resetHint")}</p>
                            <Button
                                size="sm"
                                variant="danger"
                                className="shrink-0 self-start"
                                onClick={async () => {
                                    const yes = await confirm({
                                        title: t("site.resetTitle", { name: props.data.site.name }),
                                        description: t("site.resetBody"),
                                        confirmLabel: t("site.reset"),
                                        danger: true
                                    });
                                    if (!yes) return;
                                    const result = await resetSiteDataAction({ scopeType: props.scope, scopeId: props.siteId });
                                    if (result.error) return setFailure(result.error);
                                    props.onSaved();
                                }}
                            >
                                <Trash2 aria-hidden /> {t("site.reset")}
                            </Button>
                        </div>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-sm">{t("site.trackerTitle")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-2 pt-0 text-sm">
                    {(
                        [
                            ["polaris.event(\"signup\", { plan: \"pro\" })", "site.apiEvent"],
                            ["polaris.event(\"purchase\", { revenue: 19.9, currency: \"EUR\" })", "site.apiRevenue"],
                            ["polaris.identify(\"user-42\", { plan: \"pro\" })", "site.apiIdentify"],
                            ["<button data-polaris-event=\"signup\" data-polaris-event-plan=\"pro\">", "site.apiAttr"],
                            ["data-outbound=\"true\"", "site.apiOutbound"],
                            ["data-domains=\"example.com\"", "site.apiDomains"],
                            ["data-do-not-track=\"true\"", "site.apiDnt"],
                            ["data-exclude-search=\"true\"", "site.apiSearch"],
                            ["data-before-send=\"beforeSend\"", "site.apiBefore"],
                            ["localStorage.setItem(\"polaris.disabled\", \"1\")", "site.apiOptOut"]
                        ] as const
                    ).map(([code, key]) => (
                        <div key={key} className="flex min-w-0 flex-col gap-0.5">
                            <code className="max-w-full overflow-x-auto whitespace-nowrap rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{code}</code>
                            <span className="text-xs text-muted-foreground">{t(key as NamespaceKey<"analytics">)}</span>
                        </div>
                    ))}
                </CardBody>
            </Card>
            {confirmDialog}
        </div>
    );
}
