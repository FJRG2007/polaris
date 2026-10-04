/**
 * What a place's Overview says about its devices: the figures at the top, the
 * rooms below them, and the short list of what needs somebody.
 *
 * The shape follows Home Assistant's own Home dashboard, which landed on it after
 * reading a great many shared dashboards: summaries first, one for each sort of
 * thing a house actually has (lights, climate, security), then the house by
 * area. A summary for something the place has none of is left out rather than
 * drawn as zero, so a flat with two sockets is not told about its locks.
 *
 * Pure and client-safe: the screen derives all of it from the device list it
 * already holds, so an optimistic press moves the figures with the switch.
 */

import * as kinds from "./device-kinds";
import type { DeviceView } from "./device-kinds";

/** Why a device is on the "needs attention" list, worst first. */
export const ATTENTION_REASONS = ["jammed", "offline", "battery", "door-open"] as const;

export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export interface Attention {
    readonly device: DeviceView;
    readonly reason: AttentionReason;
}

/** The room temperatures read across the place, in the unit most of them use. */
export interface TemperatureSpread {
    readonly min: number;
    readonly max: number;
    readonly unit: kinds.ClimateUnit;
}

export interface DeviceSummary {
    readonly total: number;
    readonly online: number;
    readonly offline: number;
    readonly lights: number;
    readonly lightsOn: number;
    readonly climate: number;
    readonly climateOn: number;
    readonly temperatures: TemperatureSpread | null;
    /** Locks and door openers: what a "security" summary is about. */
    readonly locks: number;
    readonly unlocked: number;
    readonly doorsOpen: number;
    readonly attention: readonly Attention[];
}

/** Whether a device is a lock rather than something switched or read. */
function isLock(device: DeviceView): boolean {
    return kinds.deviceKind(device.kind) === "lock";
}

/** A temperature a device reports, with its unit, or null. */
function temperatureOf(device: DeviceView): { value: number; unit: kinds.ClimateUnit } | null {
    if (device.climate && device.climate.current !== null) {
        return { value: device.climate.current, unit: device.climate.unit };
    }
    const air = device.air?.readings.temperature;
    if (air !== undefined) return { value: air, unit: "C" };
    const reading = device.reading;
    if (!reading) return null;
    const unit = /^°?([CF])$/i.exec(reading.unit.trim())?.[1]?.toUpperCase();
    const value = kinds.readingNumber(reading.value);
    if (!unit || value === null) return null;
    return { value, unit: unit as kinds.ClimateUnit };
}

/** Why one device needs somebody, or null when it does not. */
export function attentionFor(device: DeviceView): AttentionReason | null {
    if (device.online && (device.state === "jammed" || device.state === "uncalibrated")) {
        return "jammed";
    }
    if (!device.online) return "offline";
    if (device.batteryCritical) return "battery";
    if (device.doorState === "open" && isLock(device)) return "door-open";
    return null;
}

/** The figures for a list of devices. */
export function summarizeDevices(devices: readonly DeviceView[]): DeviceSummary {
    let online = 0;
    let lights = 0;
    let lightsOn = 0;
    let climate = 0;
    let climateOn = 0;
    let locks = 0;
    let unlocked = 0;
    let doorsOpen = 0;
    const attention: Attention[] = [];
    const temperatures = new Map<kinds.ClimateUnit, number[]>();

    for (const device of devices) {
        const kind = kinds.deviceKind(device.kind);
        if (device.online) online += 1;
        if (kind === "light") {
            lights += 1;
            if (device.online && device.state === "on") lightsOn += 1;
        }
        if (kind === "climate") {
            climate += 1;
            if (device.online && device.state === "on") climateOn += 1;
        }
        if (kind === "lock" || kind === "opener") {
            locks += 1;
            if (device.online && (device.state === "unlocked" || device.state === "unlatched")) {
                unlocked += 1;
            }
        }
        if (device.doorState === "open") doorsOpen += 1;
        const temperature = device.online ? temperatureOf(device) : null;
        if (temperature) {
            const list = temperatures.get(temperature.unit) ?? [];
            list.push(temperature.value);
            temperatures.set(temperature.unit, list);
        }
        const reason = attentionFor(device);
        if (reason) attention.push({ device, reason });
    }

    attention.sort(
        (left, right) =>
            ATTENTION_REASONS.indexOf(left.reason) - ATTENTION_REASONS.indexOf(right.reason) ||
            left.device.name.localeCompare(right.device.name)
    );

    // The unit most readings are in; a stray Fahrenheit sensor in a Celsius house
    // is not averaged into the rest.
    let spread: TemperatureSpread | null = null;
    let most = 0;
    for (const [unit, values] of temperatures) {
        if (values.length <= most) continue;
        most = values.length;
        spread = { min: Math.min(...values), max: Math.max(...values), unit };
    }

    return {
        total: devices.length,
        online,
        offline: devices.length - online,
        lights,
        lightsOn,
        climate,
        climateOn,
        temperatures: spread,
        locks,
        unlocked,
        doorsOpen,
        attention
    };
}

export interface Room {
    /** The room's name as its devices carry it; "" for devices placed nowhere. */
    readonly name: string;
    readonly devices: readonly DeviceView[];
    /** How many of its devices are on, for the line under the room's name. */
    readonly on: number;
}

/**
 * The devices of a place by room.
 *
 * A room is the zone its devices were given, compared without case or the
 * spaces around it, so "Kitchen" and "kitchen " are one room. Rooms are in
 * alphabetical order with the devices placed nowhere last; inside a room the
 * devices follow the kinds' own order - doors first, as on the devices screen.
 */
export function groupByRoom(devices: readonly DeviceView[]): Room[] {
    const rooms = new Map<string, { name: string; devices: DeviceView[] }>();
    for (const device of devices) {
        const name = device.zone.trim();
        const key = name.toLocaleLowerCase();
        const room = rooms.get(key) ?? { name, devices: [] };
        room.devices.push(device);
        rooms.set(key, room);
    }
    const order = (device: DeviceView) =>
        kinds.DEVICE_KINDS.indexOf(kinds.deviceKind(device.kind));
    return [...rooms.values()]
        .sort((left, right) =>
            left.name === "" ? 1 : right.name === "" ? -1 : left.name.localeCompare(right.name)
        )
        .map((room) => ({
            name: room.name,
            devices: room.devices.sort(
                (left, right) => order(left) - order(right) || left.name.localeCompare(right.name)
            ),
            on: room.devices.filter((device) => device.online && device.state === "on").length
        }));
}
