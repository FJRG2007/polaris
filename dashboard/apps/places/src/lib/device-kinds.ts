/**
 * What a device is, what it can be told to do, and what its history reads like.
 *
 * Pure and client-safe, and split from the service for the same reason the place
 * kinds are: a dialog needs the list of actions and a table needs the shape of a
 * device, and the service imports the database - a client component reaching for
 * either would drag Prisma into the browser bundle, which is a build failure with
 * a stack trace that names none of this.
 *
 * Nothing here is a vendor's vocabulary. Nuki numbers its states and its triggers
 * and so will the next make; those are translated in the driver, once, so that a
 * screen only ever draws these words and a second vendor changes nothing above
 * the driver.
 */

import type { PlacesTranslator } from "./i18n";
import { wallClock, zonedInstant } from "@polaris/core";
import { englishPlaces as en, type PlacesKey } from "../../messages";

/** What a device does, which is what decides the buttons it gets. */
export const DEVICE_KINDS = ["lock", "opener", "switch", "outlet", "light", "sensor"] as const;

export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const DEVICE_KIND_LABELS: Readonly<Record<DeviceKind, string>> = {
    lock: en("devices.kinds.lock"),
    opener: en("devices.kinds.opener"),
    switch: en("devices.kinds.switch"),
    outlet: en("devices.kinds.outlet"),
    light: en("devices.kinds.light"),
    sensor: en("devices.kinds.sensor")
};

/** Devices of the same sort, listed together. A place has a handful of doors and
 *  can have thirty sockets, and reading them as one list is reading neither. */
export const DEVICE_GROUP_LABELS: Readonly<Record<DeviceKind, string>> = {
    lock: en("devices.groups.lock"),
    opener: en("devices.groups.opener"),
    switch: en("devices.groups.switch"),
    outlet: en("devices.groups.outlet"),
    light: en("devices.groups.light"),
    sensor: en("devices.groups.sensor")
};

/** Whether a word off a device row is a kind this build knows. A device synced by
 *  a newer build and read by an older one lands as a lock rather than as nothing,
 *  which is the safer of the two: it draws, and its controls are refused by the
 *  service rather than silently offered. */
export function deviceKind(value: string): DeviceKind {
    return (DEVICE_KINDS as readonly string[]).includes(value) ? (value as DeviceKind) : "lock";
}

/** Where a lock is. `unknown` is a lock that has not answered yet, which is not
 *  the same as one that has answered and does not know - that is `uncalibrated`,
 *  and it needs somebody at the door rather than a retry. */
export const DEVICE_STATES = [
    "locked",
    "unlocked",
    "unlatched",
    "moving",
    "jammed",
    "uncalibrated",
    "on",
    "off",
    "unknown"
] as const;

export type DeviceState = (typeof DEVICE_STATES)[number];

export const DEVICE_STATE_LABELS: Readonly<Record<DeviceState, string>> = {
    locked: en("devices.states.locked"),
    unlocked: en("devices.states.unlocked"),
    unlatched: en("devices.states.unlatched"),
    moving: en("devices.states.moving"),
    jammed: en("devices.states.jammed"),
    uncalibrated: en("devices.states.uncalibrated"),
    on: en("devices.states.on"),
    off: en("devices.states.off"),
    unknown: en("devices.states.unknown")
};

/**
 * The states that read differently on one kind of device than on another.
 *
 * A lock whose latch is pulled back was showing "Open" on the same row as "Door
 * closed", which is two true sentences that contradict each other: one is about
 * the lock and the other about the door, and neither said which. So the lock says
 * what its latch is doing, and the door is left to the sensor.
 *
 * A door opener has no bolt at all. It sits idle and it lets somebody through,
 * and calling the first of those "Locked" was the vendor's number leaking through
 * a word.
 */
export function stateLabel(kind: string, state: DeviceState, t: PlacesTranslator = en): string {
    const own = `devices.kindStates.${deviceKind(kind)}.${state}`;
    return t.has(own) ? t(own as PlacesKey) : t(`devices.states.${state}`);
}

/** What a kind of device is called, in the reader's words. */
export function kindText(kind: string, t: PlacesTranslator = en): string {
    return t(`devices.kinds.${deviceKind(kind)}`);
}

/** The heading a kind of device is listed under, in the reader's words. */
export function groupText(kind: string, t: PlacesTranslator = en): string {
    return t(`devices.groups.${deviceKind(kind)}`);
}

