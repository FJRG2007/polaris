/**
 * What runs the automations: deciding when one fires, whether it may, and
 * walking its steps.
 *
 * Everything it touches comes in through `EnginePorts` - the clock, the rows,
 * the devices, the owner's rights, the bell - so the whole of it can be run
 * against a fake clock and an in-memory store, and the one wired to the database
 * (`automation-runtime.ts`) is only plumbing.
 *
 * The rules it keeps:
 *
 * - **A firing happens once.** Every run carries a key naming what fired it (this
 *   07:00, this change of this device, this press of Run now) and the store
 *   refuses a second row with the same key. Two passes, two processes or a pass
 *   that ran twice all come out as one run.
 * - **Nothing waits in memory.** A delay or a wait is a due time on the run's row,
 *   and the minute tick resumes whatever is due. A short delay also sets a timer
 *   to come back sooner, but the row is what counts: a restart in the middle of a
 *   two-hour delay loses nothing.
 * - **Loops end.** An automation started by another carries a depth, and so does
 *   one fired by a device a run just moved; past `MAX_DEPTH` it is refused. And
 *   however it is fired, one automation runs at most `RATE_MAX` times in
 *   `RATE_WINDOW_MS`.
 * - **It acts as its owner, every time.** The owner's right to operate the house
 *   is asked again at the start of each run, and a device step goes through the
 *   same service as the button on the screen.
 *
 * Server-only.
 */

import * as auto from "./automation-kinds";
import type { DeviceAction, DeviceCommand } from "./device-kinds";
import { AsyncLocalStorage } from "node:async_hooks";
import {
    durationSeconds,
    sunEventOn,
    wallClock,
    zonedInstant,
    type CalendarDay,
    type Coordinate,
    type Offset
} from "@polaris/core";

/** How far into a chain of automations starting one another a run may be. */
export const MAX_DEPTH = 4;
/** How many runs one automation may start in a window, whatever fires it. */
export const RATE_MAX = 20;
export const RATE_WINDOW_MS = 10 * 60 * 1000;
/** How late a time of day or an interval may still be honoured - a tick that ran
 *  late, or a restart. Longer than this and it was missed, not late. */
export const CATCH_UP_MS = 10 * 60 * 1000;
/** How long a runner holds a run before another may take it over. */
export const LEASE_MS = 2 * 60 * 1000;
/** How often a waiting step looks again when nothing wakes it sooner. */
export const RECHECK_MS = 60 * 1000;
/** The longest delay kept as a timer in memory as well as on the row. */
export const TIMER_MS = 60 * 1000;
/** How many runs of one automation the log keeps. */
export const KEEP_RUNS = 100;

// --- what the engine is given ---------------------------------------------------

export interface AutomationRecord {
    readonly id: string;
    readonly installedAppId: string;
    readonly placeId: string;
    readonly ownerId: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly definition: auto.AutomationDefinition;
    readonly armedAt: Date;
    /** Where its place is, for the sun. Absent or null, a sun trigger never
     *  fires and a sun condition never passes. */
    readonly location?: Coordinate | null;
    /** Set for an automation that lives in the central engine: its triggers are
     *  decided here, by the same rules, and a firing starts a central run. */
    readonly central?: {
        readonly automationId: string;
        /** The Places automation it moved from, whose own runs already hold some firings. */
        readonly legacyId: string | null;
    };
}

export interface RunRecord {
    readonly id: string;
    readonly automationId: string;
    readonly firingKey: string;
    readonly cause: auto.RunCause;
    readonly depth: number;
    readonly status: auto.RunStatus;
    readonly step: number;
    readonly dueAt: Date | null;
    readonly waitUntil: Date | null;
    readonly waitDeviceId: string | null;
    readonly lockedUntil: Date | null;
    readonly steps: readonly auto.StepLog[];
    readonly reason: string | null;
    readonly startedAt: Date;
    readonly finishedAt: Date | null;
}

export type RunPatch = Partial<Omit<RunRecord, "id" | "automationId" | "firingKey">>;

/** What a device was last seen doing, and since when. */
export interface Observation {
    readonly state: string;
    readonly stateSince: Date;
    readonly door: string;
    readonly doorSince: Date;
    readonly reading: string;
    readonly readingSince: Date;
    /** An air conditioner's mode, or empty for anything else. */
    readonly mode: string;
    readonly modeSince: Date;
    /** A purifier's most worn filter (ok, soon, now), or absent for anything
     *  else. */
    readonly filter?: string;
    readonly filterSince?: Date;
    /** A purifier's figures by measure - the dust, the humidity, the filter
     *  life - each with when it last changed. Absent for anything else. */
    readonly figures?: Readonly<Record<string, Figure>>;
    /** Whether it was answering (online, offline), and since when. Absent on a
     *  row from before this was kept, which was only ever written while it was. */
    readonly online?: string;
    readonly onlineSince?: Date;
    /** Its battery (low, ok), and since when. Absent for a device that has
     *  reported none. */
    readonly battery?: string;
    readonly batterySince?: Date;
    /** What each attribute was before its last change, so a change held for a
     *  while can still be told apart by where it came from. Absent until the
     *  first change is seen. */
    readonly before?: Readonly<Partial<Record<auto.AutomationAttribute, string>>>;
    /** Since when a reading has passed each line a "for" waits on, by reading
     *  (`READING_KEY` for the device's one reading, else the measure) and then
     *  by line (`lineKey`) - what tells how long a figure has been past a line
     *  when it moves on every sync. Only the lines an enabled automation
     *  watches, and only while the reading passes them. */
    readonly held?: Readonly<Record<string, Readonly<Record<string, Held>>>>;
    /** Counts every change, so each one has a name of its own even when two
     *  land in the same millisecond - and so the swap has one field to compare. */
    readonly version: number;
}

/** The key of a device's one reading among `held`, beside the measures' own. */
export const READING_KEY = "reading";

/** Since when a reading has passed a line, and - when it was seen to cross it -
 *  the value it came from. */
export interface Held {
    readonly since: Date;
    readonly from?: string;
}

/** A test on a figure that a "for" waits on: a threshold's side of its line or
 *  a reading condition's comparison, in the comparison's terms. */
export interface Line {
    readonly op: auto.Comparison;
    readonly value: number;
    readonly upper?: number;
}

/** One name for each line, so two automations waiting on the same one share it. */
export function lineKey(line: Line): string {
    const ranged = line.op === "between" || line.op === "outside";
    return `${line.op}:${line.value}${ranged ? `:${line.upper ?? ""}` : ""}`;
}

/** A threshold's line as a comparison: past it is above or below its value, or
 *  inside or outside its range. */
function thresholdLine(threshold: {
    direction: auto.ThresholdDirection;
    value: number;
    upper?: number;
}): Line {
    const { direction, value, upper } = threshold;
    const op = direction === "above" ? "gt" : direction === "below" ? "lt" : direction;
    return { op, value, upper };
}

function passesLine(line: Line, value: string): boolean {
    const figure = numberOf(value);
    return figure !== null && compare(figure, line.op, line.value, line.upper);
}

/**
 * The lines a reading passes after it changed from `before` to `after`, each
 * with since when: from now when `before` did not pass it - a crossing - and
 * otherwise from when the run it is part of began.
 */
export function heldAfter(
    previous: Readonly<Record<string, Held>> | undefined,
    before: Figure,
    after: string,
    now: Date,
    lines: readonly Line[]
): Record<string, Held> {
    const next: Record<string, Held> = {};
    for (const line of lines) {
        const key = lineKey(line);
        if (!passesLine(line, after)) continue;
        next[key] = passesLine(line, before.value)
            ? (previous?.[key] ?? { since: before.since })
            : { since: now, from: before.value };
    }
    return next;
}

