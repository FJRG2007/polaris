/**
 * Calendar's timers on a Stream Deck or in Companion: a key that starts,
 * pauses, resets, adds a minute to or skips the phase of one of this account's
 * timers - the same operations the Time screen has - and shows it counting,
 * to the second the Time screen does.
 *
 * Bound to the clock MCP tools, so a deck reaches exactly the timers its owner
 * does, through the same checks. A key set to "a new timer" finds it by its
 * name and creates it on the first press; one set to the focus cycle works the
 * account's cycle, starting one when there is none.
 *
 * Pure apart from the tools it names. Server-only by use.
 */

import { z } from "zod";
import type { Locale } from "@polaris/core";
import type { AppHostTypes } from "@polaris/app-host";
import { CLOCK_LABEL_MAX, DEFAULT_POMODORO, formatCountdown } from "./clock/model";

type AppDeckAction = AppHostTypes["AppDeckAction"];
type DeckState = ReturnType<NonNullable<AppDeckAction["read"]>["pick"]>;
type DeckCountdown = NonNullable<DeckState["countdown"]>;
type Words = Readonly<Record<Locale, string>>;

/** What `timer` is set to besides one of the account's timers. */
export const NEW_TIMER = "new";
export const FOCUS_TIMER = "focus";

/** What a press does. `shift` is a dial's turn and is not offered on a key. */
export const TIMER_OPS = ["toggle", "reset", "add", "skip", "shift"] as const;
export type TimerOp = (typeof TIMER_OPS)[number];

const DEFAULT_MINUTES = 5;

export const timerOptionsSchema = z
    .object({
        timer: z.string().trim().min(1).max(64),
        name: z.string().trim().max(CLOCK_LABEL_MAX).default(""),
        minutes: z.number().int().min(1).max(5999).default(DEFAULT_MINUTES),
        op: z.enum(TIMER_OPS).default("toggle")
    })
    .passthrough()
    // A new timer is found again by its name, so it needs one.
    .refine((options) => options.timer !== NEW_TIMER || options.name.length > 0);

export type TimerOptions = z.infer<typeof timerOptionsSchema>;

const timerRows = z.object({
    timers: z.array(
        z
            .object({
                id: z.string(),
                label: z.string(),
                state: z.enum(["running", "paused", "rung", "idle"]),
                endsAt: z.string().nullable(),
                focus: z.enum(["focus", "short", "long"]).nullable(),
                durationMs: z.number(),
                remainingMs: z.number()
            })
            .passthrough()
    ),
    serverNow: z.string().optional()
});

type TimerRow = z.infer<typeof timerRows>["timers"][number];

function rowsOf(structured: unknown): z.infer<typeof timerRows> {
    const parsed = timerRows.safeParse(structured);
    return parsed.success ? parsed.data : { timers: [] };
}

/** The timer a key means: a row, null when it is to be created, "gone" when
 *  the one it was set to has been deleted. */
export function timerFor(
    rows: readonly TimerRow[],
    options: Pick<TimerOptions, "timer" | "name">
): TimerRow | null | "gone" {
    if (options.timer === NEW_TIMER)
        return rows.find((row) => row.focus === null && row.label === options.name) ?? null;
    if (options.timer === FOCUS_TIMER) return rows.find((row) => row.focus !== null) ?? null;
    return rows.find((row) => row.id === options.timer) ?? "gone";
}

/** "4:59" or "1:02:03": a countdown as a key draws it, rounded up. */
export function keyTime(ms: number): string {
    const text = formatCountdown(ms);
    return text.startsWith("0") && text.length === 5 ? text.slice(1) : text;
}

const GONE: Words = { "en-US": "Not found", "es-ES": "No existe" };
const DONE: Words = { "en-US": "Done", "es-ES": "Hecho" };
const PHASES: Readonly<Record<"focus" | "short" | "long", Words>> = {
    focus: { "en-US": "Focus", "es-ES": "Foco" },
    short: { "en-US": "Break", "es-ES": "Pausa" },
    long: { "en-US": "Long break", "es-ES": "Pausa larga" }
};

/** A countdown as a key draws it. */
export function countdownFace(
    countdown: DeckCountdown,
    detail: string | undefined,
    locale: Locale
): DeckState {
    const running = countdown.state === "running";
    const rung = countdown.state === "rung";
    return {
        tone: running ? "ok" : rung ? "bad" : "idle",
        icon: running ? "timer" : rung ? "bell-ring" : "pause",
        on: running,
        value: keyTime(countdown.remainingMs),
        ...(rung ? { detail: DONE[locale] } : detail ? { detail } : {}),
        countdown
    };
}

/** What a key set to `options` shows, from what `clock_list` answered. */
export function timerState(structured: unknown, locale: Locale, raw: unknown): DeckState {
    const options = timerOptionsSchema.safeParse(raw);
    if (!options.success) return { tone: "idle" };
    const { timers, serverNow } = rowsOf(structured);
    const found = timerFor(timers, options.data);
    if (found === "gone") return { tone: "bad", icon: "timer", detail: GONE[locale] };
    if (found === null) {
        const focus = options.data.timer === FOCUS_TIMER;
        const length = (focus ? DEFAULT_POMODORO.focus : options.data.minutes) * 60_000;
        return countdownFace(
            {
                state: "idle",
                remainingMs: length,
                durationMs: length,
                ...(focus ? { phase: "focus" } : {})
            },
            focus ? PHASES.focus[locale] : options.data.name,
            locale
        );
    }
    const running = found.state === "running" && found.endsAt !== null;
    const countdown: DeckCountdown = {
        state: found.state,
        remainingMs: found.remainingMs,
        durationMs: found.durationMs,
        // The instant it ends and the server's clock, only while it runs: a
        // stopped one reads the same every time, and its key is not redrawn.
        ...(running && serverNow
            ? { endsAt: Date.parse(found.endsAt!), serverNow: Date.parse(serverNow) }
            : {}),
        ...(found.focus ? { phase: found.focus } : {})
    };
    return countdownFace(
        countdown,
        found.focus ? PHASES[found.focus][locale] : found.label || undefined,
        locale
    );
}