/** What the paired door sensor says, or nothing without one. */
export function doorText(state: DoorState, t: PlacesTranslator = en): string {
    return state === "none" ? "" : t(`devices.doors.${state}`);
}

/** The button for an action, in the reader's words. */
export function actionText(action: DeviceAction, t: PlacesTranslator = en): string {
    return t(`devices.actions.${action}`);
}

/** What a device that measures rather than does last read. Text and a unit as
 *  its own maker wrote them: a contact says open or closed, and a temperature
 *  that lost its decimal on the way in is worse than the string it sent. */
export interface DeviceReading {
    readonly value: string;
    readonly unit: string;
}

/** The reading as one line, or an empty string for a device that has none. The
 *  space before a unit is dropped for the ones that are written closed up, which
 *  is every symbol and no word. */
export function readingLine(reading: DeviceReading | null, t: PlacesTranslator = en): string {
    if (!reading || !reading.value) return "";
    // A word a driver wrote for an on/off sensor reads in the reader's language;
    // a value the device sent itself is shown as it came.
    const known = READING_KEYS[reading.value];
    const value = known ? t(known) : reading.value;
    if (!reading.unit) return value;
    const closed = /^[%\u00b0]/.test(reading.unit);
    return closed ? `${value}${reading.unit}` : `${value} ${reading.unit}`;
}

/**
 * What a thing that is either true or false should say it is.
 *
 * Keyed by the device class of the discovery convention, which Home Assistant
 * uses too, and it is the only reason the answer is readable: "on" is what a
 * contact publishes and "Open" is what its owner needs to see. Anything unlisted
 * falls back to on and off, which is honest rather than wrong. Every word here
 * has an entry in `READING_KEYS` below, so it reads in the viewer's language.
 */
export const BINARY_WORDS: Readonly<Record<string, { on: string; off: string }>> = {
    door: { on: "Open", off: "Closed" },
    window: { on: "Open", off: "Closed" },
    garage_door: { on: "Open", off: "Closed" },
    opening: { on: "Open", off: "Closed" },
    lock: { on: "Unlocked", off: "Locked" },
    motion: { on: "Movement", off: "Still" },
    occupancy: { on: "Somebody there", off: "Empty" },
    presence: { on: "Home", off: "Away" },
    moisture: { on: "Wet", off: "Dry" },
    smoke: { on: "Smoke", off: "Clear" },
    gas: { on: "Gas", off: "Clear" },
    problem: { on: "Problem", off: "Fine" },
    battery: { on: "Low", off: "Fine" },
    connectivity: { on: "Connected", off: "Disconnected" },
    tamper: { on: "Tampered", off: "Fine" }
};

/** The words a driver gives a two-state sensor, by their English. */
const READING_KEYS: Readonly<Record<string, PlacesKey>> = {
    "Open": "devices.readings.open",
    "Closed": "devices.readings.closed",
    "Unlocked": "devices.readings.unlocked",
    "Locked": "devices.readings.locked",
    "Movement": "devices.readings.movement",
    "Still": "devices.readings.still",
    "Somebody there": "devices.readings.occupied",
    "Empty": "devices.readings.empty",
    "Home": "devices.readings.home",
    "Away": "devices.readings.away",
    "Wet": "devices.readings.wet",
    "Dry": "devices.readings.dry",
    "Smoke": "devices.readings.smoke",
    "Clear": "devices.readings.clear",
    "Gas": "devices.readings.gas",
    "Problem": "devices.readings.problem",
    "Fine": "devices.readings.fine",
    "Low": "devices.readings.low",
    "Connected": "devices.readings.connected",
    "Disconnected": "devices.readings.disconnected",
    "Tampered": "devices.readings.tampered"
};

export type DeviceTone = "success" | "active" | "warning" | "danger" | "muted";

/**
 * How a state should read at a glance.
 *
 * Unlocked is deliberately a warning and not a failure: a door left open is worth
 * noticing on the way past, and colouring it like a fault would make the colour
 * meaningless by lunchtime.
 *
 * A socket that is on is neither. It is not safe and it is not wrong - it is
 * simply doing something, which is its own tone: a room of them reads as which
 * ones are drawing power, and calling that success would say a heater left on all
 * weekend was fine.
 */
