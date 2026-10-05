/**
 * SwitchBot over their cloud, as devices.
 *
 * One connection is the account, and it brings what maps onto something Places
 * can draw honestly: plugs and relays, the Bot, the locks, the lights, and the
 * meter, contact and motion sensors. Everything else on the account - curtains,
 * humidifiers, vacuums, infrared remotes - is left out.
 *
 * The account allows 10,000 calls a day, and a status is one call per device.
 * `device-watch` already paces this account at a minute rather than the
 * cadence it gives a cloud account, for the same quota - but that is still
 * too often to spend a call on every device every time, so a status is held
 * for a few minutes and the list of devices for longer. Pressing refresh
 * (`probe`) and pressing a button on a device both throw the held answer
 * away, so what somebody asked for is always read fresh.
 *
 * Server-only.
 */

import { createHash } from "node:crypto";
import { HomeError } from "../home-error";
import * as switchbot from "../integrations/switchbot-api";
import { BINARY_WORDS, type DeviceKind } from "../device-kinds";
import { DriverError, type Credentials, type DeviceDriver, type DeviceSnapshot } from "./contract";

export const SWITCHBOT_CLOUD = "switchbot-cloud";

const STATUS_TTL_MS = 5 * 60_000;
const DEVICES_TTL_MS = 15 * 60_000;

/** Their device types, by what each is here. Exact strings from each device's
 *  page in their documentation. */
const TYPES: Readonly<Record<string, DeviceKind>> = {
    Plug: "outlet",
    "Plug Mini (US)": "outlet",
    "Plug Mini (JP)": "outlet",
    "Plug Mini (EU)": "outlet",
    "Relay Switch 1": "switch",
    "Relay Switch 1PM": "switch",
    Bot: "switch",
    "Smart Lock": "lock",
    "Smart Lock Pro": "lock",
    "Lock Lite": "lock",
    "Smart Lock Ultra": "lock",
    "Lock Ultra": "lock",
    "Smart Lock Pro Wifi": "lock",
    "Color Bulb": "light",
    "Strip Light": "light",
    "Ceiling Light": "light",
    Meter: "sensor",
    "Contact Sensor": "sensor",
    "Motion Sensor": "sensor"
};

function credentialsOf(credentials: Credentials): switchbot.SwitchBotCredentials {
    const token = credentials.token?.trim();
    const secret = credentials.secret?.trim();
    if (!token || !secret) throw new HomeError("That connection is missing its keys");
    return { token, secret };
}

/** Held answers, per account. The key is a hash so no token sits in a map key. */
const held = new Map<
    string,
    {
        devices?: { at: number; list: switchbot.SwitchBotDevice[] };
        statuses: Map<string, { at: number; status: Record<string, unknown> }>;
    }
>();

function heldFor(keys: switchbot.SwitchBotCredentials) {
    const id = createHash("sha256").update(keys.token).digest("hex");
    let entry = held.get(id);
    if (!entry) {
        entry = { statuses: new Map() };
        held.set(id, entry);
    }
    return entry;
}

/** Forget everything held, for a test or a refresh. */
export function forgetSwitchBot(keys?: switchbot.SwitchBotCredentials): void {
    if (!keys) held.clear();
    else held.delete(createHash("sha256").update(keys.token).digest("hex"));
}

async function devicesOf(keys: switchbot.SwitchBotCredentials) {
    const cache = heldFor(keys);
    if (cache.devices && Date.now() - cache.devices.at < DEVICES_TTL_MS) return cache.devices.list;
    const list = await switchbot.switchBotDevices(keys);
    cache.devices = { at: Date.now(), list };
    return list;
}

