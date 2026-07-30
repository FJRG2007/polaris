/**
 * Turning raw log output into the lines a viewer renders: the timestamp lifted off
 * the front, the severity read from the words, and continuation lines folded into
 * the entry they belong to.
 *
 * Kept apart from the viewer because it is the part with rules - docker stamps
 * every line it emits, including the frames of a stack trace, so what makes an
 * entry cannot be decided from the raw line alone.
 */

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
const ERROR_RE = /\b(\w*errors?|fatal|panic|exception|traceback|unhandled|failed|failure|denied|refused)\b/i;
const WARN_RE = /\b(warn|warning|warnings|deprecated|deprecation)\b/i;
const INFO_RE = /\b(info|notice|listening|started|ready|success|succeeded|completed?)\b/i;

/** Lines that continue the previous entry rather than starting a new one:
 *  indented text, JS/Java stack frames, "Caused by" chains, "..." truncations. */
const CONTINUATION_RE = /^(\s+|at\s|\.{3}|caused by\b)/i;

/** The RFC 3339 stamp docker prefixes with `--timestamps`, and the updater writes.
 *  Fractional seconds are optional: docker emits them, the updater does not. */
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/;

export function levelOf(line: string): LogLevel {
    if (ERROR_RE.test(line)) return "error";
    if (WARN_RE.test(line)) return "warn";
    if (INFO_RE.test(line)) return "info";
    return "default";
}

/** Split raw output into entries, folding continuation lines into the entry above. */
export function parseLog(raw: string): LogEntry[] {
    const entries: LogEntry[] = [];
    for (const line of raw.split("\n")) {
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

/**
 * The stamp as it is shown: local wall-clock to the second, because a log is read
 * against the clock on the wall rather than against UTC. Anything unparseable is
 * left exactly as it arrived.
 */
export function formatLogTime(stamp: string): string {
    const date = new Date(stamp);
    return Number.isNaN(date.getTime())
        ? stamp
        : date.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
