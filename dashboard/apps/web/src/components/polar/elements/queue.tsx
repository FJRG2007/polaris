"use client";

/**
 * Queue: messages typed while a turn was running, waiting their turn - edited,
 * reordered, sent now or removed.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/queue.tsx at ca8be60), Apache-2.0 - see the LICENSE
 * beside this file. Changed: Tailwind 3 and Polaris tokens, a plain list
 * instead of the collapsible scroll area, and items that read as the message
 * typed (clamped, line breaks kept) with their actions in one "..." menu, because
 * Polar's queue is the user's own words rather than a plan's steps.
 */

import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@polaris/ui";
import { ArrowDown, ArrowUp, MoreHorizontal, Pencil, Send, X } from "lucide-react";
import { useState, type HTMLAttributes, type ReactNode } from "react";

export function Queue({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("px-1", className)} {...props} />;
}

export function QueueSection({ label, children }: { label: string; children: ReactNode }) {
    return (
        <section aria-label={label} className="space-y-1">
            <p className="px-1 text-xs text-foreground-subtle">{label}</p>
            <ol className="space-y-1">{children}</ol>
        </section>
    );
}

export interface QueueItemLabels {
    menu: string;
    sendNow: string;
    edit: string;
    up: string;
    down: string;
    remove: string;
    save: string;
    cancel: string;
    /** "+N files", already counted. */
    files: string | null;
}

export function QueueItem({
    value,
    labels,
    first,
    last,
    disabled = false,
    onSave,
    onSendNow,
    onUp,
    onDown,
    onRemove
}: {
    value: string;
    labels: QueueItemLabels;
    first: boolean;
    last: boolean;
    /** While a change is on its way: the menu waits for it. */
    disabled?: boolean;
    onSave: (value: string) => void;
    /** Null where nobody may send it ahead of the turn. */
    onSendNow: (() => void) | null;
    onUp: () => void;
    onDown: () => void;
    onRemove: () => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    if (draft !== null) {
        // Saving the words it already has is no change, so it closes instead.
        const save = () => {
            if (draft.trim() !== value.trim()) onSave(draft);
            setDraft(null);
        };
        return (
            <li className="space-y-1 rounded-md bg-card px-2 py-1.5">
                <textarea
                    aria-label={labels.edit}
                    value={draft}
                    autoFocus
                    rows={Math.min(6, Math.max(2, draft.split("\n").length))}
                    maxLength={20000}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") setDraft(null);
                        if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            save();
                        }
                    }}
                    className="w-full resize-none rounded border border-border bg-field px-2 py-1 text-sm text-foreground"
                />
                <div className="flex justify-end gap-2 text-xs">
                    <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setDraft(null)}>
                        {labels.cancel}
                    </button>
                    <button
                        type="button"
                        className="font-medium text-foreground disabled:opacity-50"
                        disabled={disabled || draft.trim() === value.trim()}
                        onClick={save}
                    >
                        {labels.save}
                    </button>
                </div>
            </li>
        );
    }
    return (
        <li className="flex min-w-0 items-start gap-2 rounded-md bg-card px-2 py-1.5">
            <div className="min-w-0 flex-1">
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground" title={value}>
                    {value}
                </p>
                {labels.files ? <p className="text-xs text-foreground-subtle">{labels.files}</p> : null}
            </div>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={labels.menu}
                        title={labels.menu}
                        disabled={disabled}
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground disabled:opacity-50 [@media(pointer:coarse)]:size-11"
                    >
                        <MoreHorizontal className="size-4" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                    {onSendNow ? (
                        <DropdownMenuItem onSelect={onSendNow}>
                            <Send />
                            {labels.sendNow}
                        </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem onSelect={() => setDraft(value)}>
                        <Pencil />
                        {labels.edit}
                    </DropdownMenuItem>
                    {first ? null : (
                        <DropdownMenuItem onSelect={onUp}>
                            <ArrowUp />
                            {labels.up}
                        </DropdownMenuItem>
                    )}
                    {last ? null : (
                        <DropdownMenuItem onSelect={onDown}>
                            <ArrowDown />
                            {labels.down}
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={onRemove}>
                        <X />
                        {labels.remove}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </li>
    );
}
