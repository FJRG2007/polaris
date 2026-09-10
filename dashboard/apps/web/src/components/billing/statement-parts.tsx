"use client";

/**
 * The pieces a monthly statement is drawn with, shared by the instance's Billing
 * screen and an organization's.
 *
 * **The month lives in the URL**, as the audit feed's narrowing does: a statement
 * for August is a link somebody can hand on, and the back button goes back a
 * month. The picker is drawn from the same retention rule the server answers
 * with, so it paints before anything has been fetched.
 *
 * **Only the figures wait.** The picker, the export menu and the headings are on
 * screen at once; the tiles and the table show their own skeletons until the
 * statement arrives, and a revisit paints the last one kept while it is re-read.
 *
 * Money is written in the currency the prices were set in, never the reader's
 * own - a statement in euros converted to dollars on the way to the screen would
 * be a number nobody agreed to.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { ROLLUP_RETENTION_MS } from "@/lib/metrics-shared";
import { useCallback, useMemo, type ReactNode } from "react";
import type { StatementView } from "@/lib/billing/statement";
import { useDisplayFormat } from "@/components/display-format";
import { useLiveResource } from "@/components/use-live-resource";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Cpu, Download, HardDrive, MemoryStick, Network, Wallet } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Select,
    Skeleton
} from "@polaris/ui";

/** What a statement read answers with: the statement, and whatever the screen it
 *  is for adds - the budgets beside each organization, or this one's own. */
export interface BillingResponse extends StatementView {
    readonly budgets?: Readonly<Record<string, number>>;
    readonly budget?: { readonly amount: number; readonly currency: core.CurrencyCode } | null;
}

/** A running month is re-read on this cadence; the figures behind it are folded
 *  by the hour and sampled by the minute, so anything faster redraws the same. */
const CURRENT_MONTH_POLL_MS = 5 * 60_000;

/**
 * The statement for the month in the URL, read and kept.
 *
 * A month that has ended does not change, so it is read once; the running one is
 * polled. The key carries the month, so switching months paints the one already
 * kept for it instead of the previous month's figures.
 */
export function useStatement(endpoint: string, cacheKey: string) {
    const params = useSearchParams();
    const months = useMemo(() => core.billingMonthsOffered(new Date(), ROLLUP_RETENTION_MS), []);
    const requested = params.get("month") ?? "";
    const month = months.includes(requested)
        ? requested
        : (months[0] ?? core.billingMonthOf(new Date()));
    const resource = useLiveResource<BillingResponse>({
        url: `${endpoint}?month=${encodeURIComponent(month)}`,
        cacheKey: `${cacheKey}:${month}`,
        intervalMs: month === months[0] ? CURRENT_MONTH_POLL_MS : 24 * 3_600_000,
        select: (body) => body as BillingResponse
    });
    return { ...resource, month, months };
}

/** Move the statement to another month, keeping the rest of the URL. */
export function useMonthNavigation(): (month: string) => void {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    return useCallback(
        (month: string) => {
            const next = new URLSearchParams(params);
            next.set("month", month);
            router.replace(`${pathname}?${next.toString()}`, { scroll: false });
        },
        [router, pathname, params]
    );
}

/** The display formatters with money in the statement's own currency. */
export function useStatementFormat(
    currency: core.CurrencyCode | null | undefined
): core.DisplayFormat {
    const display = useDisplayFormat();
    return useMemo(
        () => (currency ? core.createDisplayFormat({ ...display.preferences, currency }) : display),
        [display, currency]
    );
}

/** A quantity at a precision that suits its size: hundredths while it is small,
 *  whole numbers with grouping once it is not. */
export function quantity(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "0";
    if (value < 10) return value.toFixed(2);
    if (value < 1000) return value.toFixed(1);
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A month as the picker reads it, with the running one marked as so far. */
function monthOption(month: string, current: boolean): { value: string; label: string } {
    const label = core.billingMonthLabel(month);
    return { value: month, label: current ? `${label} (so far)` : label };
}

/** The month picker and the export menu, the toolbar every statement has. */
export function StatementToolbar({
    month,
    months,
    exportEndpoint,
    children
}: {
    month: string;
    months: readonly string[];
    exportEndpoint: string;
    children?: ReactNode;
}) {
    const go = useMonthNavigation();
    const exportHref = (format: core.AuditExportFormat) =>
        `${exportEndpoint}?${new URLSearchParams({ month, format }).toString()}`;
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Select
                aria-label="Month"
                className="w-52"
                value={month}
                onValueChange={go}
                options={months.map((entry, index) => monthOption(entry, index === 0))}
            />
            <div className="ml-auto flex items-center gap-1">
                {children}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Export the statement"
                            title="Export"
                        >
                            <Download className="size-4" aria-hidden />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                            <a href={exportHref("csv")} download>
                                Export as CSV
                            </a>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                            <a href={exportHref("json")} download>
                                Export as JSON
                            </a>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </div>
    );
}

