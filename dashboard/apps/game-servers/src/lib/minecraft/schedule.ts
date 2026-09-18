/**
 * When a server should be up, and when it should be allowed to go quiet.
 *
 * A game server that nobody is on is a machine burning memory on an empty world,
 * and the answer people actually want is not "off" - it is "off overnight unless
 * somebody is playing, on the rest of the day". So a schedule is a set of windows
 * over the week, each saying one of three things: be on, be off, or sleep when
 * empty. Anything no window covers falls to a default, which is what makes
 * "always on except these hours" one rule rather than six.
 *
 * The times are read in a named zone rather than the server's own clock, because
 * "midnight to ten" is a statement about where the people playing are, and a
 * machine in another region would apply it eight hours out.
 *
 * Pure, and stored in the install's config beside the server's other settings, so
 * there is nothing new to migrate and nothing about a schedule that is kept in two
 * places. Acting on a decision is `schedule-service.ts`.
 */

/** What a window asks for. */
export type GameScheduleMode = "on" | "off" | "sleep";

export interface GameScheduleWindow {
    /** Days of the week it covers, 0 for Sunday. Empty means every day. */
    readonly days: readonly number[];
    /** Local time it starts, "HH:MM". */
    readonly from: string;
    /** Local time it ends, "HH:MM". Earlier than `from` means it runs past
     *  midnight, which is how the overnight window everybody wants is written. */
    readonly to: string;
    readonly mode: GameScheduleMode;
}

/**
 * A thing to do at a time, rather than a state to be in.
 *
 * The windows above answer "should this server be up right now", which is the
 * question a schedule was built for and not the only one people have. The rest are
 * errands: restart it before anybody is on, tell everyone the server is going down
 * in five minutes, take a backup at four in the morning, run the one command that
 * resets the arena.
 *
 * There is deliberately no "wait five minutes" step. Panels that have one sleep
 * inside the runner, and a sweep that sleeps is a sweep that is not sweeping - the
 * schedules of every other server on the box wait behind it. The warning sequence
 * everybody actually wants is two routines at two times, which says the same thing
 * and cannot wedge anything.
 */
export type RoutineActionKind = "command" | "broadcast" | "restart" | "backup";

export interface RoutineAction {
    readonly kind: RoutineActionKind;
    /** The command to run, or the message to send. Ignored by the two that take no
     *  argument. */
    readonly value: string;
}

export interface ScheduledRoutine {
    readonly id: string;
    /** What it is for, in the operator's words. Shown against its last result, so
     *  a routine that failed is nameable rather than "the one at 4am". */
    readonly name: string;
    readonly enabled: boolean;
    /** Days of the week it runs, 0 for Sunday. Empty means every day. */
    readonly days: readonly number[];
    /** Local time, "HH:MM", read in the schedule's own timezone. */
    readonly at: string;
    /** Run in order, and stopping at the first one that fails: the point of an
     *  order is that the later steps assumed the earlier ones happened. */
    readonly actions: readonly RoutineAction[];
}

/** What happened the last time a routine ran, kept so a schedule that quietly does
 *  nothing can be told apart from one that is working. */
export interface RoutineRun {
    readonly at: string;
    readonly ok: boolean;
    readonly detail: string;
}

/** Where those results live in the install's config, keyed by routine id. */
export const ROUTINE_RUNS_KEY = "routineRuns";

export interface GameSchedule {
    readonly enabled: boolean;
    /** IANA zone the times are read in, e.g. "Europe/Madrid". */
    readonly timezone: string;
    /** What happens at a time no window covers. */
    readonly otherwise: GameScheduleMode;
    /** How long with nobody on before a sleeping window stops the server. */
    readonly idleMinutes: number;
    readonly windows: readonly GameScheduleWindow[];
    /** Errands to run at a time, which is a different question from whether the
     *  server should be up. */
    readonly routines: readonly ScheduledRoutine[];
}

/** Off until somebody sets one up, so an install that has never been near this
 *  screen behaves exactly as it did before. */
