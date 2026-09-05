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
import { subjectBreakdownAction } from "./actions";
import { formatAge } from "@/app/(app)/apps/containers/freshness";
import { formatRate, percent } from "@/components/metrics-history";
import { Box, HardDrive, Layers, MoreHorizontal, SearchX } from "lucide-react";
import type { Breakdown, BreakdownMetric, BreakdownRow } from "@/lib/watch/breakdown-shape";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Skeleton
} from "@polaris/ui";

/** Which metric is open, over which window. Null while the dialog is shut. */
export interface OpenBreakdown {
    readonly metric: BreakdownMetric;
    readonly from: number;
    readonly to: number;
}

/**
 * What each metric is called on the strip that opens it and in the panel it
 * opens, and how its figures are written.
 *
 * One entry per metric so the strip and the title cannot drift apart: a card
 * offering "where the room went" that opens a panel headed "Storage breakdown"
 * reads as two different features.
 */
export const BREAKDOWN_LABELS: Record<
    BreakdownMetric,
    { strip: string; title: string; format: (value: number) => string }
> = {
    cpu: { strip: "What is using the CPU", title: "What is using the CPU", format: percent },
    mem: { strip: "What is holding the memory", title: "What is holding the memory", format: formatBytes },
    disk: { strip: "Where the room went", title: "Where the room went", format: formatBytes },
    net: { strip: "What is sending", title: "What is sending", format: formatRate }
};

const ICONS = { container: Box, volume: HardDrive, store: Layers, rest: MoreHorizontal };

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
    const [result, setResult] = useState<Breakdown | null>(null);

    useEffect(() => {
        if (!open) return;
        let live = true;
        // Cleared rather than kept: the panel is about to answer a different
        // question, and last question's rows under this question's title is the
        // one thing worse than a skeleton.
        setResult(null);
        void subjectBreakdownAction({ kind: subject.kind, id: subject.id, ...open }).then(
            (answer) => {
                if (live) setResult(answer);
            }
        );
        return () => {
            live = false;
        };
    }, [open, subject.kind, subject.id]);

    const words = open ? BREAKDOWN_LABELS[open.metric] : null;
    const age = result?.at == null ? null : Date.now() - result.at;

    return (
        <Dialog open={open !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>{words?.title ?? ""}</DialogTitle>
                    <DialogDescription>
                        {result === null ? "Working out what is behind this figure" : summarize(open, result)}
                    </DialogDescription>
                </DialogHeader>

                {result === null ? (
                    <div className="flex flex-col gap-2.5" aria-busy>
                        {[0, 1, 2, 3].map((row) => (
                            <Skeleton key={row} className="h-9 w-full" />
                        ))}
                    </div>
                ) : result.unavailable ? (
                    <EmptyState bare icon={<SearchX />} title="Nothing to rank" description={result.unavailable} />
                ) : result.rows.length === 0 ? (
                    <EmptyState
                        bare
                        icon={<SearchX />}
                        title="Nothing is using it"
                        description="Everything measured here is at zero."
                    />
                ) : (
                    <ul className="flex flex-col">
                        {result.rows.map((row) => (
                            <Row key={row.key} row={row} format={words?.format ?? formatBytes} />
                        ))}
                    </ul>
                )}

                {result && (result.note || age !== null) ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                        {result.note}
                        {age !== null && age > STALE_AFTER_MS ? ` Read ${formatAge(age)} ago.` : ""}
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
function summarize(open: OpenBreakdown | null, result: Breakdown): string {
    if (!open || result.total === null) return "Heaviest first.";
    if (open.metric === "cpu") return "Share of the whole machine, heaviest first.";
    return `${BREAKDOWN_LABELS[open.metric].format(result.total)} in total, heaviest first.`;
}

function Row({ row, format }: { row: BreakdownRow; format: (value: number) => string }) {
    const Icon = ICONS[row.kind];
    // The leftover is not a thing anybody can go and look at, so it is drawn as
    // the background it is rather than competing with the rows that are.
    const rest = row.kind === "rest";
    return (
        <li className="flex items-start gap-2 border-b border-border/40 py-2 last:border-0">
            <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                    <span className="w-full max-w-0 flex-1 truncate text-sm" title={row.label}>
                        {row.href ? (
                            <Link href={row.href} className="hover:underline">
                                {row.label}
                            </Link>
                        ) : (
                            row.label
                        )}
                    </span>
                    <span className="shrink-0 tabular-nums text-sm">{format(row.value)}</span>
                    <span className="w-11 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {row.share === null ? "" : percent(row.share * 100)}
                    </span>
                </div>
                {row.detail ? (
                    <p className="truncate text-xs text-muted-foreground" title={row.detail}>
                        {row.detail}
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
        </li>
    );
}
