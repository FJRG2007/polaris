"use client";

/**
 * The card a monitored thing gets: what it is, whether it is reporting, its
 * current load, and the shape of the last hour behind it.
 *
 * The sparkline is deliberately small and unlabelled. A card's job is to make
 * the one that is misbehaving obvious at a glance across a grid of them; the
 * numbers, axes and ranges belong on the detail screen the card opens.
 */

import Link from "next/link";
import { cn, Skeleton } from "@polaris/ui";
import { Bell, Container, Rocket, Server } from "lucide-react";
import type { WatchCard, WatchSubjectKind } from "@/lib/watch-overview-service";

const KIND_ICON: Record<WatchSubjectKind, typeof Server> = {
    server: Server,
    service: Rocket,
    container: Container
};

function formatBytes(bytes: number | null): string {
    if (bytes == null) return "-";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Tone by load rather than by state: a card that is up but pinned at 98% is the
 *  one worth looking at, and it should not read the same as an idle one. */
function loadTone(cpu: number | null): string {
    if (cpu == null) return "text-muted-foreground";
    if (cpu >= 90) return "text-danger";
    if (cpu >= 70) return "text-warning";
    return "text-foreground";
}

/**
 * A filled area over the card's own width. Drawn as a normalized path so the
 * shape survives any card size, with gaps in the data breaking the line rather
 * than being interpolated across - a flat line through an outage is a lie.
 */
function Sparkline({ points, tone }: { points: { t: number; v: number | null }[]; tone: string }) {
    const values = points.map((point) => point.v);
    const present = values.filter((value): value is number => value != null);
    if (present.length < 2) {
        return (
            <div className="flex h-10 items-center justify-center rounded bg-muted/30 text-[10px] text-muted-foreground">
                Not enough history yet
            </div>
        );
    }

    const max = Math.max(10, ...present);
    const step = 100 / Math.max(1, points.length - 1);
    // One path per unbroken run, so a gap is a gap.
    const runs: string[] = [];
    let current: string[] = [];
    points.forEach((point, index) => {
        if (point.v == null) {
            if (current.length > 1) runs.push(current.join(" "));
            current = [];
            return;
        }
        const x = index * step;
        const y = 100 - (point.v / max) * 100;
        current.push(`${current.length === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
    });
    if (current.length > 1) runs.push(current.join(" "));

    return (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-10 w-full" aria-hidden="true">
            {runs.map((path, index) => (
                <path
                    key={index}
                    d={path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={tone}
                />
            ))}
        </svg>
    );
}

/** The grid's own shape, drawn while the cards are still on their way. Sized like
 *  a real card so the section does not jump when they land. */
export function WatchCardGridSkeleton({ count = 6 }: { count?: number }) {
    return (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: count }, (_, index) => (
                <div
                    key={index}
                    className="flex flex-col gap-3 rounded-xl border border-border/60 bg-surface/60 p-4"
                    aria-hidden="true"
                >
                    <div className="flex items-center gap-2.5">
                        <Skeleton className="size-7 rounded-md" />
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <Skeleton className="h-4 w-2/5" />
                            <Skeleton className="h-3 w-3/5" />
                        </div>
                    </div>
                    <Skeleton className="h-10 w-full rounded" />
                    <div className="flex items-end justify-between gap-2">
                        <div className="flex flex-col gap-1.5">
                            <Skeleton className="h-5 w-16" />
                            <Skeleton className="h-3 w-24" />
                        </div>
                        <Skeleton className="h-3 w-20" />
                    </div>
                </div>
            ))}
        </div>
    );
}

export function WatchCardGrid({ cards, empty }: { cards: WatchCard[]; empty: string }) {
    if (cards.length === 0) {
        return (
            <div className="rounded-lg border border-border/60 px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">{empty}</p>
            </div>
        );
    }
    return (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
                <WatchSubjectCard key={card.id} card={card} />
            ))}
        </div>
    );
}

function WatchSubjectCard({ card }: { card: WatchCard }) {
    const Icon = KIND_ICON[card.kind];
    const dot = card.state === "up" ? "bg-success" : card.state === "down" ? "bg-danger" : "bg-muted-foreground";
    const memShare =
        card.memUsedBytes != null && card.memTotalBytes ? (card.memUsedBytes / card.memTotalBytes) * 100 : null;

    return (
        <Link
            href={card.href}
            className="group flex flex-col gap-3 rounded-xl border border-border/60 bg-surface/60 p-4 transition-[border-color,box-shadow] hover:border-border hover:shadow-md hover:shadow-black/15"
        >
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                    <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-surface text-foreground transition-colors group-hover:border-primary/40">
                        <Icon className="size-3.5" />
                    </span>
                    <div className="min-w-0">
                        <p className="truncate text-sm font-medium group-hover:text-primary">{card.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{card.detail}</p>
                    </div>
                </div>
                {card.alarms > 0 && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
                        <Bell className="size-3" /> {card.alarms}
                    </span>
                )}
            </div>

            <Sparkline points={card.spark} tone={loadTone(card.cpuPercent)} />

            <div className="flex items-end justify-between gap-2">
                <div className="min-w-0">
                    <p className={cn("text-lg font-medium tabular-nums", loadTone(card.cpuPercent))}>
                        {card.cpuPercent == null ? "-" : `${card.cpuPercent}%`}
                        <span className="ml-1 text-xs font-normal text-muted-foreground">CPU</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                        {formatBytes(card.memUsedBytes)}
                        {card.memTotalBytes ? ` / ${formatBytes(card.memTotalBytes)}` : ""}
                        {memShare != null ? ` (${Math.round(memShare)}%)` : ""}
                    </p>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={cn("size-1.5 rounded-full", dot)} />
                    {card.stateLabel}
                </span>
            </div>
        </Link>
    );
}
