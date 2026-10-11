/**
 * Turning raw log output into the lines a viewer renders: the timestamp lifted off
 * the front, the severity read from the words, and continuation lines folded into
 * the entry they belong to.
 *
 * Kept apart from the viewer because it is the part with rules - docker stamps
 * every line it emits, including the frames of a stack trace, so what makes an
 * entry cannot be decided from the raw line alone.
 */

import type { DisplayFormat } from "@polaris/core";

export type LogLevel = "error" | "warn" | "info" | "default";

export interface LogEntry {
    /** The message, with any leading timestamp removed. */
    text: string;
    level: LogLevel;
    /** The stamp the line carried, verbatim, or null when it carried none. */
    time: string | null;
}

const LEVEL_RANK: Record<LogLevel, number> = { default: 0, info: 1, warn: 2, error: 3 };

// `\w*errors?` so the named errors a runtime throws - TypeError, ReferenceError,
// OSError - colour like the failures they are, which is what a stack trace leads
// with and what the eye goes to first.
const ERROR_RE =
    /\b(\w*errors?|fatal|panic|exception|traceback|unhandled|failed|failure|denied|refused)\b/i;
const WARN_RE = /\b(warn|warning|warnings|deprecated|deprecation)\b/i;
const INFO_RE = /\b(info|notice|listening|started|ready|success|succeeded|completed?)\b/i;

/** Lines that continue the previous entry rather than starting a new one:
 *  indented text, JS/Java stack frames, "Caused by" chains, "..." truncations. */
const CONTINUATION_RE = /^(\s+|at\s|\.{3}|caused by\b)/i;

/** The RFC 3339 stamp docker prefixes with `--timestamps`, and the updater writes.
 *  Fractional seconds are optional: docker emits them, the updater does not. */
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/;

/** Terminal colour and cursor sequences (CSI, and OSC up to BEL or ST): a
 *  container that thinks it writes to a terminal colours its own output, and the
 *  codes would otherwise reach the screen as `[33m` noise. */
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** The level a line declares about itself, which outranks any word in it: the
 *  `[thread/LEVEL]` block of a Minecraft or NeoForge server, a JSON `"level"` key,
 *  and a logfmt `level=` pair. */
const DECLARED_RES = [
    /\[[^[\]/]*\/([A-Za-z]+)\]/,
    /"(?:level|lvl|severity|log\.level)"\s*:\s*"([A-Za-z]+)"/i,
    /(?:^|\s)(?:level|lvl|severity)=(?:"([A-Za-z]+)"|([A-Za-z]+))/i
];

const DECLARED_LEVEL: Record<string, LogLevel> = {
    fatal: "error",
    panic: "error",
    critical: "error",
    crit: "error",
    severe: "error",
    emerg: "error",
    emergency: "error",
    alert: "error",
    error: "error",
    err: "error",
    warn: "warn",
    warning: "warn",
    info: "info",
    notice: "info",
    debug: "info",
    trace: "info",
    fine: "info",
    verbose: "info"
};

/** The line without terminal escape codes. */
export function stripAnsi(line: string): string {
    return line.includes("\u001b") ? line.replace(ANSI_RE, "") : line;
}

function declaredLevel(line: string): LogLevel | null {
    for (const re of DECLARED_RES) {
        const match = re.exec(line);
        const word = match?.[1] ?? match?.[2];
        const level = word ? DECLARED_LEVEL[word.toLowerCase()] : undefined;
        if (level) return level;
    }
    return null;
}

export function levelOf(line: string): LogLevel {
    const declared = declaredLevel(line);
    if (declared) return declared;
    if (ERROR_RE.test(line)) return "error";
    if (WARN_RE.test(line)) return "warn";
    if (INFO_RE.test(line)) return "info";
    return "default";
}