export const NO_SCHEDULE: GameSchedule = {
    enabled: false,
    timezone: "UTC",
    otherwise: "on",
    idleMinutes: 30,
    windows: [],
    routines: []
};

/** Where the schedule lives inside the install's config. */
export const SCHEDULE_KEY = "schedule";

/** Where the sweep leaves what it saw, beside the schedule it was following. */
export const EMPTY_SINCE_KEY = "emptySince";
export const CHECKED_AT_KEY = "scheduleCheckedAt";

/**
 * What the last sweep saw, so a screen can say whether the schedule is being
 * followed at all.
 *
 * Worth showing for one reason: a schedule that never fires and a schedule with
 * nothing to do look identical from the outside, and the first is what somebody
 * reports as "I set it and it did nothing". A time here is the sweep saying it
 * ran; no time is the sweep never having reached this server.
 */
export interface ScheduleState {
    /** When a sweep last looked at this server. */
    readonly checkedAt: string | null;
    /** Since when it has had nobody on it, as the sweep last recorded. */
    readonly emptySince: string | null;
}

export function readScheduleState(config: Record<string, unknown>): ScheduleState {
    const read = (key: string): string | null => (typeof config[key] === "string" ? (config[key] as string) : null);
    return { checkedAt: read(CHECKED_AT_KEY), emptySince: read(EMPTY_SINCE_KEY) };
}

/** How long a server may sit empty before a sleeping window stops it, at the
 *  extremes. Under five minutes it would stop between two people arriving; past a
 *  day it is not a sleep, it is being on. */
export const MIN_IDLE_MINUTES = 5;
export const MAX_IDLE_MINUTES = 24 * 60;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since midnight, or null when the text is not a time. */
export function parseTime(value: string): number | null {
    const match = TIME.exec(value.trim());
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * A schedule out of a stored config blob.
 *
 * Anything malformed falls back to the default rather than throwing: it is a
 * settings blob written by an older version of this screen or by hand, and a bad
 * entry must not take down the page somebody would fix it from.
 */
export function readSchedule(config: Record<string, unknown>): GameSchedule {
    const raw = config[SCHEDULE_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NO_SCHEDULE;
    const value = raw as Partial<Record<keyof GameSchedule, unknown>>;
    const windows = Array.isArray(value.windows) ? value.windows.flatMap(readWindow) : [];
    return {
        enabled: value.enabled === true,
        timezone: typeof value.timezone === "string" && value.timezone.length > 0 ? value.timezone : "UTC",
        otherwise: readMode(value.otherwise) ?? "on",
        idleMinutes: clampIdle(typeof value.idleMinutes === "number" ? value.idleMinutes : NO_SCHEDULE.idleMinutes),
        windows,
        routines: Array.isArray(value.routines) ? value.routines.flatMap(readRoutine) : []
    };
}

export function clampIdle(minutes: number): number {
    if (!Number.isFinite(minutes)) return NO_SCHEDULE.idleMinutes;
    return Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, Math.round(minutes)));
}

function readMode(value: unknown): GameScheduleMode | null {
    return value === "on" || value === "off" || value === "sleep" ? value : null;
}

function readWindow(value: unknown): GameScheduleWindow[] {
    if (typeof value !== "object" || value === null) return [];
    const entry = value as Partial<Record<keyof GameScheduleWindow, unknown>>;
    const mode = readMode(entry.mode);
    const from = typeof entry.from === "string" ? entry.from : "";
    const to = typeof entry.to === "string" ? entry.to : "";
    if (!mode || parseTime(from) === null || parseTime(to) === null) return [];
    const days = Array.isArray(entry.days)
        ? [...new Set(entry.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))]
        : [];
    return [{ days: days.sort(), from, to, mode }];
}

