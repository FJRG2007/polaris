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

import { wallClock, zonedInstant } from "@polaris/core";

/** What a device does, which is what decides the buttons it gets. */
export const DEVICE_KINDS = ["lock", "opener", "switch", "outlet", "light"] as const;

export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const DEVICE_KIND_LABELS: Readonly<Record<DeviceKind, string>> = {
    lock: "Lock",
    opener: "Door opener",
    switch: "Switch",
    outlet: "Socket",
    light: "Light"
};

/** Devices of the same sort, listed together. A place has a handful of doors and
 *  can have thirty sockets, and reading them as one list is reading neither. */
export const DEVICE_GROUP_LABELS: Readonly<Record<DeviceKind, string>> = {
    lock: "Doors",
    opener: "Doors",
    switch: "Switches and sockets",
    outlet: "Switches and sockets",
    light: "Lights"
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
    locked: "Locked",
    unlocked: "Unlocked",
    unlatched: "Open",
    moving: "Moving",
    jammed: "Jammed",
    uncalibrated: "Not calibrated",
    on: "On",
    off: "Off",
    unknown: "Not answering"
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
const KIND_STATE_LABELS: Readonly<Partial<Record<DeviceKind, Partial<Record<DeviceState, string>>>>> = {
    lock: { unlatched: "Latch open" },
    opener: { locked: "Idle", unlatched: "Letting through" }
};

export function stateLabel(kind: string, state: DeviceState): string {
    return KIND_STATE_LABELS[deviceKind(kind)]?.[state] ?? DEVICE_STATE_LABELS[state];
}

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
    open: "Door open",
    closed: "Door closed",
    unknown: "Door state unknown",
    none: ""
};

/** What somebody can ask of a device from here. */
export const DEVICE_ACTIONS = ["lock", "unlock", "unlatch", "turn-on", "turn-off"] as const;

export type DeviceAction = (typeof DEVICE_ACTIONS)[number];

export const DEVICE_ACTION_LABELS: Readonly<Record<DeviceAction, string>> = {
    lock: "Lock",
    unlock: "Unlock",
    unlatch: "Open",
    "turn-on": "On",
    "turn-off": "Off"
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
    light: ["turn-on", "turn-off"]
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
    return (DEVICE_STATES as readonly string[]).includes(value) ? (value as DeviceState) : "unknown";
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
    polaris: "from Polaris",
    app: "from the app",
    keypad: "on the keypad",
    fob: "with a fob",
    button: "on the device",
    auto: "automatically",
    manual: "by hand",
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

const ACTION_SENTENCES: Readonly<Record<string, string>> = {
    lock: "Locked",
    unlock: "Unlocked",
    unlatch: "Opened",
    "turn-on": "Turned on",
    "turn-off": "Turned off",
    "lock-and-go": "Locked behind whoever left",
    "door-opened": "Door opened",
    "door-closed": "Door closed",
    "door-ajar": "Door left open",
    calibrated: "Calibrated",
    other: "Something happened"
};

/**
 * One line for one entry in the history.
 *
 * Written as a sentence rather than assembled from columns on screen, so the log,
 * the device panel and anything later that shows the same entry cannot word it
 * three ways. A failed action says so first: the reason somebody is reading this
 * list at all is usually that a door did not do what it was told.
 */
export function describeEvent(event: DeviceEventView): string {
    const what = ACTION_SENTENCES[event.action] ?? ACTION_SENTENCES.other;
    const by = event.actor ? ` by ${event.actor}` : "";
    const how = DEVICE_VIA_LABELS[event.via as DeviceVia] ?? "";
    const line = `${what}${by}${how ? ` ${how}` : ""}`;
    if (event.outcome === "ok") return line;
    return event.note ? `${line} - ${event.note}` : `${line} - it did not finish`;
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
