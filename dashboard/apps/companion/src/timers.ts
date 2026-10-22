/**
 * Timer buttons: a countdown kept on this machine, or one of the account's
 * Calendar timers kept in Polaris - the same choice a Stream Deck timer key
 * has, over the same shared timer code.
 *
 * Every button, feedback and variable set to the same timer works the same
 * one: a timer is known by where it is kept and which it is, and its variables
 * are named after it, so `$(polaris:timer_tea_remaining)` reads on any button.
 * A Polaris timer counts down between readings with Polaris's clock (the skew
 * Calendar's screens apply), so it reaches zero on the second Calendar does.
 *
 * Pure: every function takes `now`, so the tests need no Companion and no clock.
 */

import * as local from "../../streamdeck/src/timer";
import { COLORS, type OptionField, type OptionValues } from "./mapping";
import * as shared from "../../streamdeck/src/polaris-timer";
import type { DeckAction, DeckState } from "../../streamdeck/src/polaris";

export const SOURCE_OPTION = "source";
export const TIMER_OPTION = "timer";
export const NAME_OPTION = "name";
export const MINUTES_OPTION = "minutes";
export const OP_OPTION = "op";

/** What a press does: the operations Calendar's Time screen has. */
export const OPS = ["toggle", "reset", "add", "skip"] as const;
export type Op = (typeof OPS)[number];

/** Where a timer is, as a button set to it shows it. */
export type TimerStatus = "running" | "paused" | "done" | "idle" | "unavailable";

/** A timer as a button's options name it. */
export interface TimerRef {
    readonly source: shared.TimerSource;
    /** For Polaris: "new", "focus" or one of the account's timers, by id. */
    readonly timer: string;
    /** A local timer's name, or the name a new Polaris timer is found by. */
    readonly name: string;
    readonly minutes: number;
}

/** A local timer nobody named. */
const DEFAULT_NAME = "Timer";

/** The options as the module hands them over, made into a timer. Absent or
 *  anything unknown is a timer on this machine, as on a Stream Deck key. */
export function refOf(values: OptionValues): TimerRef {
    const source = shared.sourceOf({ source: values[SOURCE_OPTION] });
    const typed = typeof values[NAME_OPTION] === "string" ? values[NAME_OPTION].trim() : "";
    const minutes = shared.minutesOf({ minutes: Number(values[MINUTES_OPTION]) });
    if (source === "deck") return { source, timer: "", name: typed || DEFAULT_NAME, minutes };
    const options = shared.polarisOptions({
        polarisTimer: typeof values[TIMER_OPTION] === "string" ? values[TIMER_OPTION] : "",
        polarisName: typed,
        minutes
    });
    return { source, timer: options.timer, name: options.name, minutes };
}

export function opOf(values: OptionValues): Op {
    const op = values[OP_OPTION];
    return OPS.includes(op as Op) ? (op as Op) : "toggle";
}

/** Which timer it is: two buttons with the same identity share one timer. A
 *  local timer's length is not part of it - changing it changes that timer. */
export function identity(ref: TimerRef): string {
    if (ref.source === "deck") return `local:${ref.name.toLowerCase()}`;
    if (ref.timer === "new") return `polaris:new:${ref.name.toLowerCase()}`;
    return `polaris:${ref.timer}`;
}

/** The key the state stream reads a Polaris timer under: short and fixed, as
 *  the stream takes keys of at most 64 characters. */
export function streamKey(ref: TimerRef): string {
    let hash = 5381;
    for (const char of identity(ref)) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
    return `timer:${hash.toString(36)}`;
}

/** What a Polaris timer is watched and run with. */
export function deckOptions(ref: TimerRef, op?: Op | "shift"): Record<string, unknown> {
    const options: Record<string, unknown> = {
        timer: ref.timer,
        name: ref.name,
        minutes: ref.minutes
    };
    return op ? { ...options, op } : options;
}

function slug(text: string): string {
    const words = text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40);
    return words || "timer";
}

/** The start of a timer's variable names: `timer_tea` for Polaris's "Tea",
 *  `timer_focus` for the focus cycle, `local_timer_tea` for one kept here. */