/** The face a start-or-pause shows before Polaris answers. */
export function toggledFace(state: DeckState, locale: Locale): DeckState | undefined {
    const countdown = state.countdown;
    if (!countdown) return undefined;
    if (countdown.state === "running") {
        const { endsAt: _endsAt, serverNow: _serverNow, ...rest } = countdown;
        return countdownFace({ ...rest, state: "paused" }, state.detail, locale);
    }
    // A rung timer starts over from its full length, as Start does on the screen.
    const left = countdown.state === "rung" ? countdown.durationMs : countdown.remainingMs;
    return countdownFace(
        { ...countdown, state: "running", remainingMs: left },
        countdown.state === "rung" ? undefined : state.detail,
        locale
    );
}

type Press = { readonly step?: number; readonly read?: unknown };

/** The tool a press calls: one that creates the timer the first time, the one
 *  that changes it after. */
export function timerTool(raw: Record<string, unknown>, press: Press): string {
    const options = timerOptionsSchema.safeParse(raw);
    if (!options.success) return "clock_timer_change";
    const found = timerFor(rowsOf(press.read).timers, options.data);
    if (found !== null || options.data.op !== "toggle") return "clock_timer_change";
    return options.data.timer === FOCUS_TIMER ? "clock_focus_start" : "clock_timer_start";
}

/** What that tool is sent; null when the press has nothing to do. */
export function timerInput(raw: Record<string, unknown>, press: Press): unknown {
    const options = timerOptionsSchema.safeParse(raw);
    if (!options.success) return null;
    const { op, timer, name, minutes } = options.data;
    const found = timerFor(rowsOf(press.read).timers, options.data);
    if (found === "gone") return null;
    if (found === null) {
        if (op !== "toggle") return null;
        return timer === FOCUS_TIMER ? { label: name } : { minutes, label: name };
    }
    switch (op) {
        case "toggle":
            return { timer: found.id, action: found.state === "running" ? "pause" : "resume" };
        case "reset":
            return { timer: found.id, action: "reset" };
        case "add":
            return { timer: found.id, action: "add_minute" };
        case "skip":
            return found.focus ? { timer: found.id, action: "skip" } : null;
        case "shift":
            return press.step ? { timer: found.id, action: "shift", minutes: press.step } : null;
    }
}

/** The account's timers for the picker, by their label or their length. */
export function timerChoices(structured: unknown): { value: string; label: string }[] {
    return rowsOf(structured).timers.map((row) => ({
        value: row.id,
        label: row.label || formatCountdown(row.durationMs)
    }));
}

export function calendarDeckActions(): AppDeckAction[] {
    return [
        {
            id: "calendar.timer",
            kind: "toggle",
            area: "tools",
            icon: "timer",
            label: { "en-US": "Calendar timer", "es-ES": "Temporizador" },
            scope: "calendar.manage",
            options: timerOptionsSchema,
            fields: [
                {
                    name: "timer",
                    type: "choice",
                    label: { "en-US": "Timer", "es-ES": "Temporizador" },
                    required: true,
                    fixed: [
                        {
                            value: NEW_TIMER,
                            label: { "en-US": "A new timer", "es-ES": "Uno nuevo" }
                        },
                        {
                            value: FOCUS_TIMER,
                            label: { "en-US": "Focus cycle", "es-ES": "Ciclo de foco" }
                        }
                    ],
                    choices: { tool: "clock_list", input: {}, pick: timerChoices }
                },
                {
                    name: "name",
                    type: "text",
                    label: { "en-US": "New timer's name", "es-ES": "Nombre del nuevo" },
                    required: false
                },
                {
                    name: "minutes",
                    type: "number",
                    label: { "en-US": "Minutes", "es-ES": "Minutos" },
                    required: false,
                    min: 1,
                    max: 5999
                },
                {
                    name: "op",
                    type: "choice",
                    label: { "en-US": "A press", "es-ES": "Al pulsar" },
                    required: false,
                    fixed: [
                        {
                            value: "toggle",
                            label: { "en-US": "Start or pause", "es-ES": "Iniciar o pausar" }
                        },
                        { value: "reset", label: { "en-US": "Reset", "es-ES": "Reiniciar" } },
                        {
                            value: "add",
                            label: { "en-US": "Add a minute", "es-ES": "Sumar un minuto" }
                        },
                        {
                            value: "skip",
                            label: { "en-US": "Skip the phase", "es-ES": "Saltar la fase" }
                        }
                    ]
                }
            ],
            run: { tool: timerTool, input: timerInput },
            read: {
                tool: "clock_list",
                input: () => ({}),
                pick: timerState,
                press: (state, options, _structured, locale) => {
                    const op = timerOptionsSchema.safeParse(options);
                    if (!op.success || op.data.op !== "toggle") return undefined;
                    const face = toggledFace(state, locale);
                    return face ? { face } : undefined;
                }
            }
        }
    ];
}
