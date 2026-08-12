"use client";

/**
 * The frame every Overview card is drawn in, and the small pieces they share.
 *
 * One frame rather than nine, so a card is a heading, a body and a way into the
 * screen behind it wherever it sits on the grid. The arrangement controls live
 * in the same header as the title: a grid you can rearrange has to say so where
 * the rearranging happens, not only behind a button at the top of the page.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, Skeleton, cn } from "@polaris/ui";

export function WidgetCard({
    title,
    icon: Icon,
    href,
    hint,
    grip,
    menu,
    children
}: {
    title: string;
    icon: LucideIcon;
    /** The screen this card is a window onto, when it is one. */
    href?: string | null;
    /** A figure or state worth reading in the heading itself. */
    hint?: ReactNode;
    /** The handle the card is dragged by, drawn at the very start of the header
     *  where a grid's handles are looked for. Faint until the card is hovered:
     *  it is an affordance, not information. */
    grip?: ReactNode;
    menu?: ReactNode;
    children: ReactNode;
}) {
    return (
        <Card className="group/card flex h-full min-w-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                {grip ? <span className="opacity-0 transition-opacity group-hover/card:opacity-100 focus-within:opacity-100 -ml-1.5">{grip}</span> : null}
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight" title={title}>{title}</h2>
                {hint}
                {href ? (
                    <Link
                        href={href}
                        title={`Open ${title}`}
                        aria-label={`Open ${title}`}
                        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <ArrowRight className="size-4" aria-hidden="true" />
                    </Link>
                ) : null}
                {menu}
            </div>
            <div className="min-w-0 flex-1 p-4">{children}</div>
        </Card>
    );
}

/** What a card says when there is nothing in it yet, with the one thing worth
 *  doing about it. */
export function WidgetEmpty({ children, action }: { children: ReactNode; action?: ReactNode }) {
    return (
        <div className="flex h-full min-h-24 flex-col items-center justify-center gap-2 text-center">
            <p className="text-xs text-muted-foreground">{children}</p>
            {action}
        </div>
    );
}

/** A card whose figures have not arrived. Shaped like rows rather than a spinner,
 *  so the grid does not move when they land. */
export function WidgetRowsSkeleton({ rows = 3 }: { rows?: number }) {
    return (
        <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
            {Array.from({ length: rows }, (_, index) => (
                <div key={index} className="flex items-center gap-3">
                    <Skeleton className="size-8 shrink-0 rounded-md" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <Skeleton className="h-3.5 w-2/5" />
                        <Skeleton className="h-3 w-3/5" />
                    </div>
                </div>
            ))}
        </div>
    );
}

/** A card whose source could not be read. Says so rather than showing an empty
 *  list, which would read as "nothing is deployed" when the truth is "nobody
 *  knows". */
export function WidgetUnavailable({ children }: { children: ReactNode }) {
    return <p className="py-6 text-center text-xs text-muted-foreground">{children}</p>;
}

const STATE_TONE = {
    up: "bg-success",
    down: "bg-danger",
    idle: "bg-muted-foreground"
} as const;

export function StateDot({ state, label }: { state: keyof typeof STATE_TONE; label: string }) {
    return <span className={cn("size-2 shrink-0 rounded-full", STATE_TONE[state])} title={label} aria-label={label} />;
}

/** One line of a list card: something, where it is, and somewhere to go. */
export function WidgetRow({
    href,
    icon,
    label,
    detail,
    trailing,
    action
}: {
    href: string;
    icon?: ReactNode;
    label: string;
    detail?: string | null;
    trailing?: ReactNode;
    /** An icon button drawn beside the row rather than inside the link, for the
     *  rows somebody can dismiss. */
    action?: ReactNode;
}) {
    return (
        <li className="group flex items-center gap-1">
            <Link
                href={href}
                className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
            >
                {icon}
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm" title={label}>{label}</span>
                    {detail ? <span className="truncate text-xs text-muted-foreground" title={detail}>{detail}</span> : null}
                </span>
                {trailing}
            </Link>
            {action}
        </li>
    );
}

export function WidgetList({ children }: { children: ReactNode }) {
    return <ul className="-mx-2 flex flex-col">{children}</ul>;
}
