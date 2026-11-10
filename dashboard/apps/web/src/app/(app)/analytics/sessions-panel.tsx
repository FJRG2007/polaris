"use client";

/**
 * Analytics, sessions: who came, one row each, and everything one of them did.
 *
 * Laid out the way Umami lays it out - totals for the window, a table that
 * scrolls forever, and a profile per session with its activity grouped by
 * visit - plus what Polaris keeps and Umami does not: the address, and a way
 * to narrow the whole screen to one visitor or one address from the profile.
 *
 * The open profile lives in the URL (`?session=<id>`), so a session is a link.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import * as polls from "./analytics-polls";
import { RelativeTime } from "@/components/relative-time";
import { useCursorList } from "../telemetry/use-cursor-list";
import type { SessionListRow } from "@/lib/analytics-reports";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Bot, Eye, Fingerprint, Globe, HelpCircle, Monitor, Network, Smartphone, Tablet, Zap } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    cn,
    CopyButton,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    EmptyState,
    SegmentedControl,
    Skeleton
} from "@polaris/ui";
import { LoadMore } from "./load-more";
import { avatarShape } from "./session-face";
import type { AnalyticsReportAnswer } from "./actions";
import { BarList, Empty, Failure, Rows, useReport, type PanelProps } from "./analytics-reports";
import { grouped, duration } from "./analytics-format";

type Translate = ReturnType<typeof useTranslations<"analytics">>;
type Journey = NonNullable<Extract<AnalyticsReportAnswer, { kind: "session" }>["session"]>;

/** The address parameter that names the open profile. */
const SESSION_PARAM = "session";
const TAB_KEY = "polaris.analytics.sessions.tab";

// --- the generated face ----------------------------------------------------------

/** A face per session, the same one every time for the same id - like Umami's. */
export function SessionAvatar({ id, size = 32, className }: { id: string; size?: number; className?: string }) {
    const shape = avatarShape(id);
    const gradient = `g${useId().replace(/:/g, "")}`;
    return (
        <svg
            aria-hidden
            width={size}
            height={size}
            viewBox="0 0 80 80"
            className={cn("shrink-0 rounded-full", className)}
        >
            <defs>
                <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor={shape.from} />
                    <stop offset="1" stopColor={shape.to} />
                </linearGradient>
            </defs>
            <rect width="80" height="80" fill={`url(#${gradient})`} />
            <circle cx={shape.x} cy={shape.y} r={shape.r} fill={shape.blob} opacity="0.55" />
            <circle cx={shape.x2} cy={shape.y2} r={shape.r2} fill="#fff" opacity="0.35" />
        </svg>
    );
}

// --- what a session ran on ---------------------------------------------------------

/** Browser marks Polaris ships (Umami's set, MIT), by the name `parseVisitAgent` gives. */
const BROWSER_ICON: Readonly<Record<string, string>> = {
    Chrome: "chrome",
    Chromium: "chromium-webview",
    Edge: "edge-chromium",
    Firefox: "firefox",
    Safari: "safari",
    Opera: "opera",
    Brave: "brave",
    "Samsung Internet": "samsung",
    Yandex: "yandexbrowser"
};

/** System marks, likewise. The Apple ones are black and are inverted on dark. */
const OS_ICON: Readonly<Record<string, string>> = {
    Windows: "windows-10",
    macOS: "mac-os",
    iOS: "ios",
    iPadOS: "ios",
    Android: "android-os",
    ChromeOS: "chrome-os",
    Linux: "linux",
    Ubuntu: "linux",
    Fedora: "linux",
    OpenBSD: "open-bsd"
};
const MONOCHROME = new Set(["mac-os", "ios"]);

function Mark({ type, value }: { type: "browser" | "os"; value: string }) {
    const file = (type === "browser" ? BROWSER_ICON : OS_ICON)[value];
    if (!file) return <Globe className="size-4 text-muted-foreground" aria-hidden />;
    return (
        <img
            src={`/images/analytics/${type}/${file}.png`}
            alt=""
            width={16}
            height={16}
            className={cn("size-4 shrink-0 object-contain", MONOCHROME.has(file) && "dark:invert")}
        />
    );
}

function DeviceIcon({ device }: { device: string }) {
    const Icon =
        device === "desktop" ? Monitor : device === "mobile" ? Smartphone : device === "tablet" ? Tablet : device === "bot" ? Bot : HelpCircle;
    return <Icon className="size-4 text-muted-foreground" aria-hidden />;
}

