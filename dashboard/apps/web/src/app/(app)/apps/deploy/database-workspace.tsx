"use client";

/**
 * A Deploy database's Database tab: Data, Stats, Config and Connect.
 *
 * Data is the Databases app's workbench bound to this database - the same grid,
 * statement box, new-table form and row editing, with nothing to set up: the
 * server reads the address and credentials from the deploy row on every call.
 * It opens read-only; turning that off is a confirmed choice per visit, and the
 * driver is what refuses a write while it is on.
 *
 * Stats is one bounded report (sizes, connections, vacuum, indexes, statement
 * statistics) cached for 30 seconds on both sides, above the live rates the
 * workbench already draws. Config and Connect carry the account, the password
 * and how to reach the database from a service or from outside.
 */

import * as core from "@polaris/core";
import { CopyRow } from "./deploy-view";
import { formatBytes } from "@polaris/core";
import * as actions from "./database-data-actions";
import type { ExtensionView } from "@/lib/data/maintenance";
import { useDisplayFormat } from "@/components/display-format";
import { Workbench } from "@/app/(app)/apps/databases/workbench";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import type { HealthReport, TableHealth } from "@/lib/data/health";
import { StatsPanel } from "@/app/(app)/apps/databases/stats-panel";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { DataSourceProvider, type DataSource } from "@/app/(app)/apps/databases/data-source";
import { AlertTriangle, Eye, EyeOff, Loader2, Lock, LockOpen, RefreshCw, Search } from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    ScrollRow,
    SegmentedControl,
    Skeleton,
    Switch,
    cn
} from "@polaris/ui";

type View = "data" | "stats" | "config" | "connect";

/** The workbench's calls, aimed at this database through Deploy's actions. */
function managedSource(databaseId: string, writable: boolean): DataSource {
    const source = { databaseId, writable };
    return {
        key: `deploy:${databaseId}`,
        browse: (namespace) => actions.managedBrowseAction(source, namespace),
        rows: (namespace, relation, query) => actions.managedRowsAction(source, namespace, relation, query),
        run: (statement) => actions.managedRunAction(source, statement),
        updateCell: (edit) => actions.managedUpdateCellAction(source, edit),
        insertRow: (insert) => actions.managedInsertRowAction(source, insert),
        deleteRows: (removal) => actions.managedDeleteRowsAction(source, removal),
        createTable: (draft) => actions.managedCreateTableAction(source, draft),
        redisValue: (namespace, key) => actions.managedRedisValueAction(source, namespace, key),
        stats: () => actions.managedStatsAction(source),
        insights: () => actions.managedInsightsAction(source)
    };
}

/** A pending confirmation: what it says, and what it runs once agreed to. */
interface Confirmation {
    title: string;
    body: ReactNode;
    label: string;
    danger?: boolean;
    run: () => Promise<{ error?: string }>;
    done?: () => void;
}