/** The day and the minute-of-day a moment falls on, in a named zone. */
export function zonedMoment(at: Date, timezone: string): { day: number; minutes: number } {
    // Intl is the only thing in the platform that knows a zone's rules, daylight
    // saving included. A fixed offset would be right for half the year.
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(at);
    const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return {
        day: Math.max(0, days.indexOf(read("weekday"))),
        minutes: Number(read("hour")) * 60 + Number(read("minute"))
    };
}

/** Whether a window is in force at a moment. A window that ends before it starts
 *  runs past midnight, and on that side of the break it belongs to the previous
 *  day - which is what makes "Friday 23:00 to 06:00" cover Saturday morning. */
export function windowCovers(window: GameScheduleWindow, day: number, minutes: number): boolean {
    const from = parseTime(window.from);
    const to = parseTime(window.to);
    if (from === null || to === null) return false;
    const onDay = (which: number): boolean => window.days.length === 0 || window.days.includes(which);
    if (from <= to) return onDay(day) && minutes >= from && minutes < to;
    // Past midnight: the evening half belongs to today, the morning half to the
    // day the window started on.
    if (minutes >= from) return onDay(day);
    return minutes < to && onDay((day + 6) % 7);
}

/** What the schedule asks for at a moment. The last window that covers it wins,
 *  so a specific rule written after a general one overrides it - the order on
 *  screen is the order they are read in. */
export function scheduleModeAt(schedule: GameSchedule, at: Date): GameScheduleMode {
    if (!schedule.enabled) return "on";
    const { day, minutes } = zonedMoment(at, schedule.timezone);
    let mode = schedule.otherwise;
    for (const window of schedule.windows) {
        if (windowCovers(window, day, minutes)) mode = window.mode;
    }
    return mode;
}

/** What the server is doing, as far as a decision is concerned. */
export interface ServerCondition {
    /** Whether it is meant to be up. */
    readonly running: boolean;
    /** How many people are on it, and null when the server could not be asked.
     *  Not the same as nought: a server still unpacking its first thirty gigabytes
     *  answers nothing, and reading that as "empty" stops an install halfway
     *  through the one start that takes an hour. */
    readonly playersOnline: number | null;
    /** When it was last seen with nobody on it, ISO 8601. Null when it has never
     *  been seen empty, which is not the same as having just emptied. */
    readonly emptySince: string | null;
}

/**
 * What to do about a server right now: start it, stop it, or leave it alone.
 *
 * A sleeping window never starts anything. Sleep is permission to go quiet, not
 * an instruction to come back - coming back is a window that says "on", or
 * somebody pressing start. Saying otherwise would have a server wake at three in
 * the morning to notice it was empty and stop again.
 *
 * A server that could not be asked who is on it is never slept either. "Keep
 * stopped" still stops it - that decision does not depend on anybody - but
 * "sleep when empty" is a claim about the people playing, and silence is not that
 * claim.
 */
export function scheduleAction(
    schedule: GameSchedule,
    at: Date,
    condition: ServerCondition
): "start" | "stop" | null {
    if (!schedule.enabled) return null;
    const mode = scheduleModeAt(schedule, at);
    if (mode === "on") return condition.running ? null : "start";
    if (mode === "off") return condition.running ? "stop" : null;
    if (!condition.running || condition.playersOnline === null || condition.playersOnline > 0) return null;
    if (!condition.emptySince) return null;
    const emptyFor = at.getTime() - Date.parse(condition.emptySince);
    return Number.isNaN(emptyFor) || emptyFor < schedule.idleMinutes * 60_000 ? null : "stop";
}

/** One line saying what the schedule is doing, for the screen that sets it. */
export function describeSchedule(schedule: GameSchedule, at: Date): string {
    if (!schedule.enabled) return "No schedule. The server stays as you leave it.";
    const mode = scheduleModeAt(schedule, at);
    if (mode === "on") return "Right now: kept running.";
    if (mode === "off") return "Right now: kept stopped.";
    return `Right now: stopped once nobody has played for ${schedule.idleMinutes} minutes.`;
}

/** The longest a message or a command is allowed to be, so a settings blob cannot
 *  become a way to push arbitrary length into a container. */
