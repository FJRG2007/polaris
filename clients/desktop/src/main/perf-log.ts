/**
 * Evidence of a slow window, written where it can be read after the fact:
 * `<userData>/logs/perf.log`, one line per event, kept to two files of 1 MB.
 *
 * A window that takes seconds to answer a click can be the main process stuck
 * (every input reaches the page through it), the page's own thread busy, or the
 * frame waiting on the graphics card behind a full-screen game. Each has its own
 * line here: `loop` for the main process, `page` for what the page measured
 * (`preload/perf-watch.ts`), `child-gone` and `unresponsive` for the processes
 * Chromium runs.
 *
 * Never blocks the thread it measures: every write is asynchronous and queued.
 * Nothing personal goes in: values are numbers or short tokens of
 * `[A-Za-z0-9_.:-]`, so no path, address, title or account can reach the file.
 * Free of Electron so the tests can run it against a folder of their own.
 */

import { z } from "zod";
import { dirname } from "node:path";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";

/** The most one file holds before it becomes `perf.log.1`. */
export const PERF_LOG_MAX_BYTES = 1024 * 1024;

/** The most lines written in a minute; the rest are counted, not written. */
export const PERF_LOG_LINES_PER_MINUTE = 60;

/** A main-process 99th percentile delay worth a line. */
export const LOOP_LAG_MS = 250;

/** How often the main process's delay is looked at. */
export const LOOP_CHECK_MS = 10_000;

/** What the page reports, at or over this long. */
export const PAGE_SLOW_MS = 500;

export type PerfValue = string | number | boolean;

/** A value as it may appear in the file: a rounded number or a short token. */
export function perfValue(value: PerfValue): string {
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "number") return Number.isFinite(value) ? String(Math.round(value)) : "-";
    const token = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
    return token.length > 0 ? token : "-";
}

/** `2026-11-26T10:00:00.000Z loop p99=812 max=20113`. */
export function perfLine(at: Date, event: string, fields: Readonly<Record<string, PerfValue>> = {}): string {
    const parts = Object.entries(fields).map(([key, value]) => `${perfValue(key)}=${perfValue(value)}`);
    return [at.toISOString(), perfValue(event), ...parts].join(" ");
}

export interface PerfLogOptions {
    readonly maxBytes?: number;
    readonly linesPerMinute?: number;
    readonly now?: () => Date;
}

/** The file, written one queued append at a time, rotated by size. */
export class PerfLog {
    private queue: Promise<void> = Promise.resolve();
    private window = 0;
    private written = 0;
    private dropped = 0;
    private readonly maxBytes: number;
    private readonly linesPerMinute: number;
    private readonly now: () => Date;

    constructor(
        private readonly file: string,
        options: PerfLogOptions = {}
    ) {
        this.maxBytes = options.maxBytes ?? PERF_LOG_MAX_BYTES;
        this.linesPerMinute = options.linesPerMinute ?? PERF_LOG_LINES_PER_MINUTE;
        this.now = options.now ?? (() => new Date());
    }

    /** Adds a line; resolves once it is written, or was dropped. Never rejects. */
    write(event: string, fields: Readonly<Record<string, PerfValue>> = {}): Promise<void> {
        const at = this.now();
        const minute = Math.floor(at.getTime() / 60_000);
        if (minute !== this.window) {
            this.window = minute;
            this.written = 0;
        }
        if (this.written >= this.linesPerMinute) {
            this.dropped += 1;
            return this.queue;
        }
        this.written += 1;
        let text = `${perfLine(at, event, fields)}\n`;
        if (this.dropped > 0) {
            // Said on the next line written, so a flood is never silent.
            text = `${perfLine(at, "dropped", { lines: this.dropped })}\n${text}`;
            this.dropped = 0;
        }
        this.queue = this.queue.then(() => this.append(text));
        return this.queue;
    }

    private async append(text: string): Promise<void> {
        try {
            await mkdir(dirname(this.file), { recursive: true });
            const size = await stat(this.file).then(
                (found) => found.size,
                () => 0
            );
            if (size > 0 && size + Buffer.byteLength(text) > this.maxBytes) await rename(this.file, `${this.file}.1`);
            await appendFile(this.file, text);
        } catch {
            // A log that cannot be written must never break the app.
        }
    }
}

/** The part of `IntervalHistogram` a look reads. */
export interface DelayHistogram {
    percentile(percentile: number): number;
    readonly max: number;
    reset(): void;
}