function useConfirm() {
    const t = useTranslations("deployData");
    const [confirm, setConfirm] = useState<Confirmation | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function agree() {
        if (!confirm) return;
        setPending(true);
        setError(null);
        const result = await confirm.run();
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        confirm.done?.();
        setConfirm(null);
    }

    const dialog = confirm ? (
        <Dialog open onOpenChange={(open) => !open && !pending && setConfirm(null)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{confirm.title}</DialogTitle>
                    <DialogDescription asChild>
                        <div className="flex flex-col gap-2 text-sm text-muted-foreground">{confirm.body}</div>
                    </DialogDescription>
                </DialogHeader>
                {error ? <p className="text-sm text-danger">{error}</p> : null}
                <DialogFooter>
                    <Button variant="ghost" disabled={pending} onClick={() => setConfirm(null)}>
                        {t("database.cancel")}
                    </Button>
                    <Button variant={confirm.danger ? "danger" : "primary"} disabled={pending} onClick={() => void agree()}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                        {confirm.label}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    ) : null;

    return {
        ask: (next: Confirmation) => {
            setError(null);
            setConfirm(next);
        },
        dialog
    };
}

export function DatabaseWorkspace({
    database,
    deployed,
    manage,
    hosted
}: {
    database: { id: string; name: string; engine: string };
    /** Whether the instance has a container to talk to yet. */
    deployed: boolean;
    /** `deploy.manage` and `databases.manage` on the project: everything here needs both. */
    manage: boolean;
    /** Lives inside another instance's container. */
    hosted: boolean;
}) {
    const t = useTranslations("deployData");
    const [view, setView] = useState<View>("data");

    if (!manage) return <p className="text-sm text-muted-foreground">{t("workspace.needsManage")}</p>;
    if (!deployed) return <p className="text-sm text-muted-foreground">{t("database.provisionFirst")}</p>;

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <ScrollRow>
                <SegmentedControl
                    aria-label={t("workspace.section")}
                    size="sm"
                    value={view}
                    onValueChange={setView}
                    options={[
                        { value: "data" as const, label: t("workspace.tabs.data") },
                        { value: "stats" as const, label: t("workspace.tabs.stats") },
                        { value: "config" as const, label: t("workspace.tabs.config") },
                        { value: "connect" as const, label: t("workspace.tabs.connect") }
                    ]}
                />
            </ScrollRow>
            {view === "data" ? <DataView databaseId={database.id} /> : null}
            {view === "stats" ? <StatsView databaseId={database.id} engine={database.engine} /> : null}
            {view === "config" ? <ConfigView database={database} hosted={hosted} /> : null}
            {view === "connect" ? <ConnectView database={database} hosted={hosted} /> : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function DataView({ databaseId }: { databaseId: string }) {
    const t = useTranslations("deployData");
    const [writable, setWritable] = useState(false);
    const [asking, setAsking] = useState(false);
    const source = useMemo(() => managedSource(databaseId, writable), [databaseId, writable]);

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2">
                {writable ? (
                    <LockOpen className="size-4 shrink-0 text-warning" />
                ) : (
                    <Lock className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 text-sm">
                    {writable ? t("workspace.data.writable") : t("workspace.data.readOnly")}
                </span>
                <Switch
                    checked={!writable}
                    aria-label={t("workspace.data.readOnlySwitch")}
                    onChange={(readOnly) => (readOnly ? setWritable(false) : setAsking(true))}
                />
            </div>
            <div className="flex h-[70vh] min-h-[28rem] min-w-0 flex-col">
                <Workbench
                    key={writable ? "write" : "read"}
                    connectionId={`deploy:${databaseId}`}
                    readOnly={!writable}
                    source={source}
                />
            </div>
            <Dialog open={asking} onOpenChange={setAsking}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("workspace.data.allowTitle")}</DialogTitle>
                        <DialogDescription>{t("workspace.data.allowBody")}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setAsking(false)}>
                            {t("database.cancel")}
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() => {
                                setWritable(true);
                                setAsking(false);
                            }}
                        >
                            {t("workspace.data.allow")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** How long a report kept in this tab is shown without asking again. */
const HEALTH_TTL_MS = 30_000;

/** Tables shown before "Show all". */
const FIRST_TABLES = 10;

/** Dead rows past this share of a table is called bloat. */
const BLOAT_PERCENT = 10;

function StatsView({ databaseId, engine }: { databaseId: string; engine: string }) {
    const t = useTranslations("deployData");
    const format = useDisplayFormat();
    const cacheKey = `deploy.db.health.${databaseId}`;
    const [report, setReport] = useState<HealthReport | null>(
        () => readSnapshot<HealthReport>(cacheKey, HEALTH_TTL_MS)?.value ?? null
    );
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [allTables, setAllTables] = useState(false);
    const { ask, dialog } = useConfirm();
    const source = useMemo(() => managedSource(databaseId, false), [databaseId]);

    const load = useCallback(
        async (fresh: boolean) => {
            setBusy(true);
            const result = await actions.databaseHealthAction(databaseId, fresh);
            setBusy(false);
            if (result.report) {
                setReport(result.report);
                setError(null);
                writeSnapshot(cacheKey, result.report);
            } else setError(result.error ?? t("workspace.stats.unreadable"));
        },
        [databaseId, cacheKey]
    );

    useEffect(() => {
        if (!readSnapshot<HealthReport>(cacheKey, HEALTH_TTL_MS)) void load(false);
    }, [cacheKey, load]);

    const number = (value: number | null | undefined) => (value === null || value === undefined ? "-" : format.number(value));
    const bloated = (report?.tables ?? []).filter((table) => (table.deadPercent ?? 0) >= BLOAT_PERCENT);
    const tables = allTables ? (report?.tables ?? []) : (report?.tables ?? []).slice(0, FIRST_TABLES);
    const postgres = engine === "postgres";

    function vacuum(table: TableHealth) {
        ask({
            title: t("workspace.stats.vacuumTitle", { table: table.name }),
            body: t("workspace.stats.vacuumBody"),
            label: t("workspace.stats.vacuum"),
            run: () => actions.vacuumTableAction(databaseId, { schema: table.schema ?? "public", name: table.name }),
            done: () => void load(true)
        });
    }

    function enableStatements() {
        ask({
            title: t("workspace.stats.enableTitle"),
            body: t("workspace.stats.enableBody"),
            label: t("workspace.stats.enable"),
            run: () => actions.enableStatStatementsAction(databaseId),
            done: () => void load(true)
        });
    }

    return (
        <div className="flex min-w-0 flex-col gap-5">
            <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                    {report ? t("workspace.stats.readAt", { time: format.time(new Date(report.at), { seconds: true }) }) : ""}
                </span>
                <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto"
                    title={t("workspace.stats.refresh")}
                    aria-label={t("workspace.stats.refresh")}
                    onClick={() => void load(true)}
                >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                </Button>
            </div>
            {error ? <p className="text-sm text-danger">{error}</p> : null}

            {!report ? (
                <div className="grid gap-3 sm:grid-cols-3" aria-hidden="true">
                    <Skeleton className="h-20" />
                    <Skeleton className="h-20" />
                    <Skeleton className="h-20" />
                    <Skeleton className="h-40 sm:col-span-3" />
                </div>
            ) : (
                <>
                    <div className="grid gap-3 sm:grid-cols-3">
                        {report.connections ? (
                            <Tile label={t("workspace.stats.connections")}>
                                <span className="text-xl font-semibold tabular-nums">
                                    {number(report.connections.used)}
                                    {report.connections.max ? (
                                        <span className="text-sm font-normal text-muted-foreground">
                                            {" "}
                                            / {number(report.connections.max)}
                                        </span>
                                    ) : null}
                                </span>
                                {report.connections.max ? (
                                    <Meter value={report.connections.used / report.connections.max} />
                                ) : null}
                                <span className="text-xs text-muted-foreground">
                                    {[
                                        report.connections.active !== null
                                            ? t("workspace.stats.active", { count: report.connections.active })
                                            : null,
                                        report.connections.idle !== null
                                            ? t("workspace.stats.idle", { count: report.connections.idle })
                                            : null,
                                        report.connections.idleInTransaction !== null
                                            ? t("workspace.stats.idleInTransaction", { count: report.connections.idleInTransaction })
                                            : null
                                    ]
                                        .filter(Boolean)
                                        .join(" - ")}
                                </span>
                            </Tile>
                        ) : null}
                        <Tile label={t("workspace.stats.cacheHit")}>
                            <span className="text-xl font-semibold tabular-nums">
                                {report.cacheHitRatio === null
                                    ? "-"
                                    : `${format.number(report.cacheHitRatio * 100, { maximumFractionDigits: 1 })}%`}
                            </span>
                            {report.cacheHitRatio !== null ? <Meter value={report.cacheHitRatio} good /> : null}
                        </Tile>
                        {report.sizes[0] ? (
                            <Tile label={t(`workspace.stats.sizes.${report.sizes[0].key}`)}>
                                <span className="text-xl font-semibold tabular-nums">{formatBytes(report.sizes[0].bytes)}</span>
                                <span className="text-xs text-muted-foreground">
                                    {report.sizes
                                        .slice(1)
                                        .map((part) => `${t(`workspace.stats.sizes.${part.key}`)} ${formatBytes(part.bytes)}`)
                                        .join(" - ")}
                                </span>
                            </Tile>
                        ) : null}
                    </div>

                    {report.facts.length > 0 ? (
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                            {report.facts.map((fact) => (
                                <div key={fact.key} className="min-w-0">
                                    <dt className="text-xs text-muted-foreground">{t(`workspace.stats.facts.${fact.key}`)}</dt>
                                    <dd className="truncate tabular-nums" title={String(fact.value)}>
                                        {typeof fact.value === "number"
                                            ? fact.unit === "seconds"
                                                ? t("workspace.stats.hours", { count: Math.floor(fact.value / 3600) })
                                                : format.number(fact.value, { maximumFractionDigits: 2 })
                                            : fact.key === "persistence"
                                              ? t(`workspace.stats.persistence.${fact.value as "aof" | "rdb" | "none"}`)
                                              : fact.value}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    ) : null}

                    {report.queries ? (
                        <Block title={t("workspace.stats.queries")}>
                            {report.queries.rows.length > 0 ? (
                                <Table
                                    head={[
                                        t("workspace.stats.statement"),
                                        t("workspace.stats.calls"),
                                        t("workspace.stats.rows"),
                                        t("workspace.stats.total"),
                                        t("workspace.stats.mean"),
                                        t("workspace.stats.max")
                                    ]}
                                    rows={report.queries.rows.map((row) => [
                                        <code key="s" className="block max-w-md truncate font-mono text-xs" title={row.statement}>
                                            {row.statement}
                                        </code>,
                                        number(row.calls),
                                        number(row.rows),
                                        ms(row.totalMs, format),
                                        ms(row.meanMs, format),
                                        ms(row.maxMs, format)
                                    ])}
                                />
                            ) : postgres && report.queries.available && !(report.queries.installed && report.queries.preloaded) ? (
                                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border p-3">
                                    <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t("workspace.stats.enableHint")}</p>
                                    <Button size="sm" onClick={enableStatements}>
                                        {t("workspace.stats.enable")}
                                    </Button>
                                </div>
                            ) : (
                                <p className="text-sm text-muted-foreground">
                                    {report.queries.available ? t("workspace.stats.noQueries") : t("workspace.stats.queriesUnavailable")}
                                </p>
                            )}
                        </Block>
                    ) : null}

                    {report.tables.length > 0 ? (
                        <Block
                            title={t("workspace.stats.tables", { count: report.tablesTotal })}
                            action={
                                report.tables.length > FIRST_TABLES ? (
                                    <Button size="sm" variant="ghost" onClick={() => setAllTables((value) => !value)}>
                                        {allTables ? t("workspace.stats.showFewer") : t("workspace.stats.showAll", { count: report.tables.length })}
                                    </Button>
                                ) : null
                            }
                        >
                            <Table
                                head={[
                                    t("workspace.stats.table"),
                                    t("workspace.stats.rows"),
                                    t("workspace.stats.data"),
                                    t("workspace.stats.indexes"),
                                    ...(postgres ? [t("workspace.stats.seqScans"), t("workspace.stats.idxScans")] : [t("workspace.stats.free")])
                                ]}
                                rows={tables.map((table) => [
                                    <span key="n" className="block max-w-56 truncate" title={qualified(table)}>
                                        {qualified(table)}
                                    </span>,
                                    number(table.rows),
                                    formatBytes(table.dataBytes),
                                    formatBytes(table.indexBytes),
                                    ...(postgres
                                        ? [number(table.seqScans), number(table.idxScans)]
                                        : [table.freeBytes === null ? "-" : formatBytes(table.freeBytes)])
                                ])}
                            />
                        </Block>
                    ) : null}

                    {report.vacuum ? (
                        <Block title={t("workspace.stats.vacuumHealth")}>
                            {report.vacuum.freezeRisk ? (
                                <p className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                                    {t("workspace.stats.freezeRisk", {
                                        age: number(report.vacuum.databaseXidAge),
                                        limit: number(report.vacuum.freezeMaxAge)
                                    })}
                                </p>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    {t("workspace.stats.xidAge", {
                                        age: number(report.vacuum.databaseXidAge),
                                        limit: number(report.vacuum.freezeMaxAge)
                                    })}
                                </p>
                            )}
                            {bloated.length > 0 ? (
                                <p className="text-sm text-warning">{t("workspace.stats.bloat", { count: bloated.length, percent: BLOAT_PERCENT })}</p>
                            ) : null}
                            <Table
                                head={[
                                    t("workspace.stats.table"),
                                    t("workspace.stats.deadRows"),
                                    t("workspace.stats.deadPercent"),
                                    t("workspace.stats.lastVacuum"),
                                    t("workspace.stats.xid"),
                                    ""
                                ]}
                                stickyLast
                                rows={tables.map((table) => {
                                    const last = [table.lastVacuum, table.lastAutovacuum]
                                        .filter((value): value is string => Boolean(value))
                                        .sort()
                                        .at(-1);
                                    return [
                                        <span key="n" className="block max-w-56 truncate" title={qualified(table)}>
                                            {qualified(table)}
                                        </span>,
                                        number(table.deadRows),
                                        table.deadPercent === null ? (
                                            "-"
                                        ) : (
                                            <span key="p" className={cn(table.deadPercent >= BLOAT_PERCENT && "text-warning")}>
                                                {format.number(table.deadPercent, { maximumFractionDigits: 1 })}%
                                            </span>
                                        ),
                                        last ? format.dateTime(last) : t("workspace.stats.never"),
                                        number(table.xidAge),
                                        <Button key="v" size="sm" variant="ghost" onClick={() => vacuum(table)}>
                                            {t("workspace.stats.vacuum")}
                                        </Button>
                                    ];
                                })}
                            />
                        </Block>
                    ) : null}

                    {report.unusedIndexes ? (
                        <Block title={t("workspace.stats.indexHealth")}>
                            {report.unusedIndexes.length === 0 ? (
                                <p className="text-sm text-muted-foreground">{t("workspace.stats.noUnused")}</p>
                            ) : (
                                <>
                                    <p className="text-xs text-muted-foreground">{t("workspace.stats.unusedHint")}</p>
                                    <Table
                                        head={[
                                            t("workspace.stats.index"),
                                            t("workspace.stats.table"),
                                            t("workspace.stats.size"),
                                            t("workspace.stats.scans")
                                        ]}
                                        rows={report.unusedIndexes.map((index) => [
                                            <span key="i" className="block max-w-56 truncate font-mono text-xs" title={index.name}>
                                                {index.name}
                                            </span>,
                                            index.table,
                                            index.bytes ? formatBytes(index.bytes) : "-",
                                            number(index.scans)
                                        ])}
                                    />
                                </>
                            )}
                        </Block>
                    ) : null}
                </>
            )}

            <Block title={t("workspace.stats.live")}>
                <DataSourceProvider source={source}>
                    <StatsPanel />
                </DataSourceProvider>
            </Block>
            {dialog}
        </div>
    );
}

function qualified(table: TableHealth): string {
    return table.schema && table.schema !== "public" ? `${table.schema}.${table.name}` : table.name;
}

function ms(value: number | null, format: ReturnType<typeof useDisplayFormat>): string {
    return value === null ? "-" : `${format.number(value, { maximumFractionDigits: 1 })} ms`;
}

function Tile({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border p-3">
            <span className="text-xs text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

function Meter({ value, good }: { value: number; good?: boolean }) {
    const share = Math.max(0, Math.min(1, value));
    const tone = good
        ? share >= 0.95
            ? "bg-success"
            : share >= 0.8
              ? "bg-warning"
              : "bg-danger"
        : share >= 0.9
          ? "bg-danger"
          : share >= 0.7
            ? "bg-warning"
            : "bg-primary";
    return (
        <span className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <span className={cn("block h-full rounded-full", tone)} style={{ width: `${share * 100}%` }} />
        </span>
    );
}

function Block({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
    return (
        <section className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">{title}</h3>
                {action ? <div className="ml-auto">{action}</div> : null}
            </div>
            {children}
        </section>
    );
}

function Table({
    head,
    rows,
    stickyLast = false
}: {
    head: readonly string[];
    rows: readonly (readonly ReactNode[])[];
    /** Keep the last column (an action) in view while the rest scrolls sideways. */
    stickyLast?: boolean;
}) {
    return (
        <div className="min-w-0 overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
                <thead className="bg-surface text-left text-xs text-muted-foreground">
                    <tr>
                        {head.map((label, index) => (
                            <th key={index} className="whitespace-nowrap px-3 py-2 font-medium">
                                {label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, index) => (
                        <tr key={index} className="border-t border-border">
                            {row.map((cell, column) => (
                                <td
                                    key={column}
                                    className={cn(
                                        "whitespace-nowrap px-3 py-1.5 tabular-nums",
                                        stickyLast && column === row.length - 1 && "sticky right-0 bg-background"
                                    )}
                                >
                                    {cell}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function ConfigView({ database, hosted }: { database: { id: string; name: string; engine: string }; hosted: boolean }) {
    const t = useTranslations("deployData");
    const [info, setInfo] = useState<actions.ConnectInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [revealed, setRevealed] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const { ask, dialog } = useConfirm();

    const load = useCallback(async () => {
        const result = await actions.databaseConnectInfoAction(database.id);
        if (result.info) setInfo(result.info);
        else setError(result.error ?? t("workspace.connect.unreadable"));
    }, [database.id]);
    const retry = () => {
        setError(null);
        void load();
    };

    useEffect(() => {
        void load();
    }, [load]);

    async function regenerate() {
        const dependents = await actions.passwordDependentsAction(database.id);
        if (dependents.error) {
            setError(dependents.error);
            return;
        }
        const services = dependents.services ?? [];
        ask({
            title: t("workspace.config.regenerateTitle"),
            danger: true,
            body: (
                <>
                    <span>{t("workspace.config.regenerateBody")}</span>
                    <span>
                        {services.length === 0
                            ? t("workspace.config.noDependents")
                            : t("workspace.config.dependents", {
                                  count: services.length,
                                  names: services.map((service) => service.name).join(", ")
                              })}
                    </span>
                </>
            ),
            label: t("workspace.config.regenerate"),
            run: async () => {
                const result = await actions.regeneratePasswordAction(database.id);
                if (!result.error) {
                    const restarted = result.restarted ?? [];
                    setNotice(
                        restarted.length === 0
                            ? t("workspace.config.regenerated")
                            : t("workspace.config.regeneratedRestarting", {
                                  count: restarted.length,
                                  names: restarted.map((service) => service.name).join(", ")
                              })
                    );
                    setRevealed(false);
                    await load();
                }
                return result;
            }
        });
    }

    const hidden = "•".repeat(16);
    const engineName = core.dbEngineLabel(database.engine);

    return (
        <div className="flex min-w-0 flex-col gap-6">
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <Block title={t("workspace.config.connection")}>
                {!info ? (
                    error ? (
                        <RetryButton onClick={retry} />
                    ) : (
                        <Skeleton className="h-24 w-full" />
                    )
                ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Labelled label={t("workspace.config.username")}>
                            <CopyRow value={info.connection.username || "-"} />
                        </Labelled>
                        <Labelled label={t("workspace.config.password")}>
                            <div className="flex items-center gap-1">
                                <div className="min-w-0 flex-1">
                                    <CopyRow value={revealed ? info.connection.password : hidden} copyValue={info.connection.password} />
                                </div>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    title={revealed ? t("workspace.connect.hide") : t("workspace.connect.show")}
                                    aria-label={revealed ? t("workspace.connect.hide") : t("workspace.connect.show")}
                                    onClick={() => setRevealed((value) => !value)}
                                >
                                    {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                                </Button>
                            </div>
                        </Labelled>
                        <Labelled label={t("workspace.config.database")}>
                            <CopyRow value={info.connection.database || "-"} />
                        </Labelled>
                        <Labelled label={t("workspace.config.engine")}>
                            <span className="py-1.5 text-sm">{engineName}</span>
                        </Labelled>
                    </div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                    <Button size="sm" variant="secondary" disabled={!info} onClick={() => void regenerate()}>
                        {t("workspace.config.regenerate")}
                    </Button>
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">{t("workspace.config.regenerateHint")}</span>
                </div>
                {notice ? (
                    <p role="status" className="text-sm text-success">
                        {notice}
                    </p>
                ) : null}
            </Block>

            {database.engine === "postgres" ? <ExtensionsBlock databaseId={database.id} hosted={hosted} ask={ask} /> : null}
            {dialog}
        </div>
    );
}

function RetryButton({ onClick }: { onClick: () => void }) {
    const t = useTranslations("deployData");
    return (
        <Button size="sm" variant="secondary" className="self-start" onClick={onClick}>
            <RefreshCw className="size-4" />
            {t("workspace.retry")}
        </Button>
    );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

function ExtensionsBlock({
    databaseId,
    hosted,
    ask
}: {
    databaseId: string;
    hosted: boolean;
    ask: ReturnType<typeof useConfirm>["ask"];
}) {
    const t = useTranslations("deployData");
    const [extensions, setExtensions] = useState<ExtensionView[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [find, setFind] = useState("");

    const load = useCallback(async () => {
        const result = await actions.listExtensionsAction(databaseId);
        if (result.extensions) setExtensions(result.extensions);
        else setError(result.error ?? t("workspace.config.extensionsUnreadable"));
    }, [databaseId]);

    useEffect(() => {
        void load();
    }, [load]);

    const needle = find.trim().toLowerCase();
    const matching = (extensions ?? []).filter(
        (entry) => !needle || entry.name.toLowerCase().includes(needle) || (entry.comment ?? "").toLowerCase().includes(needle)
    );
    const installed = matching.filter((entry) => entry.installedVersion);
    const available = matching.filter((entry) => !entry.installedVersion);

    function change(entry: ExtensionView, install: boolean) {
        const preload = entry.name === "pg_stat_statements";
        ask({
            title: install
                ? t("workspace.config.installTitle", { name: entry.name })
                : t("workspace.config.uninstallTitle", { name: entry.name }),
            body: install
                ? preload
                    ? t("workspace.config.installPreload")
                    : t("workspace.config.installBody")
                : t("workspace.config.uninstallBody"),
            label: install ? t("workspace.config.install") : t("workspace.config.uninstall"),
            danger: !install,
            run: () => actions.setExtensionAction(databaseId, { name: entry.name, installed: install }),
            done: () => void load()
        });
    }

    const row = (entry: ExtensionView, install: boolean) => (
        <li key={entry.name} className="flex items-start gap-3 border-t border-border px-3 py-2 first:border-t-0">
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-sm">{entry.name}</span>
                    <Badge>{entry.installedVersion ?? entry.defaultVersion ?? ""}</Badge>
                </div>
                {entry.comment ? <p className="text-xs text-muted-foreground">{entry.comment}</p> : null}
            </div>
            {entry.name === "plpgsql" ? null : (
                <Button size="sm" variant={install ? "secondary" : "ghost"} onClick={() => change(entry, install)}>
                    {install ? t("workspace.config.install") : t("workspace.config.uninstall")}
                </Button>
            )}
        </li>
    );

    return (
        <Block title={t("workspace.config.extensions")}>
            {hosted ? <p className="text-xs text-muted-foreground">{t("workspace.config.extensionsHosted")}</p> : null}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    className="pl-9"
                    value={find}
                    placeholder={t("workspace.config.findExtension")}
                    aria-label={t("workspace.config.findExtension")}
                    onChange={(event) => setFind(event.target.value)}
                />
            </div>
            {extensions === null ? (
                <Skeleton className="h-32 w-full" />
            ) : (
                <>
                    <span className="text-xs font-medium text-muted-foreground">
                        {t("workspace.config.installed", { count: installed.length })}
                    </span>
                    {installed.length > 0 ? (
                        <ul className="rounded-lg border border-border">{installed.map((entry) => row(entry, false))}</ul>
                    ) : null}
                    <span className="text-xs font-medium text-muted-foreground">
                        {t("workspace.config.available", { count: available.length })}
                    </span>
                    {available.length > 0 ? (
                        <ul className="max-h-96 overflow-y-auto overscroll-contain rounded-lg border border-border">
                            {available.map((entry) => row(entry, true))}
                        </ul>
                    ) : (
                        <p className="text-sm text-muted-foreground">{t("workspace.config.noneMatch")}</p>
                    )}
                </>
            )}
        </Block>
    );
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

/** The shell command a person types to reach this database with its own client. */
export function clientCommand(
    engine: string,
    target: { host: string; port: number; username: string; password: string; database: string },
    hosted: boolean
): string {
    const { host, port, username, password, database } = target;
    switch (engine) {
        case "postgres":
            return `PGPASSWORD=${password} psql -h ${host} -p ${port} -U ${username} -d ${database}`;
        case "mysql":
        case "mariadb":
            return `${engine === "mysql" ? "mysql" : "mariadb"} -h ${host} -P ${port} -u ${username} -p${password} ${database}`;
        case "redis":
            return `redis-cli -h ${host} -p ${port} -a ${password}`;
        case "mongo":
            return `mongosh "mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}?authSource=${hosted ? database : "admin"}"`;
        default:
            return "";
    }
}

function ConnectView({ database, hosted }: { database: { id: string; name: string; engine: string }; hosted: boolean }) {
    const t = useTranslations("deployData");
    const [network, setNetwork] = useState<"private" | "public">("private");
    const [info, setInfo] = useState<actions.ConnectInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [revealed, setRevealed] = useState(false);
    const [port, setPort] = useState("");
    const { ask, dialog } = useConfirm();

    const load = useCallback(async () => {
        const result = await actions.databaseConnectInfoAction(database.id);
        if (result.info) {
            setInfo(result.info);
            setError(null);
        } else setError(result.error ?? t("workspace.connect.unreadable"));
    }, [database.id]);

    useEffect(() => {
        void load();
    }, [load]);
    const retry = () => {
        setError(null);
        void load();
    };

    const portNumber = Number(port);
    const portValid = /^\d+$/.test(port) && core.isPublishablePort(portNumber);

    function publish(next: number | null) {
        ask({
            title: next === null ? t("workspace.connect.closeTitle") : t("workspace.connect.publishTitle", { port: next }),
            body: next === null ? t("workspace.connect.closeBody") : t("workspace.connect.publishBody"),
            label: next === null ? t("workspace.connect.close") : t("workspace.connect.publish"),
            danger: next === null,
            run: () => actions.setPublicPortAction(database.id, next),
            done: () => {
                setPort("");
                void load();
            }
        });
    }

    const connection = info?.connection;
    const reference = info ? `\${{${info.slug}.DATABASE_URL}}` : "";
    const publicTarget =
        connection && info?.publicHost && connection.exposedPort
            ? {
                  host: info.publicHost,
                  port: connection.exposedPort,
                  username: connection.username,
                  password: connection.password,
                  database: connection.database
              }
            : null;
    const mask = (text: string) => (connection?.password ? text.split(connection.password).join("********") : text);
    const publicUrl = publicTarget && connection ? connection.uri.replace(`@${connection.host}:${connection.port}`, `@${publicTarget.host}:${publicTarget.port}`).replace(`://${connection.host}:${connection.port}`, `://${publicTarget.host}:${publicTarget.port}`) : null;
    const command = publicTarget ? clientCommand(database.engine, publicTarget, hosted) : "";

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <SegmentedControl
                aria-label={t("workspace.connect.network")}
                size="sm"
                value={network}
                onValueChange={setNetwork}
                options={[
                    { value: "private" as const, label: t("workspace.connect.private") },
                    { value: "public" as const, label: t("workspace.connect.public") }
                ]}
            />
            {error ? <p className="text-sm text-danger">{error}</p> : null}
            {!connection || !info ? (
                error ? (
                    <RetryButton onClick={retry} />
                ) : (
                    <Skeleton className="h-40 w-full" />
                )
            ) : network === "private" ? (
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-muted-foreground">{t("workspace.connect.privateIntro")}</p>
                    <Labelled label={t("workspace.connect.reference")}>
                        <CopyRow value={reference} />
                    </Labelled>
                    <p className="text-xs text-muted-foreground">{t("workspace.connect.referenceHint", { name: info.slug })}</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Labelled label={t("workspace.connect.host")}>
                            <CopyRow value={connection.host} />
                        </Labelled>
                        <Labelled label={t("workspace.connect.port")}>
                            <CopyRow value={String(connection.port)} />
                        </Labelled>
                    </div>
                    <Labelled label={t("workspace.connect.url")}>
                        <CopyRow value={connection.uri} secret={!revealed} />
                    </Labelled>
                    <Button size="sm" variant="ghost" className="self-start" onClick={() => setRevealed((value) => !value)}>
                        {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        {revealed ? t("workspace.connect.hide") : t("workspace.connect.show")}
                    </Button>
                    <Block title={t("workspace.connect.variables")}>
                        <p className="text-xs text-muted-foreground">{t("workspace.connect.variablesHint")}</p>
                        <div className="flex flex-wrap gap-1.5">
                            {info.referenceKeys.map((key) => (
                                <ReferenceChip key={key} value={`\${{${info.slug}.${key}}}`} label={key} />
                            ))}
                        </div>
                    </Block>
                </div>
            ) : (
                <div className="flex flex-col gap-4">
                    {publicTarget && publicUrl ? (
                        <>
                            <p className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-ink">
                                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                                {t("workspace.connect.publicWarning")}
                            </p>
                            <Labelled label={t("workspace.connect.url")}>
                                <CopyRow value={revealed ? publicUrl : mask(publicUrl)} copyValue={publicUrl} />
                            </Labelled>
                            <Labelled label={t("workspace.connect.command")}>
                                <CopyRow value={revealed ? command : mask(command)} copyValue={command} />
                            </Labelled>
                            <div className="flex flex-wrap items-center gap-2">
                                <Button size="sm" variant="ghost" onClick={() => setRevealed((value) => !value)}>
                                    {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                                    {revealed ? t("workspace.connect.hide") : t("workspace.connect.show")}
                                </Button>
                                {!hosted ? (
                                    <Button size="sm" variant="ghost" className="ml-auto text-danger" onClick={() => publish(null)}>
                                        {t("workspace.connect.close")}
                                    </Button>
                                ) : null}
                            </div>
                        </>
                    ) : connection.exposedPort && !info.publicHost ? (
                        <p className="text-sm text-muted-foreground">{t("workspace.connect.noAddress", { port: connection.exposedPort })}</p>
                    ) : hosted ? (
                        <p className="text-sm text-muted-foreground">{t("workspace.connect.hostedPrivate")}</p>
                    ) : (
                        <div className="flex flex-col gap-3">
                            <p className="text-sm text-muted-foreground">{t("workspace.connect.notPublic")}</p>
                            <div className="flex flex-wrap items-start gap-2">
                                <div className="flex w-40 flex-col gap-1">
                                    <Input
                                        inputMode="numeric"
                                        value={port}
                                        placeholder={String(core.suggestedPublishPort(database.engine))}
                                        aria-label={t("workspace.connect.portLabel")}
                                        aria-invalid={Boolean(port) && !portValid}
                                        onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
                                    />
                                    {port && !portValid ? <span className="text-xs text-danger">{t("workspace.connect.portInvalid")}</span> : null}
                                </div>
                                <Button
                                    size="sm"
                                    aria-disabled={Boolean(port) && !portValid}
                                    onClick={() => {
                                        const chosen = port ? portNumber : core.suggestedPublishPort(database.engine);
                                        if (port && !portValid) return;
                                        publish(chosen);
                                    }}
                                >
                                    {t("workspace.connect.publish")}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            )}
            {dialog}
        </div>
    );
}

function ReferenceChip({ value, label }: { value: string; label: string }) {
    const t = useTranslations("deployData");
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            title={t("workspace.connect.copyReference", { reference: value })}
            onClick={() =>
                void navigator.clipboard?.writeText(value).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                })
            }
            className={cn(
                "rounded-md border border-border px-2 py-0.5 font-mono text-xs transition-colors hover:bg-muted",
                copied && "border-success text-success"
            )}
        >
            {label}
        </button>
    );
}
