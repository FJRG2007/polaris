"use client";

/**
 * The backup console.
 *
 * A table, not a stack of cards. What this replaced showed one card per thing
 * being backed up, which reads fine at three and is unusable at thirty - and the
 * point of the rebuild is that an instance has hundreds. So: one row per
 * protected thing, sorted by when it was last copied, filtered in the database,
 * paged by cursor.
 *
 * The shell paints immediately and the rows arrive after. Everything that does
 * not depend on the query - the header, the tabs, the filters, the table's own
 * chrome - is on screen in the first frame, and only the rows hold a skeleton.
 * The old page awaited its data before rendering anything, which meant opening
 * it showed nothing at all until the slowest game server had answered.
 */

import Link from "next/link";
import { KeysPanel } from "./keys-panel";
import { readJson } from "@/lib/read-json";
import { PlansPanel } from "./plans-panel";
import { formatBytes } from "@polaris/core";
import { kindLabel } from "@/lib/backups/words";
import { ProtectDialog } from "./protect-dialog";
import { ActivityPanel } from "./activity-panel";
import { readReasonText } from "@/lib/read-json";
import { RESOURCE_KINDS } from "@/lib/backups/kinds";
import { DestinationsPanel } from "./destinations-panel";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { BackupOverview, DestinationSummary, PlanSummary, ResourceRow } from "./types";
import { backUpNowAction, setPausedAction, setPlanAction, unprotectAction } from "./actions";
import {
    AlertTriangle,
    Clock,
    HardDriveDownload,
    Loader2,
    Pause,
    Play,
    Plus,
    Search
} from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    cn,
    ConfirmDeleteDialog,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";

/** How many rows a page holds. Enough to fill a screen twice over. */
const PAGE_SIZE = 50;

/** Read-side cache TTL. A console somebody is clicking around should not
 *  re-query the same page on every tab switch. */
const CACHE_MS = 30_000;

type Tab = "protected" | "plans" | "destinations" | "keys" | "activity";

/** The tabs, in order; each one's name is `tabs.<id>` in the catalog. */
const TABS: readonly Tab[] = ["protected", "plans", "destinations", "keys", "activity"];

export function BackupsView() {
    const t = useTranslations("backups");
    const tc = useTranslations("components");
    const [tab, setTab] = useState<Tab>("protected");
    const [overview, setOverview] = useState<BackupOverview | null>(null);
    // Why the console has nothing to draw, when that is the answer. Held apart
    // from the data so a refresh that fails does not blank what is already on
    // screen, and shown rather than swallowed: skeletons that never resolve are
    // a broken page with the reason removed.
    const [unread, setUnread] = useState<string | null>(null);

    const loadOverview = useCallback(async () => {
        const next = await readJson<BackupOverview>("/api/backups/overview");
        if (next.ok) {
            setOverview(next.value);
            setUnread(null);
        } else {
            setUnread(readReasonText(tc, next.reason));
        }
    }, [tc]);

    useEffect(() => {
        void loadOverview();
    }, [loadOverview]);

    return (
        <div className="flex flex-col gap-4">
            {unread ? (
                <Card>
                    <CardBody className="flex items-start gap-2 py-3 text-sm text-danger">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <span>{unread}</span>
                    </CardBody>
                </Card>
            ) : null}
            <SummaryStrip overview={overview} failed={unread !== null} />

            <div className="flex flex-wrap items-center gap-1 border-b border-border">
                {TABS.map((entry) => (
                    <button
                        key={entry}
                        type="button"
                        onClick={() => setTab(entry)}
                        className={cn(
                            "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                            tab === entry
                                ? "border-primary font-medium text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {t(`tabs.${entry}`)}
                    </button>
                ))}
            </div>

            {tab === "protected" ? (
                <ProtectedTable
                    plans={overview?.plans ?? []}
                    destinations={overview?.destinations ?? []}
                    onChanged={loadOverview}
                />
            ) : null}
            {tab === "plans" ? (
                <PlansPanel
                    plans={overview?.plans ?? []}
                    destinations={overview?.destinations ?? []}
                    loading={overview === null}
                    onChanged={loadOverview}
                />
            ) : null}
            {tab === "destinations" ? (
                <DestinationsPanel
                    destinations={overview?.destinations ?? []}
                    loading={overview === null}
                    onChanged={loadOverview}
                />
            ) : null}
            {tab === "keys" ? <KeysPanel /> : null}
            {tab === "activity" ? <ActivityPanel /> : null}
        </div>
    );
}

/**
 * The numbers across the top.
 *
 * Skeletons rather than zeros while they load: "0 protected" is a statement,
 * and showing it before the answer is known is showing something false.
 */
function SummaryStrip({ overview, failed }: { overview: BackupOverview | null; failed: boolean }) {
    const t = useTranslations("backups");
    const summary = overview?.summary;
    // A dash once the read has failed, not a skeleton: a skeleton says the answer
    // is on its way, and it is not.
    const missing = failed ? "-" : null;
    return (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t("summary.protected")} value={summary ? String(summary.protectedCount) : missing} />
            <Stat label={t("summary.copies")} value={summary ? String(summary.copyCount) : missing} />
            <Stat label={t("summary.stored")} value={summary ? formatBytes(BigInt(summary.storedBytes)) : missing} />
            <Stat
                label={t("summary.failed")}
                value={summary ? String(summary.failedRecently) : missing}
                bad={Boolean(summary && summary.failedRecently > 0)}
            />
            {summary && summary.destinationsDown > 0 ? (
                <Card className="sm:col-span-2 lg:col-span-4">
                    <CardBody className="flex items-start gap-2 py-3 text-xs text-danger">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <span>
                            {t("summary.destinationsDown", { count: summary.destinationsDown })}
                        </span>
                    </CardBody>
                </Card>
            ) : null}
        </div>
    );
}

function Stat({ label, value, bad }: { label: string; value: string | null; bad?: boolean }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-1 py-3">
                <span className="text-xs text-muted-foreground">{label}</span>
                {value === null ? (
                    <Skeleton className="h-6 w-20" />
                ) : (
                    <span className={cn("text-lg font-medium", bad && "text-danger")}>{value}</span>
                )}
            </CardBody>
        </Card>
    );
}

