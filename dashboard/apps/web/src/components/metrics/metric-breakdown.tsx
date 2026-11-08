"use client";

/**
 * The panel behind a metric card: what is using it, heaviest first.
 *
 * A chart says how much, and the next question is always of what - which used to
 * have no answer anywhere except by going to the Servers app, opening the right
 * tab and adding it up by eye. So every row here names a thing, says how much of
 * the metric it is, and opens where that thing lives: a service goes to Deploy, a
 * volume goes to its files in Drive, a container Polaris did not deploy goes to
 * the Containers screen. A name in a list that cannot be opened is the thing this
 * panel exists to stop being.
 *
 * The last row is usually the honest one. What a machine's disk is holding that
 * Polaris cannot name, and the traffic from containers it did not deploy, are
 * rows of their own rather than a gap in a list that would otherwise read as the
 * whole answer.
 *
 * Nothing in here fails loudly. A machine that is off, a window with too little
 * recorded in it and a metric with no parts are all answers, and each arrives as
 * a sentence in the reader's terms rather than as an error over an empty list.
 */

import Link from "next/link";
import { formatBytes } from "@polaris/core";
import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";

import { formatAge } from "@/app/(app)/apps/containers/freshness";
import { formatRate, percent } from "@/components/metrics-history";
import { DockerMark, GitHubMark } from "@/components/brand-icons";
import { restartApplicationAction } from "@/app/(app)/apps/deploy/actions";
import {
    Box,
    ChevronRight,
    CircleDashed,
    Cpu,
    HardDrive,
    Layers,
    MoreHorizontal,
    RotateCw,
    SearchX,
    Server
} from "lucide-react";
import { BREAKDOWN_GROUPS } from "@/lib/watch/breakdown-shape";
import type {
    Breakdown,
    BreakdownGroup,
    BreakdownMetric,
    BreakdownRow
} from "@/lib/watch/breakdown-shape";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Skeleton
} from "@polaris/ui";
import * as polls from "../shared-polls";

/** Which metric is open, over which window. Null while the dialog is shut. */
export interface OpenBreakdown {
    readonly metric: BreakdownMetric;
    readonly from: number;
    readonly to: number;
}

/**
 * How each metric's figures are written. What it is called - on the strip that
 * opens it and in the panel it opens - is one catalog entry per metric
 * (`breakdown.title.<metric>`), so the strip and the title cannot drift apart: a
 * card offering "where the room went" that opens a panel headed "Storage
 * breakdown" reads as two different features.
 */
export const BREAKDOWN_FORMAT: Record<BreakdownMetric, (value: number) => string> = {
    cpu: percent,
    mem: formatBytes,
    disk: formatBytes,
    net: formatRate
};

/** What a metric's breakdown is called, on its strip and in its title. */
export function breakdownTitle(t: NamespaceTranslator<"watch">, metric: BreakdownMetric): string {
    return t(`breakdown.title.${metric}`);
}

const ICONS = {
    container: Box,
    volume: HardDrive,
    store: Layers,
    process: Cpu,
    rest: MoreHorizontal
};

/** Past this, the figures are old enough that showing them without saying so
 *  would pass a minute-old reading off as this instant's. */
const STALE_AFTER_MS = 90_000;

