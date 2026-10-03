/**
 * What somebody types into the search to start a clock: "timer 10m", "alarm
 * 7:30", "stopwatch" - and the same in Spanish ("temporizador 5 min tea",
 * "alarma 7:30 pm", "cronómetro").
 *
 * Pure and shared: the search panel reads it to offer the row, and Calendar's
 * route reads the same text again before it creates anything, so what the
 * panel promised is what happens.
 */

import { z } from "zod";

/** The longest timer: 99:59:59, the most a timer face shows. */
export const CLOCK_TIMER_MAX_MS = (99 * 3600 + 59 * 60 + 59) * 1000;

/** How long a label typed after the time may be. */
export const CLOCK_LABEL_MAX = 60;

/** Raised on the window when a tab changed the person's clocks. */
export const CLOCK_CHANGED_EVENT = "polaris:clock-changed";

/** The broadcast channel that tells this browser's other tabs the same. */
export const CLOCK_CHANNEL = "polaris-clock";

/** Where a tab keeps the last clock snapshot it read. */
export const CLOCK_SNAPSHOT_KEY = "calendar.clock";

export type ClockCommand =
    | { readonly kind: "timer"; readonly durationMs: number; readonly label: string }
    | {
          readonly kind: "alarm";
          readonly hour: number;
          readonly minute: number;
          readonly label: string;
      }
    | { readonly kind: "stopwatch" };

const TIMER_WORDS = new Set(["timer", "countdown", "temporizador", "cuenta"]);
const ALARM_WORDS = new Set(["alarm", "alarma", "wake", "despertador"]);
const STOPWATCH_WORDS = new Set(["stopwatch", "cronometro", "cronómetro", "chrono"]);

const UNIT_MS: Readonly<Record<string, number>> = {
    h: 3_600_000,
    hr: 3_600_000,
    hrs: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    hora: 3_600_000,
    horas: 3_600_000,
    m: 60_000,
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    minuto: 60_000,
    minutos: 60_000,
    s: 1000,
    sec: 1000,
    secs: 1000,
    second: 1000,
    seconds: 1000,
    seg: 1000,
    segs: 1000,
    segundo: 1000,
    segundos: 1000
};

/** "1h30m", "10 min", "90s", "1.5h", "5:00", "1:02:03" or a bare "10" (minutes),
 *  at the front of `text`; what follows is the label. */
function readDuration(text: string): { ms: number; rest: string } | null {
    const clock = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?=\s|$)/.exec(text);
    if (clock) {
        const [whole, a, b, c] = clock;
        const ms =
            c === undefined
                ? (Number(a) * 60 + Number(b)) * 1000
                : (Number(a) * 3600 + Number(b) * 60 + Number(c)) * 1000;
        return { ms, rest: text.slice(whole.length) };
    }
    const part = /^(\d+(?:[.,]\d+)?)(\s*([a-z]+)(?![a-z]))?/i;
    let rest = text;
    let ms = 0;
    let parts = 0;
    for (;;) {
        const match = part.exec(rest);
        if (!match) break;
        const amount = Number(match[1]!.replace(",", "."));
        const unit = match[3] === undefined ? undefined : UNIT_MS[match[3].toLowerCase()];
        if (unit !== undefined) {
            ms += amount * unit;
            parts += 1;
            rest = rest.slice(match[0].length).trimStart();
            continue;
        }
        // A bare number means minutes, and only on its own: "1h 30" is not a
        // duration anybody writes, and "10 tea" is ten minutes called tea.
        if (parts > 0 || !/^\d+(?:[.,]\d+)?(?=\s|$)/.test(rest)) return null;
        ms += amount * 60_000;
        parts += 1;
        rest = rest.slice(match[1]!.length);
        break;
    }
    if (parts === 0) return null;
    return { ms: Math.round(ms), rest };
}

/** "7:30", "07.30", "7pm", "7:30 p.m.", "19:30" at the front of `text`. */
function readTimeOfDay(text: string): { hour: number; minute: number; rest: string } | null {
    const match = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\s|$)/i.exec(text);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    const meridiem = match[3]?.toLowerCase().replace(/\./g, "");
    if (minute > 59) return null;
    if (meridiem) {
        if (hour < 1 || hour > 12) return null;
        hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
    } else if (hour > 23) return null;
    // "7" alone is not a time somebody means without a meridiem or minutes:
    // "alarm 7" could be either seven, so it waits for more.
    if (match[2] === undefined && !meridiem) return null;
    return { hour, minute, rest: text.slice(match[0].length) };
}

function label(rest: string): string {
    return rest.trim().replace(/\s+/g, " ").slice(0, CLOCK_LABEL_MAX);
}

/**
 * The clock a line asks for, or null when it does not ask for one. Leading and
 * trailing space, case and a leading slash ("/timer 5m") are ignored.
 */
export function parseClockCommand(input: string): ClockCommand | null {
    const text = input.trim().replace(/^\//, "").trimStart();
    const word = /^(\S+)\s*/.exec(text);
    if (!word) return null;
    const keyword = word[1]!.toLowerCase();
    const rest = text.slice(word[0].length);
    if (STOPWATCH_WORDS.has(keyword)) return rest.trim() === "" ? { kind: "stopwatch" } : null;
    if (TIMER_WORDS.has(keyword)) {
        const duration = readDuration(rest);
        if (!duration || duration.ms < 1000 || duration.ms > CLOCK_TIMER_MAX_MS) return null;
        return { kind: "timer", durationMs: duration.ms, label: label(duration.rest) };
    }
    if (ALARM_WORDS.has(keyword)) {
        const time = readTimeOfDay(rest);
        if (!time) return null;
        return { kind: "alarm", hour: time.hour, minute: time.minute, label: label(time.rest) };
    }
    return null;
}

/** What a request that runs a typed command carries. */
export const clockCommandRequestSchema = z.object({
    command: z.string().trim().min(1).max(120),
    /** The zone an alarm rings in: the reader's. */
    zone: z.string().trim().min(1).max(64)
});

export type ClockCommandRequest = z.infer<typeof clockCommandRequestSchema>;
