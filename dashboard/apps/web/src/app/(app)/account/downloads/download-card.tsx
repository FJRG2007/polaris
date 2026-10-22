/**
 * The pieces every card on the downloads screen is made of: the card itself,
 * with its title, one line on what the thing does and a picture of it at the
 * bottom, and the rows inside it - a mark, a name, and the one thing to press.
 *
 * Plain markup with no state, so the server page and the client cards draw them
 * alike. Each card carries a faint wash of its own colour, which is identity,
 * not status, and so is drawn from the palette rather than the status tokens.
 */

import { cn } from "@polaris/ui";
import type { ReactNode } from "react";

/** The colour each card is washed with, from its top edge down. */
export type CardTint = "violet" | "sky" | "amber" | "emerald" | "rose" | "slate";

const TINTS: Readonly<Record<CardTint, string>> = {
    violet: "from-violet-500/[0.08]",
    sky: "from-sky-500/[0.08]",
    amber: "from-amber-500/[0.08]",
    emerald: "from-emerald-500/[0.08]",
    rose: "from-rose-500/[0.08]",
    slate: "from-slate-500/[0.08]"
};

export function DownloadCard({
    id,
    title,
    description,
    icon,
    tint,
    preview,
    side,
    className,
    children
}: {
    /** The anchor other screens link to. */
    id?: string;
    title: string;
    description: ReactNode;
    icon?: ReactNode;
    tint: CardTint;
    /** The picture at the bottom of the card; decoration, hidden from readers. */
    preview?: ReactNode;
    /** A picture beside the content instead of under it, from `lg` up: the wide card at the top. */
    side?: ReactNode;
    className?: string;
    children?: ReactNode;
}) {
    const content = (
        <>
            <div className="relative flex min-w-0 flex-col gap-1 px-5 pt-5">
                <h2 className="flex min-w-0 items-center gap-2 text-[0.9375rem] font-semibold tracking-tight">
                    {icon}
                    <span className="min-w-0 truncate" title={title}>
                        {title}
                    </span>
                </h2>
                <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <div className="relative flex min-w-0 flex-1 flex-col gap-4 px-5 pb-5 pt-4 text-sm">
                {children}
            </div>
        </>
    );
    return (
        <section
            id={id}
            aria-label={title}
            className={cn(
                "relative flex min-w-0 scroll-mt-4 flex-col overflow-hidden rounded-xl border border-border bg-card",
                className
            )}
        >
            <div
                aria-hidden
                className={cn(
                    "pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b to-transparent",
                    TINTS[tint]
                )}
            />
            {side ? (
                <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
                    <div className="flex min-w-0 flex-col lg:w-2/5 lg:shrink-0">{content}</div>
                    <div
                        aria-hidden
                        className="relative h-48 min-w-0 overflow-hidden lg:h-auto lg:min-h-60 lg:flex-1"
                    >
                        <div className="absolute inset-x-5 bottom-0 top-1 lg:top-6">{side}</div>
                    </div>
                </div>
            ) : (
                content
            )}
            {preview ? (
                <div aria-hidden className="relative mt-auto h-40 overflow-hidden px-5 pt-1">
                    {preview}
                </div>
            ) : null}
        </section>
    );
}

/** A list of rows, a hairline between each. */
export function DownloadRows({ children, label }: { children: ReactNode; label?: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            {label ? <p className="text-xs font-medium text-muted-foreground">{label}</p> : null}
            <ul className="flex min-w-0 flex-col divide-y divide-border/60 border-y border-border/60">
                {children}
            </ul>
        </div>
    );
}

/** One way to have it: its mark, its name, and what to press. */
export function DownloadRow({
    mark,
    name,
    detail,
    action,
    tile = true,
    children
}: {
    mark: ReactNode;
    /** Whether the mark is set on a tile here; false when it brings its own. */
    tile?: boolean;
    name: string;
    detail?: string;
    action?: ReactNode;
    /** Anything that belongs under the row, such as a line to copy. */
    children?: ReactNode;
}) {
    return (
        <li className="flex min-w-0 flex-col gap-2 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
                {tile ? (
                    <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-background">
                        {mark}
                    </span>
                ) : (
                    mark
                )}
                <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" title={name}>
                        {name}
                    </p>
                    {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
                </div>
                {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
            </div>
            {children}
        </li>
    );
}