export function MetricBreakdownDialog({
    subject,
    open,
    onClose
}: {
    subject: { kind: "server" | "service"; id: string };
    /** Held in the caller's state, so this object is stable between renders and
     *  the read below runs once per opening rather than once per render. */
    open: OpenBreakdown | null;
    onClose: () => void;
}) {
    const t = useTranslations("watch");
    const [result, setResult] = useState<Breakdown | null>(null);

    useEffect(() => {
        if (!open) return;
        let live = true;
        // Cleared rather than kept: the panel is about to answer a different
        // question, and last question's rows under this question's title is the
        // one thing worse than a skeleton.
        setResult(null);
        void polls.subjectBreakdown({ kind: subject.kind, id: subject.id, ...open }).then(
            (answer) => live && setResult(answer),
            () =>
                live &&
                setResult({
                    rows: [],
                    total: null,
                    note: "",
                    unavailable: t("text.breakdownFailed"),
                    at: null
                })
        );
        return () => {
            live = false;
        };
    }, [open, subject.kind, subject.id]);

    const format = open ? BREAKDOWN_FORMAT[open.metric] : null;
    const age = result?.at == null ? null : Date.now() - result.at;

    return (
        <Dialog open={open !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>{open ? breakdownTitle(t, open.metric) : ""}</DialogTitle>
                    <DialogDescription>
                        {result === null ? t("breakdown.working") : summarize(t, open, result)}
                    </DialogDescription>
                </DialogHeader>

                {result === null ? (
                    <div className="flex flex-col gap-2.5" aria-busy>
                        {[0, 1, 2, 3].map((row) => (
                            <Skeleton key={row} className="h-9 w-full" />
                        ))}
                    </div>
                ) : result.unavailable ? (
                    <EmptyState
                        bare
                        icon={<SearchX />}
                        title={t("breakdown.nothingToRank")}
                        description={result.unavailable}
                    />
                ) : result.rows.length === 0 ? (
                    <EmptyState
                        bare
                        icon={<SearchX />}
                        title={t("breakdown.nothingUsing")}
                        description={t("breakdown.allZero")}
                    />
                ) : (
                    <Rows rows={result.rows} total={result.total} format={format ?? formatBytes} />
                )}

                {result && (result.note || age !== null) ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                        {result.note}
                        {age !== null && age > STALE_AFTER_MS
                            ? ` ${t("breakdown.readAgo", { age: formatAge(age) })}`
                            : ""}
                    </p>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

/**
 * The line under the title: what the shares are shares of.
 *
 * CPU is the one that cannot say it as a figure. Its total is the whole machine
 * by definition, and "100% in total" is a sentence that tells nobody anything -
 * so it says what the percentages mean instead.
 */
function summarize(
    t: NamespaceTranslator<"watch">,
    open: OpenBreakdown | null,
    result: Breakdown
): string {
    if (!open || result.total === null) return t("breakdown.heaviestFirst");
    if (open.metric === "cpu") return t("breakdown.shareOfMachine");
    return t("breakdown.inTotal", { total: BREAKDOWN_FORMAT[open.metric](result.total) });
}

/** A row's share as a whole percentage: the parts are two readings taken
 *  moments apart, so a second decimal would be precision nobody measured. */
function shareText(share: number): string {
    const value = share * 100;
    if (value <= 0) return "0%";
    if (value < 1) return "<1%";
    return `${Math.round(value)}%`;
}

/**
 * The list, under whose it is when it knows: each owner a heading with its
 * subtotal, its rows beneath it heaviest first. The buttons above narrow it to
 * one owner. Totals are of the whole list.
 */
function Rows({
    rows,
    total,
    format
}: {
    rows: readonly BreakdownRow[];
    total: number | null;
    format: (value: number) => string;
}) {
    const t = useTranslations("watch");
    const [group, setGroup] = useState<BreakdownGroup | null>(null);
    const groups = BREAKDOWN_GROUPS.filter((name) => rows.some((row) => row.group === name));
    const sum = (name: BreakdownGroup) =>
        rows.reduce((subtotal, row) => subtotal + (row.group === name ? row.value : 0), 0);
    const grouped = groups.length > 1;
    const sections: { name: BreakdownGroup | null; rows: readonly BreakdownRow[] }[] = grouped
        ? (group ? [group] : groups).map((name) => ({
              name,
              rows: rows.filter((row) => row.group === name)
          }))
        : [{ name: null, rows }];
    return (
        <>
            {grouped ? (
                <div
                    role="group"
                    aria-label={t("breakdown.whose")}
                    className="flex flex-wrap gap-1"
                >
                    {groups.map((name) => (
                        <button
                            key={name}
                            type="button"
                            aria-pressed={group === name}
                            onClick={() => setGroup(group === name ? null : name)}
                            className={`flex items-baseline gap-1.5 rounded-md border px-2 py-1 text-xs ${
                                group === name
                                    ? "border-primary bg-muted text-foreground"
                                    : "border-border text-muted-foreground hover:bg-muted/60"
                            }`}
                        >
                            <span className="whitespace-nowrap">
                                {t(`breakdown.group.${name}`)}
                            </span>
                            <span className="whitespace-nowrap tabular-nums">
                                {format(sum(name))}
                            </span>
                        </button>
                    ))}
                </div>
            ) : null}
            <div className="flex max-h-[55vh] min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain">
                {sections.map((section) => (
                    <section key={section.name ?? "all"} className="min-w-0">
                        {/* A leftover alone under its heading (Free) would say the
                            same name and figure twice, so it stands on its own. */}
                        {section.name &&
                        !(section.rows.length === 1 && section.rows[0]?.kind === "rest") ? (
                            <h3 className="flex items-baseline gap-2 border-b border-border px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-foreground-subtle">
                                <span className="min-w-0 flex-1 truncate">
                                    {t(`breakdown.group.${section.name}`)}
                                </span>
                                <span className="shrink-0 tabular-nums">
                                    {format(sum(section.name))}
                                </span>
                                <span className="w-9 shrink-0 text-right tabular-nums">
                                    {total !== null && total > 0
                                        ? shareText(sum(section.name) / total)
                                        : ""}
                                </span>
                            </h3>
                        ) : null}
                        <ul className="flex min-w-0 flex-col">
                            {section.rows.map((row) => (
                                <Row key={row.key} row={row} format={format} />
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
        </>
    );
}

/** The Polaris star alone, the mark the shell draws beside its name. */
function PolarisGlyph({ className }: { className: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            className={`${className} text-primary`}
            fill="currentColor"
            aria-hidden
        >
            <path d="M12 2l1.9 6.6L20 10l-6.1 1.4L12 18l-1.9-6.6L4 10l6.1-1.4L12 2z" />
        </svg>
    );
}

/** What a row is drawn with: the service's own mark where Deploy draws one, and
 *  otherwise what kind of thing it is. */
function RowIcon({ row }: { row: BreakdownRow }) {
    const className = "mt-0.5 size-4 shrink-0 text-muted-foreground";
    if (row.service?.source === "image") return <DockerMark className={className} />;
    if (row.service?.source === "github") return <GitHubMark className={className} />;
    if (row.group === "polaris") return <PolarisGlyph className={className} />;
    if (row.group === "free") return <CircleDashed className={className} aria-hidden />;
    if (row.group === "machine" && row.kind === "rest")
        return <Server className={className} aria-hidden />;
    const Icon = ICONS[row.kind];
    return <Icon className={className} aria-hidden />;
}

function Row({ row, format }: { row: BreakdownRow; format: (value: number) => string }) {
    const t = useTranslations("watch");
    // The leftover is not a thing anybody can go and look at, so it is drawn as
    // the background it is rather than competing with the rows that are.
    const rest = row.kind === "rest";
    // Said only when it is not already the name: two services of one project are
    // told apart by it, and a container nobody deployed is already called by it.
    const container = row.container && row.container !== row.label ? row.container : null;
    const second = [row.detail, row.image ? t("breakdown.image", { image: row.image }) : null]
        .filter(Boolean)
        .join(" - ");
    const locked = row.service && !row.href ? t("breakdown.noAccess") : null;
    const body = (
        <>
            <RowIcon row={row} />
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-baseline gap-2">
                    <span
                        className="min-w-0 flex-1 truncate text-sm font-medium"
                        title={row.label}
                    >
                        {row.label}
                    </span>
                    <span className="shrink-0 tabular-nums text-sm">{format(row.value)}</span>
                    <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {row.share === null ? "" : shareText(row.share)}
                    </span>
                </div>
                {second || container || row.limit ? (
                    <div className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
                        {second ? (
                            <span className="min-w-0 truncate" title={second}>
                                {second}
                            </span>
                        ) : null}
                        {container ? (
                            <span
                                className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground-subtle"
                                title={container}
                            >
                                {container}
                            </span>
                        ) : (
                            <span className="flex-1" />
                        )}
                        {row.limit ? (
                            <span className="shrink-0 whitespace-nowrap tabular-nums">
                                {t("breakdown.limit", { limit: format(row.limit) })}
                            </span>
                        ) : null}
                    </div>
                ) : null}
                {locked ? (
                    <p className="truncate text-xs text-foreground-subtle" title={locked}>
                        {locked}
                    </p>
                ) : null}
                {row.share === null ? null : (
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border" aria-hidden>
                        <div
                            className={`h-full rounded-full ${rest ? "bg-muted-foreground/40" : "bg-primary/70"}`}
                            // A hair wide at minimum: a row worth listing is worth
                            // seeing, and a share under a pixel draws as nothing.
                            style={{ width: `${Math.max(1, row.share * 100)}%` }}
                        />
                    </div>
                )}
            </div>
            {row.href ? (
                <ChevronRight
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                />
            ) : null}
        </>
    );
    return (
        <li className="flex min-w-0 items-start gap-1 border-b border-border/40 last:border-0">
            {row.href ? (
                <Link
                    href={row.href}
                    className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1 py-2 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    {body}
                </Link>
            ) : (
                <div className="flex min-w-0 flex-1 items-start gap-2 px-1 py-2">{body}</div>
            )}
            {row.service?.canRestart ? (
                <RestartService id={row.service.id} name={row.label} />
            ) : null}
        </li>
    );
}

/**
 * Restarting a service from the row that shows what it is holding. Two presses,
 * because it drops whatever the service is doing: the first asks, in place, and
 * the second does it - no second dialog on top of this one.
 */
function RestartService({ id, name }: { id: string; name: string }) {
    const t = useTranslations("watch");
    const [state, setState] = useState<"idle" | "asking" | "working" | "done" | "failed">(
        "idle"
    );
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (state !== "asking" && state !== "done") return;
        // A question left on screen is one somebody answers by accident later.
        const timer = window.setTimeout(() => setState("idle"), state === "asking" ? 6000 : 4000);
        return () => window.clearTimeout(timer);
    }, [state]);
    const run = async () => {
        setState("working");
        setError(null);
        const result = await restartApplicationAction(id).catch(() => null);
        setError(result?.error ?? null);
        setState(!result || result.error ? "failed" : "done");
    };
    const ask = (
        <Button
            size="icon-xs"
            variant="ghost"
            className="mt-1.5 shrink-0"
            aria-label={t("breakdown.restart", { name })}
            title={t("breakdown.restart", { name })}
            onClick={() => setState("asking")}
        >
            <RotateCw aria-hidden />
        </Button>
    );
    if (state === "asking") {
        return (
            <div className="flex shrink-0 items-center gap-1 py-1.5">
                <Button size="xs" variant="danger" onClick={() => void run()}>
                    {t("breakdown.confirmRestart")}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setState("idle")}>
                    {t("breakdown.cancelRestart")}
                </Button>
            </div>
        );
    }
    if (state !== "idle") {
        const text =
            state === "working"
                ? t("breakdown.restarting")
                : state === "done"
                  ? t("breakdown.restarted")
                  : (error ?? t("breakdown.restartFailed"));
        return (
            <div className="flex min-w-0 max-w-[40%] shrink-0 items-start gap-1">
                <span
                    role="status"
                    className={`min-w-0 truncate py-2 text-xs ${state === "failed" ? "text-danger" : "text-muted-foreground"}`}
                    title={text}
                >
                    {text}
                </span>
                {state === "failed" ? ask : null}
            </div>
        );
    }
    return ask;
}