interface Page {
    rows: ResourceRow[];
    nextCursor: string | null;
    total: number;
}

function ProtectedTable({
    plans,
    destinations,
    onChanged
}: {
    plans: PlanSummary[];
    destinations: DestinationSummary[];
    onChanged: () => Promise<void>;
}) {
    const t = useTranslations("backups");
    const tc = useTranslations("components");
    const format = useDisplayFormat();
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState("");
    const [page, setPage] = useState<Page | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [removing, setRemoving] = useState<ResourceRow | null>(null);
    const [protecting, setProtecting] = useState(false);
    const [, startTransition] = useTransition();
    // Debounced search: a keystroke per query would re-page the table five times
    // on the way to one word.
    const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cache = useRef(new Map<string, { at: number; page: Page }>());

    const key = useMemo(() => `${query}|${kind}`, [query, kind]);

    const load = useCallback(
        async (cursor?: string) => {
            const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
            if (query) params.set("query", query);
            if (kind) params.set("kind", kind);
            if (cursor) params.set("cursor", cursor);

            if (!cursor) {
                const cached = cache.current.get(key);
                if (cached && Date.now() - cached.at < CACHE_MS) {
                    setPage(cached.page);
                    return;
                }
            }
            const next = await readJson<Page>(`/api/backups/resources?${params}`);
            if (!next.ok) {
                setError(readReasonText(tc, next.reason));
                // An empty page rather than nothing: the table draws its "nothing
                // here" row instead of skeletons that never resolve, and the
                // sentence above it says why it is empty.
                setPage((current) => current ?? { rows: [], nextCursor: null, total: 0 });
                return;
            }
            const answer = next.value;
            setError(null);
            setPage((current) =>
                cursor && current ? { ...answer, rows: [...current.rows, ...answer.rows] } : answer
            );
            if (!cursor) cache.current.set(key, { at: Date.now(), page: answer });
        },
        [key, kind, query, tc]
    );

    useEffect(() => {
        if (debounce.current) clearTimeout(debounce.current);
        debounce.current = setTimeout(() => void load(), query ? 250 : 0);
        return () => {
            if (debounce.current) clearTimeout(debounce.current);
        };
    }, [load, query]);

    /** Re-read after a mutation, ignoring the cache it just invalidated. */
    const refresh = useCallback(async () => {
        cache.current.clear();
        await Promise.all([load(), onChanged()]);
    }, [load, onChanged]);

    async function onBackUpNow(row: ResourceRow) {
        setBusy(row.id);
        setError(null);
        const result = await backUpNowAction(row.id);
        setBusy(null);
        // `!== undefined` rather than truthiness: the error arm is typed
        // `string`, which includes "", so a truthy check narrows neither arm.
        if (result.error !== undefined) {
            setError(result.error);
        } else if (result.status === "partial") {
            setError(t("table.partial", { name: row.name }));
        }
        await refresh();
    }

    async function onTogglePause(row: ResourceRow) {
        setBusy(row.id);
        const result = await setPausedAction(row.id, row.status !== "paused");
        setBusy(null);
        if (result.error) setError(result.error);
        await refresh();
    }

    async function onRemove(deleteCopies: boolean) {
        if (!removing) return;
        const target = removing;
        setRemoving(null);
        setBusy(target.id);
        const result = await unprotectAction(target.id, deleteCopies);
        setBusy(null);
        if (result.error) setError(result.error);
        await refresh();
    }

    const rows = page?.rows ?? null;

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-48 flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("table.search")}
                        className="pl-8"
                        aria-label={t("table.search")}
                    />
                </div>
                <Select
                    value={kind}
                    onValueChange={setKind}
                    aria-label={t("table.filterType")}
                    // Room for the longest kind in Spanish ("Base de datos de Polaris").
                    className="w-52"
                    options={[
                        { value: "", label: t("table.everyType") },
                        ...RESOURCE_KINDS.map((entry) => ({
                            value: entry,
                            label: kindLabel(t, entry)
                        }))
                    ]}
                />
                <Button onClick={() => setProtecting(true)}>
                    <Plus className="size-4" />
                    {t("table.add")}
                </Button>
            </div>

            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <Card>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="border-b border-border text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2 font-medium">{t("table.columns.name")}</th>
                                <th className="px-3 py-2 font-medium">{t("table.columns.type")}</th>
                                <th className="px-3 py-2 font-medium">{t("table.columns.plan")}</th>
                                <th className="px-3 py-2 font-medium">{t("table.columns.lastCopy")}</th>
                                <th className="px-3 py-2 font-medium">{t("table.columns.next")}</th>
                                <th className="px-3 py-2 text-right font-medium">{t("summary.copies")}</th>
                                <th className="px-3 py-2 text-right font-medium">{t("table.columns.size")}</th>
                                <th className="px-3 py-2 font-medium">{t("tabs.destinations")}</th>
                                <th className="px-3 py-2" />
                            </tr>
                        </thead>
                        <tbody>
                            {rows === null ? (
                                Array.from({ length: 5 }, (_, index) => (
                                    <tr key={index} className="border-b border-border last:border-0">
                                        <td colSpan={9} className="px-3 py-2.5">
                                            <Skeleton className="h-5 w-full" />
                                        </td>
                                    </tr>
                                ))
                            ) : rows.length === 0 ? (
                                <tr>
                                    <td colSpan={9} className="px-3 py-10 text-center text-sm text-muted-foreground">
                                        {query || kind ? t("table.noMatch") : t("table.empty")}
                                    </td>
                                </tr>
                            ) : (
                                rows.map((row) => (
                                    <ResourceLine
                                        key={row.id}
                                        row={row}
                                        plans={plans}
                                        busy={busy === row.id}
                                        format={format}
                                        onBackUp={() => void onBackUpNow(row)}
                                        onTogglePause={() => void onTogglePause(row)}
                                        onRemove={() => setRemoving(row)}
                                        onChanged={refresh}
                                    />
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </Card>

            {page?.nextCursor ? (
                <Button
                    variant="ghost"
                    disabled={loadingMore}
                    onClick={() => {
                        setLoadingMore(true);
                        startTransition(async () => {
                            await load(page.nextCursor ?? undefined);
                            setLoadingMore(false);
                        });
                    }}
                >
                    {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t("table.more")}
                </Button>
            ) : null}

            {protecting ? (
                <ProtectDialog
                    plans={plans}
                    destinations={destinations}
                    onClose={() => setProtecting(false)}
                    onProtected={refresh}
                />
            ) : null}

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={removing.name}
                    kind={t("table.kind")}
                    requireTyping={false}
                    description={
                        removing.copyCount > 0
                            ? t("table.removeKeeps", { count: removing.copyCount })
                            : t("table.removeNoCopies")
                    }
                    confirmLabel={t("table.stop")}
                    onConfirm={() => void onRemove(false)}
                />
            ) : null}
        </div>
    );
}