function deviceLabel(t: Translate, device: string): string {
    if (device === "desktop") return t("sessions.deviceDesktop");
    if (device === "mobile") return t("sessions.deviceMobile");
    if (device === "tablet") return t("sessions.deviceTablet");
    if (device === "bot") return t("sessions.deviceBot");
    return t("sessions.deviceUnknown");
}

/** A country's name in the reader's own language. */
function useCountryName() {
    const t = useTranslations("analytics");
    const language = useDisplayFormat().preferences.language;
    const names = useMemo(() => {
        try {
            return new Intl.DisplayNames([language], { type: "region" });
        } catch {
            return null;
        }
    }, [language]);
    return useCallback(
        (code: string | null) => {
            if (!code || !/^[A-Za-z]{2}$/.test(code)) return t("sessions.unknown");
            try {
                return names?.of(code.toUpperCase()) ?? core.countryName(code);
            } catch {
                return core.countryName(code);
            }
        },
        [names, t]
    );
}

function Labelled({ icon, children, title }: { icon: ReactNode; children: ReactNode; title?: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2" title={title}>
            {icon}
            <span className="min-w-0 truncate">{children}</span>
        </span>
    );
}

function Flag({ code }: { code: string | null }) {
    const flag = core.countryFlag(code);
    return flag ? (
        <span aria-hidden className="w-4 shrink-0 text-center">
            {flag}
        </span>
    ) : (
        <Globe className="size-4 text-muted-foreground" aria-hidden />
    );
}

/** DB-IP's licence asks for a link wherever a country it placed is shown. */
function GeoCredit() {
    const t = useTranslations("analytics");
    return (
        <a
            href="https://db-ip.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-foreground-subtle hover:text-muted-foreground hover:underline"
        >
            {t("map.attribution")}
        </a>
    );
}

// --- the screen --------------------------------------------------------------------

export function SessionsPanel(props: PanelProps) {
    const t = useTranslations("analytics");
    const params = useSearchParams();
    const pathname = usePathname();
    const router = useRouter();
    const [tab, setTab] = useState<"activity" | "properties">("activity");
    useEffect(() => {
        try {
            if (window.localStorage.getItem(TAB_KEY) === "properties") setTab("properties");
        } catch {
            // No storage: the first tab.
        }
    }, []);
    const choose = (next: "activity" | "properties") => {
        setTab(next);
        try {
            window.localStorage.setItem(TAB_KEY, next);
        } catch {
            // Remembered for this visit only.
        }
    };

    const raw = params.get(SESSION_PARAM) ?? "";
    const open = raw.length >= 8 && raw.length <= 128 ? raw : null;
    const hrefFor = useCallback(
        (id: string | null, change?: (search: URLSearchParams) => void) => {
            const search = new URLSearchParams(params.toString());
            if (id) search.set(SESSION_PARAM, id);
            else search.delete(SESSION_PARAM);
            change?.(search);
            const query = search.toString();
            return query ? `${pathname}?${query}` : pathname;
        },
        [params, pathname]
    );

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <SessionsMetrics {...props} />
            <Card className="min-w-0">
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
                    <CardTitle className="text-sm">{t("sessions.title")}</CardTitle>
                    <SegmentedControl
                        size="sm"
                        value={tab}
                        onValueChange={choose}
                        aria-label={t("sessions.title")}
                        options={[
                            { value: "activity", label: t("sessions.tabActivity") },
                            { value: "properties", label: t("sessions.tabProperties") }
                        ]}
                    />
                </CardHeader>
                <CardBody className="min-w-0 pt-0">
                    {tab === "activity" ? (
                        <SessionsTable {...props} hrefFor={hrefFor} />
                    ) : (
                        <SessionProperties {...props} />
                    )}
                </CardBody>
            </Card>
            {open ? (
                <SessionProfile
                    {...props}
                    id={open}
                    onClose={() => router.replace(hrefFor(null), { scroll: false })}
                    onNarrow={(dimension, value) =>
                        router.replace(
                            hrefFor(null, (search) => {
                                const current = core.parseVisitFilters(search.get("f") ?? "");
                                const parsed = core.visitFilterSchema.safeParse({ dimension, value, negate: false });
                                if (!parsed.success) return;
                                const rest = current.filter((one) => one.dimension !== dimension);
                                search.set("f", JSON.stringify([...rest, parsed.data].slice(-10)));
                            }),
                            { scroll: false }
                        )
                    }
                />
            ) : null}
        </div>
    );
}

