/**
 * A Shelly on the same network, as devices.
 *
 * One connection is one Shelly, found by its address. A relay with two channels
 * is two rows, each addressed by the device and the channel together, the same
 * way a Tuya wall switch is one row per gang.
 *
 * What a channel is decides its kind: a plug's relay is a socket, a dimmer or a
 * bulb is a light, and a relay somebody told the Shelly app drives a light is a
 * light too - that is what the app's own "consumption type" setting is for. A
 * relay in roller mode drives a blind, and blinds are skipped, as they are for
 * a broker: Polaris has no honest control for one yet.
 *
 * Server-only.
 */

import { HomeError } from "../home-error";
import type { DeviceKind } from "../device-kinds";
import * as shelly from "../integrations/shelly-api";
import { DriverError, type Credentials, type DeviceDriver, type DeviceSnapshot } from "./contract";

export const SHELLY_LOCAL = "shelly-local";

/** Second-generation plugs, by the prefix of their model code (aioshelly's
 *  model list). Every other `switch:N` is a relay. */
const PLUG_MODELS = /^(SNPL|S3PL|S4PL)-/;

/** First-generation plugs, by their type code. */
const GEN1_PLUGS = new Set(["SHPLG-1", "SHPLG2-1", "SHPLG-S", "SHPLG-U1"]);

