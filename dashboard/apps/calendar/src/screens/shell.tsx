/**
 * The calendar's frame as the server draws it, before the browser has loaded
 * anything: the header, the sidebar's place and the grid's, with placeholders
 * only where data will go. The screen replaces it the moment it mounts - the
 * page hides this once an element marked `data-cal-ready` is beside it.
 *
 * No hooks and no state: drawn by the server, with its words handed in.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { AlarmClock, ChevronDown, Plus, Settings } from "lucide-react";

export interface ShellWords {
    readonly today: string;
    readonly newEvent: string;
    readonly loading: string;
    /** The static chrome, drawn as itself rather than as a placeholder: none of
     *  it waits for data, so a pulsing block there read as "still loading". */
    readonly add: string;
    readonly time: string;
    readonly settings: string;
}

const ICON_LINK =
    "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground [&_svg]:size-4";

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
                <Link
                    href="/calendar/time"
                    aria-label={words.time}
                    title={words.time}
                    className={ICON_LINK}
                >
                    <AlarmClock aria-hidden />
                </Link>
                <Link
                    href="/calendar/settings"
                    aria-label={words.settings}
                    title={words.settings}
                    className={ICON_LINK}
                >
                    <Settings aria-hidden />
                </Link>
            </div>
            <div className="flex min-h-0 flex-1">
                <div className="hidden w-64 shrink-0 flex-col gap-3 border-r border-border bg-surface p-3 lg:flex">
                    <Block className="h-40 w-full" />
                    {/* Opens a menu once the screen is up; until then it is
                        drawn where it will be, not as a block. */}
                    <span className="inline-flex h-8 w-full items-center gap-2 rounded-md border border-border px-3 text-[0.8125rem] [&_svg]:size-4">
                        <Plus aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{words.add}</span>
                        <ChevronDown aria-hidden className="text-foreground-subtle" />
                    </span>
                    <Link
                        href="/calendar/time"
                        className="-mt-2 inline-flex h-8 w-full items-center gap-2 rounded-md px-3 text-[0.8125rem] hover:bg-card-hover [&_svg]:size-4"
                    >
                        <AlarmClock aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{words.time}</span>
                    </Link>
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