const ROUTINE_VALUE_MAX = 400;

function readAction(value: unknown): RoutineAction[] {
    if (typeof value !== "object" || value === null) return [];
    const entry = value as Partial<Record<keyof RoutineAction, unknown>>;
    const kind = entry.kind;
    if (kind !== "command" && kind !== "broadcast" && kind !== "restart" && kind !== "backup") return [];
    const raw = typeof entry.value === "string" ? entry.value.trim().slice(0, ROUTINE_VALUE_MAX) : "";
    // The two that take an argument are nothing without one: an empty broadcast is
    // a message nobody sees, and an empty command is a step that silently does
    // nothing in the middle of a sequence that assumed it did something.
    if ((kind === "command" || kind === "broadcast") && raw.length === 0) return [];
    return [{ kind, value: raw }];
}

function readRoutine(value: unknown): ScheduledRoutine[] {
    if (typeof value !== "object" || value === null) return [];
    const entry = value as Partial<Record<keyof ScheduledRoutine, unknown>>;
    const at = typeof entry.at === "string" ? entry.at : "";
    if (parseTime(at) === null) return [];
    const actions = Array.isArray(entry.actions) ? entry.actions.flatMap(readAction) : [];
    if (actions.length === 0) return [];
    const days = Array.isArray(entry.days)
        ? [...new Set(entry.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))]
        : [];
    return [
        {
            id: typeof entry.id === "string" && entry.id.length > 0 ? entry.id : at,
            name: typeof entry.name === "string" ? entry.name.slice(0, 80) : "",
            enabled: entry.enabled !== false,
            days: days.sort(),
            at,
            actions
        }
    ];
}

/** What was recorded about each routine's last run. */
export function readRoutineRuns(config: Record<string, unknown>): Record<string, RoutineRun> {
    const raw = config[ROUTINE_RUNS_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const runs: Record<string, RoutineRun> = {};
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) continue;
        const entry = value as Record<string, unknown>;
        if (typeof entry.at !== "string") continue;
        runs[id] = {
            at: entry.at,
            ok: entry.ok !== false,
            detail: typeof entry.detail === "string" ? entry.detail : ""
        };
    }
    return runs;
}

/**
 * Which routines are due right now.
 *
 * Due means the local clock has reached the minute it asks for and it has not
 * already run in that minute. Both halves matter: the sweep runs about once a
 * minute but not exactly, so an equality test alone would miss a routine whenever
 * a pass landed a few seconds late - and a sweep that ran twice in the same minute
 * would restart the server twice.
 *
 * So a routine fires when its minute has arrived and the last run was in an
 * earlier minute, and a pass that was late still catches it. A pass that was very
 * late - the box was asleep, the container was down for an hour - does not: an
 * errand whose moment passed long ago is one nobody wants suddenly happening now.
 */
export function routinesDue(
    schedule: GameSchedule,
    at: Date,
    runs: Record<string, RoutineRun>,
    graceMinutes = 10
): ScheduledRoutine[] {
    if (!schedule.enabled) return [];
    const { day, minutes } = zonedMoment(at, schedule.timezone);
    return schedule.routines.filter((routine) => {
        if (!routine.enabled) return false;
        if (routine.days.length > 0 && !routine.days.includes(day)) return false;
        const wanted = parseTime(routine.at);
        if (wanted === null) return false;
        const late = minutes - wanted;
        if (late < 0 || late > graceMinutes) return false;

        const last = runs[routine.id];
        if (!last) return true;
        const lastAt = Date.parse(last.at);
        if (Number.isNaN(lastAt)) return true;
        // Ran already for this occurrence: same day, and at or after the minute it
        // was due. Compared in the same zone the routine is written in.
        const previous = zonedMoment(new Date(lastAt), schedule.timezone);
        const sameDay = at.getTime() - lastAt < 23 * 60 * 60 * 1000 && previous.day === day;
        return !(sameDay && previous.minutes >= wanted);
    });
}