export const DEVICE_STATE_TONES: Readonly<Record<DeviceState, DeviceTone>> = {
    locked: "success",
    unlocked: "warning",
    unlatched: "warning",
    moving: "muted",
    jammed: "danger",
    uncalibrated: "danger",
    on: "active",
    off: "muted",
    unknown: "muted"
};

/** The door itself, when a sensor is paired. `none` is no sensor at all, which
 *  is not the same as a sensor that cannot tell. */
export const DOOR_STATES = ["open", "closed", "unknown", "none"] as const;

export type DoorState = (typeof DOOR_STATES)[number];

export const DOOR_STATE_LABELS: Readonly<Record<DoorState, string>> = {
    open: en("devices.doors.open"),
    closed: en("devices.doors.closed"),
    unknown: en("devices.doors.unknown"),
    none: ""
};

/** What somebody can ask of a device from here. */
export const DEVICE_ACTIONS = ["lock", "unlock", "unlatch", "turn-on", "turn-off"] as const;

export type DeviceAction = (typeof DEVICE_ACTIONS)[number];

export const DEVICE_ACTION_LABELS: Readonly<Record<DeviceAction, string>> = {
    lock: en("devices.actions.lock"),
    unlock: en("devices.actions.unlock"),
    unlatch: en("devices.actions.unlatch"),
    "turn-on": en("devices.actions.turn-on"),
    "turn-off": en("devices.actions.turn-off")
};

/** The same actions as something a sentence can be built out of. The label on a
 *  button and the verb in a refusal are not the same word: a button says "On",
 *  and a refusal has to say what could not be done. */
export const DEVICE_ACTION_VERBS: Readonly<Record<DeviceAction, string>> = {
    lock: "lock",
    unlock: "unlock",
    unlatch: "open",
    "turn-on": "turn on",
    "turn-off": "turn off"
};

/**
 * What this kind of device can be told to do.
 *
 * An opener has no bolt to throw - it releases a strike and that is the whole of
 * it - so offering it "lock" would be a button that cannot do what it says. The
 * same rule decides the rest: this is the one place that knows which buttons a
 * kind has, and every screen and the service both read it, so a control that
 * cannot exist is never drawn and never accepted.
 */
const KIND_ACTIONS: Readonly<Record<DeviceKind, readonly DeviceAction[]>> = {
    lock: ["lock", "unlock", "unlatch"],
    opener: ["unlatch"],
    switch: ["turn-on", "turn-off"],
    outlet: ["turn-on", "turn-off"],
    light: ["turn-on", "turn-off"],
    // A sensor is not done, it is read. Nothing to press, and a row that offered
    // something would be offering to change the weather.
    sensor: []
};

export function actionsFor(kind: string): readonly DeviceAction[] {
    return KIND_ACTIONS[deviceKind(kind)];
}

/** The state a device is in once an action has finished, where that is known
 *  before anything answers. A switch told to go on is on or it failed; a lock
 *  told to lock is turning, and what it reaches is the vendor's to report. */
export function settledState(action: DeviceAction): DeviceState | null {
    if (action === "turn-on") return "on";
    if (action === "turn-off") return "off";
    return null;
}

/** Whether a word off a device row is one this app knows. A device synced by a
 *  newer build and read by an older one is the case this exists for. */
export function deviceState(value: string): DeviceState {
    return (DEVICE_STATES as readonly string[]).includes(value)
        ? (value as DeviceState)
        : "unknown";
}

export function doorState(value: string): DoorState {
    return (DOOR_STATES as readonly string[]).includes(value) ? (value as DoorState) : "none";
}

/** A device as a screen sees it. No credential, no vendor id, no address. */
export interface DeviceView {
    readonly id: string;
    readonly vendor: string;
    readonly kind: string;
    readonly name: string;
    readonly zone: string;
    readonly placeId: string | null;
    readonly model: string;
    readonly firmware: string;
    readonly state: DeviceState;
    readonly doorState: DoorState;
    readonly batteryPercent: number | null;
    readonly batteryCritical: boolean;
    readonly online: boolean;
    readonly controllable: boolean;
    /** What it last read, for a device that measures rather than does. Null for
     *  everything that has a state instead. */
    readonly reading: DeviceReading | null;
    /** When the state was last read, so a screen can say how old it is rather
     *  than presenting a stale reading as the present. */
    readonly stateAt: string | null;
}

/** How something came to happen. `polaris` is the one that carries weight: it is
 *  the only value meaning somebody pressed a button on this screen. */
