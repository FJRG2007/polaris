/**
 * Anything that announces itself on an MQTT broker.
 *
 * There is a convention every serious smart-home bridge already publishes:
 * alongside its state, a device writes a retained description of itself under a
 * discovery prefix, saying what it is, where its state is and where to send it a
 * command. Zigbee2MQTT does it, Tasmota does it, ESPHome does it, Shelly does it,
 * and so does anything written against them - which is why this one driver is
 * worth more than a shelf of per-make ones: a house with a Zigbee bridge gets
 * every bulb, plug and relay on it from a single connection.
 *
 * It is deliberately not a "Home Assistant" connection. The convention is what is
 * being read, not a product: nothing here talks to Home Assistant, nothing needs
 * it installed, and a broker that has one on it is simply a broker with these
 * topics on it.
 *
 * Only what Polaris can honestly draw is taken: things that are on or off, things
 * that lock, and things that read. A thermostat and a blind announce themselves
 * the same way and are skipped rather than listed with controls that would mean
 * something else - they are the next kinds to grow, not something to fake now.
 *
 * Server-only.
 */

import { z } from "zod";
import { HomeError } from "@/lib/home/home-error";
import * as broker from "@/lib/integrations/mqtt-broker";
import type { DeviceKind } from "@/lib/home/device-kinds";
import {
    DriverError,
    type Credentials,
    type DeviceDriver,
    type DeviceSnapshot
} from "@/lib/home/drivers/contract";

export const MQTT_DISCOVERY = "mqtt-discovery";

/** The convention's own default prefix, and what every bridge uses unless
 *  somebody changed it. */
export const DEFAULT_DISCOVERY_PREFIX = "homeassistant";

export const DEFAULT_BROKER_PORT = 1883;

/**
 * The components worth taking, as kinds.
 *
 * A switch is a switch and a light is a light. The two sensor components are
 * everything else a house is full of - a temperature, a door contact, a movement
 * detector - and they arrive as one kind here because what Polaris does with all
 * of them is the same: read them and draw what they said.
 */
const COMPONENT_KINDS: Readonly<Record<string, DeviceKind>> = {
    switch: "switch",
    light: "light",
    lock: "lock",
    sensor: "sensor",
    binary_sensor: "sensor"
};

/**
 * What a thing that is either true or false should say it is.
 *
 * The convention has a device class for this and it is the only reason the answer
 * is readable: "on" is what a contact publishes and "Open" is what its owner
 * needs to see. Anything unlisted falls back to on and off, which is honest
 * rather than wrong.
 */
