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

import { z } from "zod";
import type { PlacesTranslator } from "./i18n";
import { wallClock, zonedInstant } from "@polaris/core";
import { englishPlaces as en, type PlacesKey } from "../../messages";
import {
    airCommandIssue,
    airCommandSchema,
    airModeText,
    airSpeedText,
    applyAir,
    type AirCommand,
    type AirSettings
} from "./air-kinds";

import { applianceStatusText, type ApplianceView } from "./appliance-kinds";

export * from "./air-kinds";
export * from "./appliance-kinds";

/** What a device does, which is what decides the buttons it gets. */
export const DEVICE_KINDS = [
    "lock",
    "opener",
    "climate",
    "air",
    "switch",
    "outlet",
    "light",
    "sensor",
    "appliance"
] as const;

export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const DEVICE_KIND_LABELS: Readonly<Record<DeviceKind, string>> = {
    lock: en("devices.kinds.lock"),
    opener: en("devices.kinds.opener"),
    climate: en("devices.kinds.climate"),
    air: en("devices.kinds.air"),
    switch: en("devices.kinds.switch"),
    outlet: en("devices.kinds.outlet"),
    light: en("devices.kinds.light"),
    sensor: en("devices.kinds.sensor"),
    appliance: en("devices.kinds.appliance")
};

/** Devices of the same sort, listed together. A place has a handful of doors and
 *  can have thirty sockets, and reading them as one list is reading neither. */