function SessionsMetrics(props: PanelProps) {
    const t = useTranslations("analytics");
    const { answer, error } = useReport<"sessionStats">(props, { kind: "sessionStats" });
    const stats = answer?.stats ?? null;
    const multiDay = props.data.range !== "24h";
    const cards = stats
        ? [
              {
                  label: multiDay ? t("cards.dailyVisitors") : t("sessions.statVisitors"),
                  value: grouped(stats.visitors),
                  hint: multiDay ? t("cards.dailyVisitorsHint") : t("cards.visitorsHint")
              },
              {
                  label: t("sessions.statVisits"),
                  value: stats.visits === null ? "-" : grouped(stats.visits),
                  hint: stats.visits === null ? t("sessions.visitsDaily") : t("sessions.visitsHint")
              },
              { label: t("sessions.statViews"), value: grouped(stats.views), hint: t("cards.pageviewsHint") },
              { label: t("sessions.statCountries"), value: grouped(stats.countries), hint: t("sessions.countriesHint") }
          ]
        : [];
    if (error) return <Failure message={error} />;
    return (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {stats
                ? cards.map((card) => (
                      <Card key={card.label} className="min-w-0">
                          <CardBody className="flex flex-col gap-1 p-4" title={card.hint}>
                              <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                  {card.label}
                              </span>
                              <span className="text-2xl font-semibold tabular-nums">{card.value}</span>
                          </CardBody>
                      </Card>
                  ))
                : Array.from({ length: 4 }, (_, index) => (
                      <Card key={index}>
                          <CardBody className="flex flex-col gap-2 p-4">
                              <Skeleton className="h-3 w-20" />
                              <Skeleton className="h-7 w-16" />
                          </CardBody>
                      </Card>
                  ))}
        </div>
    );
}

/** First pages already read, so coming back to the screen draws at once. */
const firstPages = new Map<string, readonly SessionListRow[]>();

