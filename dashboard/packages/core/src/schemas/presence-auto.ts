/**
 * Automatic status: what somebody appears as while they are on a call or in a
 * meeting, without having to say so twice a day.
 *
 * The converged design, from Slack (a huddle sets "In a huddle", a synced
 * Google or Outlook calendar sets "In a meeting"), Microsoft Teams (presence
 * follows calls and the calendar: In a call, In a meeting) and Google Chat
 * (calendar-driven status): the automatic state is derived, never written over
 * what somebody chose, and it ends when the call or the event does.
 *
 * **A choice always wins.** Anything picked by hand - or held by a status
 * schedule, which is also somebody's own decision - outranks what is worked
 * out here. Automatic status only ever speaks for an account on `auto`.
 *
 * **Nothing is stored about the call or the meeting.** The setting is the only
 * row; whether it applies is worked out on the way past, from the call seats
 * that already lapse when heartbeats stop and from the calendar, so there is no
 * state that can be left behind on.
 *
 * **Others see the reason, never the event.** "In a meeting" or "Do not
 * disturb", not the title; that stays on the account's own screen.
 */

import { z } from "zod";

/** What an automatic status does: show the reason beside the dot, or turn on
 *  do not disturb with it. */
export const AUTO_PRESENCE_EFFECTS = ["status", "busy"] as const;

export type AutoPresenceEffect = (typeof AUTO_PRESENCE_EFFECTS)[number];

/** Why one applies. A call is the more immediate of the two, so it is the one
 *  said when both hold. */
export const AUTO_PRESENCE_REASONS = ["call", "meeting"] as const;

export type AutoPresenceReason = (typeof AUTO_PRESENCE_REASONS)[number];

/** The most minutes an event's edges may be widened by on either side. */
export const MAX_AUTO_PRESENCE_MARGIN = 30;

/** The most calendars a selection may name. */
export const MAX_AUTO_PRESENCE_CALENDARS = 50;

/** How far ahead the next meeting is looked for, so a screen holding the
 *  answer knows when to ask again. */
export const AUTO_PRESENCE_LOOKAHEAD_MS = 6 * 60 * 60_000;

const effectSchema = z.enum(AUTO_PRESENCE_EFFECTS);
const marginSchema = z.number().int().min(0).max(MAX_AUTO_PRESENCE_MARGIN);

export const autoPresenceCallSchema = z.object({
    enabled: z.boolean(),
    effect: effectSchema
});

export const autoPresenceMeetingSchema = z.object({
    enabled: z.boolean(),
    effect: effectSchema,
    /** The calendars that count, or null for every calendar the account owns. */
    calendars: z.array(z.string().uuid()).max(MAX_AUTO_PRESENCE_CALENDARS).nullable(),
    /** Whether an all-day event counts. Off by default: an all-day block is
     *  usually a holiday or a reminder, not somebody sitting in a room. */
    allDay: z.boolean(),
    beforeMinutes: marginSchema,
    afterMinutes: marginSchema
});

export const autoPresenceSchema = z.object({
    call: autoPresenceCallSchema,
    meeting: autoPresenceMeetingSchema
});

export type AutoPresence = z.infer<typeof autoPresenceSchema>;

/**
 * What an account that never opened the setting has.
 *
 * A call shows "In a call" and changes nothing else, which is what Slack does
 * for a huddle and what nobody has to be asked about: the dot stays as it was,
 * so nothing is silenced that was not before. The calendar is off until it is
 * switched on, because it is a new fact about somebody that others would see.
 */
export const DEFAULT_AUTO_PRESENCE: AutoPresence = {
    call: { enabled: true, effect: "status" },
    meeting: {
        enabled: false,
        effect: "busy",
        calendars: null,
        allDay: false,
        beforeMinutes: 0,
        afterMinutes: 0
    }
};

/**
 * The stored setting, read total: an empty column, a blob that is not JSON, or
 * a row written before a field existed each fall back to the default for the
 * part that does not read, never to an error.
 */