export const DEVICE_GROUP_LABELS: Readonly<Record<DeviceKind, string>> = {
    lock: en("devices.groups.lock"),
    opener: en("devices.groups.opener"),
    climate: en("devices.groups.climate"),
    air: en("devices.groups.air"),
    switch: en("devices.groups.switch"),
    outlet: en("devices.groups.outlet"),
    light: en("devices.groups.light"),
    sensor: en("devices.groups.sensor"),
    appliance: en("devices.groups.appliance")
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
    Open: "devices.readings.open",
    Closed: "devices.readings.closed",
    Unlocked: "devices.readings.unlocked",
    Locked: "devices.readings.locked",
    Movement: "devices.readings.movement",
    Still: "devices.readings.still",
    "Somebody there": "devices.readings.occupied",
    Empty: "devices.readings.empty",
    Home: "devices.readings.home",
    Away: "devices.readings.away",
    Wet: "devices.readings.wet",
    Dry: "devices.readings.dry",
    Smoke: "devices.readings.smoke",
    Clear: "devices.readings.clear",
    Gas: "devices.readings.gas",
    Problem: "devices.readings.problem",
    Fine: "devices.readings.fine",
    Low: "devices.readings.low",
    Connected: "devices.readings.connected",
    Disconnected: "devices.readings.disconnected",
    Tampered: "devices.readings.tampered"
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
export const DEVICE_ACTIONS = [
    "lock",
    "unlock",
    "unlatch",
    "turn-on",
    "turn-off",
    "set-mode",
    "set-temperature",
    "set-fan",
    "set-option",
    "set-humidity",
    "stop"
] as const;

export type DeviceAction = (typeof DEVICE_ACTIONS)[number];

export const DEVICE_ACTION_LABELS: Readonly<Record<DeviceAction, string>> = {
    lock: en("devices.actions.lock"),
    unlock: en("devices.actions.unlock"),
    unlatch: en("devices.actions.unlatch"),
    "turn-on": en("devices.actions.turn-on"),
    "turn-off": en("devices.actions.turn-off"),
    "set-mode": en("devices.actions.set-mode"),
    "set-temperature": en("devices.actions.set-temperature"),
    "set-fan": en("devices.actions.set-fan"),
    "set-option": en("devices.actions.set-option"),
    "set-humidity": en("devices.actions.set-humidity"),
    stop: en("devices.actions.stop")
};

/** The same actions as something a sentence can be built out of. The label on a
 *  button and the verb in a refusal are not the same word: a button says "On",
 *  and a refusal has to say what could not be done. */
export const DEVICE_ACTION_VERBS: Readonly<Record<DeviceAction, string>> = {
    lock: "lock",
    unlock: "unlock",
    unlatch: "open",
    "turn-on": "turn on",
    "turn-off": "turn off",
    "set-mode": "change mode",
    "set-temperature": "change temperature",
    "set-fan": "change fan speed",
    "set-option": "change a setting",
    "set-humidity": "change humidity",
    stop: "stop"
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
    // An air conditioner is switched like a socket and then told how: a mode,
    // a temperature, a fan speed and whichever extras it has. The extras are
    // per unit, and `climateCommandIssue` is what refuses one it lacks.
    climate: ["turn-on", "turn-off", "set-mode", "set-temperature", "set-fan", "set-option"],
    // A purifier is switched, then put on a preset or a fan speed; a humidifier
    // also aims at a humidity. What a unit lacks, `airCommandIssue` refuses.
    air: ["turn-on", "turn-off", "set-mode", "set-fan", "set-option", "set-humidity"],
    switch: ["turn-on", "turn-off"],
    outlet: ["turn-on", "turn-off"],
    light: ["turn-on", "turn-off"],
    // A sensor is not done, it is read. Nothing to press, and a row that offered
    // something would be offering to change the weather.
    sensor: [],
    // A kitchen appliance is watched, and may be stopped from here. Nothing that
    // starts it is offered: it would be heating with nobody there to see it.
    // Whether one can be stopped at all is the unit's (`stoppable`).
    appliance: ["stop"]
};

export function actionsFor(kind: string): readonly DeviceAction[] {
    return KIND_ACTIONS[deviceKind(kind)];
}

/** Whether a kind is worked by one switch rather than a row of buttons: it has
 *  on and off and nothing else, so the control is where it is now. */
export function isSwitchable(kind: string): boolean {
    const actions = actionsFor(kind);
    return actions.length === 2 && actions.includes("turn-on") && actions.includes("turn-off");
}

/** The state a device is in once an action has finished, where that is known
 *  before anything answers. A switch told to go on is on or it failed; a lock
 *  told to lock is turning, and what it reaches is the vendor's to report. */
export function settledState(action: DeviceAction): DeviceState | null {
    if (action === "turn-on") return "on";
    if (action === "turn-off") return "off";
    return null;
}

// --- air conditioners ---------------------------------------------------------

/**
 * What an air conditioner can be set to do. The words are Places' own: Gree
 * numbers them, Tuya calls cooling "cold" and Home Assistant calls the fan
 * "fan_only", and each driver translates once on the way in and on the way out.
 * Off is not a mode here - it is the power, which is the device's state - so a
 * unit that is off still remembers whether it was cooling.
 */
export const CLIMATE_MODES = ["cool", "heat", "dry", "fan", "auto"] as const;
export type ClimateMode = (typeof CLIMATE_MODES)[number];

/** Fan speeds, slowest first after automatic. A unit offers the ones it has. */
export const CLIMATE_FANS = ["auto", "low", "medium-low", "medium", "medium-high", "high"] as const;
export type ClimateFan = (typeof CLIMATE_FANS)[number];

/** The extras some units have and some do not, each simply on or off. */
export const CLIMATE_OPTIONS = ["swing", "turbo", "quiet", "eco"] as const;
export type ClimateOption = (typeof CLIMATE_OPTIONS)[number];

export const CLIMATE_UNITS = ["C", "F"] as const;
export type ClimateUnit = (typeof CLIMATE_UNITS)[number];

/** The widest range any unit is believed when it states its own: anything past
 *  this is a misread, not an air conditioner. */
const TEMPERATURE_FLOOR = -50;
const TEMPERATURE_CEILING = 150;

const temperature = z.number().finite().min(TEMPERATURE_FLOOR).max(TEMPERATURE_CEILING);

/**
 * How an air conditioner is set, and what it can be set to.
 *
 * Stored on the device row as one document, refreshed by every sync. The
 * current room temperature is not in here: it is the device's reading, the same
 * column a thermometer's lives in, which is what lets an automation compare it
 * like any other temperature. An option is listed only when the unit has it, so
 * a switch for something it cannot do is never drawn.
 */
export const climateSettingsSchema = z
    .object({
        mode: z.enum(CLIMATE_MODES).nullable(),
        modes: z.array(z.enum(CLIMATE_MODES)).max(CLIMATE_MODES.length),
        target: temperature.nullable(),
        min: temperature,
        max: temperature,
        step: z.number().finite().positive().max(10),
        unit: z.enum(CLIMATE_UNITS),
        fan: z.enum(CLIMATE_FANS).nullable(),
        fans: z.array(z.enum(CLIMATE_FANS)).max(CLIMATE_FANS.length),
        options: z.object({
            swing: z.boolean().optional(),
            turbo: z.boolean().optional(),
            quiet: z.boolean().optional(),
            eco: z.boolean().optional()
        })
    })
    .refine((settings) => settings.min < settings.max);

export type ClimateSettings = z.infer<typeof climateSettingsSchema>;

/** The settings with the room's temperature beside them, as a screen draws it. */
export interface ClimateView extends ClimateSettings {
    readonly current: number | null;
}

/** Stored settings, read back, or null for anything that is not them - a row
 *  from before air conditioners, or a document a later build wrote. */
export function climateSettings(value: unknown): ClimateSettings | null {
    const parsed = climateSettingsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** A reading that is a number, or null. "22.5" and "22,5" are both 22.5. */
export function readingNumber(value: string | null | undefined): number | null {
    const match = /-?\d+(?:[.,]\d+)?/.exec(value ?? "");
    if (!match) return null;
    const parsed = Number(match[0].replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One change to an air conditioner, with what it is changed to.
 *
 * Checked twice: by this schema for its shape wherever it arrives from, and by
 * `climateCommandIssue` against the unit it is for, because a temperature that is
 * a perfectly good number is still not one a unit that stops at 30 accepts.
 */
export const climateCommandSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("set-mode"), mode: z.enum(CLIMATE_MODES) }),
    z.object({ action: z.literal("set-temperature"), target: temperature }),
    z.object({ action: z.literal("set-fan"), fan: z.enum(CLIMATE_FANS) }),
    z.object({
        action: z.literal("set-option"),
        option: z.enum(CLIMATE_OPTIONS),
        on: z.boolean()
    })
]);