function SessionsTable(props: PanelProps & { hrefFor: (id: string | null) => string }) {
    const t = useTranslations("analytics");
    const countryName = useCountryName();
    const { scope, siteId, filtersParam } = props;
    const range = props.data.range;
    const key = `${scope}:${siteId}:${range}:${filtersParam}`;
    const list = useCursorList<SessionListRow>(
        async (cursor, signal) => {
            const result = await polls.analyticsReport(
                {
                    scopeType: scope,
                    scopeId: siteId,
                    range,
                    filters: filtersParam,
                    request: JSON.stringify({ kind: "sessionPage", cursor })
                },
                signal
            );
            if ("error" in result) return { error: result.error || t("sessions.failed") };
            if (result.kind !== "sessionPage") return { error: t("sessions.failed") };
            if (cursor === null) firstPages.set(key, result.rows);
            return { data: { items: result.rows, next: result.next } };
        },
        key
    );
    const rows = list.items ?? firstPages.get(key) ?? null;

    if (rows === null) return <TableSkeleton />;
    if (rows.length === 0) {
        if (list.error) {
            return (
                <div className="flex flex-col items-center gap-2 py-6">
                    <Failure message={list.error} />
                    <Button size="sm" variant="secondary" onClick={list.reload}>
                        {t("sessions.retry")}
                    </Button>
                </div>
            );
        }
        return <EmptyState bare icon={<Fingerprint className="size-5" />} title={t("sessions.none")} />;
    }

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="-mx-1 overflow-x-auto px-1">
                <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                        <tr className="border-b border-border">
                            <th className="w-full max-w-0 px-2 py-2 font-medium">{t("sessions.colSession")}</th>
                            <th className="hidden px-2 py-2 text-right font-medium lg:table-cell">{t("sessions.statVisits")}</th>
                            <th className="hidden px-2 py-2 text-right font-medium lg:table-cell">{t("sessions.statViews")}</th>
                            <th className="hidden px-2 py-2 text-right font-medium lg:table-cell">{t("sessions.statEvents")}</th>
                            <th className="hidden px-2 py-2 font-medium lg:table-cell">{t("sessions.colLocation")}</th>
                            <th className="hidden px-2 py-2 font-medium xl:table-cell">{t("sessions.colBrowser")}</th>
                            <th className="hidden px-2 py-2 font-medium xl:table-cell">{t("sessions.colOs")}</th>
                            <th className="hidden px-2 py-2 font-medium xl:table-cell">{t("sessions.colDevice")}</th>
                            <th className="hidden px-2 py-2 font-medium 2xl:table-cell">{t("sessions.colAddress")}</th>
                            <th className="px-2 py-2 text-right font-medium">{t("sessions.colLastSeen")}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {rows.map((row) => {
                            const place = countryName(row.country);
                            return (
                                <tr key={row.id} className="group hover:bg-muted/40">
                                    <td className="w-full max-w-0 px-2 py-2">
                                        <Link
                                            href={props.hrefFor(row.id)}
                                            scroll={false}
                                            className="flex min-w-0 items-center gap-3"
                                            aria-label={t("sessions.open", { id: row.distinctId ?? row.id.slice(0, 8) })}
                                        >
                                            <SessionAvatar id={row.id} />
                                            <span className="flex min-w-0 flex-col">
                                                <span className="truncate font-medium group-hover:underline" title={row.distinctId ?? row.id}>
                                                    {row.distinctId ?? row.id.slice(0, 12)}
                                                </span>
                                                <span className="flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground xl:hidden">
                                                    <span className="lg:hidden">
                                                        {t("sessions.counts", { visits: grouped(row.visits), views: grouped(row.views) })}
                                                    </span>
                                                    <span className="flex min-w-0 items-center gap-1 lg:hidden" title={place}>
                                                        <Flag code={row.country} />
                                                        <span className="truncate">{place}</span>
                                                    </span>
                                                    <Mark type="browser" value={row.browser} />
                                                    <Mark type="os" value={row.os} />
                                                    <DeviceIcon device={row.device} />
                                                    <span className="truncate">{`${row.browser} / ${row.os}`}</span>
                                                </span>
                                            </span>
                                        </Link>
                                    </td>
                                    <td className="hidden px-2 py-2 text-right tabular-nums lg:table-cell">{grouped(row.visits)}</td>
                                    <td className="hidden px-2 py-2 text-right tabular-nums lg:table-cell">{grouped(row.views)}</td>
                                    <td className="hidden px-2 py-2 text-right tabular-nums lg:table-cell">{grouped(row.events)}</td>
                                    <td className="hidden max-w-[12rem] px-2 py-2 lg:table-cell">
                                        <Labelled icon={<Flag code={row.country} />} title={place}>
                                            {place}
                                        </Labelled>
                                    </td>
                                    <td className="hidden max-w-[10rem] px-2 py-2 xl:table-cell">
                                        <Labelled icon={<Mark type="browser" value={row.browser} />} title={row.browser}>
                                            {row.browser}
                                        </Labelled>
                                    </td>
                                    <td className="hidden max-w-[10rem] px-2 py-2 xl:table-cell">
                                        <Labelled icon={<Mark type="os" value={row.os} />} title={row.os}>
                                            {row.os}
                                        </Labelled>
                                    </td>
                                    <td className="hidden max-w-[9rem] px-2 py-2 xl:table-cell">
                                        <Labelled icon={<DeviceIcon device={row.device} />}>{deviceLabel(t, row.device)}</Labelled>
                                    </td>
                                    <td className="hidden max-w-[12rem] truncate px-2 py-2 font-mono text-xs 2xl:table-cell" title={row.ip ?? ""}>
                                        {row.ip ?? "-"}
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-2 text-right text-xs text-muted-foreground">
                                        <RelativeTime iso={row.lastSeenAt} formatStyle="narrow" />
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {list.paging && list.items ? <Skeleton className="h-10 w-full" aria-label={t("sessions.loadingMore")} /> : null}
            {list.error ? <Failure message={list.error} /> : null}
            {list.more ? <LoadMore loading={list.paging} label={t("sessions.more")} onMore={list.loadMore} /> : null}
            <div className="flex justify-end">
                <GeoCredit />
            </div>
        </div>
    );
}

function TableSkeleton() {
    return (
        <div className="flex flex-col divide-y divide-border" aria-busy>
            {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="flex items-center gap-3 py-2">
                    <Skeleton className="size-8 shrink-0 rounded-full" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <Skeleton className="h-3.5 w-32 max-w-full" />
                        <Skeleton className="h-3 w-48 max-w-full xl:hidden" />
                    </div>
                    <Skeleton className="hidden h-3.5 w-24 lg:block" />
                    <Skeleton className="hidden h-3.5 w-20 xl:block" />
                    <Skeleton className="hidden h-3.5 w-20 xl:block" />
                    <Skeleton className="h-3 w-12" />
                </div>
            ))}
        </div>
    );
}

// --- what the sessions said about themselves -----------------------------------------

function SessionProperties(props: PanelProps) {
    const t = useTranslations("analytics");
    const [chosen, setChosen] = useState<string | null>(null);
    const keys = useReport<"sessionProperties">(props, { kind: "sessionProperties" });
    const values = useReport<"sessionProperties">(props, chosen ? { kind: "sessionProperties", key: chosen } : null);
    const keyRows = keys.answer?.rows ?? null;
    useEffect(() => {
        if (chosen && keyRows && !keyRows.some((row) => row.key === chosen)) setChosen(null);
    }, [chosen, keyRows]);

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
                <span className="text-xs text-muted-foreground">{t("sessions.property")}</span>
                <Failure message={keys.error} />
                {keyRows === null ? (
                    <Rows />
                ) : keyRows.length === 0 ? (
                    <Empty>
                        {t("sessions.noPropertiesAll")} {t("sessions.identifyHint")}
                    </Empty>
                ) : (
                    <BarList
                        rows={keyRows.map((row) => ({
                            key: row.key,
                            value: row.sessions,
                            label: (
                                <button
                                    type="button"
                                    className={cn("max-w-full truncate text-left font-mono text-xs hover:underline", chosen === row.key && "font-semibold")}
                                    aria-pressed={chosen === row.key}
                                    title={row.key}
                                    onClick={() => setChosen(row.key)}
                                >
                                    {row.key}
                                </button>
                            )
                        }))}
                    />
                )}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {chosen ? t("sessions.valuesOf", { key: chosen }) : t("sessions.property")}
                </span>
                <Failure message={values.error} />
                {!chosen ? (
                    <Empty>{t("sessions.pickProperty")}</Empty>
                ) : !values.answer || values.answer.key !== chosen ? (
                    <Rows />
                ) : (
                    <BarList
                        rows={values.answer.rows.map((row) => ({
                            key: row.value,
                            value: row.sessions,
                            label: <span title={row.value}>{row.value || "-"}</span>
                        }))}
                    />
                )}
            </div>
        </div>
    );
}