export function parseAutoPresence(raw: string | null | undefined): AutoPresence {
    let value: unknown = null;
    if (raw) {
        try {
            value = JSON.parse(raw);
        } catch {
            value = null;
        }
    }
    const stored = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const section = <T extends object>(schema: z.ZodType<T>, fallback: T, held: unknown): T => {
        const merged = held && typeof held === "object" ? { ...fallback, ...held } : fallback;
        const checked = schema.safeParse(merged);
        return checked.success ? checked.data : fallback;
    };
    return {
        call: section(autoPresenceCallSchema, DEFAULT_AUTO_PRESENCE.call, stored.call),
        meeting: section(autoPresenceMeetingSchema, DEFAULT_AUTO_PRESENCE.meeting, stored.meeting)
    };
}

/** One busy event as the calendar reports it, before the setting is applied. */
export interface BusyEvent {
    readonly start: Date;
    readonly end: Date;
    readonly allDay: boolean;
    readonly title: string;
}

/** The meeting somebody is in now, with its edges widened by their margins. */
export interface MeetingNow {
    readonly endsAt: Date;
    readonly title: string;
}

/**
 * The meeting in force at `now`, and when the next one starts.
 *
 * An event counts from `beforeMinutes` ahead of its start until `afterMinutes`
 * past its end, end exclusive - so the minute a meeting ends is the minute the
 * status goes. Back-to-back meetings read as one, ending when the last does.
 */
export function meetingAt(
    events: readonly BusyEvent[],
    settings: AutoPresence["meeting"],
    now: Date
): { current: MeetingNow | null; nextStartAt: Date | null } {
    const before = settings.beforeMinutes * 60_000;
    const after = settings.afterMinutes * 60_000;
    const blocks = events
        .filter((event) => settings.allDay || !event.allDay)
        .filter((event) => event.end.getTime() > event.start.getTime())
        .map((event) => ({
            from: event.start.getTime() - before,
            to: event.end.getTime() + after,
            title: event.title
        }))
        .sort((a, b) => a.from - b.from);
    const at = now.getTime();
    let current: { to: number; title: string } | null = null;
    let nextStartAt: Date | null = null;
    for (const block of blocks) {
        if (current && block.from <= current.to) {
            if (block.to > current.to) current = { to: block.to, title: current.title };
            continue;
        }
        if (block.from <= at && at < block.to) {
            current = { to: block.to, title: block.title };
            continue;
        }
        if (block.from > at) {
            nextStartAt = new Date(block.from);
            break;
        }
    }
    return {
        current: current ? { endsAt: new Date(current.to), title: current.title } : null,
        nextStartAt
    };
}

/** What automatic status says about somebody right now. */
export interface AutoPresenceView {
    readonly reason: AutoPresenceReason;
    /** Whether it turns on do not disturb, rather than only saying why. */
    readonly busy: boolean;
    /** When it ends, when that is known - a meeting's end. Null for a call,
     *  which ends when it ends. Only ever said to the account itself. */
    readonly until: string | null;
    /** The meeting's title. Only ever said to the account itself. */
    readonly title?: string;
}

/**
 * Which automatic status applies, given the facts.
 *
 * @param chosen - The presence in force from the account's own choices and
 *   schedule. Anything but `auto` wins and this answers null.
 */
export function autoPresenceOf(
    chosen: string,
    settings: AutoPresence,
    facts: { readonly onCall: boolean; readonly meeting: MeetingNow | null }
): AutoPresenceView | null {
    if (chosen !== "auto") return null;
    if (settings.call.enabled && facts.onCall) {
        return { reason: "call", busy: settings.call.effect === "busy", until: null };
    }
    if (settings.meeting.enabled && facts.meeting) {
        return {
            reason: "meeting",
            busy: settings.meeting.effect === "busy",
            until: facts.meeting.endsAt.toISOString(),
            title: facts.meeting.title
        };
    }
    return null;
}

/** The catalog word for one: the reason, and whether it is do not disturb. */
export function autoPresenceWord(
    view: Pick<AutoPresenceView, "reason" | "busy">
): "call" | "meeting" | "busyCall" | "busyMeeting" {
    if (view.reason === "call") return view.busy ? "busyCall" : "call";
    return view.busy ? "busyMeeting" : "meeting";
}

/** What another reader is told: the reason and whether it is do not disturb,
 *  never the event's title or when it ends. */
export function autoPresenceForOthers(view: AutoPresenceView): AutoPresenceView {
    return { reason: view.reason, busy: view.busy, until: null };
}
