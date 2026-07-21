"use client";

/**
 * Shared deployment log viewer: colorizes lines by severity (error/warn/info),
 * groups multi-line entries (stack traces, indented continuations) so each one
 * copies as a whole on hover, and exports the full stream to a file. Used by the
 * Deploy service detail and deployment dialogs so both render logs identically.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Download, Search } from "lucide-react";
import { Button, Input, cn } from "@polaris/ui";

type LogLevel = "error" | "warn" | "info" | "default";

interface LogEntry {
    text: string;
    level: LogLevel;
}

const LEVEL_RANK: Record<LogLevel, number> = { default: 0, info: 1, warn: 2, error: 3 };

const LEVEL_CLASS: Record<LogLevel, string> = {
    error: "text-red-400",
    warn: "text-amber-300",
    info: "text-sky-400",
    default: "text-zinc-300"
};

const ERROR_RE = /\b(error|errors|fatal|panic|exception|traceback|unhandled|failed|failure|denied|refused)\b/i;
const WARN_RE = /\b(warn|warning|warnings|deprecated|deprecation)\b/i;
const INFO_RE = /\b(info|notice|listening|started|ready|success|succeeded|completed?)\b/i;
// Lines that continue the previous entry rather than starting a new one:
// indented text, JS/Java stack frames, "Caused by" chains, and "..." truncations.
const CONTINUATION_RE = /^(\s+|at\s|\.{3}|caused by\b)/i;

/** Cap on rendered log rows, so a very large stream stays responsive. */
const MAX_LOG_ROWS = 3000;

function levelOf(line: string): LogLevel {
    if (ERROR_RE.test(line)) return "error";
    if (WARN_RE.test(line)) return "warn";
    if (INFO_RE.test(line)) return "info";
    return "default";
}

/** Split raw output into entries, folding continuation lines into the entry above. */
function parseLog(raw: string): LogEntry[] {
    const entries: LogEntry[] = [];
    for (const line of raw.split("\n")) {
        const last = entries[entries.length - 1];
        if (last && CONTINUATION_RE.test(line)) {
            last.text += `\n${line}`;
            if (LEVEL_RANK[levelOf(line)] > LEVEL_RANK[last.level]) last.level = levelOf(line);
        } else {
            entries.push({ text: line, level: levelOf(line) });
        }
    }
    return entries;
}

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
    const scrollRef = useRef<HTMLDivElement>(null);

    const entries = useMemo(() => (log ? parseLog(log) : []), [log]);
    const query = search.trim().toLowerCase();
    const matched = query ? entries.filter((entry) => entry.text.toLowerCase().includes(query)) : entries;
    // Logs are read tail-first, so cap the rendered rows to the most recent slice -
    // this keeps the DOM light on a huge stream without losing what matters.
    const filtered = matched.length > MAX_LOG_ROWS ? matched.slice(-MAX_LOG_ROWS) : matched;
    const hiddenCount = matched.length - filtered.length;

    // Follow the tail as new output streams in, matching a live console.
    useEffect(() => {
        const el = scrollRef.current;
        if (el && autoScroll) el.scrollTop = el.scrollHeight;
    }, [log, autoScroll]);

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
                ref={scrollRef}
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
                            <LogRow key={index} entry={entry} />
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

function LogRow({ entry }: { entry: LogEntry }) {
    const [copied, setCopied] = useState(false);

    async function copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(entry.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard unavailable (insecure context); the text is still visible to select manually.
        }
    }

    return (
        <div className={cn("group relative whitespace-pre-wrap px-3 pr-9 hover:bg-white/5", LEVEL_CLASS[entry.level])}>
            {entry.text || " "}
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