// --- one session --------------------------------------------------------------------

function SessionProfile(
    props: PanelProps & {
        id: string;
        onClose: () => void;
        onNarrow: (dimension: "distinctId" | "ip", value: string) => void;
    }
) {
    const t = useTranslations("analytics");
    const [tab, setTab] = useState<"activity" | "properties">("activity");
    const { answer, error, loading } = useReport<"session">(props, { kind: "session", id: props.id });
    const session = answer?.session ?? null;

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : props.onClose())}>
            <DialogContent className="flex max-h-[90vh] w-[min(100vw-2rem,52rem)] max-w-none flex-col gap-4 overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{t("sessions.profile")}</DialogTitle>
                </DialogHeader>
                <Failure message={error} />
                {loading && !session ? (
                    <ProfileSkeleton />
                ) : !session ? (
                    <Empty>{t("sessions.gone")}</Empty>
                ) : (
                    <div className="flex min-h-0 flex-col gap-5 overflow-y-auto overscroll-contain pr-1">
                        <div className="flex flex-col items-center gap-4 sm:flex-row">
                            <SessionAvatar id={session.id} size={96} />
                            <div className="flex w-full min-w-0 flex-col gap-1">
                                <span className="text-xs text-muted-foreground">ID</span>
                                <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-field px-2 py-1.5">
                                    <code className="min-w-0 flex-1 truncate text-xs" title={session.id}>
                                        {session.id}
                                    </code>
                                    <CopyButton value={session.id} label={t("sessions.copyId")} />
                                </div>
                            </div>
                        </div>
                        <ProfileStats session={session} />
                        <ProfileInfo session={session} onNarrow={props.onNarrow} />
                        <div className="flex flex-col gap-3">
                            <SegmentedControl
                                size="sm"
                                value={tab}
                                onValueChange={setTab}
                                aria-label={t("sessions.profile")}
                                options={[
                                    { value: "activity", label: t("sessions.tabActivity") },
                                    { value: "properties", label: t("sessions.tabProperties") }
                                ]}
                                className="self-start"
                            />
                            {tab === "activity" ? <Activity session={session} /> : <SessionData session={session} />}
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

function ProfileSkeleton() {
    return (
        <div className="flex flex-col gap-5">
            <div className="flex items-center gap-4">
                <Skeleton className="size-24 shrink-0 rounded-full" />
                <Skeleton className="h-9 flex-1" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }, (_, index) => (
                    <Skeleton key={index} className="h-14" />
                ))}
            </div>
            <Rows count={6} />
        </div>
    );
}

