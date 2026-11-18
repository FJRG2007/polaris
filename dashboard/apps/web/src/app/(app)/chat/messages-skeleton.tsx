"use client";

/**
 * What a conversation looks like while it is read: the rows of `message-list`
 * at their own sizes - the 28px face in its 32px gutter, the name and the time
 * on one line, follow-ups under it without a face, a day divider - so the page
 * that arrives lands where the skeleton was instead of jumping. Bars of one
 * width stacked on each other read as a broken page, not as messages.
 *
 * The shapes are fixed rather than random, so a reload draws the same thing
 * and nothing shifts between a server and a client render.
 */

import { Skeleton, cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** One author's turn: how wide each line is, and whether it carries a picture. */
interface Turn {
    name: string;
    lines: readonly string[];
    picture?: boolean;
}

const TURNS: readonly Turn[] = [
    { name: "w-24", lines: ["w-3/5", "w-2/5"] },
    { name: "w-20", lines: ["w-4/5"] },
    { name: "w-28", lines: ["w-1/2", "w-3/4", "w-1/3"] },
    { name: "w-16", lines: ["w-2/5"], picture: true },
    { name: "w-24", lines: ["w-2/3", "w-1/4"] }
];

/** Where the day divider sits among the turns. */
const DIVIDER_AFTER = 1;

export function MessagesSkeleton({ turns = TURNS.length, className }: { turns?: number; className?: string }) {
    const t = useTranslations("chat");
    const shown = TURNS.slice(-Math.max(1, Math.min(turns, TURNS.length)));
    return (
        <div role="status" aria-busy="true" className={cn("flex flex-col justify-end pb-2", className)}>
            <span className="sr-only">{t("channelView.loadingMessages")}</span>
            {shown.map((turn, index) => (
                <div key={index} aria-hidden="true">
                    {index === DIVIDER_AFTER && shown.length > 2 ? (
                        <div className="flex items-center gap-3 px-4 pt-4">
                            <span className="h-px flex-1 bg-border" />
                            <Skeleton className="h-3 w-16 rounded-full" />
                            <span className="h-px flex-1 bg-border" />
                        </div>
                    ) : null}
                    <div className="flex gap-2 px-4 pb-0.5 pt-3">
                        <span className="flex w-8 shrink-0 justify-center">
                            <Skeleton className="size-7 rounded-full" />
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <div className="flex items-center gap-2">
                                <Skeleton className={cn("h-3.5", turn.name)} />
                                <Skeleton className="h-2.5 w-10 opacity-60" />
                            </div>
                            {turn.lines.map((width, line) => (
                                <Skeleton key={line} className={cn("h-3.5 max-w-xl", width)} />
                            ))}
                            {turn.picture ? <Skeleton className="mt-1 aspect-video w-full max-w-64 rounded-lg" /> : null}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}

/** The bar over a conversation while it is read: its face, name and line. */
export function ChannelHeaderSkeleton() {
    return (
        <div className="flex h-header shrink-0 items-center gap-2.5 border-b border-border px-4" aria-hidden="true">
            <Skeleton className="size-6 rounded-full" />
            <div className="flex min-w-0 flex-col gap-1">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-2.5 w-24 opacity-60" />
            </div>
            <span className="flex-1" />
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
        </div>
    );
}

/** Where the composer will be, at its height, so the list does not jump. */
export function ComposerSkeleton() {
    return (
        <div className="shrink-0 px-4 pb-4 pt-2" aria-hidden="true">
            <div className="flex h-11 items-center gap-2 rounded-lg border border-border bg-card px-3">
                <Skeleton className="size-5 rounded-md" />
                <Skeleton className="h-3 w-48 opacity-60" />
                <span className="flex-1" />
                <Skeleton className="size-5 rounded-md" />
            </div>
        </div>
    );
}

/** A whole conversation while it is read: header, messages and composer. */
export function ConversationSkeleton() {
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <ChannelHeaderSkeleton />
            <MessagesSkeleton className="min-h-0 flex-1 overflow-hidden" />
            <ComposerSkeleton />
        </div>
    );
}