export function variablePrefix(ref: TimerRef, choiceLabel?: string): string {
    if (ref.source === "deck") return `local_timer_${slug(ref.name)}`;
    if (ref.timer === "focus") return "timer_focus";
    if (ref.timer === "new") return `timer_${slug(ref.name)}`;
    return `timer_${slug(choiceLabel ?? ref.timer)}`;
}

/** A timer's three variables. */
export function variableDefinitions(prefix: string, title: string): { id: string; name: string }[] {
    return [
        { id: `${prefix}_remaining`, name: `${title}: time left` },
        { id: `${prefix}_state`, name: `${title}: running, paused, done or idle` },
        { id: `${prefix}_name`, name: `${title}: name` }
    ];
}

/** What a button set to a timer shows. */
export interface TimerView {
    readonly status: TimerStatus;
    /** "4:59" or "1:02:03"; empty when Polaris has not said yet. */
    readonly remaining: string;
    readonly name: string;
}

/** A timer kept here, at `now`. */
export function localView(timer: local.TimerState, name: string, now: number): TimerView {
    const status: TimerStatus = local.finished(timer, now)
        ? "done"
        : local.running(timer)
          ? "running"
          : local.elapsed(timer, now) > 0
            ? "paused"
            : "idle";
    return { status, remaining: local.display(timer, now), name };
}

/**
 * A timer kept in Polaris, at `now` on this machine's clock: counted down
 * from the last reading, received at `receivedAt`. Unavailable until Polaris
 * has said, or when it cannot find the timer.
 */
export function polarisView(
    state: DeckState | undefined,
    receivedAt: number,
    fallbackName: string,
    now: number
): TimerView {
    const countdown = state?.countdown;
    if (!countdown) {
        return { status: "unavailable", remaining: "", name: state?.detail ?? fallbackName };
    }
    const skew = shared.skewOf(countdown, receivedAt);
    const left = shared.remainingAt(countdown, now, skew);
    const status: TimerStatus = shared.finishedAt(countdown, now, skew)
        ? "done"
        : countdown.state === "running"
          ? "running"
          : countdown.state === "paused"
            ? "paused"
            : "idle";
    return {
        status,
        remaining: shared.timeText(status === "done" ? 0 : left),
        // A rung timer's line says it is done, which the status already does.
        name: status === "done" ? fallbackName : (state?.detail ?? fallbackName)
    };
}

/** A button's variables for a timer's view. */
export function variableValues(prefix: string, view: TimerView): Record<string, string> {
    return {
        [`${prefix}_remaining`]: view.remaining,
        [`${prefix}_state`]: view.status,
        [`${prefix}_name`]: view.name
    };
}

/** A minute more on a timer kept here: one that ran out counts down a minute
 *  again, as Calendar's "+1 min" on a ringing timer does, and a reset still
 *  goes back to its whole length. */
export function addMinute(timer: local.TimerState, now: number): local.TimerState {
    const step = local.TIMER_LIMITS.stepMs;
    if (local.finished(timer, now))
        return { ...timer, startedAt: now, elapsedMs: timer.durationMs - step };
    const durationMs = Math.min(local.TIMER_LIMITS.maxMs, timer.durationMs + step);
    return { ...timer, durationMs };
}

/** A press on a timer kept here. Skipping a phase is the focus cycle's alone. */
export function applyLocal(timer: local.TimerState, op: Op, now: number): local.TimerState {
    if (op === "toggle") return local.toggle(timer, now);
    if (op === "reset") return local.reset(timer);
    if (op === "add") return addMinute(timer, now);
    return timer;
}

/** A local timer's length set on its button takes effect while it is stopped. */
export function withLength(
    timer: local.TimerState,
    minutes: number,
    now: number
): local.TimerState {
    if (local.running(timer) || local.elapsed(timer, now) > 0) return timer;
    return { ...timer, durationMs: local.newTimer("countdown", minutes * 60_000).durationMs };
}

/** The catalogue entry Polaris timers run, when this account has it. */
export function timerEntry(catalogue: readonly DeckAction[]): DeckAction | undefined {
    return catalogue.find((entry) => entry.id === shared.CALENDAR_TIMER);
}

