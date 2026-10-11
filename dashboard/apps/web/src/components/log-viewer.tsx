"use client";

/**
 * Shared log viewer: colorizes lines by severity (error/warn/info), lifts the
 * timestamp each line carries into a gutter of its own, groups multi-line entries
 * (stack traces, indented continuations) so each one copies as a whole on hover,
 * and exports the full stream to a file. Used by the Deploy service detail, the
 * deployment dialogs, the update log and the game server console, so every log in
 * Polaris reads the same.
 *
 * A reader narrows it three ways: by level (errors, warnings, info - several at
 * once), by text (highlighted, stepped through with next and previous), and by
 * folding repeats - a server that logs the same line every few seconds would
 * otherwise bury everything else. The level and folding choices are kept per
 * viewer.
 *
 * The timestamp is split off rather than left inline because it is the one part of
 * a log line nobody reads word by word - as a column it stays scannable and gets
 * out of the way of the message. Lines without one (plain application output) keep
 * the full width, so a stream that has no times never pays for a blank gutter.
 */

import { z } from "zod";
import { Button, Input, cn } from "@polaris/ui";
import { useDisplayFormat } from "./display-format";
import { useFollowBottom } from "@/lib/use-follow-bottom";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    Check,
    ChevronDown,
    ChevronUp,
    Copy,
    Download,
    ListCollapse,
    ListFilter,
    Search
} from "lucide-react";
import * as logLines from "@/lib/log-lines";

const LEVEL_CLASS: Record<logLines.LogLevel, string> = {
    error: "text-danger",
    warn: "text-warning",
    info: "text-sky-400",
    default: "text-zinc-300"
};

const CHIP_DOT: Record<logLines.LogBucket, string> = {
    error: "bg-danger",
    warn: "bg-warning",
    info: "bg-sky-400"
};

/** Cap on rendered log rows, so a very large stream stays responsive. */
const MAX_LOG_ROWS = 3000;

/** How near the top counts as having scrolled back to the start of what is loaded. */
const NEAR_START = 64;

const STORAGE_PREFIX = "polaris.logViewer.";

/** What a viewer remembers between visits. Read back from the browser, so it is
 *  checked before use - an old or hand-edited entry falls back to the defaults. */
const viewSchema = z.object({
    levels: z.array(z.enum(["error", "warn", "info"])).min(1),
    collapse: z.boolean(),
    onlyMatches: z.boolean()
});

type ViewOptions = z.infer<typeof viewSchema>;

const DEFAULT_VIEW: ViewOptions = {
    levels: [...logLines.LOG_BUCKETS],
    collapse: true,
    onlyMatches: true
};

function readView(key: string): ViewOptions {
    try {
        const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
        if (!raw) return DEFAULT_VIEW;
        const parsed = viewSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : DEFAULT_VIEW;
    } catch {
        return DEFAULT_VIEW;
    }
}

function writeView(key: string, view: ViewOptions): void {
    try {
        window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(view));
    } catch {
        // Storage unavailable (private window, quota); the choice lasts this visit.
    }
}

const CHIP_CLASS =
    "inline-flex h-7 items-center gap-1.5 rounded border px-2 text-xs transition-colors";
const CHIP_ON = "border-border bg-muted text-foreground";
const CHIP_OFF = "border-dashed border-border text-muted-foreground hover:text-foreground";

