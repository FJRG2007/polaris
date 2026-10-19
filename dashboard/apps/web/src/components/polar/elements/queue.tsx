"use client";

/**
 * Queue: messages typed while a turn was running, waiting their turn - edited,
 * reordered or removed in place.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/queue.tsx at ca8be60), Apache-2.0 - see the LICENSE
 * beside this file. Changed: Tailwind 3 and Polaris tokens, a plain list
 * instead of the collapsible scroll area, and editable items, because Polar's
 * queue is the user's own words rather than a plan's steps.
 */

import { cn } from "@polaris/ui";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { MessageAction } from "@/components/polar/elements/message";

export function Queue({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("rounded-lg border border-border bg-card p-2", className)} {...props} />;
}

export function QueueSection({ label, children }: { label: string; children: ReactNode }) {
    return (
        <section aria-label={label} className="space-y-1">
            <p className="px-1 text-xs text-foreground-subtle">{label}</p>
            <ol className="space-y-1">{children}</ol>
        </section>
    );
}

export function QueueItem({
    value,
    labels,
    first,
    last,
    onChange,
    onCommit,
    onUp,
    onDown,
    onRemove
}: {
    value: string;
    labels: { edit: string; up: string; down: string; remove: string };
    first: boolean;
    last: boolean;
    onChange: (value: string) => void;
    onCommit: () => void;
    onUp: () => void;
    onDown: () => void;
    onRemove: () => void;
}) {
    return (
        <li className="flex min-w-0 items-center gap-0.5">
            <input
                aria-label={labels.edit}
                value={value}
                maxLength={20000}
                onChange={(event) => onChange(event.target.value)}
                onBlur={onCommit}
                className="h-7 min-w-0 flex-1 rounded border border-border bg-field px-2 text-sm text-foreground"
            />
            <MessageAction label={labels.up} disabled={first} onClick={onUp}>
                <ArrowUp />
            </MessageAction>
            <MessageAction label={labels.down} disabled={last} onClick={onDown}>
                <ArrowDown />
            </MessageAction>
            <MessageAction label={labels.remove} onClick={onRemove}>
                <X />
            </MessageAction>
        </li>
    );
}