export type ClimateCommand = z.infer<typeof climateCommandSchema>;

/** The actions that say what to set, and so arrive with a command. */
export function needsCommand(action: DeviceAction): boolean {
    return (
        action === "set-mode" ||
        action === "set-temperature" ||
        action === "set-fan" ||
        action === "set-option" ||
        action === "set-humidity"
    );
}

/** Whether a temperature sits on a unit's own grid: 24.5 is fine on a unit that
 *  steps by a half and refused on one that steps by whole degrees. */
function onStep(value: number, settings: ClimateSettings): boolean {
    const steps = (value - settings.min) / settings.step;
    return Math.abs(steps - Math.round(steps)) < 1e-6;
}

/** Why a typed target cannot be sent, in the terms the field explains it in. */
export type TypedTemperatureIssue = "number" | "range" | "step";

/**
 * A target temperature somebody typed, read the way they meant it.
 *
 * Trimmed, with a decimal comma read as a point - "24,5" is how half of Europe
 * writes it - and a trailing degree sign or unit allowed, since that is what the
 * field shows beside the number. Then held to the same rule the service applies
 * (`climateCommandIssue`): inside the unit's range and on its step. A value off
 * either is refused and said, never moved to the nearest one that fits: the
 * person typed 31 because they wanted 31, and silently sending 30 is a setting
 * they did not choose.
 *
 * Null for nothing typed, which is not a mistake - it is a field left alone.
 */