function addressOf(credentials: Credentials): shelly.ShellyAddress {
    const host = credentials.host?.trim();
    if (!host) throw new HomeError("That connection is missing the device's address");
    const address = shelly.shellyAddress(
        host,
        credentials.username?.trim() ?? "",
        credentials.password ?? ""
    );
    if (!address) throw new HomeError("Write the address as 192.168.1.30, with no path");
    return address;
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function list(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.map(record) : [];
}

/** A device's MAC, one spelling. */
function macOf(info: shelly.ShellyInfo): string {
    return info.mac.replace(/[^0-9a-f]/gi, "").toUpperCase();
}

function row(
    externalId: string,
    kind: DeviceKind,
    name: string,
    model: string | null,
    firmware: string | null,
    on: boolean | null
): DeviceSnapshot {
    return {
        externalId,
        kind,
        name,
        model,
        firmware,
        state: on === null ? "unknown" : on ? "on" : "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true
    };
}

/** "Hallway" for a one-channel device, "Hallway 2" for the second of two - unless
 *  the channel has a name of its own, which always wins. */
function channelName(own: string, device: string, index: number, count: number): string {
    if (own) return own;
    return count > 1 ? `${device} ${index + 1}` : device;
}

async function readRpc(
    address: shelly.ShellyAddress,
    info: shelly.ShellyInfo
): Promise<DeviceSnapshot[]> {
    const [status, config] = await Promise.all([
        shelly.shellyStatus(address),
        shelly.shellyConfig(address)
    ]);
    const sys = record(config.sys);
    const device = text(record(sys.device).name) || text(info.id) || "Shelly";
    const model = text(info.model) || text(info.app) || null;
    const firmware = text(info.ver) || null;
    const consumption = record(sys.ui_data).consumption_types;
    const consumptionTypes = Array.isArray(consumption) ? consumption : [];
    const mac = macOf(info);

    const channels = (prefix: string) =>
        Object.keys(status)
            .map((key) => new RegExp(`^${prefix}:(\\d+)$`).exec(key))
            .filter((match): match is RegExpExecArray => match !== null)
            .map((match) => Number(match[1]))
            .sort((left, right) => left - right);

    const switches = channels("switch");
    const lights = channels("light");
    const total = switches.length + lights.length;
    const rows: DeviceSnapshot[] = [];
    for (const [index, id] of switches.entries()) {
        const key = `switch:${id}`;
        const drives = text(consumptionTypes[id]).toLowerCase();
        const kind: DeviceKind = drives.startsWith("light")
            ? "light"
            : PLUG_MODELS.test(model ?? "")
              ? "outlet"
              : "switch";
        const output = record(status[key]).output;
        rows.push(
            row(
                `${mac}#${key}`,
                kind,
                channelName(text(record(config[key]).name), device, index, total),
                model,
                firmware,
                typeof output === "boolean" ? output : null
            )
        );
    }
    for (const [index, id] of lights.entries()) {
        const key = `light:${id}`;
        const output = record(status[key]).output;
        rows.push(
            row(
                `${mac}#${key}`,
                "light",
                channelName(text(record(config[key]).name), device, switches.length + index, total),
                model,
                firmware,
                typeof output === "boolean" ? output : null
            )
        );
    }
    return rows;
}

/**
 * The first generation, from `/settings` for the names and `/status` for the
 * state.
 *
 * Its outputs are addressed by path rather than by component - `relay/0`,
 * `light/0`, and on an RGBW2 `white/N` or `color/0` depending on its mode - and
 * the id carries that path, since it is exactly what `act` has to call.
 */
async function readGen1(
    address: shelly.ShellyAddress,
    info: shelly.ShellyInfo
): Promise<DeviceSnapshot[]> {
    const [settings, status] = await Promise.all([
        shelly.shellyGet(address, "/settings"),
        shelly.shellyGet(address, "/status")
    ]);
    const type = text(info.type);
    const device = text(settings.name) || text(record(settings.device).hostname) || "Shelly";
    const model = type || null;
    const firmware = text(info.fw) || text(settings.fw) || null;
    const mac = macOf(info);
    const rows: DeviceSnapshot[] = [];

    // Roller mode is a blind, not two switches.
    if (text(settings.mode) !== "roller") {
        const relays = list(status.relays);
        const named = list(settings.relays);
        const lights = list(status.lights);
        const total = relays.length + lights.length;
        relays.forEach((relay, index) => {
            const own = named[index] ?? {};
            const kind: DeviceKind = text(own.appliance_type).toLowerCase().startsWith("light")
                ? "light"
                : GEN1_PLUGS.has(type)
                  ? "outlet"
                  : "switch";
            rows.push(
                row(
                    `${mac}#relay/${index}`,
                    kind,
                    channelName(text(own.name), device, index, total),
                    model,
                    firmware,
                    typeof relay.ison === "boolean" ? relay.ison : null
                )
            );
        });
        // An RGBW2 is four white channels or one colour output; anything else
        // with lights answers on `light/N`.
        const path =
            type === "SHRGBW2" ? (text(status.mode) === "color" ? "color" : "white") : "light";
        const namedLights = list(settings.lights);
        lights.forEach((light, index) => {
            rows.push(
                row(
                    `${mac}#${path}/${index}`,
                    "light",
                    channelName(
                        text(namedLights[index]?.name),
                        device,
                        relays.length + index,
                        total
                    ),
                    model,
                    firmware,
                    typeof light.ison === "boolean" ? light.ison : null
                )
            );
        });
    }
    return rows;
}

async function read(credentials: Credentials): Promise<DeviceSnapshot[]> {
    const address = addressOf(credentials);
    const info = await shelly.shellyInfo(address);
    return shelly.generationOf(info) === 2 ? readRpc(address, info) : readGen1(address, info);
}

/** The channel a row stands for, from its id. */
function channelOf(externalId: string): string {
    const hash = externalId.indexOf("#");
    return hash >= 0 ? externalId.slice(hash + 1) : "";
}

export const shellyLocalDriver: DeviceDriver = {
    connection: SHELLY_LOCAL,

    /** Whether it answers, lets Polaris in, and has something to switch. A
     *  Shelly that only measures, or one in roller mode, answers perfectly and
     *  has nothing to draw - which is worth saying before it is connected. */
    async verify(credentials) {
        const found = await read(credentials);
        if (found.length === 0) {
            throw new DriverError(
                "That Shelly has no relay or light to control. Blinds and meters are not something Polaris can operate yet.",
                "refused"
            );
        }
    },

    async list(credentials) {
        return read(credentials);
    },

    async act(credentials, device, action) {
        if (action !== "turn-on" && action !== "turn-off") {
            throw new HomeError("A Shelly cannot be told to do that");
        }
        const on = action === "turn-on";
        const address = addressOf(credentials);
        const channel = channelOf(device.externalId);

        const rpc = /^(switch|light):(\d+)$/.exec(channel);
        if (rpc) {
            await shelly.shellyRpc(address, rpc[1] === "switch" ? "Switch.Set" : "Light.Set", {
                id: Number(rpc[2]),
                on
            });
            return;
        }
        const gen1 = /^(relay|light|white|color)\/(\d+)$/.exec(channel);
        if (!gen1) throw new DriverError("That device is no longer on this Shelly.", "refused");
        await shelly.shellyGet(address, `/${gen1[1]}/${gen1[2]}?turn=${on ? "on" : "off"}`);
    }
};