const BINARY_WORDS: Readonly<Record<string, { on: string; off: string }>> = {
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

/**
 * What a device says about itself.
 *
 * The convention allows abbreviated keys - `stat_t` for `state_topic`, `cmd_t`
 * for `command_topic` - and Tasmota uses them by default to keep its payloads
 * small, so both spellings are read. Everything is optional: this is somebody
 * else's JSON, and a description missing the half that matters is skipped rather
 * than drawn as a device that cannot be reached.
 */
const configSchema = z
    .object({
        name: z.string().optional(),
        unique_id: z.string().optional(),
        uniq_id: z.string().optional(),
        object_id: z.string().optional(),
        state_topic: z.string().optional(),
        stat_t: z.string().optional(),
        command_topic: z.string().optional(),
        cmd_t: z.string().optional(),
        value_template: z.string().optional(),
        val_tpl: z.string().optional(),
        payload_on: z.union([z.string(), z.number(), z.boolean()]).optional(),
        pl_on: z.union([z.string(), z.number(), z.boolean()]).optional(),
        payload_off: z.union([z.string(), z.number(), z.boolean()]).optional(),
        pl_off: z.union([z.string(), z.number(), z.boolean()]).optional(),
        state_on: z.union([z.string(), z.number(), z.boolean()]).optional(),
        state_off: z.union([z.string(), z.number(), z.boolean()]).optional(),
        payload_lock: z.string().optional(),
        payload_unlock: z.string().optional(),
        state_locked: z.string().optional(),
        state_unlocked: z.string().optional(),
        unit_of_measurement: z.string().optional(),
        unit_of_meas: z.string().optional(),
        device_class: z.string().optional(),
        dev_cla: z.string().optional(),
        availability_topic: z.string().optional(),
        avty_t: z.string().optional(),
        payload_available: z.string().optional(),
        payload_not_available: z.string().optional(),
        device: z
            .object({
                name: z.string().optional(),
                model: z.string().optional(),
                manufacturer: z.string().optional(),
                sw_version: z.string().optional(),
                identifiers: z.union([z.string(), z.array(z.string())]).optional()
            })
            .optional()
    })
    .passthrough();

type Config = z.infer<typeof configSchema>;

/** One entry that was found, kept whole so `act` can use the same description the
 *  list was built from. */
interface Announced {
    readonly id: string;
    readonly kind: DeviceKind;
    /** The convention's own word for it. Two of them are one kind here and are
     *  not read the same way, which is the only reason this is kept. */
    readonly component: string;
    readonly config: Config;
}

function brokerOf(credentials: Credentials): broker.BrokerAddress & { prefix: string } {
    const host = credentials.host?.trim();
    if (!host) throw new HomeError("That connection is missing the broker's address");
    const port = Number(credentials.port || DEFAULT_BROKER_PORT);
    return {
        host,
        port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_BROKER_PORT,
        username: credentials.username ?? "",
        password: credentials.password ?? "",
        prefix: credentials.prefix?.trim() || DEFAULT_DISCOVERY_PREFIX
    };
}

async function speaking<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof broker.BrokerError) throw new DriverError(caught.message, caught.kind);
        throw caught;
    }
}

/** Either spelling of a key, long first. */
function pick(config: Config, long: keyof Config, short: keyof Config): string | null {
    const value = config[long] ?? config[short];
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A payload as the string it is published as. The convention allows numbers and
 *  booleans in the description where the wire only ever carries text. */
function payload(value: unknown, fallback: string): string {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return fallback;
}

/**
 * What one description is addressed as, for the life of the row.
 *
 * Their `unique_id` where there is one, because that is what it is for: a bridge
 * restarting, being renamed or moving to another topic keeps it, and a row keyed
 * on the topic instead would become a second device every time. The topic is the
 * fallback for a description that carries no id at all.
 */
function idOf(config: Config, topic: string): string {
    return pick(config, "unique_id", "uniq_id") ?? topic;
}

/** What to call it: the device's name where the bridge gave one, then the
 *  entity's, then whatever the topic says. A room full of "Switch" is a room
 *  nobody can use. */
function nameOf(config: Config, topic: string): string {
    const device = config.device?.name?.trim();
    const own = config.name?.trim();
    if (device && own && !own.toLowerCase().startsWith(device.toLowerCase())) return `${device} ${own}`;
    return device || own || topic.split("/").at(-2) || "Device";
}

/**
 * The state of one thing, from whatever its state topic is holding.
 *
 * Two shapes, because both are everywhere: a bare payload ("ON"), and a JSON
 * object with the value under a key ({"state":"ON"}). The convention says which
 * key through a template, and a template is a small language Polaris has no
 * business running - so the common shapes are read directly and anything else
 * reads as unknown rather than as a guess.
 */
function stateOf(config: Config, raw: string | undefined, kind: DeviceKind): DeviceSnapshot["state"] {
    if (raw === undefined) return "unknown";
    const text = raw.trim();
    let value = text;
    if (text.startsWith("{")) {
        try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            const template = pick(config, "value_template", "val_tpl") ?? "";
            // The one thing a template is ever used for here: naming which key
            // holds the value. `{{ value_json.state }}` is the whole idiom.
            const named = /value_json\.([A-Za-z0-9_]+)/.exec(template)?.[1];
            const key = named ?? (kind === "lock" ? "state" : "state");
            const held = parsed[key] ?? parsed.state ?? parsed.value;
            if (held === undefined) return "unknown";
            value = typeof held === "string" ? held : String(held);
        } catch {
            return "unknown";
        }
    }

    if (kind === "lock") {
        const locked = config.state_locked ?? "LOCKED";
        const unlocked = config.state_unlocked ?? "UNLOCKED";
        if (value === locked) return "locked";
        if (value === unlocked) return "unlocked";
        if (value === "JAMMED") return "jammed";
        return "unknown";
    }

    const on = payload(config.state_on ?? config.payload_on ?? config.pl_on, "ON");
    const off = payload(config.state_off ?? config.payload_off ?? config.pl_off, "OFF");
    if (value === on) return "on";
    if (value === off) return "off";
    return "unknown";
}