/** One figure as last seen, and since when. */
export interface Figure {
    readonly value: string;
    readonly since: Date;
}

/** A device as the engine reads it. */
export interface DeviceReadout {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    readonly state: string;
    readonly door: string;
    readonly reading: string;
    /** An air conditioner's mode, or empty for anything else. */
    readonly mode: string;
    /** A purifier's most worn filter's state, and its figures by measure. */
    readonly filter?: string;
    readonly figures?: Readonly<Record<string, string>>;
    readonly online: boolean;
    /** Its battery as `batteryWord` reads it (low, ok), or absent for none. */
    readonly battery?: string;
}

export interface AutomationStore {
    enabledAutomations(installedAppId: string): Promise<AutomationRecord[]>;
    automation(id: string): Promise<AutomationRecord | null>;
    /** A new run, or null when one with this key already exists. */
    createRun(input: {
        automationId: string;
        firingKey: string;
        cause: auto.RunCause;
        depth: number;
        status: auto.RunStatus;
        dueAt: Date | null;
        startedAt: Date;
        steps?: readonly auto.StepLog[];
        reason?: string | null;
        finishedAt?: Date | null;
    }): Promise<RunRecord | null>;
    /** How many runs that actually ran started since then. */
    countRunsSince(automationId: string, since: Date): Promise<number>;
    /** Take the queued and waiting runs that are due and free, marking each held
     *  until `lockUntil`. A run another runner holds is not returned. */
    claimDueRuns(now: Date, lockUntil: Date, limit: number): Promise<RunRecord[]>;
    /** Write to a run that is still queued, waiting or running. False when it
     *  has ended meanwhile - stopped from the screen, or removed with its
     *  automation - and nothing was written. */
    saveRun(id: string, patch: RunPatch): Promise<boolean>;
    /** Bring forward every run waiting on this device, so it looks now. */
    wakeWaiting(deviceId: string, now: Date): Promise<void>;
    markAutomation(id: string, at: Date, status: auto.RunStatus): Promise<void>;
    observation(deviceId: string): Promise<Observation | null>;
    /** Replace what a device was seen doing, only if it is still `previous`. */
    swapObservation(
        deviceId: string,
        previous: Observation | null,
        next: Observation
    ): Promise<boolean>;
    pruneRuns(automationId: string, keep: number): Promise<void>;
}

/** Why a device step did not happen, as the device service refuses. */
export class StepRefusal extends Error {}

export interface EnginePorts {
    readonly now: () => Date;
    readonly store: AutomationStore;
    readonly devices: {
        read(installedAppId: string, deviceId: string): Promise<DeviceReadout | null>;
        /** Throws a `StepRefusal` with a sentence Places wrote, or anything else
         *  for a fault. */
        act(
            installedAppId: string,
            deviceId: string,
            action: DeviceAction,
            by: { ownerId: string; automationId: string; automationName: string },
            /** What to set, for a step that sets something. */
            setting?: DeviceCommand
        ): Promise<void>;
    };
    /** Whether the owner still holds a right: "run" is keeping automations at
     *  all, "control" is operating the devices a step names. */
    readonly mayOperate: (ownerId: string, right: "run" | "control") => Promise<boolean>;
    readonly notify: (
        automation: AutomationRecord,
        message: string,
        runId: string
    ) => Promise<void>;
    /** The place's devices by room and its rooms by floor, which a block naming
     *  a room or a floor is read against each time it is looked at - so a
     *  device moved into the kitchen counts for "the kitchen" from then on.
     *  Absent, a room or a floor holds nothing. */
    readonly places?: (installedAppId: string, placeId: string) => Promise<auto.TargetScope>;
    /** Start a central run for an automation that has `central`. True when one started. */
    readonly central?: (
        automation: AutomationRecord,
        firingKey: string,
        cause: auto.RunCause,
        depth: number
    ) => Promise<boolean>;
    /** Come back and drain in this many milliseconds. */
    readonly wake?: (ms: number) => void;
    /** Where a fault that is not a refusal is written. */
    readonly log?: (message: string, error: unknown) => void;
}

/** Which run, if any, the current work is being done on behalf of - so a device
 *  it moves passes its depth on to whatever that change fires. */
const causeContext = new AsyncLocalStorage<{ readonly depth: number }>();

/** Do `work` on behalf of a run this deep in a chain - a central run's device
 *  step - so whatever a device it moves fires carries the depth on. */
export function withCauseDepth<T>(depth: number, work: () => Promise<T>): Promise<T> {
    return causeContext.run({ depth }, work);
}

function iso(date: Date): string {
    return date.toISOString();
}

// --- reading devices ------------------------------------------------------------

/** The value of one attribute, as triggers and conditions compare it. */
function attributeOf(
    source: {
        state: string;
        door: string;
        reading: string;
        mode: string;
        filter?: string;
        online?: boolean | string;
        battery?: string;
    },
    attribute: auto.AutomationAttribute
): string {
    // A readout says whether it answers as a flag, an observation as the word;
    // a row from before either was kept was written while it answered.
    if (attribute === "online")
        return source.online === false || source.online === "offline" ? "offline" : "online";
    if (attribute === "battery") return source.battery ?? "";
    if (attribute === "door") return source.door;
    if (attribute === "reading") return source.reading;
    if (attribute === "mode") return source.mode;
    if (attribute === "filter") return source.filter ?? "";
    return source.state;
}

/** Two words for the same thing. A reading is whatever the sensor sends, in
 *  whatever case; a state is one of ours. */
