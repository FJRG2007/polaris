/**
 * Tuya's words, as Places' words. Shared by every way into a Tuya account.
 *
 * Tuya is not a make so much as the thing inside a few thousand makes: the plug
 * with somebody else's brand on the box, the switch that came with the light, the
 * strip sold under a name that exists only on that shop. Whether an account is
 * reached through a developer project (`tuya-cloud`) or through the app's own
 * sign-in (`tuya-app`), a device comes back in the same shape - a category, a
 * name and a list of data points - so what that shape means here is decided once,
 * in this file, and both drivers read it.
 *
 * Two things about their model are dealt with here and nowhere else. Their
 * taxonomy is a two-letter category per device, so what a screen may offer is
 * decided by translating that into a kind - and anything not recognised is left
 * out rather than listed with controls that would do nothing. And a switch is not
 * a device but a data point on one: a four-gang wall switch is one device with
 * four switches on it, so it arrives here as four, each addressed by the device
 * and the point together. That is what makes the second gang of a switch usable
 * instead of invisible, and it is why an id here carries a "#".
 *
 * Server-only, like the drivers that use it.
 */

import { HomeError } from "../home-error";
import type { DeviceAction } from "../device-kinds";
import { TuyaError } from "../integrations/tuya-api";
import { DriverError, type DeviceSnapshot } from "./contract";

/**
 * Their categories, as kinds.
 *
 * Only the ones whose whole behaviour is on and off, which is what Polaris can
 * honestly offer today. A thermostat and a curtain motor are real devices on the
 * same account and are deliberately left out: listing one with an "On" would be a
 * button that does something other than what it says.
 */
const CATEGORY_KINDS: Readonly<Record<string, DeviceSnapshot["kind"]>> = {
    kg: "switch",
    tdq: "switch",
    tgkg: "switch",
    cz: "outlet",
    pc: "outlet",
    dj: "light",
    dd: "light",
    xdd: "light",
    fwd: "light",
    dc: "light",
    gyd: "light",
    tgq: "light",
    fsd: "light"
};

/** One device as either way in describes it: the fields both answers share. */
export interface TuyaDeviceShape {
    readonly id: string;
    readonly name: string;
    readonly category: string;
    readonly product_name?: string;
    readonly model?: string;
    readonly online: boolean;
    readonly status: readonly { readonly code: string; readonly value: unknown }[];
}

/** The data points that are a switch, in the order a device is most likely to
 *  name its main one. Anything matching `switch_<n>` is a gang of its own. */
function switchCodes(codes: readonly string[]): string[] {
    const found = codes.filter(
        (code) => code === "switch" || code === "switch_led" || /^switch(_led)?_\d+$/.test(code)
    );
    // A device that answers with both a general switch and numbered ones is a
    // device whose general switch is the whole thing at once. The gangs are what
    // somebody actually wants on a row, so they win.
    const gangs = found.filter((code) => /_\d+$/.test(code));
    return gangs.length > 0 ? gangs.sort() : found;
}

/** What to call one gang of a device that has several. A wall switch with three
 *  of them is three rows, and "Hallway" three times is three rows nobody can
 *  tell apart. */
function gangName(name: string, code: string, gangs: number): string {
    if (gangs < 2) return name;
    const index = /_(\d+)$/.exec(code)?.[1];
    return index ? `${name} ${index}` : `${name} ${code}`;
}

/** The device and the data point, as one id. Split again by `commandFor`, which
 *  is the only other place that may know this shape. */
function addressOf(deviceId: string, code: string): string {
    return `${deviceId}#${code}`;
}

function splitAddress(externalId: string): { deviceId: string; code: string } {
    const hash = externalId.lastIndexOf("#");
    if (hash <= 0) return { deviceId: externalId, code: "switch" };
    return { deviceId: externalId.slice(0, hash), code: externalId.slice(hash + 1) };
}

function numberOf(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Every row a set of Tuya devices becomes: one per switch on each device Places
 *  can honestly operate, and nothing for the rest. */
export function tuyaSnapshots(devices: readonly TuyaDeviceShape[]): DeviceSnapshot[] {
    const snapshots: DeviceSnapshot[] = [];
    for (const device of devices) {
        const kind = CATEGORY_KINDS[device.category];
        if (!kind) continue;
        const byCode = new Map(device.status.map((point) => [point.code, point.value]));
        const codes = switchCodes([...byCode.keys()]);
        if (codes.length === 0) continue;

        const battery = numberOf(byCode.get("battery_percentage"));
        const model = (device.product_name ?? "").trim() || (device.model ?? "").trim() || null;
        for (const code of codes) {
            const on = byCode.get(code) === true;
            snapshots.push({
                externalId: addressOf(device.id, code),
                kind,
                name: gangName(device.name.trim() || "Tuya device", code, codes.length),
                model,
                firmware: null,
                // A device nobody can reach has no state worth reporting:
                // whatever it was doing when it last spoke is not what it is
                // doing now, and the row says "not answering" instead.
                state: device.online ? (on ? "on" : "off") : "unknown",
                doorState: "none",
                batteryPercent: battery,
                batteryCritical: battery !== null && battery <= 15,
                online: device.online
            });
        }
    }
    return snapshots;
}

/** What to send for one press on one row: the device, and its data point set to
 *  what the button says. Anything but on and off is refused here, before a
 *  request is made, rather than sent as something odd. */
export function tuyaCommandFor(
    externalId: string,
    action: DeviceAction
): { deviceId: string; commands: { code: string; value: boolean }[] } {
    if (action !== "turn-on" && action !== "turn-off") {
        throw new HomeError("A Tuya device cannot be told to do that");
    }
    const { deviceId, code } = splitAddress(externalId);
    return { deviceId, commands: [{ code, value: action === "turn-on" }] };
}

/** Their refusal, as one this app can act on. Which sort of wrong it was is kept
 *  rather than flattened: a revoked key has to stop the connection, and a plug
 *  that would not answer must not. */
export async function tuyaSpeaking<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof TuyaError) {
            throw new DriverError(
                caught.message,
                caught.kind === "unauthorized"
                    ? "unauthorized"
                    : caught.kind === "unreachable"
                      ? "unreachable"
                      : "refused"
            );
        }
        throw caught;
    }
}