/** One figure: what was used, and what it cost when there is a price for it. */
function Tile({
    icon,
    label,
    value,
    unit,
    cost,
    loading
}: {
    icon: ReactNode;
    label: string;
    value: string;
    unit: string;
    cost: string | null;
    loading: boolean;
}) {
    return (
        <div className="border-border flex min-w-0 flex-col gap-1 rounded-lg border p-3">
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                {icon}
                {label}
            </span>
            {loading ? (
                <Skeleton className="h-7 w-24" />
            ) : (
                <span className="truncate text-xl font-semibold tabular-nums">
                    {value}{" "}
                    <span className="text-muted-foreground text-xs font-normal">{unit}</span>
                </span>
            )}
            {loading ? (
                <Skeleton className="h-4 w-16" />
            ) : (
                <span className="text-muted-foreground text-xs tabular-nums">
                    {cost ?? "Not priced"}
                </span>
            )}
        </div>
    );
}

/** The month's totals, one tile per thing measured and one for the money. */
export function StatementTotals({ view }: { view: BillingResponse | null }) {
    const statement = view?.statement ?? null;
    const format = useStatementFormat(statement?.rates?.currency);
    const loading = statement === null;
    const usage = statement?.usage ?? core.EMPTY_USAGE;
    const cost = statement?.cost ?? null;
    const hours = statement ? core.hoursInMonth(statement.month) || 1 : 1;
    const priced = (value: number | null | undefined) =>
        value === null || value === undefined ? null : format.currency(value);

    return (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Tile
                icon={<Cpu className="size-3.5" aria-hidden />}
                label="CPU"
                value={quantity(usage.cpuHours)}
                unit="vCPU-h"
                cost={priced(cost?.cpu)}
                loading={loading}
            />
            <Tile
                icon={<MemoryStick className="size-3.5" aria-hidden />}
                label="Memory"
                value={quantity(usage.memoryGbHours)}
                unit="GB-h"
                cost={priced(cost?.memory)}
                loading={loading}
            />
            <Tile
                icon={<HardDrive className="size-3.5" aria-hidden />}
                label="Storage"
                value={quantity(usage.storageGbHours / hours)}
                unit="GB-month"
                cost={priced(cost?.storage)}
                loading={loading}
            />
            <Tile
                icon={<Network className="size-3.5" aria-hidden />}
                label="Network out"
                value={quantity(usage.egressGb)}
                unit="GB"
                cost={priced(cost?.egress)}
                loading={loading}
            />
            <div className="border-border col-span-2 flex min-w-0 flex-col gap-1 rounded-lg border p-3 lg:col-span-1">
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <Wallet className="size-3.5" aria-hidden />
                    Total
                </span>
                {loading ? (
                    <Skeleton className="h-7 w-28" />
                ) : (
                    <span className="truncate text-xl font-semibold tabular-nums">
                        {cost ? format.currency(cost.total) : "-"}
                    </span>
                )}
                <span className="text-muted-foreground text-xs">
                    {loading
                        ? ""
                        : cost
                          ? view?.current
                              ? "So far this month"
                              : "For the month"
                          : "No prices set"}
                </span>
            </div>
        </div>
    );
}

/** What the reader has to know about how complete the figures are. */
export function StatementNotes({ view }: { view: BillingResponse | null }) {
    const display = useDisplayFormat();
    if (!view) return null;
    const notes: string[] = [];
    if (view.current)
        notes.push(
            `Figures run to ${display.dateTime(view.through)} and fill in as the month goes on.`
        );
    if (view.keptFrom) {
        notes.push(
            `Usage before ${display.date(view.keptFrom)} is no longer kept, so this month starts there.`
        );
    }
    if (view.statement.usage.cpuUnmeasuredHours > 0) {
        notes.push(
            "Some CPU is not counted: a server has not reported how many cores it has yet. It is counted from the next reading on."
        );
    }
    notes.push("Months run on UTC. A service that was deleted took its usage with it.");
    return (
        <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
            {notes.map((note) => (
                <li key={note}>{note}</li>
            ))}
        </ul>
    );
}