/**
 * What a sensor last read, as the line to draw.
 *
 * The same two shapes as a state - a bare payload, or JSON with the value under
 * the key a template names - because a bridge publishes both for the same device.
 * A binary one is turned into words by its device class: "on" is what a contact
 * publishes and "Open" is what somebody needs to read.
 */
function readingOf(
    config: Config,
    component: string,
    raw: string | undefined
): { value: string; unit: string } | null {
    if (raw === undefined) return null;
    const text = raw.trim();
    let value = text;
    if (text.startsWith("{")) {
        try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            const template = pick(config, "value_template", "val_tpl") ?? "";
            const named = /value_json\.([A-Za-z0-9_]+)/.exec(template)?.[1];
            const held = named ? parsed[named] : (parsed.value ?? parsed.state);
            if (held === undefined || held === null) return null;
            value = typeof held === "string" ? held : String(held);
        } catch {
            return null;
        }
    }
    if (!value) return null;

    if (component === "binary_sensor") {
        const on = payload(config.payload_on ?? config.pl_on, "ON");
        const words = BINARY_WORDS[pick(config, "device_class", "dev_cla") ?? ""];
        if (!words) return { value: value === on ? "On" : "Off", unit: "" };
        return { value: value === on ? words.on : words.off, unit: "" };
    }
    return { value, unit: pick(config, "unit_of_measurement", "unit_of_meas") ?? "" };
}

/** Whether the bridge says this one is reachable. No availability topic means
 *  nothing was claimed, which is not the same as being offline. */
function onlineOf(config: Config, held: Map<string, string>): boolean {
    const topic = pick(config, "availability_topic", "avty_t");
    if (!topic) return true;
    const raw = held.get(topic)?.trim();
    if (raw === undefined) return true;
    const away = config.payload_not_available ?? "offline";
    const here = config.payload_available ?? "online";
    if (raw === away) return false;
    if (raw === here) return true;
    // Zigbee2MQTT publishes {"state":"online"} on the same topic.
    return !raw.includes(String(away));
}

/** Everything announcing itself under the prefix, and everything those
 *  descriptions point at. One read: a broker hands over all of it at once, and
 *  asking twice would be asking for a different moment. */
async function readAll(
    address: broker.BrokerAddress & { prefix: string }
): Promise<{ found: Announced[]; held: Map<string, string> }> {
    const configs = await speaking(() =>
        broker.readRetained(address, [
            // <prefix>/<component>/<object>/config and the deeper form with a node
            // between them, which is what a bridge speaking for several devices
            // publishes.
            `${address.prefix}/+/+/config`,
            `${address.prefix}/+/+/+/config`
        ])
    );

    const found: Announced[] = [];
    const topics = new Set<string>();
    for (const [topic, raw] of configs) {
        const component = topic.split("/")[1] ?? "";
        const kind = COMPONENT_KINDS[component];
        if (!kind) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw) as unknown;
        } catch {
            continue;
        }
        const config = configSchema.safeParse(parsed);
        if (!config.success) continue;
        const state = pick(config.data, "state_topic", "stat_t");
        const command = pick(config.data, "command_topic", "cmd_t");
        // Something that is worked needs both; something that is only read needs
        // one. A description with no state topic is a device nothing can say
        // anything about either way.
        if (!state) continue;
        if (kind !== "sensor" && !command) continue;
        found.push({ id: idOf(config.data, topic), kind, component, config: config.data });
        topics.add(state);
        const availability = pick(config.data, "availability_topic", "avty_t");
        if (availability) topics.add(availability);
    }

    const held = topics.size > 0 ? await speaking(() => broker.readRetained(address, [...topics])) : new Map();
    return { found, held };
}