export function LogViewer({
    log,
    name = "deployment",
    storageKey,
    header,
    searchable = false,
    autoScroll = true,
    emptyText,
    className,
    withDates = false,
    onReachStart,
    startSlot
}: {
    log: string;
    name?: string;
    /** Where this viewer's level and folding choices are remembered; defaults to `name`. */
    storageKey?: string;
    header?: ReactNode;
    searchable?: boolean;
    autoScroll?: boolean;
    emptyText?: string;
    className?: string;
    /** The gutter carries the date as well as the time - for a log that spans days. */
    withDates?: boolean;
    /** Called when the reader scrolls back to the top, for a log that loads older
     *  lines on demand. Lines it prepends keep the reader where they were. */
    onReachStart?: () => void;
    /** Shown above the first line, inside the scrolling region. */
    startSlot?: ReactNode;
}) {
    const t = useTranslations("components");
    const [search, setSearch] = useState("");
    const [copiedAll, setCopiedAll] = useState(false);
    const [view, setView] = useState<ViewOptions>(DEFAULT_VIEW);
    const [current, setCurrent] = useState<number | null>(null);
    const viewKey = storageKey ?? name;
    const loaded = useRef<string | null>(null);

    // Read after mount, not during render, so the server-rendered markup and the
    // first client render agree.
    useEffect(() => {
        setView(readView(viewKey));
        loaded.current = viewKey;
    }, [viewKey]);

    function updateView(next: Partial<ViewOptions>): void {
        const merged = { ...view, ...next };
        setView(merged);
        if (loaded.current === viewKey) writeView(viewKey, merged);
    }

    function toggleLevel(level: logLines.LogBucket): void {
        const levels = view.levels.includes(level)
            ? view.levels.filter((item) => item !== level)
            : logLines.LOG_BUCKETS.filter((item) => item === level || view.levels.includes(item));
        // Switching the last level off would show nothing at all; it means "all" instead.
        updateView({ levels: levels.length > 0 ? levels : [...logLines.LOG_BUCKETS] });
    }

    const entries = useMemo(() => (log ? logLines.parseLog(log) : []), [log]);
    const counts = useMemo(() => logLines.countBuckets(entries), [entries]);
    const levelKey = view.levels.join(",");
    const leveled = useMemo(() => {
        const allowed = new Set(levelKey.split(","));
        if (allowed.size === logLines.LOG_BUCKETS.length) return entries;
        return entries.filter((entry) => allowed.has(logLines.bucketOf(entry.level)));
    }, [entries, levelKey]);
    const folded = useMemo(
        () => (view.collapse ? logLines.foldRepeats(leveled) : logLines.unfoldedRows(leveled)),
        [leveled, view.collapse]
    );

    const query = searchable ? search.trim().toLowerCase() : "";
    // enigma:allow-substring-search - a log filter is grep, not a search box.
    // What is typed here is a container name, a status code, a path or a word
    // that appears in the output verbatim, and the reader is looking for the
    // lines that contain exactly that. Fuzzy matching would answer with lines
    // that nearly say it, which in a log is a wrong answer that reads like a
    // right one - and it would rank a stream whose only meaningful order is
    // time.
    // Each kept row notes whether it is the first of its repeat block still
    // shown, so the count stays visible when the block's first line is filtered out.
    const matched = useMemo(() => {
        const filter = Boolean(query && view.onlyMatches);
        const result: Array<{ row: logLines.LogRow; lead: boolean }> = [];
        let lastBlock = -1;
        folded.forEach((row, index) => {
            if (filter && !row.entry.text.toLowerCase().includes(query)) return;
            const block = index - row.offset;
            result.push({ row, lead: block !== lastBlock });
            lastBlock = block;
        });
        return result;
    }, [folded, query, view.onlyMatches]);
    // Logs are read tail-first, so cap the rendered rows to the most recent slice -
    // this keeps the DOM light on a huge stream without losing what matters.
    const shown = useMemo(
        () => (matched.length > MAX_LOG_ROWS ? matched.slice(-MAX_LOG_ROWS) : matched),
        [matched]
    );
    const hiddenCount = matched.length - shown.length;
    // The rows the search hits, in order - what next and previous step through.
    // Numbered from the start of `matched`, so a row keeps its number as the
    // tail streams in and the oldest rows drop off the top.
    const hits = useMemo(() => {
        if (!query) return [];
        const result: number[] = [];
        shown.forEach(({ row }, index) => {
            if (row.entry.text.toLowerCase().includes(query)) result.push(hiddenCount + index);
        });
        return result;
    }, [shown, query, hiddenCount]);
    // One gutter for the whole view, not per line: a stream where only some lines
    // are stamped still reads as one column.
    const hasTimes = useMemo(() => shown.some(({ row }) => row.entry.time !== null), [shown]);

    // Follows the tail as new output streams in, matching a live console - and
    // leaves the view alone while it is being read further up. Keyed on the rows
    // shown, so a filter that changes them keeps a following reader on the tail.
    const follow = useFollowBottom<HTMLDivElement>(shown, autoScroll);
    const previous = useRef<{ height: number; first: string; last: string } | null>(null);

    // Older lines arriving above the reader push everything down by their own
    // height; moving the scroll position by that much is what keeps the line
    // being read under the reader's eye instead of somewhere below it.
    useLayoutEffect(() => {
        const element = follow.ref.current;
        if (!element) return;
        const first = log.slice(0, 120);
        const last = log.slice(-120);
        const before = previous.current;
        if (onReachStart && before && before.last === last && before.first !== first) {
            element.scrollTop += element.scrollHeight - before.height;
            setCurrent(null);
        }
        previous.current = { height: element.scrollHeight, first, last };
    }, [log, onReachStart, follow]);

    useEffect(() => setCurrent(null), [query, levelKey, view.collapse, view.onlyMatches]);

    const position = current !== null ? hits.indexOf(current) : -1;
    const active = position >= 0 ? position : null;

    function step(direction: 1 | -1): void {
        if (hits.length === 0) return;
        let next = direction === 1 ? 0 : hits.length - 1;
        if (active !== null) next = (active + direction + hits.length) % hits.length;
        setCurrent(hits[next] ?? null);
        // Moving the view away from the tail is what stops it following, which is
        // what the reader wants while stepping through matches.
        const row = follow.ref.current?.querySelector(`[data-row="${hits[next]}"]`);
        row?.scrollIntoView?.({ block: "center" });
    }

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
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
                {header}
                {searchable && (
                    <div className="flex min-w-[12rem] flex-1 items-center gap-1">
                        <div className="relative min-w-0 flex-1">
                            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key !== "Enter") return;
                                    event.preventDefault();
                                    step(event.shiftKey ? -1 : 1);
                                }}
                                placeholder={t("logViewer.search")}
                                aria-label={t("logViewer.search")}
                                className="pl-8 font-mono text-xs"
                            />
                        </div>
                        {query && (
                            <>
                                <span
                                    className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground"
                                    aria-live="polite"
                                >
                                    {active !== null
                                        ? t("logViewer.matchPosition", {
                                              current: active + 1,
                                              total: hits.length
                                          })
                                        : t("logViewer.matchCount", { total: hits.length })}
                                </span>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => step(-1)}
                                    disabled={hits.length === 0}
                                    aria-label={t("logViewer.previousMatch")}
                                    title={t("logViewer.previousMatch")}
                                >
                                    <ChevronUp />
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => step(1)}
                                    disabled={hits.length === 0}
                                    aria-label={t("logViewer.nextMatch")}
                                    title={t("logViewer.nextMatch")}
                                >
                                    <ChevronDown />
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => updateView({ onlyMatches: !view.onlyMatches })}
                                    aria-pressed={view.onlyMatches}
                                    aria-label={t("logViewer.onlyMatches")}
                                    title={t("logViewer.onlyMatches")}
                                    className={cn(view.onlyMatches && "bg-muted text-foreground")}
                                >
                                    <ListFilter />
                                </Button>
                            </>
                        )}
                    </div>
                )}
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={copyAll}
                        disabled={!log}
                    >
                        {copiedAll ? (
                            <Check className="size-4 text-success" />
                        ) : (
                            <Copy className="size-4" />
                        )}
                        {copiedAll ? t("logViewer.copied") : t("logViewer.copyAll")}
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={exportLog}
                        disabled={!log}
                    >
                        <Download className="size-4" />
                        {t("logViewer.export")}
                    </Button>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
                <div
                    className="flex flex-wrap items-center gap-1.5"
                    role="group"
                    aria-label={t("logViewer.levels")}
                >
                    {logLines.LOG_BUCKETS.map((level) => {
                        const on = view.levels.includes(level);
                        return (
                            <button
                                key={level}
                                type="button"
                                onClick={() => toggleLevel(level)}
                                aria-pressed={on}
                                className={cn(CHIP_CLASS, on ? CHIP_ON : CHIP_OFF)}
                            >
                                <span
                                    className={cn(
                                        "size-2 rounded-full",
                                        CHIP_DOT[level],
                                        !on && "opacity-40"
                                    )}
                                />
                                {t(`logViewer.level.${level}`)}
                                <span className="tabular-nums text-muted-foreground">
                                    {t("logViewer.levelCount", { count: counts[level] })}
                                </span>
                            </button>
                        );
                    })}
                </div>
                <button
                    type="button"
                    onClick={() => updateView({ collapse: !view.collapse })}
                    aria-pressed={view.collapse}
                    title={t("logViewer.collapseHint")}
                    className={cn(CHIP_CLASS, "ml-auto", view.collapse ? CHIP_ON : CHIP_OFF)}
                >
                    <ListCollapse className="size-3.5" />
                    {t("logViewer.collapse")}
                </button>
            </div>

            <div
                ref={follow.ref}
                onScroll={() => {
                    follow.onScroll();
                    const element = follow.ref.current;
                    if (onReachStart && element && element.scrollTop < NEAR_START) onReachStart();
                }}
                className={cn(
                    "h-80 overflow-auto overscroll-contain rounded-md bg-[#0b0e14] py-2 font-mono text-xs leading-relaxed",
                    className
                )}
            >
                {startSlot}
                {shown.length === 0 ? (
                    <p className="px-3 py-2 text-muted-foreground">
                        {log ? t("logViewer.noMatch") : (emptyText ?? t("logViewer.waiting"))}
                    </p>
                ) : (
                    <>
                        {hiddenCount > 0 && (
                            <p className="px-3 py-1 text-[0.6875rem] text-zinc-500">
                                {t("logViewer.hidden", {
                                    hidden: hiddenCount,
                                    shown: MAX_LOG_ROWS
                                })}
                            </p>
                        )}
                        {shown.map(({ row, lead }, index) => (
                            <LogRow
                                key={hiddenCount + index}
                                index={hiddenCount + index}
                                text={row.entry.text}
                                level={row.entry.level}
                                time={row.entry.time}
                                repeat={row.repeat}
                                span={row.span}
                                badge={lead && row.repeat > 1}
                                query={query}
                                active={hiddenCount + index === current}
                                gutter={hasTimes}
                                withDates={withDates}
                            />
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

/** The text with every occurrence of the search marked. */
function Highlighted({ text, query }: { text: string; query: string }) {
    const ranges = logLines.matchRanges(text, query);
    if (ranges.length === 0) return <>{text}</>;
    const parts: ReactNode[] = [];
    let at = 0;
    for (const [start, end] of ranges) {
        if (start > at) parts.push(text.slice(at, start));
        parts.push(
            <mark key={start} className="rounded-sm bg-yellow-400/30 text-inherit">
                {text.slice(start, end)}
            </mark>
        );
        at = end;
    }
    if (at < text.length) parts.push(text.slice(at));
    return <>{parts}</>;
}

// Memoized on plain values, so a new line arriving re-renders that line, not the
// thousands above it - the rows are rebuilt on every change, their contents are not.
const LogRow = memo(function LogRow({
    index,
    text,
    level,
    time: stamp,
    repeat,
    span,
    badge,
    query,
    active,
    gutter,
    withDates
}: {
    index: number;
    text: string;
    level: logLines.LogLevel;
    time: string | null;
    repeat: number;
    span: number;
    /** This row carries the count of the repeat block it belongs to. */
    badge: boolean;
    query: string;
    active: boolean;
    gutter: boolean;
    withDates: boolean;
}) {
    const t = useTranslations("components");
    const [copied, setCopied] = useState(false);
    const format = useDisplayFormat();
    const time = stamp ? logLines.formatLogTime(stamp, format, withDates) : null;
    const repeated = repeat > 1;

    async function copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(time ? `${time} ${text}` : text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard unavailable (insecure context); the text is still visible to select manually.
        }
    }

    return (
        <div
            data-row={index}
            className={cn(
                "group relative flex gap-2 px-3 pr-9 hover:bg-white/5",
                repeated && "border-l-2 border-zinc-600 pl-2.5",
                active && "bg-yellow-400/10"
            )}
        >
            {gutter && (
                <span
                    className={cn(
                        "shrink-0 select-none border-r border-white/10 pr-2 text-zinc-500 tabular-nums",
                        withDates ? "w-[9.5rem]" : "w-[4.25rem]"
                    )}
                >
                    {time ?? ""}
                </span>
            )}
            <span
                className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", LEVEL_CLASS[level])}
            >
                {text ? <Highlighted text={text} query={query} /> : " "}
                {badge && (
                    <span
                        className="ml-2 inline-block rounded bg-zinc-700/80 px-1 align-baseline text-[0.6875rem] tabular-nums text-zinc-200"
                        title={t("logViewer.repeatedTitle", { count: repeat, lines: span })}
                    >
                        {t("logViewer.repeat", { count: repeat })}
                    </span>
                )}
            </span>
            <button
                type="button"
                onClick={copy}
                aria-label={t("logViewer.copyEntry")}
                className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 group-hover:block"
            >
                {copied ? (
                    <Check className="size-3.5 text-success" />
                ) : (
                    <Copy className="size-3.5" />
                )}
            </button>
        </div>
    );
});