/** The timers Polaris offers to pick from: a new one, the focus cycle and the
 *  account's own, as the catalogue last listed them. */
export function timerChoices(entry: DeckAction | undefined): { id: string; label: string }[] {
    const field = entry?.options.find((option) => option.name === TIMER_OPTION);
    const listed = (field?.choices ?? []).map((choice) => ({
        id: choice.value,
        label: choice.label
    }));
    return listed.length > 0 ? listed : [{ id: "new", label: "A new timer" }];
}

const ON_POLARIS = `$(options:${SOURCE_OPTION}) == 'polaris'`;

/** A timer button's options: where it is kept, which, and - for an action -
 *  what a press does. */
export function timerOptions(entry: DeckAction | undefined, withOp: boolean): OptionField[] {
    const fields: OptionField[] = [
        {
            type: "dropdown",
            id: SOURCE_OPTION,
            label: "Kept",
            default: "deck",
            choices: [
                { id: "deck", label: "On this machine" },
                ...(entry ? [{ id: "polaris", label: "In Polaris" }] : [])
            ],
            disableAutoExpression: true
        },
        {
            type: "dropdown",
            id: TIMER_OPTION,
            label: "Polaris timer",
            default: "new",
            choices: timerChoices(entry),
            isVisibleExpression: ON_POLARIS
        },
        {
            type: "textinput",
            id: NAME_OPTION,
            label: "Name (a new Polaris timer is found by it)",
            default: "",
            useVariables: false
        },
        {
            type: "number",
            id: MINUTES_OPTION,
            label: "Minutes",
            default: 5,
            min: 1,
            max: 1440
        }
    ];
    if (withOp) {
        fields.push({
            type: "dropdown",
            id: OP_OPTION,
            label: "A press",
            default: "toggle",
            choices: [
                { id: "toggle", label: "Start or pause" },
                { id: "reset", label: "Reset" },
                { id: "add", label: "Add a minute" },
                { id: "skip", label: "Skip the phase (focus cycle)" }
            ]
        });
    }
    return fields;
}
/** How a timer is named in its variables' descriptions. */
export function timerTitle(ref: TimerRef, choiceLabel: string | undefined): string {
    if (ref.source === "deck") return `Timer here "${ref.name}"`;
    if (ref.timer === "focus") return "Focus cycle";
    if (ref.timer === "new") return ref.name || "New timer";
    return choiceLabel ?? "Calendar timer";
}

/** Companion colours, by where a timer is. */
const STATUS_COLORS: Readonly<Record<TimerStatus, number>> = {
    running: COLORS.ok,
    paused: COLORS.warn,
    done: COLORS.bad,
    idle: COLORS.idle,
    unavailable: COLORS.off
};

/** How a button set to a timer looks: coloured by where it is, with its name
 *  and the time left when the feedback is set to show them. */
export function timerStyle(
    view: TimerView,
    withText: boolean
): { bgcolor: number; color: number; text?: string } {
    const style: { bgcolor: number; color: number; text?: string } = {
        bgcolor: STATUS_COLORS[view.status],
        color: COLORS.white
    };
    if (withText) style.text = view.remaining ? `${view.name}\n${view.remaining}` : view.name;
    return style;
}

/** A ready-made timer button. */
export interface TimerPreset {
    readonly id: string;
    readonly name: string;
    readonly options: Record<string, unknown>;
}

/** The ready-made timer buttons: one kept here, and - for an account with
 *  Calendar's timers - the focus cycle. */
export function timerPresets(polaris: boolean): TimerPreset[] {
    const presets: TimerPreset[] = [
        {
            id: "timer_local",
            name: "Timer",
            options: { source: "deck", timer: "new", name: "Timer", minutes: 5, op: "toggle" }
        }
    ];
    if (polaris) {
        presets.push({
            id: "timer_focus",
            name: "Focus cycle",
            options: { source: "polaris", timer: "focus", name: "", minutes: 25, op: "toggle" }
        });
    }
    return presets;
}