function ProfileStats({ session }: { session: Journey }) {
    const t = useTranslations("analytics");
    const stats = [
        [t("sessions.statVisits"), grouped(session.visitCount)],
        [t("sessions.statViews"), grouped(session.pageviews)],
        [t("sessions.statEvents"), grouped(session.eventCount)],
        [t("sessions.statDuration"), duration(session.durationSec)]
    ] as const;
    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stats.map(([label, value]) => (
                <div key={label} className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border px-3 py-2">
                    <span className="truncate text-xs text-muted-foreground" title={label}>{label}</span>
                    <span className="text-xl font-semibold tabular-nums">{value}</span>
                </div>
            ))}
        </div>
    );
}

function ProfileInfo({
    session,
    onNarrow
}: {
    session: Journey;
    onNarrow: (dimension: "distinctId" | "ip", value: string) => void;
}) {
    const t = useTranslations("analytics");
    const format = useDisplayFormat();
    const countryName = useCountryName();
    const facts: { label: string; icon: ReactNode; value: ReactNode; title?: string }[] = [
        {
            label: t("filters.dims.distinctId"),
            icon: <Fingerprint className="size-4 text-muted-foreground" aria-hidden />,
            value: session.distinctId ?? "-",
            title: session.distinctId ?? undefined
        },
        {
            label: t("sessions.colLastSeen"),
            icon: null,
            value: <RelativeTime iso={session.lastSeenAt} />,
            title: format.dateTime(session.lastSeenAt)
        },
        {
            label: t("sessions.firstSeen"),
            icon: null,
            value: <RelativeTime iso={session.startedAt} />,
            title: format.dateTime(session.startedAt)
        },
        { label: t("filters.dims.country"), icon: <Flag code={session.country} />, value: countryName(session.country) },
        { label: t("sessions.colBrowser"), icon: <Mark type="browser" value={session.browser} />, value: session.browser },
        { label: t("sessions.colOs"), icon: <Mark type="os" value={session.os} />, value: session.os },
        { label: t("sessions.colDevice"), icon: <DeviceIcon device={session.device} />, value: deviceLabel(t, session.device) },
        {
            label: t("filters.dims.ip"),
            icon: <Network className="size-4 text-muted-foreground" aria-hidden />,
            value: session.ip ?? "-",
            title: session.ip ?? undefined
        },
        { label: t("filters.dims.screen"), icon: null, value: session.screen ?? "-" },
        { label: t("filters.dims.language"), icon: null, value: session.language ?? "-" },
        {
            label: t("filters.dims.referrer"),
            icon: null,
            value: session.referrerSource ?? session.referrerKind,
            title: session.referrerSource ?? undefined
        },
        ...(session.campaign ? [{ label: t("filters.dims.campaign"), icon: null, value: session.campaign }] : []),
        ...(session.linkedSessions > 1
            ? [{ label: t("sessions.linked"), icon: null, value: grouped(session.linkedSessions) }]
            : [])
    ];
    return (
        <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm min-[420px]:grid-cols-2 sm:grid-cols-3">
                {facts.map((fact) => (
                    <div key={fact.label} className="flex min-w-0 flex-col gap-0.5">
                        <dt className="truncate text-xs text-muted-foreground" title={fact.label}>{fact.label}</dt>
                        <dd className="flex min-w-0 items-center gap-2" title={fact.title}>
                            {fact.icon}
                            <span className="min-w-0 truncate">{fact.value}</span>
                        </dd>
                    </div>
                ))}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
                {session.distinctId ? (
                    <Button size="sm" variant="secondary" onClick={() => onNarrow("distinctId", session.distinctId!)}>
                        <Fingerprint className="size-3.5" />
                        {t("sessions.ofVisitor")}
                    </Button>
                ) : null}
                {session.ip ? (
                    <Button size="sm" variant="secondary" onClick={() => onNarrow("ip", session.ip!)}>
                        <Network className="size-3.5" />
                        {t("sessions.ofAddress")}
                    </Button>
                ) : null}
                <span className="ml-auto">
                    <GeoCredit />
                </span>
            </div>
        </div>
    );
}