/** A status, or null when the device is not answering SwitchBot. */
async function statusOf(keys: switchbot.SwitchBotCredentials, deviceId: string) {
    const cache = heldFor(keys);
    const kept = cache.statuses.get(deviceId);
    if (kept && Date.now() - kept.at < STATUS_TTL_MS) return kept.status;
    try {
        const status = await switchbot.switchBotStatus(keys, deviceId);
        cache.statuses.set(deviceId, { at: Date.now(), status });
        return status;
    } catch (caught) {
        // One plug offline is that plug's problem, not the account's.
        if (
            caught instanceof DriverError &&
            caught.kind === "unreachable" &&
            caught.message.startsWith("The device")
        ) {
            return null;
        }
        throw caught;
    }
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function numberOf(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** On or off, from `power` ("on"/"off", case not stated in their docs) or, on
 *  the newer plugs and relays, `switchStatus` (1/0). */
function onOffOf(status: Record<string, unknown>): DeviceSnapshot["state"] {
    const power = text(status.power).toLowerCase();
    if (power === "on") return "on";
    if (power === "off") return "off";
    if (status.switchStatus === 1) return "on";
    if (status.switchStatus === 0) return "off";
    return "unknown";
}

function lockStateOf(status: Record<string, unknown>): DeviceSnapshot["state"] {
    const state = text(status.lockState).toLowerCase();
    if (state === "lock" || state === "locked" || state === "latchboltlocked") return "locked";
    if (state === "unlock" || state === "unlocked") return "unlocked";
    if (state === "jammed") return "jammed";
    return "unknown";
}

function doorOf(status: Record<string, unknown>): DeviceSnapshot["doorState"] {
    const door = text(status.doorState).toLowerCase();
    return door === "open" ? "open" : door === "close" || door === "closed" ? "closed" : "none";
}

function rowsOf(
    device: switchbot.SwitchBotDevice,
    kind: DeviceKind,
    status: Record<string, unknown> | null
): DeviceSnapshot[] {
    const battery = status ? numberOf(status.battery) : null;
    const base = {
        name: device.deviceName.trim() || device.deviceType,
        model: device.deviceType || null,
        firmware: status ? text(status.version) || null : null,
        doorState: "none" as DeviceSnapshot["doorState"],
        batteryPercent: battery,
        // Their battery is reported in four steps, the lowest of them 9 or 10.
        batteryCritical: battery !== null && battery <= 10,
        online: status !== null
    };
    if (kind !== "sensor") {
        const state = !status ? "unknown" : kind === "lock" ? lockStateOf(status) : onOffOf(status);
        return [
            {
                ...base,
                externalId: device.deviceId,
                kind,
                state,
                doorState: kind === "lock" && status ? doorOf(status) : "none"
            }
        ];
    }
    const reading = (externalId: string, value: string | null, unit: string): DeviceSnapshot => ({
        ...base,
        externalId,
        kind: "sensor",
        state: "unknown",
        value,
        unit
    });
    if (device.deviceType === "Meter") {
        const temperature = status ? numberOf(status.temperature) : null;
        const humidity = status ? numberOf(status.humidity) : null;
        return [
            reading(
                `${device.deviceId}#temperature`,
                temperature === null ? null : String(temperature),
                "°C"
            ),
            reading(`${device.deviceId}#humidity`, humidity === null ? null : String(humidity), "%")
        ];
    }
    if (device.deviceType === "Contact Sensor") {
        const open = text(status?.openState).toLowerCase();
        const words = BINARY_WORDS.door!;
        // "timeOutNotClose" is a door left open too long - still open.
        return [
            reading(
                device.deviceId,
                !status || !open ? null : open === "close" ? words.off : words.on,
                ""
            )
        ];
    }
    const moving = status?.moveDetected;
    const words = BINARY_WORDS.motion!;
    return [
        reading(
            device.deviceId,
            typeof moving === "boolean" ? (moving ? words.on : words.off) : null,
            ""
        )
    ];
}

/** The command an action is, for a kind. A lock has no documented command for
 *  pulling its latch, so that one is refused rather than guessed. */
function commandFor(kind: string, action: string): string | null {
    if (kind === "lock") return action === "lock" ? "lock" : action === "unlock" ? "unlock" : null;
    return action === "turn-on" ? "turnOn" : action === "turn-off" ? "turnOff" : null;
}

export const switchBotCloudDriver: DeviceDriver = {
    connection: SWITCHBOT_CLOUD,

    /** Whether the token and secret work. The list is fetched fresh, never held,
     *  so a replaced secret is proved against SwitchBot rather than a cache. */
    async verify(credentials) {
        const keys = credentialsOf(credentials);
        forgetSwitchBot(keys);
        await switchbot.switchBotDevices(keys);
    },

    async list(credentials) {
        const keys = credentialsOf(credentials);
        const devices = await devicesOf(keys);
        const rows: DeviceSnapshot[] = [];
        for (const device of devices) {
            const kind = TYPES[device.deviceType];
            if (!kind) continue;
            // A device with cloud service switched off in the app cannot be read
            // through the API at all; it is drawn, saying it is not answering.
            const status = device.enableCloudService ? await statusOf(keys, device.deviceId) : null;
            rows.push(...rowsOf(device, kind, status));
        }
        return rows;
    },

    /** Somebody pressed refresh: read everything fresh. */
    async probe(credentials) {
        forgetSwitchBot(credentialsOf(credentials));
    },

    async act(credentials, device, action) {
        const command = commandFor(device.kind, action);
        if (!command) throw new HomeError("A SwitchBot device cannot be told to do that");
        const keys = credentialsOf(credentials);
        await switchbot.switchBotCommand(keys, device.externalId, command);
        heldFor(keys).statuses.delete(device.externalId);
    }
};