/** Where an owner's name leads: an organization's own statement, or a person's
 *  profile. */
export function ownerHref(owner: core.BillingOwner): string | null {
    if (!owner.handle) return null;
    return owner.kind === "org"
        ? `/account/organizations/${encodeURIComponent(owner.handle)}/billing`
        : `/u/${encodeURIComponent(owner.handle)}`;
}

/** The skeleton rows a table shows while the statement is on its way. */
function LoadingRows({ columns }: { columns: number }) {
    return (
        <>
            {[0, 1, 2].map((row) => (
                <tr key={row} className="border-border/40 border-b last:border-0">
                    {Array.from({ length: columns }, (_, cell) => (
                        <td key={cell} className="px-2 py-2.5">
                            <Skeleton className="h-4 w-full" />
                        </td>
                    ))}
                </tr>
            ))}
        </>
    );
}

/**
 * A line per project, heaviest first.
 *
 * The project opens the project. The owner column is for the instance's
 * statement, where lines from many owners sit together; an organization's own
 * statement has one owner and leaves it out.
 */
export function StatementTable({
    view,
    showOwner,
    emptyLabel
}: {
    view: BillingResponse | null;
    showOwner: boolean;
    emptyLabel: string;
}) {
    const statement = view?.statement ?? null;
    const format = useStatementFormat(statement?.rates?.currency);
    const hours = statement ? core.hoursInMonth(statement.month) || 1 : 1;
    const columns = showOwner ? 7 : 6;

    return (
        <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
                <thead>
                    <tr className="border-border/60 border-b text-left">
                        <th className="w-full max-w-0 px-2 py-1.5">Project</th>
                        {showOwner ? <th className="px-2 py-1.5">Owner</th> : null}
                        <th className="px-2 py-1.5 text-right">CPU</th>
                        <th className="px-2 py-1.5 text-right">Memory</th>
                        <th className="px-2 py-1.5 text-right">Storage</th>
                        <th className="px-2 py-1.5 text-right">Network out</th>
                        <th className="px-2 py-1.5 text-right">Cost</th>
                    </tr>
                </thead>
                <tbody>
                    {statement === null ? <LoadingRows columns={columns} /> : null}
                    {statement?.lines.map((line) => {
                        const href = ownerHref(line.owner);
                        return (
                            <tr
                                key={line.projectId}
                                className="border-border/40 border-b last:border-0"
                            >
                                <td className="w-full max-w-0 px-2 py-2">
                                    <Link
                                        href={`/apps/deploy/${line.projectId}`}
                                        className="hover:text-foreground block truncate font-medium"
                                        title={line.projectName}
                                    >
                                        {line.projectName}
                                    </Link>
                                </td>
                                {showOwner ? (
                                    <td className="text-muted-foreground max-w-[12rem] truncate px-2 py-2">
                                        {href ? (
                                            <Link
                                                href={href}
                                                className="hover:text-foreground"
                                                title={line.owner.name}
                                            >
                                                {line.owner.name}
                                            </Link>
                                        ) : (
                                            line.owner.name
                                        )}
                                    </td>
                                ) : null}
                                <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                                    {quantity(line.usage.cpuHours)} vCPU-h
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                                    {quantity(line.usage.memoryGbHours)} GB-h
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                                    {quantity(line.usage.storageGbHours / hours)} GB-mo
                                </td>
                                <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                                    {quantity(line.usage.egressGb)} GB
                                </td>
                                <td className="px-2 py-2 text-right font-medium tabular-nums whitespace-nowrap">
                                    {line.cost ? format.currency(line.cost.total) : "-"}
                                </td>
                            </tr>
                        );
                    })}
                    {statement !== null && statement.lines.length === 0 ? (
                        <tr>
                            <td
                                colSpan={columns}
                                className="text-muted-foreground px-2 py-8 text-center"
                            >
                                {emptyLabel}
                            </td>
                        </tr>
                    ) : null}
                </tbody>
            </table>
        </div>
    );
}
