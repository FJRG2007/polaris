/**
 * TP-Link's Tapo and Kasa, on the same network, as devices.
 *
 * One connection is one device - a plug, a strip, a wall switch or a bulb - found
 * by its address. A strip is one device with several outlets, and each outlet is
 * a row of its own, addressed by the strip and the outlet together, for the same
 * reason a Tuya wall switch is one row per gang: the second socket on a strip is
 * somebody's lamp, and it has to be reachable on its own.
 *
 * Tapo and Kasa are two entries rather than one because they are two apps with
 * two names in their owners' heads, and because they differ in what they ask
 * for: every Tapo needs the TP-Link account, while an older Kasa needs nothing
 * at all. Underneath it is one driver - a Kasa on newer firmware answers exactly
 * the way a Tapo does, and a Tapo-branded plug that speaks Kasa's JSON is read
 * the same either way - so which entry somebody picked only decides what is
 * asked of them and which port is tried first.
 *
 * Only what is on or off is taken. A hub, a camera and a robot vacuum answer on
 * the same protocol and are left out rather than listed with a switch.
 *
 * Server-only.
 */

import { HomeError } from "../home-error";
import type { DeviceKind } from "../device-kinds";
import { deviceHost } from "../integrations/lan-http";
import * as tplink from "../integrations/tplink-local";
import { DriverError, type Credentials, type DeviceDriver, type DeviceSnapshot } from "./contract";

export const TAPO_LOCAL = "tapo-local";
export const KASA_LOCAL = "kasa-local";

/** Tapo's device types, as kinds. `SMART.TAPOPLUG` is also what a strip says. */
const SMART_KINDS: Readonly<Record<string, DeviceKind>> = {
    "SMART.TAPOPLUG": "outlet",
    "SMART.KASAPLUG": "outlet",
    "SMART.TAPOSWITCH": "switch",
    "SMART.KASASWITCH": "switch",
    "SMART.TAPOBULB": "light"
};

function addressOf(credentials: Credentials): tplink.TplinkAddress {
    const typed = credentials.host?.trim();
    if (!typed) throw new HomeError("That connection is missing the device's address");
    const host = deviceHost(typed);
    if (!host) throw new HomeError("Write the address as 10.0.1.30, with no path");
    return {
        host,
        username: credentials.email?.trim() ?? "",
        password: credentials.password ?? ""
    };
}

/** A strip's outlet and the strip, as one id. Split again in `act`. */
function childAddress(parentId: string, childId: string): string {
    return `${parentId}#${childId}`;
}

function splitAddress(externalId: string): { deviceId: string; childId: string | null } {
    const hash = externalId.indexOf("#");
    if (hash <= 0) return { deviceId: externalId, childId: null };
    return { deviceId: externalId.slice(0, hash), childId: externalId.slice(hash + 1) };
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/** Tapo's names travel base64-encoded; anything that does not decode is shown
 *  as it came rather than lost. */
function nickname(value: unknown): string {
    const raw = text(value);
    if (!raw) return "";
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    return Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "") ===
        raw.replace(/=+$/, "")
        ? decoded.trim()
        : raw;
}

/** "1.0.13 Build 230925 Rel.150200" is version 1.0.13. */
function firmwareOf(value: unknown): string | null {
    return text(value).split(" ")[0] || null;
}

function onOff(on: boolean): DeviceSnapshot["state"] {
    return on ? "on" : "off";
}

function row(
    externalId: string,
    kind: DeviceKind,
    name: string,
    model: string | null,
    firmware: string | null,
    on: boolean
): DeviceSnapshot {
    return {
        externalId,
        kind,
        name,
        model,
        firmware,
        state: onOff(on),
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true
    };
}