/** Split raw output into entries, folding continuation lines into the entry above. */
export function parseLog(raw: string): LogEntry[] {
    const entries: LogEntry[] = [];
    for (const rawLine of raw.split("\n")) {
        const line = stripAnsi(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
        const stamped = TIMESTAMP_RE.exec(line);
        const body = stamped ? (stamped[2] ?? "") : line;
        const last = entries[entries.length - 1];
        if (last && CONTINUATION_RE.test(body)) {
            last.text += `\n${body}`;
            if (LEVEL_RANK[levelOf(body)] > LEVEL_RANK[last.level]) last.level = levelOf(body);
        } else {
            entries.push({ text: body, level: levelOf(body), time: stamped?.[1] ?? null });
        }
    }
    return entries;
}

/** The three levels a reader filters by. A line that names none reads as info. */
export type LogBucket = "error" | "warn" | "info";

export const LOG_BUCKETS: readonly LogBucket[] = ["error", "warn", "info"];

export function bucketOf(level: LogLevel): LogBucket {
    return level === "default" ? "info" : level;
}

export function countBuckets(entries: readonly LogEntry[]): Record<LogBucket, number> {
    const counts: Record<LogBucket, number> = { error: 0, warn: 0, info: 0 };
    for (const entry of entries) counts[bucketOf(entry.level)] += 1;
    return counts;
}

/** A clock or date the message itself starts with - `[12:00:01]`, the
 *  `[11Oct2026 12:00:01.123]` of a NeoForge server, an ISO stamp - which differs on
 *  every repeat and so has to go before two lines can be called the same. */
const LEADING_STAMP_RE =
    /^\s*\[?(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{1,2}[A-Za-z]{3}\d{4} \d{2}:\d{2}:\d{2}(?:[.,]\d+)?|\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?)\]?\s*/;

/** What two lines are compared by when folding repeats: the text without the
 *  stamp it starts with. */
export function repeatKey(text: string): string {
    return text.replace(LEADING_STAMP_RE, "");
}

/** One shown row: an entry, and - when it stands for a run of repeats - how many
 *  times its block occurred and where in that block it sits. */
export interface LogRow {
    entry: LogEntry;
    /** Times the block this row belongs to occurred in a row; 1 when it did not repeat. */
    repeat: number;
    /** Lines in that block (1 for a single repeated line). */
    span: number;
    /** Position of this row inside its block. */
    offset: number;
}

/** The longest block of lines folded as one repeat - a server that alternates
 *  "client started" / "client shutting down" repeats with a period of two. */
const MAX_PERIOD = 4;

/**
 * Fold consecutive repeats - of one line, or of a short block of lines - into a
 * single occurrence carrying the count. Lines compare after the stamp at their
 * start is dropped. The occurrence kept is the last one, so the time shown is
 * when it last happened.
 */
export function foldRepeats(entries: readonly LogEntry[]): LogRow[] {
    const keys = entries.map((entry) => repeatKey(entry.text));
    const rows: LogRow[] = [];
    let index = 0;
    while (index < entries.length) {
        let period = 1;
        let times = 1;
        for (
            let candidate = 1;
            candidate <= MAX_PERIOD && index + candidate * 2 <= entries.length;
            candidate += 1
        ) {
            let count = 1;
            while (sameBlock(keys, index, index + count * candidate, candidate)) count += 1;
            // Strictly more lines covered, so a tie keeps the shorter period:
            // "a a a a" is one line four times, not a pair that came twice.
            if (count > 1 && count * candidate > times * period) {
                period = candidate;
                times = count;
            }
        }
        const start = index + (times - 1) * period;
        for (let offset = 0; offset < period; offset += 1) {
            rows.push({ entry: entries[start + offset]!, repeat: times, span: period, offset });
        }
        index += times * period;
    }
    return rows;
}

function sameBlock(
    keys: readonly string[],
    first: number,
    second: number,
    period: number
): boolean {
    if (second + period > keys.length) return false;
    for (let offset = 0; offset < period; offset += 1) {
        if (keys[first + offset] !== keys[second + offset]) return false;
    }
    return true;
}

/** Every entry as a row of its own, for when repeats are not folded. */
export function unfoldedRows(entries: readonly LogEntry[]): LogRow[] {
    return entries.map((entry) => ({ entry, repeat: 1, span: 1, offset: 0 }));
}

/** Where `query` occurs in `text`, ignoring case, as [start, end) pairs. The
 *  query is expected lower-cased already. */
export function matchRanges(text: string, query: string): Array<[number, number]> {
    if (!query) return [];
    const ranges: Array<[number, number]> = [];
    const haystack = text.toLowerCase();
    let from = haystack.indexOf(query);
    while (from !== -1) {
        ranges.push([from, from + query.length]);
        from = haystack.indexOf(query, from + query.length);
    }
    return ranges;
}

/**
 * The stamp as it is shown: local wall-clock to the second, because a log is read
 * against the clock on the wall rather than against UTC, and on the reader's own
 * clock format. Anything unparseable is left exactly as it arrived.
 */
export function formatLogTime(stamp: string, format: DisplayFormat, withDate = false): string {
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) return stamp;
    return withDate
        ? format.dateTime(date, { seconds: true })
        : format.time(date, { seconds: true });
}