function toSnapshot(entry: Announced, held: Map<string, string>): DeviceSnapshot {
    const state = pick(entry.config, "state_topic", "stat_t");
    const online = onlineOf(entry.config, held);
    const raw = state ? held.get(state) : undefined;
    // A sensor whose bridge cannot reach it keeps its last reading rather than
    // losing it: what a thermometer said an hour ago is still what it said, and
    // the row already says the bridge has lost it.
    const reading = entry.kind === "sensor" ? readingOf(entry.config, entry.component, raw) : null;
    return {
        externalId: entry.id,
        kind: entry.kind,
        name: nameOf(entry.config, state ?? entry.id),
        model:
            [entry.config.device?.manufacturer, entry.config.device?.model]
                .filter(Boolean)
                .join(" ")
                .trim() || null,
        firmware: entry.config.device?.sw_version?.trim() || null,
        // A device the bridge says it cannot reach has no state worth drawing:
        // what it was doing when it last answered is not what it is doing.
        // A sensor has no state to be in. Its reading is what it has, and
        // borrowing the word a lock uses would put "Not answering" beside a
        // perfectly good temperature.
        state:
            entry.kind === "sensor"
                ? "unknown"
                : online
                  ? stateOf(entry.config, raw, entry.kind)
                  : "unknown",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online,
        value: reading?.value ?? null,
        unit: reading?.unit ?? null
    };
}

export const mqttDiscoveryDriver: DeviceDriver = {
    connection: MQTT_DISCOVERY,

    /**
     * Whether the broker is there, lets Polaris in, and has anything announcing
     * itself on it.
     *
     * The third is the one that goes wrong quietly: the address is right, the
     * password is right, and the bridge publishes under a different prefix or has
     * discovery switched off. Connecting to that would leave somebody with an
     * empty screen and no reason on it.
     */
    async verify(credentials) {
        const address = brokerOf(credentials);
        const { found } = await readAll(address);
        if (found.length === 0) {
            throw new DriverError(
                `Nothing on that broker is announcing itself under "${address.prefix}". Check that discovery is switched on in whatever publishes your devices, and that it uses this prefix.`,
                "refused"
            );
        }
    },

    async list(credentials) {
        const { found, held } = await readAll(brokerOf(credentials));
        return found.map((entry) => toSnapshot(entry, held));
    },

    /**
     * Say the thing on the topic the device itself named.
     *
     * Retained deliberately not: a command that stayed on the broker would be
     * replayed at whatever is listening the next time it connects, which for a
     * lock is a door opening because something was restarted.
     */
    async act(credentials, device, action) {
        const address = brokerOf(credentials);
        const { found } = await readAll(address);
        const entry = found.find((candidate) => candidate.id === device.externalId);
        if (!entry) {
            throw new DriverError(
                "That device is no longer announcing itself on the broker",
                "refused"
            );
        }
        const command = pick(entry.config, "command_topic", "cmd_t");
        if (!command) throw new DriverError("That device published no way to work it", "refused");

        const say =
            entry.kind === "lock"
                ? action === "lock"
                    ? (entry.config.payload_lock ?? "LOCK")
                    : action === "unlock" || action === "unlatch"
                      ? (entry.config.payload_unlock ?? "UNLOCK")
                      : null
                : action === "turn-on"
                  ? payload(entry.config.payload_on ?? entry.config.pl_on, "ON")
                  : action === "turn-off"
                    ? payload(entry.config.payload_off ?? entry.config.pl_off, "OFF")
                    : null;
        if (say === null) throw new HomeError("That device cannot be told to do that");

        await speaking(() => broker.publish(address, command, say, { qos: 1, expirySeconds: 10 }));
    }
};