async function readSmart(link: tplink.TplinkLink): Promise<DeviceSnapshot[]> {
    const info = await tplink.smartCall(link, "get_device_info");
    const kind = SMART_KINDS[text(info.type)];
    if (!kind) return [];
    const id = text(info.device_id);
    if (!id) throw new DriverError("The device answered with something unexpected.", "refused");
    const model = text(info.model) || null;
    const firmware = firmwareOf(info.fw_ver);
    const name = nickname(info.nickname) || model || "TP-Link device";

    // A strip reports its outlets on their own list, and its own `device_on`
    // means nothing a person would press.
    const children = kind === "outlet" ? await tplink.smartChildren(link).catch(() => []) : [];
    if (children.length > 0) {
        return children.flatMap((child, index) => {
            const childId = text(child.device_id);
            if (!childId) return [];
            return [
                row(
                    childAddress(id, childId),
                    "outlet",
                    nickname(child.nickname) || `${name} ${index + 1}`,
                    model,
                    firmware,
                    child.device_on === true
                )
            ];
        });
    }
    return [row(id, kind, name, model, firmware, info.device_on === true)];
}

async function readIot(link: tplink.TplinkLink): Promise<DeviceSnapshot[]> {
    const info = await tplink.iotCall(link, "system", "get_sysinfo");
    const type = (text(info.type) || text(info.mic_type)).toLowerCase();
    const id = text(info.deviceId);
    if (!id) throw new DriverError("The device answered with something unexpected.", "refused");
    const model = text(info.model) || null;
    const firmware = firmwareOf(info.sw_ver);
    const name = text(info.alias) || model || "Kasa device";

    if (type.includes("smartbulb")) {
        const light = info.light_state as { on_off?: unknown } | undefined;
        return [row(id, "light", name, model, firmware, light?.on_off === 1)];
    }
    if (!type.includes("smartplug")) return [];
    const children = Array.isArray(info.children)
        ? (info.children as Record<string, unknown>[])
        : [];
    if (children.length > 0) {
        return children.flatMap((child, index) => {
            const childId = text(child.id);
            if (!childId) return [];
            return [
                row(
                    childAddress(id, childId),
                    "outlet",
                    text(child.alias) || `${name} ${index + 1}`,
                    model,
                    firmware,
                    child.state === 1
                )
            ];
        });
    }
    return [row(id, "outlet", name, model, firmware, info.relay_state === 1)];
}

async function read(credentials: Credentials, prefer: "klap" | "xor") {
    const link = await tplink.openTplink(addressOf(credentials), prefer);
    return { link, devices: link.family === "smart" ? await readSmart(link) : await readIot(link) };
}

function driver(connection: string, prefer: "klap" | "xor"): DeviceDriver {
    return {
        connection,

        /**
         * Whether something at the address answers, lets Polaris in, and is a
         * thing that switches. A hub or a camera at the address is the one to
         * say so about: it answers perfectly and has nothing to draw.
         */
        async verify(credentials) {
            const { devices } = await read(credentials, prefer);
            if (devices.length === 0) {
                throw new DriverError(
                    "That TP-Link device is not a plug, a switch or a bulb, so there is nothing here to control.",
                    "refused"
                );
            }
        },

        async list(credentials) {
            return (await read(credentials, prefer)).devices;
        },

        async act(credentials, device, action) {
            if (action !== "turn-on" && action !== "turn-off") {
                throw new HomeError("A TP-Link device cannot be told to do that");
            }
            const on = action === "turn-on";
            const { childId } = splitAddress(device.externalId);
            const link = await tplink.openTplink(addressOf(credentials), prefer);
            if (link.family === "smart") {
                if (childId)
                    await tplink.smartChildCall(link, childId, "set_device_info", {
                        device_on: on
                    });
                else await tplink.smartCall(link, "set_device_info", { device_on: on });
                return;
            }
            if (device.kind === "light") {
                await tplink.iotCall(
                    link,
                    "smartlife.iot.smartbulb.lightingservice",
                    "transition_light_state",
                    {
                        on_off: on ? 1 : 0
                    }
                );
                return;
            }
            await tplink.iotCall(
                link,
                "system",
                "set_relay_state",
                { state: on ? 1 : 0 },
                childId ?? undefined
            );
        }
    };
}

export const tapoLocalDriver = driver(TAPO_LOCAL, "klap");
export const kasaLocalDriver = driver(KASA_LOCAL, "xor");