export const DEVICE_VIA = [
    "polaris",
    "app",
    "keypad",
    "fob",
    "button",
    "auto",
    "manual",
    "system"
] as const;

export type DeviceVia = (typeof DEVICE_VIA)[number];

export const DEVICE_VIA_LABELS: Readonly<Record<DeviceVia, string>> = {
    polaris: en("devices.via.polaris"),
    app: en("devices.via.app"),
    keypad: en("devices.via.keypad"),
    fob: en("devices.via.fob"),
    button: en("devices.via.button"),
    auto: en("devices.via.auto"),
    manual: en("devices.via.manual"),
    system: ""
};

/** One thing that happened, as a screen sees it. */
export interface DeviceEventView {
    readonly id: string;
    readonly deviceId: string;
    readonly deviceName: string;
    readonly action: string;
    readonly actor: string;
    readonly via: string;
    readonly outcome: string;
    readonly note: string;
    readonly at: string;
}

/**
 * One line for one entry in the history.
 *
 * Written as a sentence rather than assembled from columns on screen, so the log,
 * the device panel and anything later that shows the same entry cannot word it
 * three ways. A failed action says so first: the reason somebody is reading this
 * list at all is usually that a door did not do what it was told.
 */
export function describeEvent(
    event: DeviceEventView,
    t: PlacesTranslator = en,
    /** The failure's own words, in the reader's language where Places wrote them. */
    note: (said: string) => string = (said) => said
): string {
    const sentence = `devices.sentences.${event.action}`;
    const what = t.has(sentence) ? t(sentence as PlacesKey) : t("devices.sentences.other");
    const via = `devices.via.${event.via}`;
    const how = t.has(via) ? t(via as PlacesKey) : "";
    const line = t("devices.event", {
        what,
        actor: event.actor,
        hasActor: event.actor ? "yes" : "no",
        how,
        hasHow: how ? "yes" : "no"
    });
    if (event.outcome === "ok") return line;
    return event.note
        ? t("devices.failedBecause", { line, note: note(event.note) })
        : t("devices.failed", { line });
}

/** How far back the usage chart looks, in days. A month is what makes a weekly
 *  pattern visible, which is the pattern anybody looking at a door has. */
export const USAGE_DAYS = 30;

/** One day of the usage chart: how many times the door was actually used. */
export interface UsageDay {
    /** Midnight of that day, epoch ms, in the reader's own zone. */
    readonly t: number;
    readonly count: number;
}

/**
 * A month of timestamps, counted into the days they fall in.
 *
 * Done here rather than in the query because a day begins at midnight where the
 * reader is, and the server is the one party to this that does not know which
 * zone that is - so the zone comes from the same display preference every other
 * date on the screen is drawn with.
 *
 * The dates are walked as a calendar and each one is then turned back into the
 * instant its midnight actually happened at. Subtracting twenty-four hours would
 * be a day out by the end of the month: twice a year one of them is twenty-three
 * hours long.
 *
 * Every day in the window is present, including the empty ones. A chart that
 * skipped them would draw a quiet fortnight as a straight line between two busy
 * days, which is the opposite of what happened.
 */
export function bucketUsage(
    times: readonly number[],
    timeZone: string,
    days = USAGE_DAYS,
    now = Date.now()
): UsageDay[] {
    const today = wallClock(new Date(now), timeZone);
    // The calendar walk is done in UTC, where every day is the same length and
    // `setUTCDate` cannot land anywhere surprising. Nothing is read off it but
    // the date, which is then asked what instant its midnight was.
    const cursor = new Date(Date.UTC(today.year, today.month - 1, today.day));
    cursor.setUTCDate(cursor.getUTCDate() - (days - 1));

    const starts: number[] = [];
    for (let day = 0; day < days; day += 1) {
        starts.push(
            zonedInstant(
                {
                    year: cursor.getUTCFullYear(),
                    month: cursor.getUTCMonth() + 1,
                    day: cursor.getUTCDate(),
                    hours: 0,
                    minutes: 0
                },
                timeZone
            ).getTime()
        );
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const counts = new Array<number>(starts.length).fill(0);
    for (const time of times) {
        if (time < (starts[0] ?? 0)) continue;
        let index = starts.length - 1;
        while (index > 0 && time < (starts[index] ?? 0)) index -= 1;
        counts[index] = (counts[index] ?? 0) + 1;
    }
    return starts.map((t, index) => ({ t, count: counts[index] ?? 0 }));
}