/** One row. Every verb is here: the two anybody uses, and a right-click for the rest. */
function ResourceLine({
    row,
    plans,
    busy,
    format,
    onBackUp,
    onTogglePause,
    onRemove,
    onChanged
}: {
    row: ResourceRow;
    plans: PlanSummary[];
    busy: boolean;
    format: ReturnType<typeof useDisplayFormat>;
    onBackUp: () => void;
    onTogglePause: () => void;
    onRemove: () => void;
    onChanged: () => Promise<void>;
}) {
    const t = useTranslations("backups");
    const paused = row.status === "paused";
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>
                <tr className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="px-3 py-2.5">
                        <Link href={`/apps/backups/${row.id}`} className="font-medium hover:underline">
                            {row.name}
                        </Link>
                        {row.lastStatus === "failed" || row.lastStatus === "partial" ? (
                            <p className="truncate text-xs text-danger" title={row.lastError ?? undefined}>
                                {row.lastError ?? t("table.lastFailed")}
                            </p>
                        ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{kindLabel(t, row.kind, row.kindLabel)}</td>
                    <td className="px-3 py-2.5">
                        {row.planName ? (
                            <span className="text-muted-foreground">{row.planName}</span>
                        ) : (
                            <span className="text-xs text-muted-foreground">{t("table.onDemand")}</span>
                        )}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                        {row.lastBackupAt ? format.dateTime(row.lastBackupAt) : t("table.never")}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                        {paused ? (
                            <Badge variant="neutral">{t("table.paused")}</Badge>
                        ) : row.nextDueAt ? (
                            <span className="flex items-center gap-1 text-xs">
                                <Clock className="size-3.5" />
                                {format.dateTime(row.nextDueAt)}
                            </span>
                        ) : (
                            <span className="text-xs">-</span>
                        )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{row.copyCount}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                        {formatBytes(BigInt(row.sizeBytes))}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                        {row.destinations.length > 0 ? row.destinations.join(", ") : t("table.default")}
                    </td>
                    <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={t("table.backUpNamed", { name: row.name })}
                                title={t("table.backUp")}
                                disabled={busy}
                                onClick={onBackUp}
                            >
                                {busy ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <HardDriveDownload className="size-4" />
                                )}
                            </Button>
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={
                                    paused
                                        ? t("table.resumeNamed", { name: row.name })
                                        : t("table.pauseNamed", { name: row.name })
                                }
                                title={paused ? t("table.resume") : t("table.pause")}
                                disabled={busy}
                                onClick={onTogglePause}
                            >
                                {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                            </Button>
                        </div>
                    </td>
                </tr>
            </ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuLabel>{row.name}</ContextMenuLabel>
                <ContextMenuItem asChild>
                    <Link href={`/apps/backups/${row.id}`}>{t("table.open")}</Link>
                </ContextMenuItem>
                <ContextMenuItem onSelect={onBackUp}>{t("table.backUp")}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuLabel>{t("table.columns.plan")}</ContextMenuLabel>
                <PlanChoices row={row} plans={plans} onChanged={onChanged} />
                <ContextMenuSeparator />
                <ContextMenuItem variant="danger" onSelect={onRemove}>
                    {t("table.stop")}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

/** The plans this row could be on, so changing one is a right-click. */
function PlanChoices({
    row,
    plans,
    onChanged
}: {
    row: ResourceRow;
    plans: PlanSummary[];
    onChanged: () => Promise<void>;
}) {
    const t = useTranslations("backups");
    return (
        <>
            <ContextMenuItem
                onSelect={async () => {
                    await setPlanAction(row.id, null);
                    await onChanged();
                }}
            >
                {row.planId === null ? "- " : ""}
                {t("table.onDemandOnly")}
            </ContextMenuItem>
            {plans.map((plan) => (
                <ContextMenuItem
                    key={plan.id}
                    onSelect={async () => {
                        await setPlanAction(row.id, plan.id);
                        await onChanged();
                    }}
                >
                    {row.planId === plan.id ? "- " : ""}
                    {plan.name}
                </ContextMenuItem>
            ))}
            {plans.length === 0 ? (
                <ContextMenuItem disabled>{t("table.noPlans")}</ContextMenuItem>
            ) : null}
        </>
    );
}
