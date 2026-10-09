/**
 * A list's frame as the server draws it, before the browser has loaded
 * anything: the title, the toolbar's place and the table's, with placeholders
 * only where rows will go. The screen replaces it the moment it mounts - the
 * page hides this once an element marked `data-crm-ready` is beside it.
 *
 * No hooks and no state: drawn by the server, with its words handed in.
 */

import { cn } from "@polaris/ui";

export interface ListShellWords {
    readonly title: string;
    readonly newRecord: string;
    readonly loading: string;
}

function Block({ className }: { className?: string }) {
    return <span aria-hidden className={cn("block animate-pulse rounded bg-muted", className)} />;
}

export function ListShell({ words }: { words: ListShellWords }) {
    return (
        <div
            className="flex h-full min-h-0 flex-col gap-3"
            aria-busy="true"
            aria-label={words.loading}
        >
            <div className="flex flex-wrap items-center gap-2">
                <h1 className="mr-auto text-[1.0625rem] font-semibold leading-tight tracking-tight">
                    {words.title}
                </h1>
                <Block className="h-8 w-56" />
                <span className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[0.8125rem] font-medium text-primary-foreground opacity-60">
                    {words.newRecord}
                </span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-px overflow-hidden rounded-lg border border-border bg-card">
                <div className="flex h-9 items-center gap-6 border-b border-border px-3">
                    <Block className="h-3 w-24" />
                    <Block className="h-3 w-20" />
                    <Block className="h-3 w-28" />
                </div>
                {Array.from({ length: 8 }, (_, index) => (
                    <div
                        key={index}
                        className="flex h-9 items-center gap-6 border-b border-border px-3"
                    >
                        <Block className="h-3 w-40" />
                        <Block className="h-3 w-24" />
                        <Block className="h-3 w-32" />
                    </div>
                ))}
            </div>
        </div>
    );
}
