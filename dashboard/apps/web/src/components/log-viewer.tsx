"use client";

/**
 * Shared log viewer: colorizes lines by severity (error/warn/info), lifts the
 * timestamp each line carries into a gutter of its own, groups multi-line entries
 * (stack traces, indented continuations) so each one copies as a whole on hover,
 * and exports the full stream to a file. Used by the Deploy service detail, the
 * deployment dialogs and the update log, so every log in Polaris reads the same.
 *
 * The timestamp is split off rather than left inline because it is the one part of
 * a log line nobody reads word by word - as a column it stays scannable and gets
 * out of the way of the message. Lines without one (plain application output) keep
 * the full width, so a stream that has no times never pays for a blank gutter.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy, Download, Search } from "lucide-react";
import { Button, Input, cn } from "@polaris/ui";
import { useDisplayFormat } from "./display-format";
import { useFollowBottom } from "@/lib/use-follow-bottom";
import { formatLogTime, parseLog, type LogEntry, type LogLevel } from "@/lib/log-lines";

const LEVEL_CLASS: Record<LogLevel, string> = {
    error: "text-red-400",
    warn: "text-amber-300",
    info: "text-sky-400",
    default: "text-zinc-300"
};

/** Cap on rendered log rows, so a very large stream stays responsive. */
const MAX_LOG_ROWS = 3000;

export function LogViewer({
    log,
    name = "deployment",
    header,
    searchable = false,
    autoScroll = true,
    emptyText = "Waiting for output...",
    className
}: {
    log: string;
    name?: string;
    header?: ReactNode;
    searchable?: boolean;
    autoScroll?: boolean;
    emptyText?: string;
    className?: string;
}) {
    const [search, setSearch] = useState("");
    const [copiedAll, setCopiedAll] = useState(false);
    // Follows the tail as new output streams in, matching a live console - and
    // leaves the view alone while it is being read further up.
    const follow = useFollowBottom<HTMLDivElement>(log, autoScroll);

    const entries = useMemo(() => (log ? parseLog(log) : []), [log]);
    const query = search.trim().toLowerCase();
    const matched = query ? entries.filter((entry) => entry.text.toLowerCase().includes(query)) : entries;
    // Logs are read tail-first, so cap the rendered rows to the most recent slice -
    // this keeps the DOM light on a huge stream without losing what matters.
    const filtered = matched.length > MAX_LOG_ROWS ? matched.slice(-MAX_LOG_ROWS) : matched;
    const hiddenCount = matched.length - filtered.length;
    // One gutter for the whole view, not per line: a stream where only some lines
    // are stamped still reads as one column.
    const hasTimes = filtered.some((entry) => entry.time !== null);

    function exportLog(): void {
        const blob = new Blob([log], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${name}-logs.log`;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    async function copyAll(): Promise<void> {
        try {
            await navigator.clipboard.writeText(log);
            setCopiedAll(true);
            setTimeout(() => setCopiedAll(false), 1500);
        } catch {
            // Clipboard unavailable (insecure context); the text is still selectable.
        }
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                {header}
                {searchable && (
                    <div className="relative min-w-0 flex-1">
                        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="Filter and search logs"
                            className="pl-8 font-mono text-xs"
                        />
                    </div>
                )}
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={copyAll}
                    disabled={!log}
                    className="ml-auto shrink-0"
                >
                    {copiedAll ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
                    {copiedAll ? "Copied" : "Copy all"}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={exportLog} disabled={!log} className="shrink-0">
                    <Download className="size-4" />
                    Export
                </Button>
            </div>

            <div
                ref={follow.ref}
                onScroll={follow.onScroll}
                className={cn("h-80 overflow-auto rounded-md bg-[#0b0e14] py-2 font-mono text-xs leading-relaxed", className)}
            >
                {filtered.length === 0 ? (
                    <p className="px-3 py-2 text-muted-foreground">{log ? "No matching lines." : emptyText}</p>
                ) : (
                    <>
                        {hiddenCount > 0 && (
                            <p className="px-3 py-1 text-[11px] text-zinc-500">
                                {hiddenCount.toLocaleString()} earlier lines hidden - showing the latest {MAX_LOG_ROWS.toLocaleString()}.
                            </p>
                        )}
                        {filtered.map((entry, index) => (
                            <LogRow key={index} entry={entry} gutter={hasTimes} />
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

function LogRow({ entry, gutter }: { entry: LogEntry; gutter: boolean }) {
    const [copied, setCopied] = useState(false);
    const format = useDisplayFormat();
    const time = entry.time ? formatLogTime(entry.time, format) : null;

    async function copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(time ? `${time} ${entry.text}` : entry.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard unavailable (insecure context); the text is still visible to select manually.
        }
    }

    return (
        <div className="group relative flex gap-2 px-3 pr-9 hover:bg-white/5">
            {gutter && (
                <span className="w-[4.25rem] shrink-0 select-none border-r border-white/10 pr-2 text-zinc-500 tabular-nums">
                    {time ?? ""}
                </span>
            )}
            <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", LEVEL_CLASS[entry.level])}>
                {entry.text || " "}
            </span>
            <button
                type="button"
                onClick={copy}
                aria-label="Copy log entry"
                className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 group-hover:block"
            >
                {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
            </button>
        </div>
    );
}