export function typedTemperature(
    text: string,
    settings: Pick<ClimateSettings, "min" | "max" | "step">
): { target: number } | { issue: TypedTemperatureIssue } | null {
    const cleaned = text
        .trim()
        .replace(/\s*°?\s*[cfCF]?$/, "")
        .replace(",", ".");
    if (cleaned === "") return null;
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { issue: "number" };
    const target = Number(cleaned);
    if (!Number.isFinite(target)) return { issue: "number" };
    if (target < settings.min || target > settings.max) return { issue: "range" };
    const steps = (target - settings.min) / settings.step;
    if (Math.abs(steps - Math.round(steps)) >= 1e-6) return { issue: "step" };
    return { target };
}

/**
 * Whether a number being typed could still become one in range by typing more.
 *
 * "2" on a unit that takes 16 to 30 is the start of "24", not a mistake, and a
 * field that shouts "between 16 and 30" at the first keystroke is one people
 * learn to ignore. Only whole numbers grow this way: once there is a decimal
 * point, more digits cannot make a too-small number big enough.
 */
export function mayStillGrow(
    text: string,
    settings: Pick<ClimateSettings, "min" | "max">
): boolean {
    const cleaned = text.trim().replace(",", ".");
    if (!/^\d+$/.test(cleaned)) return false;
    const value = Number(cleaned);
    return value < settings.min && value * 10 <= settings.max;
}

/**
 * Why a command cannot go to this unit, as the sentence the service refuses
 * with, or null when it can. The same answer in the browser, where it decides
 * what is drawn, and on the server, where it decides what is sent.
 */
export function climateCommandIssue(
    settings: ClimateSettings | null,
    command: ClimateCommand
): string | null {
    if (!settings) return "That device has not said what it can be set to yet";
    switch (command.action) {
        case "set-mode":
            return settings.modes.includes(command.mode)
                ? null
                : "That mode is not one this device has";
        case "set-temperature":
            return command.target >= settings.min &&
                command.target <= settings.max &&
                onStep(command.target, settings)
                ? null
                : "That temperature is not one this device accepts";
        case "set-fan":
            return settings.fans.includes(command.fan)
                ? null
                : "That fan speed is not one this device has";
        case "set-option":
            return settings.options[command.option] === undefined
                ? "That setting is not one this device has"
                : null;
    }
}

/** The settings once a command has landed. What the row shows the moment it is
 *  pressed, and what the service stores once the unit has accepted it. */
export function applyClimate(settings: ClimateSettings, command: ClimateCommand): ClimateSettings {
    switch (command.action) {
        case "set-mode":
            return { ...settings, mode: command.mode };
        case "set-temperature":
            return { ...settings, target: command.target };
        case "set-fan":
            return { ...settings, fan: command.fan };
        case "set-option":
            return { ...settings, options: { ...settings.options, [command.option]: command.on } };
    }
}

// --- any setting, whichever kind it is for ------------------------------------

/** One change to a device that takes a setting: an air conditioner's or a
 *  purifier's. The two share action words and differ in what they carry. */
export type DeviceCommand = ClimateCommand | AirCommand;

/** The shape of a setting as it arrives from anywhere, either kind's. Which kind
 *  it has to be is the device's to decide: `commandIssue` checks it again
 *  against that kind alone. */
export const deviceCommandSchema = z.union([climateCommandSchema, airCommandSchema]);

/** What a device holds that a command is checked against. */
export interface CommandTarget {
    readonly kind: string;
    readonly climate: ClimateSettings | null;
    readonly air: AirSettings | null;
}

/** The command, read as the device's own kind's, or null when it is not one. */
export function commandFor(
    kind: string,
    command: unknown
): { kind: "climate"; command: ClimateCommand } | { kind: "air"; command: AirCommand } | null {
    const which = deviceKind(kind);
    if (which === "climate") {
        const parsed = climateCommandSchema.safeParse(command);
        return parsed.success ? { kind: "climate", command: parsed.data } : null;
    }
    if (which === "air") {
        const parsed = airCommandSchema.safeParse(command);
        return parsed.success ? { kind: "air", command: parsed.data } : null;
    }
    return null;
}

