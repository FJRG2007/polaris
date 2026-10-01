/**
 * The calendar's frame as the server draws it, before the browser has loaded
 * anything: the header, the sidebar's place and the grid's, with placeholders
 * only where data will go. The screen replaces it the moment it mounts - the
 * page hides this once an element marked `data-cal-ready` is beside it.
 *
 * No hooks and no state: drawn by the server, with its words handed in.
 */

import { cn } from "@polaris/ui";

export interface ShellWords {
    readonly today: string;
    readonly newEvent: string;
    readonly loading: string;
}

function Block({ className }: { className?: string }) {
    return <span aria-hidden className={cn("block animate-pulse rounded bg-muted", className)} />;
}

export function CalendarShell({ words }: { words: ShellWords }) {
    return (
        <div className="flex h-full min-h-0 flex-col" aria-busy="true" aria-label={words.loading}>
            <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
                <span className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-[0.8125rem] text-muted-foreground">
                    {words.today}
                </span>
                <Block className="h-5 w-40" />
                <span className="ml-auto inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-[0.8125rem] font-medium text-primary-foreground opacity-60">
                    {words.newEvent}
                </span>
            </div>
            <div className="flex min-h-0 flex-1">
                <div className="hidden w-64 shrink-0 flex-col gap-3 border-r border-border bg-surface p-3 lg:flex">
                    <Block className="h-40 w-full" />
                    <Block className="h-4 w-24" />
                    <Block className="h-4 w-full" />
                    <Block className="h-4 w-4/5" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-px bg-card p-3">
                    <Block className="h-6 w-full" />
                    <div className="grid flex-1 grid-cols-7 gap-px pt-2">
                        {Array.from({ length: 7 }, (_, index) => (
                            <Block key={index} className="h-full rounded-none opacity-50" />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