function same(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function numberOf(text: string): number | null {
    const match = /-?\d+(?:[.,]\d+)?/.exec(text);
    if (!match) return null;
    const value = Number(match[0].replace(",", "."));
    return Number.isFinite(value) ? value : null;
}

/** Whether a figure passes a reading condition's test. Both ends of a range
 *  are inside it, and a range with no top above its bottom passes nothing. */
function compare(
    value: number,
    op: auto.Comparison,
    against: number,
    upper: number | undefined
): boolean {
    switch (op) {
        case "gt":
            return value > against;
        case "gte":
            return value >= against;
        case "lt":
            return value < against;
        case "lte":
            return value <= against;
        case "eq":
            return value === against;
        case "ne":
            return value !== against;
        case "between":
        case "outside": {
            if (upper === undefined || !(upper > against)) return false;
            const inside = value >= against && value <= upper;
            return op === "between" ? inside : !inside;
        }
    }
}

function minutesOf(clock: string): number {
    const [hours, minutes] = clock.split(":").map(Number);
    return (hours ?? 0) * 60 + (minutes ?? 0);
}

// --- the engine -------------------------------------------------------------------

export interface Transition {
    readonly deviceId: string;
    readonly attribute: auto.AutomationAttribute;
    /** Which of a purifier's figures changed, for a reading that is one. */
    readonly measure?: auto.ReadingMeasure;
    readonly from: string;
    readonly to: string;
    readonly at: Date;
    /** The observation this change made, which is what names the firing. */
    readonly version: number;
}

/** One device of a trigger that has to last, being the way it waits for. */
interface Lasting {
    /** What the time it has to last is counted from. */
    readonly start: Date;
    /** The firing's name, before the device's own for a set of them. */
    readonly key: string;
    readonly cause: auto.RunCause & { readonly deviceId: string };
}

/**
 * Which of a set's devices fire, from the ones being that way: each of them; the
 * first to get there, alone; or, once every device answering is, the last to.
 * `present` is how many of the set are answering at all - a silent one is not
 * held against "all of them".
 */
export function pickHeld(
    behaviour: auto.Behaviour,
    held: readonly Lasting[],
    present: number
): Lasting[] {
    if (held.length === 0) return [];
    const byStart = [...held].sort((a, b) => a.start.getTime() - b.start.getTime());
    if (behaviour === "first") return byStart.slice(0, 1);
    if (behaviour === "all") return held.length >= present ? byStart.slice(-1) : [];
    return byStart;
}

/**
 * Whether a set's device counts towards its trigger: one that is answering, or
 * any of them where whether it is answering is the very question.
 */
function answers(trigger: auto.Trigger, seen: Observation): boolean {
    if (seen.online !== "offline") return true;
    return (
        (trigger.kind === "change" || trigger.kind === "stays") && trigger.attribute === "online"
    );
}

export function createEngine(ports: EnginePorts) {
    const { store } = ports;

    const NOWHERE: auto.TargetScope = { devices: [], rooms: [] };

    /** An automation as it runs: its rooms and floors read into devices. */
    async function placed(automation: AutomationRecord): Promise<AutomationRecord> {
        if (!auto.namesPlaces(automation.definition)) return automation;
        const scope = ports.places
            ? await ports.places(automation.installedAppId, automation.placeId)
            : NOWHERE;
        return { ...automation, definition: auto.resolveDefinition(automation.definition, scope) };
    }

    /** The enabled automations of an install, their rooms and floors read once
     *  per place. */
    async function enabled(installedAppId: string): Promise<AutomationRecord[]> {
        const list = await store.enabledAutomations(installedAppId);
        if (!list.some((each) => auto.namesPlaces(each.definition))) return list;
        const scopes = new Map<string, Promise<auto.TargetScope>>();
        return Promise.all(
            list.map(async (automation) => {
                if (!auto.namesPlaces(automation.definition)) return automation;
                let scope = scopes.get(automation.placeId);
                if (!scope) {
                    scope = ports.places
                        ? ports.places(installedAppId, automation.placeId)
                        : Promise.resolve(NOWHERE);
                    scopes.set(automation.placeId, scope);
                }
                return {
                    ...automation,
                    definition: auto.resolveDefinition(automation.definition, await scope)
                };
            })
        );
    }

    async function one(id: string): Promise<AutomationRecord | null> {
        const found = await store.automation(id);
        return found ? placed(found) : null;
    }
    let draining: Promise<void> | null = null;
    let again = false;

    const fault = (message: string, error: unknown) =>
        (ports.log ?? ((said, caught) => console.error(`places: ${said}`, caught)))(message, error);

    /**
     * Start a run, unless this firing already has one or the automation has run
     * too often lately. Returns whether a run was queued.
     */
    async function fire(
        automation: AutomationRecord,
        firingKey: string,
        cause: auto.RunCause,
        depth: number
    ): Promise<boolean> {
        if (automation.central) return ports.central ? ports.central(automation, firingKey, cause, depth) : false;
        const now = ports.now();
        if (depth > MAX_DEPTH) {
            // Written once per firing, so the log says why a chain stopped rather
            // than going quiet.
            await store.createRun({
                automationId: automation.id,
                firingKey,
                cause,
                depth,
                status: "refused",
                dueAt: null,
                startedAt: now,
                finishedAt: now,
                reason: "loop"
            });
            await store.markAutomation(automation.id, now, "refused");
            return false;
        }
        const recent = await store.countRunsSince(
            automation.id,
            new Date(now.getTime() - RATE_WINDOW_MS)
        );
        if (recent >= RATE_MAX) {
            // One row per window, not one per firing: a device flapping twice a
            // second would otherwise fill the log with the same sentence.
            const window = Math.floor(now.getTime() / RATE_WINDOW_MS);
            const written = await store.createRun({
                automationId: automation.id,
                firingKey: `limited:${window}`,
                cause,
                depth,
                status: "limited",
                dueAt: null,
                startedAt: now,
                finishedAt: now,
                reason: "limited"
            });
            if (written) await store.markAutomation(automation.id, now, "limited");
            return false;
        }
        const run = await store.createRun({
            automationId: automation.id,
            firingKey,
            cause,
            depth,
            status: "queued",
            dueAt: now,
            startedAt: now
        });
        if (!run) return false;
        await store.pruneRuns(automation.id, KEEP_RUNS);
        return true;
    }

    /**
     * What a device is doing now, compared with what it was last seen doing.
     *
     * The comparison is a swap on the stored row that only succeeds against the
     * row that was read, so however many syncs see the same change at once, one
     * of them fires the automations and the rest find nothing new. The first time
     * a device is seen is not a change.
     *
     * A device that stops answering is a change of its own - to offline - and
     * nothing else it says is current until it answers again: its last state,
     * door and readings are kept as they were. The first reading after it comes
     * back is where it is now, not something it just did, so it is kept without
     * firing anything but the return itself; a door that was closed when the
     * hub dropped and reads open when it returns did not just open.
     */
    async function observe(installedAppId: string, device: DeviceReadout): Promise<Transition[]> {
        const now = ports.now();
        const online = device.online ? "online" : "offline";
        const previous = await store.observation(device.id);
        const passing = device.state === "moving" || device.state === "unknown";
        const state = passing ? (previous?.state ?? device.state) : device.state;
        const seenFigures = (figures: Readonly<Record<string, string>> | undefined) =>
            Object.fromEntries(
                Object.entries(figures ?? {}).map(([key, value]) => [key, { value, since: now }])
            );
        if (!previous) {
            await store.swapObservation(device.id, null, {
                state,
                stateSince: now,
                door: device.door,
                doorSince: now,
                reading: device.reading,
                readingSince: now,
                mode: device.mode,
                modeSince: now,
                ...(device.filter ? { filter: device.filter, filterSince: now } : {}),
                ...(device.figures ? { figures: seenFigures(device.figures) } : {}),
                online,
                onlineSince: now,
                ...(device.battery ? { battery: device.battery, batterySince: now } : {}),
                version: 0
            });
            return [];
        }
        const changed: Transition[] = [];
        const moved: { key: string; before: Figure; after: string }[] = [];
        const next = {
            state: previous.state,
            stateSince: previous.stateSince,
            door: previous.door,
            doorSince: previous.doorSince,
            reading: previous.reading,
            readingSince: previous.readingSince,
            mode: previous.mode,
            modeSince: previous.modeSince,
            filter: previous.filter,
            filterSince: previous.filterSince,
            figures: previous.figures ? { ...previous.figures } : undefined,
            online: previous.online,
            onlineSince: previous.onlineSince,
            battery: previous.battery,
            batterySince: previous.batterySince,
            before: { ...(previous.before ?? {}) } as Partial<
                Record<auto.AutomationAttribute, string>
            >,
            held: { ...(previous.held ?? {}) } as Record<string, Readonly<Record<string, Held>>>,
            version: previous.version + 1
        };
        const version = next.version;
        const wasOnline = previous.online !== "offline";
        if (device.online !== wasOnline) {
            changed.push({
                deviceId: device.id,
                attribute: "online",
                from: wasOnline ? "online" : "offline",
                to: online,
                at: now,
                version
            });
            next.before.online = wasOnline ? "online" : "offline";
            next.online = online;
            next.onlineSince = now;
        }
        // Silent: nothing it says is current, so its last values stand.
        if (!device.online) {
            if (changed.length === 0) return [];
            return (await settle(installedAppId, device.id, previous, next, changed, moved, now))
                ? changed
                : [];
        }
        if (state !== previous.state) {
            changed.push({
                deviceId: device.id,
                attribute: "state",
                from: previous.state,
                to: state,
                at: now,
                version
            });
            next.before.state = previous.state;
            next.state = state;
            next.stateSince = now;
        }
        if (device.door !== previous.door) {
            changed.push({
                deviceId: device.id,
                attribute: "door",
                from: previous.door,
                to: device.door,
                at: now,
                version
            });
            next.before.door = previous.door;
            next.door = device.door;
            next.doorSince = now;
        }
        if (device.reading !== previous.reading) {
            changed.push({
                deviceId: device.id,
                attribute: "reading",
                from: previous.reading,
                to: device.reading,
                at: now,
                version
            });
            next.before.reading = previous.reading;
            moved.push({
                key: READING_KEY,
                before: { value: previous.reading, since: previous.readingSince },
                after: device.reading
            });
            next.reading = device.reading;
            next.readingSince = now;
        }
        // A unit that is off reports no mode worth reacting to; its last one is
        // kept, so switching it on in the same mode is not a change of mode.
        if (device.mode && device.mode !== previous.mode) {
            changed.push({
                deviceId: device.id,
                attribute: "mode",
                from: previous.mode,
                to: device.mode,
                at: now,
                version
            });
            next.before.mode = previous.mode;
            next.mode = device.mode;
            next.modeSince = now;
        }
        // A purifier's figures, each its own change: the dust crossing a line is
        // not the humidity crossing one. A figure the device stopped reporting
        // keeps its last value rather than reading as a change to nothing.
        for (const [measure, value] of Object.entries(device.figures ?? {})) {
            const before = next.figures?.[measure];
            if (before && before.value === value) continue;
            next.figures = { ...(next.figures ?? {}), [measure]: { value, since: now } };
            if (!before) continue;
            moved.push({ key: measure, before, after: value });
            changed.push({
                deviceId: device.id,
                attribute: "reading",
                measure: measure as auto.ReadingMeasure,
                from: before.value,
                to: value,
                at: now,
                version
            });
        }
        if (device.filter && device.filter !== previous.filter) {
            if (previous.filter) {
                changed.push({
                    deviceId: device.id,
                    attribute: "filter",
                    from: previous.filter,
                    to: device.filter,
                    at: now,
                    version
                });
            }
            if (previous.filter) next.before.filter = previous.filter;
            next.filter = device.filter;
            next.filterSince = now;
        }
        // A battery that stops reporting keeps its last word rather than reading
        // as a change to nothing; one seen for the first time is learned.
        if (device.battery && device.battery !== previous.battery) {
            if (previous.battery) {
                changed.push({
                    deviceId: device.id,
                    attribute: "battery",
                    from: previous.battery,
                    to: device.battery,
                    at: now,
                    version
                });
                next.before.battery = previous.battery;
            }
            next.battery = device.battery;
            next.batterySince = now;
        }
        if (!wasOnline) {
            // Back: whatever else differs is where it is now, kept but not fired.
            const returned = changed.filter((change) => change.attribute === "online");
            return (await settle(installedAppId, device.id, previous, next, returned, moved, now))
                ? returned
                : [];
        }
        if (changed.length === 0) {
            // A figure seen for the first time is not a change, but it is kept,
            // so the next one has something to be compared with.
            const learned =
                (device.filter && !previous.filter) ||
                (device.battery && !previous.battery) ||
                previous.online === undefined ||
                Object.keys(device.figures ?? {}).some((measure) => !previous.figures?.[measure]);
            if (learned) await store.swapObservation(device.id, previous, next);
            return [];
        }
        return (await settle(installedAppId, device.id, previous, next, changed, moved, now))
            ? changed
            : [];
    }

    /**
     * Keep what a device was just seen as, and fire what its changes start. The
     * swap is what makes one reader of a change the one that fires it: false when
     * another got there first. `moved` are the readings that changed, so the
     * lines a "for" waits on are carried forward or started over.
     */
    async function settle(
        installedAppId: string,
        deviceId: string,
        previous: Observation,
        next: Observation,
        changed: readonly Transition[],
        moved: readonly { key: string; before: Figure; after: string }[],
        now: Date
    ): Promise<boolean> {
        const automations = await enabled(installedAppId);
        const lines = watchedLines(automations, deviceId);
        const held: Record<string, Readonly<Record<string, Held>>> = { ...(next.held ?? {}) };
        for (const { key, before, after } of moved) {
            const kept = heldAfter(previous.held?.[key], before, after, now, lines.get(key) ?? []);
            if (Object.keys(kept).length > 0) held[key] = kept;
            else delete held[key];
        }
        const settled: Observation = { ...next, held };
        if (!(await store.swapObservation(deviceId, previous, settled))) return false;

        const depth = (causeContext.getStore()?.depth ?? -1) + 1;
        for (const change of changed) {
            for (const automation of automations) {
                for (const trigger of automation.definition.triggers) {
                    if (!matchesChange(trigger, change)) continue;
                    if (!(await setAllows(trigger, change))) continue;
                    const cause: auto.RunCause = {
                        kind: trigger.kind,
                        triggerId: trigger.id,
                        deviceId: change.deviceId,
                        attribute: change.attribute,
                        ...(change.measure ? { measure: change.measure } : {}),
                        from: change.from,
                        to: change.to,
                        at: iso(change.at)
                    };
                    // A set's devices count their changes apart, so two of them
                    // on the same count are two firings, not one.
                    const who =
                        "deviceId" in trigger && auto.deviceTargets(trigger).length > 1
                            ? `:${change.deviceId}`
                            : "";
                    const key = `${trigger.kind}:${trigger.id}:${change.attribute}${change.measure ? `:${change.measure}` : ""}:${change.version}${who}`;
                    try {
                        await fire(automation, key, cause, depth);
                    } catch (error) {
                        fault(`automation ${automation.id} could not fire`, error);
                    }
                }
            }
        }
        await store.wakeWaiting(deviceId, now);
        // Whatever was queued, and whatever was waiting on this device, is looked
        // at now rather than on the next tick.
        ports.wake?.(0);
        return true;
    }

    function matchesChange(trigger: auto.Trigger, change: Transition): boolean {
        // One that has to last is looked at on the clock, once it has.
        if ((trigger.kind === "change" || trigger.kind === "threshold") && trigger.forMinutes)
            return false;
        if (trigger.kind === "change") {
            if (
                !auto.deviceTargets(trigger).includes(change.deviceId) ||
                trigger.attribute !== change.attribute
            )
                return false;
            // A change of reading is the device's one reading, never one of a
            // purifier's figures: those are crossed, with a threshold.
            if (change.measure !== undefined) return false;
            if (trigger.from && !same(trigger.from, change.from)) return false;
            if (trigger.to && !same(trigger.to, change.to)) return false;
            return true;
        }
        if (trigger.kind === "threshold") {
            if (
                !auto.deviceTargets(trigger).includes(change.deviceId) ||
                change.attribute !== "reading" ||
                trigger.measure !== change.measure
            )
                return false;
            const before = numberOf(change.from);
            const after = numberOf(change.to);
            if (before === null || after === null) return false;
            return crossed(trigger, before, after);
        }
        return false;
    }

    /**
     * Whether a set's change is the one its trigger waits for: any of them (each),
     * the first of them to get there - none of the others already was - or the
     * last, once every other device answering is there too. A change with no
     * value to get to has no first or last, and counts for each device.
     */
    async function setAllows(trigger: auto.Trigger, change: Transition): Promise<boolean> {
        if (trigger.kind !== "change" && trigger.kind !== "threshold") return true;
        const behaviour = trigger.behaviour ?? "each";
        const members = auto.deviceTargets(trigger);
        if (behaviour === "each" || members.length < 2) return true;
        if (trigger.kind === "change" && !trigger.to) return true;
        const there = (seen: Observation): boolean => {
            if (trigger.kind === "change")
                return same(attributeOf(seen, trigger.attribute), trigger.to);
            const current = trigger.measure ? seen.figures?.[trigger.measure]?.value : seen.reading;
            return current !== undefined && passesLine(thresholdLine(trigger), current);
        };
        const others: Observation[] = [];
        for (const deviceId of members) {
            if (deviceId === change.deviceId) continue;
            const seen = await store.observation(deviceId);
            if (seen && answers(trigger, seen)) others.push(seen);
        }
        return behaviour === "first" ? !others.some(there) : others.every(there);
    }

    /**
     * The triggers that are about the clock rather than a change: a time of day,
     * an interval, and a device that has been in one state for long enough. Each
     * names the occurrence it fires for, so a second pass over the same minute
     * finds its run already there.
     */
    async function evaluateSchedules(installedAppId: string): Promise<void> {
        const now = ports.now();
        const automations = await enabled(installedAppId);
        for (const automation of automations) {
            for (const trigger of automation.definition.triggers) {
                try {
                    await scheduled(automation, trigger, now);
                } catch (error) {
                    fault(`automation ${automation.id} could not check a trigger`, error);
                }
            }
        }
    }

    async function scheduled(
        automation: AutomationRecord,
        trigger: auto.Trigger,
        now: Date
    ): Promise<void> {
        const armed = automation.armedAt.getTime();
        if (trigger.kind === "time") {
            const occurrence = lastOccurrence(trigger, automation.definition.timeZone, now);
            if (!occurrence) return;
            const late = now.getTime() - occurrence.getTime();
            if (late < 0 || late > CATCH_UP_MS || occurrence.getTime() < armed) return;
            await fire(
                automation,
                `time:${trigger.id}:${iso(occurrence)}`,
                { kind: "time", triggerId: trigger.id, at: iso(occurrence) },
                0
            );
            return;
        }
        if (trigger.kind === "sun") {
            const found = lastSunOccurrence(
                trigger,
                automation.location ?? null,
                automation.definition.timeZone,
                now
            );
            if (!found) return;
            const late = now.getTime() - found.at.getTime();
            if (late < 0 || late > CATCH_UP_MS || found.at.getTime() < armed) return;
            // Keyed by the day the event belongs to, not by the instant: a
            // location or an offset edited after it fired is still today's.
            await fire(
                automation,
                `sun:${trigger.id}:${trigger.event}:${found.day}`,
                { kind: "sun", triggerId: trigger.id, event: trigger.event, at: iso(found.at) },
                0
            );
            return;
        }
        if (trigger.kind === "interval") {
            const period = trigger.minutes * 60 * 1000;
            const slot = Math.floor((now.getTime() - armed) / period);
            if (slot < 1) return;
            const at = new Date(armed + slot * period);
            if (now.getTime() - at.getTime() > CATCH_UP_MS) return;
            await fire(
                automation,
                `interval:${trigger.id}:${trigger.minutes}:${slot}`,
                { kind: "interval", triggerId: trigger.id, minutes: trigger.minutes, at: iso(at) },
                0
            );
            return;
        }
        if (
            trigger.kind === "stays" ||
            ((trigger.kind === "change" || trigger.kind === "threshold") && trigger.forMinutes)
        ) {
            const members = auto.deviceTargets(trigger);
            const minutes = trigger.kind === "stays" ? trigger.minutes : (trigger.forMinutes ?? 0);
            const candidates: Lasting[] = [];
            let present = 0;
            for (const deviceId of members) {
                const seen = await store.observation(deviceId);
                if (!seen || !answers(trigger, seen)) continue;
                present += 1;
                const candidate = heldOn(trigger, deviceId, seen, armed, now);
                if (candidate) candidates.push(candidate);
            }
            const picked = pickHeld(trigger.behaviour ?? "each", candidates, present);
            for (const held of picked) {
                if (now.getTime() - held.start.getTime() < minutes * 60 * 1000) continue;
                const who = members.length > 1 ? `:${held.cause.deviceId}` : "";
                await fire(automation, `${held.key}${who}`, { ...held.cause, at: iso(now) }, 0);
            }
        }
    }

    /**
     * What one device of a trigger that has to last is doing about it: since
     * when it has been the way the trigger waits for, and the run cause it would
     * fire with. Null when it is not that way, or got there before the
     * automation was switched on (for a change or a crossing, which is then no
     * change it saw).
     */
    function heldOn(
        trigger: auto.Trigger,
        deviceId: string,
        seen: Observation,
        armed: number,
        now: Date
    ): Lasting | null {
        if (trigger.kind === "change") {
            // No change seen yet is nothing to have lasted.
            const before = seen.before?.[trigger.attribute];
            if (before === undefined) return null;
            const value = attributeOf(seen, trigger.attribute);
            if (trigger.from && !same(trigger.from, before)) return null;
            if (trigger.to && !same(trigger.to, value)) return null;
            const since = sinceOf(seen, trigger.attribute);
            if (since.getTime() < armed) return null;
            return {
                start: since,
                key: `held:${trigger.id}:${trigger.attribute}:${iso(since)}`,
                cause: {
                    kind: "change",
                    triggerId: trigger.id,
                    deviceId,
                    attribute: trigger.attribute,
                    from: before,
                    to: value,
                    minutes: trigger.forMinutes,
                    at: iso(now)
                }
            };
        }
        if (trigger.kind === "threshold") {
            const held = heldOf(seen, trigger.measure, thresholdLine(trigger));
            // Past the line since before anything was seen is no crossing at all.
            if (!held || held.from === undefined || held.since.getTime() < armed) return null;
            return {
                start: held.since,
                key: `held:${trigger.id}:${trigger.measure ?? READING_KEY}:${iso(held.since)}`,
                cause: {
                    kind: "threshold",
                    triggerId: trigger.id,
                    deviceId,
                    attribute: "reading",
                    ...(trigger.measure ? { measure: trigger.measure } : {}),
                    from: held.from,
                    to: held.value,
                    minutes: trigger.forMinutes,
                    at: iso(now)
                }
            };
        }
        if (trigger.kind === "stays") {
            const value = attributeOf(seen, trigger.attribute);
            if (!same(value, trigger.is)) return null;
            const since = sinceOf(seen, trigger.attribute);
            // Measured from when it was switched on here, not from when the
            // device got there: a light already on for three hours when "off
            // after 30 minutes" is written goes off 30 minutes later, not now.
            return {
                start: new Date(Math.max(since.getTime(), armed)),
                key: `stays:${trigger.id}:${trigger.attribute}:${iso(since)}`,
                cause: {
                    kind: "stays",
                    triggerId: trigger.id,
                    deviceId,
                    attribute: trigger.attribute,
                    to: value,
                    minutes: trigger.minutes,
                    at: iso(now)
                }
            };
        }
        return null;
    }

    /** Somebody pressed Run now. */
    async function runNow(
        automation: AutomationRecord,
        byUser: string,
        key: string
    ): Promise<boolean> {
        const now = ports.now();
        // Run now is what its "Run by hand" trigger stands for, so a condition
        // asking which trigger started it gets that one.
        const manual = automation.definition.triggers.find((trigger) => trigger.kind === "manual");
        const queued = await fire(
            automation,
            `manual:${key}`,
            { kind: "manual", ...(manual ? { triggerId: manual.id } : {}), byUser, at: iso(now) },
            0
        );
        if (queued) ports.wake?.(0);
        return queued;
    }

    /**
     * Work through every run that is due, until none are.
     *
     * One drain at a time in a process; a second call while one is going asks it
     * to go round once more rather than starting beside it. Across processes the
     * claim on each run is what keeps two runners off the same steps.
     */
    function drain(): Promise<void> {
        if (draining) {
            again = true;
            return draining;
        }
        draining = (async () => {
            try {
                do {
                    again = false;
                    for (;;) {
                        const now = ports.now();
                        const due = await store.claimDueRuns(
                            now,
                            new Date(now.getTime() + LEASE_MS),
                            20
                        );
                        if (due.length === 0) break;
                        for (const run of due) {
                            try {
                                await execute(run);
                            } catch (error) {
                                fault(`automation run ${run.id} failed`, error);
                                await finish(run, "failed", run.steps, "fault");
                            }
                        }
                    }
                } while (again);
            } finally {
                draining = null;
            }
        })();
        return draining;
    }

    async function finish(
        run: RunRecord,
        status: auto.RunStatus,
        steps: readonly auto.StepLog[],
        reason: string | null = null
    ): Promise<void> {
        const now = ports.now();
        const saved = await store.saveRun(run.id, {
            status,
            steps,
            reason,
            dueAt: null,
            waitUntil: null,
            waitDeviceId: null,
            lockedUntil: null,
            finishedAt: now
        });
        if (saved) await store.markAutomation(run.automationId, now, status);
    }

    async function execute(run: RunRecord): Promise<void> {
        const automation = await one(run.automationId);
        const steps: auto.StepLog[] = [...run.steps];
        if (!automation) {
            await finish(run, "failed", steps, "unreadable");
            return;
        }
        if (!automation.enabled) {
            await finish(run, "stopped", steps, "disabled");
            return;
        }
        const definition = automation.definition;

        // A run starting for the first time checks its owner and its conditions.
        // One resuming after a delay has passed both already.
        if (run.status === "queued") {
            if (!(await ports.mayOperate(automation.ownerId, "run"))) {
                await finish(run, "refused", steps, "owner");
                return;
            }
            const held = await conditionsHold(automation, ports.now(), run.cause);
            if (!held) {
                await finish(run, "skipped", steps, "conditions");
                return;
            }
        }
        if (!(await store.saveRun(run.id, { status: "running" }))) return;

        let index = run.step;
        let waitUntil = run.waitUntil;
        while (index < definition.actions.length) {
            const step = definition.actions[index]!;
            const now = ports.now();
            const log = (outcome: auto.StepOutcome, extra: { code?: string; said?: string } = {}) =>
                steps.push({
                    stepId: step.id,
                    kind: step.kind,
                    outcome,
                    ...extra,
                    at: iso(ports.now())
                });

            if (step.kind === "delay") {
                const due = new Date(now.getTime() + step.seconds * 1000);
                log("ok");
                if (
                    !(await store.saveRun(run.id, {
                        status: "waiting",
                        step: index + 1,
                        steps,
                        dueAt: due,
                        lockedUntil: null
                    }))
                ) {
                    return;
                }
                if (step.seconds * 1000 <= TIMER_MS) ports.wake?.(step.seconds * 1000);
                return;
            }

            if (step.kind === "wait") {
                const reached = await waitReached(automation, step);
                if (reached === null) {
                    log("failed", { code: "deviceGone" });
                    await finish(run, "failed", steps, "step");
                    return;
                }
                if (reached) {
                    log("ok");
                    waitUntil = null;
                } else {
                    const deadline =
                        waitUntil ?? new Date(now.getTime() + step.timeoutMinutes * 60 * 1000);
                    if (now.getTime() < deadline.getTime()) {
                        await store.saveRun(run.id, {
                            status: "waiting",
                            step: index,
                            steps,
                            waitUntil: deadline,
                            waitDeviceId: step.deviceId,
                            dueAt: new Date(
                                Math.min(deadline.getTime(), now.getTime() + RECHECK_MS)
                            ),
                            lockedUntil: null
                        });
                        return;
                    }
                    log("timedOut");
                    waitUntil = null;
                    if (step.onTimeout === "stop") {
                        await finish(run, "stopped", steps, "timedOut");
                        return;
                    }
                }
            }

            if (step.kind === "device") {
                const outcome = await deviceStep(automation, run, step);
                if (outcome.outcome !== "ok") {
                    log(outcome.outcome, { code: outcome.code, said: outcome.said });
                    await finish(
                        run,
                        outcome.outcome === "refused" ? "refused" : "failed",
                        steps,
                        "step"
                    );
                    return;
                }
                log("ok");
            }

            if (step.kind === "notify") {
                try {
                    await ports.notify(automation, step.message, run.id);
                    log("ok");
                } catch (error) {
                    fault(`automation ${automation.id} could not notify`, error);
                    log("failed", { code: "notifyFailed" });
                    await finish(run, "failed", steps, "step");
                    return;
                }
            }

            if (step.kind === "run") {
                const target = await one(step.automationId);
                if (!target || target.installedAppId !== automation.installedAppId) {
                    log("failed", { code: "automationGone" });
                    await finish(run, "failed", steps, "step");
                    return;
                }
                if (!target.enabled) {
                    log("skipped", { code: "automationOff" });
                } else if (run.depth + 1 > MAX_DEPTH) {
                    log("refused", { code: "loop" });
                    await finish(run, "refused", steps, "loop");
                    return;
                } else {
                    const started = await fire(
                        target,
                        `chain:${run.id}:${step.id}`,
                        {
                            kind: "automation",
                            byAutomationId: automation.id,
                            byName: automation.name,
                            at: iso(now)
                        },
                        run.depth + 1
                    );
                    if (started) {
                        log("ok");
                        ports.wake?.(0);
                    } else {
                        log("skipped", { code: "automationHeld" });
                    }
                }
            }

            index += 1;
            // Saved after every step, so a restart resumes after the last one
            // that finished rather than doing it again.
            const kept = await store.saveRun(run.id, {
                step: index,
                steps,
                waitUntil: null,
                waitDeviceId: null,
                lockedUntil: new Date(ports.now().getTime() + LEASE_MS)
            });
            if (!kept) return;
        }
        await finish(run, "succeeded", steps);
    }

    /** Whether a wait step's devices are where it waits for them now; null when
     *  every one of them is gone. */
    async function waitReached(
        automation: AutomationRecord,
        step: Extract<auto.Step, { kind: "wait" }>
    ): Promise<boolean | null> {
        const members = auto.deviceTargets(step);
        const read = await Promise.all(
            members.map((id) => ports.devices.read(automation.installedAppId, id))
        );
        if (read.every((device) => !device)) return null;
        const there = read.flatMap((device) =>
            device && (device.online || step.attribute === "online")
                ? [same(attributeOf(device, step.attribute), step.is)]
                : members.length > 1
                  ? []
                  : [false]
        );
        return (
            there.length > 0 &&
            (step.quantifier === "all" ? there.every(Boolean) : there.some(Boolean))
        );
    }

    async function deviceStep(
        automation: AutomationRecord,
        run: RunRecord,
        step: Extract<auto.Step, { kind: "device" }>
    ): Promise<{ outcome: auto.StepOutcome; code?: string; said?: string }> {
        // Asked again for every step, not once per run: a run that waited an
        // hour may have outlived its owner's right to open the door.
        if (!(await ports.mayOperate(automation.ownerId, "control")))
            return { outcome: "refused", code: "owner" };
        // Every device of a set is told, one failing or not; the step fails with
        // the first that did, so nobody reads "done" over a lamp still on.
        const members = auto.deviceTargets(step);
        if (members.length === 0) return { outcome: "failed", code: "deviceGone" };
        let first: { outcome: auto.StepOutcome; code?: string; said?: string } | null = null;
        for (const deviceId of members) {
            const outcome = await deviceAct(automation, run, step, deviceId);
            if (outcome.outcome !== "ok" && !first) first = outcome;
        }
        return first ?? { outcome: "ok" };
    }

    async function deviceAct(
        automation: AutomationRecord,
        run: RunRecord,
        step: Extract<auto.Step, { kind: "device" }>,
        deviceId: string
    ): Promise<{ outcome: auto.StepOutcome; code?: string; said?: string }> {
        let action: DeviceAction;
        if (step.do === auto.TOGGLE) {
            const device = await ports.devices.read(automation.installedAppId, deviceId);
            if (!device) return { outcome: "failed", code: "deviceGone" };
            if (device.state !== "on" && device.state !== "off")
                return { outcome: "failed", code: "toggleUnknown" };
            action = device.state === "on" ? "turn-off" : "turn-on";
        } else {
            action = step.do;
        }
        try {
            await causeContext.run({ depth: run.depth }, () =>
                ports.devices.act(
                    automation.installedAppId,
                    deviceId,
                    action,
                    {
                        ownerId: automation.ownerId,
                        automationId: automation.id,
                        automationName: automation.name
                    },
                    step.setting
                )
            );
            return { outcome: "ok" };
        } catch (error) {
            if (error instanceof StepRefusal) return { outcome: "failed", said: error.message };
            fault(`automation ${automation.id} could not act on a device`, error);
            return { outcome: "failed", code: "failed" };
        }
    }

    /** Whether the conditions hold now. `cause` is what started the run, which
     *  a "Triggered by" condition reads. */
    async function conditionsHold(
        automation: AutomationRecord,
        now: Date,
        cause?: auto.RunCause
    ): Promise<boolean> {
        const { conditions, timeZone } = automation.definition;
        if (conditions.groups.length === 0) return true;
        const results: boolean[] = [];
        for (const group of conditions.groups) {
            const items: boolean[] = [];
            for (const condition of group.items) {
                if (condition.kind === "triggeredBy") {
                    items.push(triggeredBy(condition, cause));
                    continue;
                }
                if (condition.kind === "sun") {
                    items.push(sunHolds(condition, automation.location ?? null, timeZone, now));
                    continue;
                }
                items.push(await conditionHolds(automation, condition, now, timeZone));
            }
            results.push(group.match === "all" ? items.every(Boolean) : items.some(Boolean));
        }
        return conditions.match === "all" ? results.every(Boolean) : results.some(Boolean);
    }

    async function conditionHolds(
        automation: AutomationRecord,
        condition: auto.Condition,
        now: Date,
        timeZone: string
    ): Promise<boolean> {
        if (condition.kind === "device" || condition.kind === "reading") {
            const members = auto.deviceTargets(condition);
            if (members.length > 1) {
                return setHolds(automation, condition, members, now, timeZone);
            }
        }
        const deviceId =
            condition.kind === "device" || condition.kind === "reading" ? condition.deviceId : "";
        return memberHolds(automation, condition, deviceId, now, timeZone);
    }

    /**
     * A condition on a set of devices: any of them, or all of them. A device
     * that is gone or silent counts for neither - so with every one of them
     * silent, "any" fails and "all" has nothing against it and passes - except
     * where whether it is answering is the very question.
     */
    async function setHolds(
        automation: AutomationRecord,
        condition: auto.Condition & { kind: "device" | "reading" },
        members: readonly string[],
        now: Date,
        timeZone: string
    ): Promise<boolean> {
        const all = condition.quantifier === "all";
        for (const deviceId of members) {
            const device = await ports.devices.read(automation.installedAppId, deviceId);
            const asked = condition.kind === "device" && condition.attribute === "online";
            if (!device || (!device.online && !asked)) continue;
            const passes = await memberHolds(automation, condition, deviceId, now, timeZone);
            if (passes && !all) return true;
            if (!passes && all) return false;
        }
        return all;
    }

    async function memberHolds(
        automation: AutomationRecord,
        condition: auto.Condition,
        deviceId: string,
        now: Date,
        timeZone: string
    ): Promise<boolean> {
        if (condition.kind === "device") {
            const device = await ports.devices.read(automation.installedAppId, deviceId);
            // A device that is gone or silent is not in any state, so "is" and
            // "is not" both fail rather than the second passing by default -
            // except whether it is answering, which is just what silence says.
            if (!device) return false;
            if (!device.online && condition.attribute !== "online") return false;
            const matches = same(attributeOf(device, condition.attribute), condition.is);
            const passes = condition.negate ? !matches : matches;
            if (!passes || !condition.forMinutes) return passes;
            // Held for long enough: the attribute has not changed since at least
            // that long ago. Its last change is what made it match (or stop
            // matching, for "is not"), so that change is when the wait began.
            const seen = await store.observation(deviceId);
            if (!seen || same(attributeOf(seen, condition.attribute), condition.is) !== matches) {
                return false;
            }
            const since = sinceOf(seen, condition.attribute);
            return now.getTime() - since.getTime() >= condition.forMinutes * 60 * 1000;
        }
        if (condition.kind === "reading") {
            const device = await ports.devices.read(automation.installedAppId, deviceId);
            if (!device || !device.online) return false;
            const value = numberOf(
                condition.measure ? (device.figures?.[condition.measure] ?? "") : device.reading
            );
            const passes =
                value !== null && compare(value, condition.op, condition.value, condition.upper);
            if (!passes || !condition.forMinutes) return passes;
            // Held for long enough: every value since then passed too. A figure
            // passing since it was first seen counts from then, never before.
            const seen = await store.observation(deviceId);
            if (!seen) return false;
            const held = heldOf(seen, condition.measure, condition);
            return (
                held !== null &&
                now.getTime() - held.since.getTime() >= condition.forMinutes * 60 * 1000
            );
        }
        if (condition.kind === "sun" || condition.kind === "triggeredBy") return false;
        const clock = wallClock(now, timeZone);
        if (condition.kind === "weekday") {
            const day = new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay();
            return condition.days.includes(day);
        }
        const minute = clock.hours * 60 + clock.minutes;
        const from = minutesOf(condition.from);
        const to = minutesOf(condition.to);
        // 22:00 to 07:00 is the night, across midnight.
        return from < to ? minute >= from && minute < to : minute >= from || minute < to;
    }

    /** One device step for a central run, as an old run would take it. */
    function actFor(
        automation: AutomationRecord,
        depth: number,
        step: Extract<auto.Step, { kind: "device" }>
    ) {
        return deviceStep(automation, { depth } as RunRecord, step);
    }

    return {
        observe,
        evaluateSchedules,
        runNow,
        drain,
        fire,
        conditionsHold,
        placed,
        waitReached,
        actFor
    };
}

export type AutomationEngine = ReturnType<typeof createEngine>;

/** When the attribute an observation holds last changed. */
function sinceOf(seen: Observation, attribute: auto.AutomationAttribute): Date {
    if (attribute === "door") return seen.doorSince;
    if (attribute === "reading") return seen.readingSince;
    if (attribute === "mode") return seen.modeSince;
    if (attribute === "filter") return seen.filterSince ?? seen.stateSince;
    if (attribute === "online") return seen.onlineSince ?? seen.stateSince;
    if (attribute === "battery") return seen.batterySince ?? seen.stateSince;
    return seen.stateSince;
}

/**
 * Since when a reading has passed a line, counting back from the value it has
 * now: null when that one does not. A run no change was seen to start - the
 * line was not watched when it began - counts from the value it has now, never
 * before, and is no crossing.
 */
function heldOf(
    seen: Observation,
    measure: auto.ReadingMeasure | undefined,
    line: Line
): (Held & { value: string }) | null {
    const current = measure
        ? seen.figures?.[measure]
        : { value: seen.reading, since: seen.readingSince };
    if (!current || !passesLine(line, current.value)) return null;
    const held = seen.held?.[measure ?? READING_KEY]?.[lineKey(line)];
    return { ...(held ?? { since: current.since }), value: current.value };
}

/** The lines enabled automations wait on with a "for" on one device, by the
 *  reading they read. */
function watchedLines(
    automations: readonly AutomationRecord[],
    deviceId: string
): Map<string, Line[]> {
    const lines = new Map<string, Line[]>();
    const add = (measure: auto.ReadingMeasure | undefined, line: Line) => {
        const key = measure ?? READING_KEY;
        lines.set(key, [...(lines.get(key) ?? []), line]);
    };
    for (const { definition } of automations) {
        for (const trigger of definition.triggers) {
            if (
                trigger.kind === "threshold" &&
                trigger.forMinutes &&
                auto.deviceTargets(trigger).includes(deviceId)
            )
                add(trigger.measure, thresholdLine(trigger));
        }
        for (const group of definition.conditions.groups) {
            for (const condition of group.items) {
                if (
                    condition.kind === "reading" &&
                    condition.forMinutes &&
                    auto.deviceTargets(condition).includes(deviceId)
                )
                    add(condition.measure, condition);
            }
        }
    }
    return lines;
}

/**
 * Whether a figure going from `before` to `after` is what a threshold waits for:
 * crossing its line, or coming into its range ("between") or leaving it
 * ("outside"). Both ends of a range count as inside it.
 */
export function crossed(
    threshold: { direction: auto.ThresholdDirection; value: number; upper?: number },
    before: number,
    after: number
): boolean {
    const { direction, value } = threshold;
    if (direction === "above") return before <= value && after > value;
    if (direction === "below") return before >= value && after < value;
    const upper = threshold.upper;
    if (upper === undefined || !(upper > value)) return false;
    const inside = (figure: number) => figure >= value && figure <= upper;
    return direction === "between"
        ? !inside(before) && inside(after)
        : inside(before) && !inside(after);
}

/**
 * The most recent moment a time-of-day trigger was due, at or before now, on
 * one of its days - looking back as far as yesterday so a tick just after
 * midnight still finds 23:59.
 */
export function lastOccurrence(
    trigger: Extract<auto.Trigger, { kind: "time" }>,
    timeZone: string,
    now: Date
): Date | null {
    const [hours, minutes] = trigger.at.split(":").map(Number);
    const today = wallClock(now, timeZone);
    const cursor = new Date(Date.UTC(today.year, today.month - 1, today.day));
    for (let back = 0; back < 2; back += 1) {
        const day = cursor.getUTCDay();
        if (trigger.days.includes(day)) {
            const at = zonedInstant(
                {
                    year: cursor.getUTCFullYear(),
                    month: cursor.getUTCMonth() + 1,
                    day: cursor.getUTCDate(),
                    hours: hours ?? 0,
                    minutes: minutes ?? 0
                },
                timeZone
            );
            if (at.getTime() <= now.getTime()) return at;
        }
        cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return null;
}

// --- the sun ------------------------------------------------------------------

/** An offset as signed milliseconds: before is earlier. */
function offsetMs(offset: Offset | undefined): number {
    if (!offset) return 0;
    const ms = durationSeconds(offset) * 1000;
    return offset.direction === "before" ? -ms : ms;
}

function dayKey(day: CalendarDay): string {
    return `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

/** The place's calendar day `shift` days from the one `now` falls on. */
function dayAt(now: Date, timeZone: string, shift: number): CalendarDay {
    const today = wallClock(now, timeZone);
    const cursor = new Date(Date.UTC(today.year, today.month - 1, today.day + shift));
    return {
        year: cursor.getUTCFullYear(),
        month: cursor.getUTCMonth() + 1,
        day: cursor.getUTCDate()
    };
}

/**
 * The latest moment at or before `now` a sun trigger was due, with the day its
 * event belongs to - or null with no location, or when the event has not
 * happened lately (a polar summer has no sunset to fire on). Tomorrow is looked
 * at too, since "12 hours before sunrise" can fall this evening.
 */
export function lastSunOccurrence(
    trigger: Extract<auto.Trigger, { kind: "sun" }>,
    location: Coordinate | null,
    timeZone: string,
    now: Date
): { at: Date; day: string } | null {
    if (!location) return null;
    let found: { at: Date; day: string } | null = null;
    for (const shift of [1, 0, -1, -2]) {
        const day = dayAt(now, timeZone, shift);
        const event = sunEventOn(trigger.event, day, location);
        if (!event) continue;
        const at = new Date(event.getTime() + offsetMs(trigger.offset));
        if (at.getTime() > now.getTime()) continue;
        if (!found || at.getTime() > found.at.getTime()) found = { at, day: dayKey(day) };
    }
    return found;
}

/**
 * A sun condition, read against today's sunrise and sunset at the place.
 *
 * After sunset and before sunrise is the night - the one pair read across
 * midnight, as "before today's sunrise or after today's sunset". Any other
 * pair has to hold together on the same day. An event that does not happen
 * today (no sunset in a polar summer) fails the condition rather than guessing
 * which side of it the day is on.
 */
export function sunHolds(
    condition: Extract<auto.Condition, { kind: "sun" }>,
    location: Coordinate | null,
    timeZone: string,
    now: Date
): boolean {
    if (!location || (!condition.after && !condition.before)) return false;
    const today = dayAt(now, timeZone, 0);
    const edge = (side: { event: auto.SunEdgeEvent; offset?: Offset }): number | null => {
        const event = sunEventOn(side.event, today, location);
        return event ? event.getTime() + offsetMs(side.offset) : null;
    };
    const after = condition.after ? edge(condition.after) : undefined;
    const before = condition.before ? edge(condition.before) : undefined;
    if (after === null || before === null) return false;
    const at = now.getTime();
    if (
        after !== undefined &&
        before !== undefined &&
        condition.after?.event === "sunset" &&
        condition.before?.event === "sunrise"
    ) {
        return at < before || at > after;
    }
    if (before !== undefined && !(at < before)) return false;
    if (after !== undefined && !(at > after)) return false;
    return true;
}

/** Whether the run was started by one of the triggers a condition names. A
 *  run with no trigger behind it - started by another automation - is not. */
export function triggeredBy(
    condition: Extract<auto.Condition, { kind: "triggeredBy" }>,
    cause: auto.RunCause | undefined
): boolean {
    const id = cause?.triggerId;
    return id !== undefined && condition.triggerIds.includes(id);
}