/** `Timeout:3,FSReqPromise:1`: what the process was waiting on, by kind, most first. */
export function activeSummary(resources: readonly string[]): string {
    const counts = new Map<string, number>();
    for (const name of resources) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name.replace(/[^A-Za-z0-9_]/g, "")}:${count}`)
        .join(",");
}

/**
 * One look at the main process's delay since the last: a line when its 99th
 * percentile reached `threshold`, then a fresh count. The histogram counts in
 * nanoseconds.
 */
export function checkLoop(
    histogram: DelayHistogram,
    log: Pick<PerfLog, "write">,
    active: () => readonly string[],
    threshold: number = LOOP_LAG_MS
): boolean {
    const p99 = histogram.percentile(99) / 1e6;
    const max = histogram.max / 1e6;
    histogram.reset();
    if (!(p99 >= threshold)) return false;
    let waiting = "";
    try {
        waiting = activeSummary(active());
    } catch {
        // Older runtimes have no list; the delay alone is still worth a line.
    }
    void log.write("loop", { p99, max, ...(waiting ? { active: waiting } : {}) });
    return true;
}

/** What the page's preload reports (`preload/perf-watch.ts`), checked again here. */
export const pageReportSchema = z.strictObject({
    kind: z.enum(["longtask", "event"]),
    duration: z.number().min(0).max(3_600_000),
    /** An event's name: `click`, `pointerdown`, `keydown`. */
    name: z
        .string()
        .regex(/^[a-z]{1,32}$/)
        .optional(),
    /** From the input to its handler starting: the page's thread was busy. */
    delay: z.number().min(0).max(3_600_000).optional(),
    /** The handlers themselves. */
    processing: z.number().min(0).max(3_600_000).optional()
});

export type PageReport = z.infer<typeof pageReportSchema>;

/** The page's report as a line, or nothing for anything malformed. */
export function writePageReport(log: Pick<PerfLog, "write">, raw: unknown): boolean {
    const parsed = pageReportSchema.safeParse(raw);
    if (!parsed.success) return false;
    const { kind, duration, name, delay, processing } = parsed.data;
    const fields: Record<string, PerfValue> = { kind, ms: duration };
    if (name) fields.name = name;
    if (delay !== undefined) fields.delay = delay;
    if (processing !== undefined) fields.processing = processing;
    // What is left of an event after its handlers: waiting for the frame, which
    // is the graphics card's (or the compositor's) time, not the page's.
    if (kind === "event" && delay !== undefined && processing !== undefined) fields.present = Math.max(0, duration - delay - processing);
    void log.write("page", fields);
    return true;
}

/** What a page's console message carries that a line may keep (Electron's `console-message`). */
export interface ConsoleDetails {
    readonly level: string;
    readonly message: string;
    readonly lineNumber: number;
    readonly sourceId: string;
}

/**
 * The words of an error with what could name somebody taken out first:
 * addresses, mail addresses, quoted text and long numbers (ids). What stays is
 * the framework's or the browser's own sentence, which is what names the bug.
 */
export function errorWords(message: string): string {
    return (message.split("\n")[0] ?? "")
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
        .replace(/\S+@\S+/g, "<mail>")
        .replace(/(["'`])(?:(?!\1).){13,}\1/g, "<text>")
        .replace(/\d{5,}/g, "<n>")
        .trim();
}

/** A script's file name, without the address, folders or query around it. */
export function scriptName(sourceId: string): string {
    const path = sourceId.split(/[?#]/)[0] ?? "";
    return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * A page's error as a line: what the page said when it could not be drawn -
 * Next's "Application error" screen says nothing on its own, the console says
 * why. Only errors are written; the rest of a page's console is its own.
 */
export function writeRendererError(log: Pick<PerfLog, "write">, details: ConsoleDetails, type: string): boolean {
    if (details.level !== "error") return false;
    const words = errorWords(details.message);
    const kind = /^(?:Uncaught\s+)?((?:[A-Z][A-Za-z]*)?Error)\b:?\s*/.exec(words);
    const name = kind?.[1] ?? "";
    const fields: Record<string, PerfValue> = { type, msg: kind ? words.slice(kind[0].length) : words };
    if (name) fields.name = name;
    const script = scriptName(details.sourceId);
    if (script) fields.src = script;
    if (details.lineNumber > 0) fields.line = details.lineNumber;
    void log.write("page-error", fields);
    return true;
}