/** The hue a visit's marker is drawn in, so the hits of one visit read together. */
function visitHue(visit: number): string {
    return `hsl(${(visit * 137) % 360} 65% 50%)`;
}

function Activity({ session }: { session: Journey }) {
    const t = useTranslations("analytics");
    const format = useDisplayFormat();
    if (session.events.length === 0) return <Empty>{t("sessions.noActivity")}</Empty>;
    let lastDay = "";
    let lastVisit = -1;
    return (
        <div className="flex flex-col gap-1">
            {session.events.map((event, index) => {
                const day = format.date(event.at);
                const showDay = day !== lastDay;
                const showVisit = event.visit !== lastVisit;
                lastDay = day;
                lastVisit = event.visit;
                return (
                    <div key={`${event.at}:${index}`} className="flex min-w-0 flex-col">
                        {showDay ? <h3 className="mt-2 text-sm font-semibold">{day}</h3> : null}
                        {showVisit && session.visitCount > 1 ? (
                            <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                                <span aria-hidden className="size-2 rounded-full" style={{ background: visitHue(event.visit) }} />
                                {t("sessions.visitN", { n: event.visit + 1 })}
                            </span>
                        ) : null}
                        <div className="flex min-w-0 items-start gap-3 py-1 text-sm">
                            <span className="flex w-20 shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                                <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: visitHue(event.visit) }} />
                                {format.time(event.at, { seconds: true })}
                            </span>
                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                                <span className="flex min-w-0 items-center gap-2">
                                    {event.kind === "event" ? (
                                        <Zap className="size-4 text-muted-foreground" aria-hidden />
                                    ) : (
                                        <Eye className="size-4 text-muted-foreground" aria-hidden />
                                    )}
                                    <span className="shrink-0 text-muted-foreground">
                                        {event.kind === "event" ? t("sessions.triggered") : t("sessions.viewed")}
                                    </span>
                                    <span className="min-w-0 truncate font-medium" title={event.kind === "event" ? (event.name ?? "") : event.path}>
                                        {event.kind === "event" ? event.name : event.path}
                                    </span>
                                </span>
                                {event.kind === "event" && event.path ? (
                                    <span className="min-w-0 truncate text-xs text-muted-foreground" title={event.path}>
                                        {event.path}
                                    </span>
                                ) : null}
                                {event.props ? <PropChips props={event.props} /> : null}
                            </div>
                        </div>
                    </div>
                );
            })}
            {session.truncated ? <p className="pt-2 text-xs text-muted-foreground">{t("sessions.truncated")}</p> : null}
        </div>
    );
}

function PropChips({ props }: { props: Record<string, string | number | boolean> }) {
    return (
        <div className="flex flex-wrap gap-1">
            {Object.entries(props).map(([key, value]) => (
                <span
                    key={key}
                    className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                    title={`${key}: ${String(value)}`}
                >
                    {key}: {String(value)}
                </span>
            ))}
        </div>
    );
}

function SessionData({ session }: { session: Journey }) {
    const t = useTranslations("analytics");
    const entries = Object.entries(session.data ?? {});
    if (entries.length === 0) {
        return (
            <Empty>
                {t("sessions.noProps")} {t("sessions.identifyHint")}
            </Empty>
        );
    }
    return (
        <dl className="flex flex-col gap-3">
            {entries.map(([key, value]) => (
                <div key={key} className="flex min-w-0 flex-col gap-0.5">
                    <dt className="truncate font-mono text-xs text-muted-foreground" title={key}>
                        {key}
                    </dt>
                    <dd className="flex min-w-0 items-center gap-2 text-sm">
                        <span className="min-w-0 truncate" title={String(value)}>
                            {String(value)}
                        </span>
                        <Badge variant="neutral">
                            {typeof value === "number"
                                ? t("sessions.typeNumber")
                                : typeof value === "boolean"
                                  ? t("sessions.typeBoolean")
                                  : t("sessions.typeString")}
                        </Badge>
                    </dd>
                </div>
            ))}
        </dl>
    );
}