/** The command as an air conditioner's, or nothing when it is not one. What a
 *  climate driver is handed, so a purifier's setting can never reach it. */
export function climateCommandOf(command: DeviceCommand | undefined): ClimateCommand | undefined {
    const parsed = climateCommandSchema.safeParse(command);
    return parsed.success ? parsed.data : undefined;
}

/** The command as a purifier's, or nothing when it is not one. */
export function airCommandOf(command: DeviceCommand | undefined): AirCommand | undefined {
    const parsed = airCommandSchema.safeParse(command);
    return parsed.success ? parsed.data : undefined;
}

/** Why a command cannot go to this device, or null when it can. */
export function commandIssue(device: CommandTarget, command: DeviceCommand): string | null {
    const read = commandFor(device.kind, command);
    if (!read) return "That device cannot be told to do that";
    return read.kind === "climate"
        ? climateCommandIssue(device.climate, read.command)
        : airCommandIssue(device.air, read.command);
}

/** A device's settings once a command has landed, or null when the command is
 *  not its kind's or there is nothing to apply it to. */
export function applyCommand(
    device: CommandTarget,
    command: DeviceCommand
): { climate: ClimateSettings } | { air: AirSettings } | null {
    const read = commandFor(device.kind, command);
    if (!read) return null;
    if (read.kind === "climate")
        return device.climate ? { climate: applyClimate(device.climate, read.command) } : null;
    return device.air ? { air: applyAir(device.air, read.command) } : null;
}

/** A temperature as a person reads it: no trailing ".0", the unit closed up. */
export function temperatureText(value: number, unit: ClimateUnit): string {
    return `${degreesText(value)}°${unit}`;
}

/** A temperature to one decimal, without its unit. */
export function degreesText(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

export function climateModeText(mode: ClimateMode, t: PlacesTranslator = en): string {
    return t(`devices.climate.modes.${mode}`);
}

export function climateFanText(fan: ClimateFan, t: PlacesTranslator = en): string {
    return t(`devices.climate.fans.${fan}`);
}

export function climateOptionText(option: ClimateOption, t: PlacesTranslator = en): string {
    return t(`devices.climate.options.${option}`);
}

/**
 * The word on a device's badge.
 *
 * A sensor's badge is its reading, and one whose reading has not arrived says so
 * rather than borrowing the word a lock uses for the same silence. An air
 * conditioner that is on says what it is doing - "Cool" tells somebody more than
 * "On". Everything else says its state, in its own kind's words.
 */
export function badgeText(device: DeviceView, t: PlacesTranslator = en): string {
    if (!device.online) return t("devices.states.unknown");
    const kind = deviceKind(device.kind);
    if (kind === "sensor") return readingLine(device.reading, t) || t("devicesView.nothingRead");
    // An appliance says what it is doing: "Cooking" rather than "On".
    if (kind === "appliance" && device.appliance?.status) {
        return applianceStatusText(device.appliance.status, t);
    }
    if (kind === "climate" && device.state === "on" && device.climate?.mode) {
        return climateModeText(device.climate.mode, t);
    }
    // A purifier that is on says what it is running: "Sleep" rather than "On".
    if (kind === "air" && device.state === "on" && device.air) {
        if (device.air.mode) return airModeText(device.air.mode, t);
        if (device.air.speed) return airSpeedText(device.air.speed, t);
    }
    return stateLabel(device.kind, device.state, t);
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
    /** How an air conditioner is set, and the room's temperature beside it. Null,
     *  or absent, for every other kind. */
    readonly climate?: ClimateView | null;
    /** How a purifier or humidifier is set and what it last read. Null, or
     *  absent, for every other kind. */
    readonly air?: AirSettings | null;
    /** What a kitchen appliance is doing. Null, or absent, for every other kind. */
    readonly appliance?: ApplianceView | null;
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
