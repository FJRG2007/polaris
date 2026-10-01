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

import { z } from "zod";
import { HomeError } from "../home-error";
import type {
    ClimateCommand,
    ClimateFan,
    ClimateMode,
    ClimateOption,
    ClimateSettings,
    ClimateUnit,
    DeviceAction
} from "../device-kinds";
import { TuyaError } from "../integrations/tuya-api";
import { DriverError, type DeviceSnapshot } from "./contract";

/**
 * Their categories, as kinds.
 *
 * The ones whose whole behavior is on and off, and air conditioners (`kt`),
 * which have controls of their own. A thermostat and a curtain motor are real
 * devices on the same account and are deliberately left out: listing one with an
 * "On" would be a button that does something other than what it says.
 */
const CATEGORY_KINDS: Readonly<Record<string, DeviceSnapshot["kind"]>> = {
    kt: "climate",
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
    readonly status: readonly { readonly code: string; readonly value?: unknown }[];
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

/** An air conditioner, as one row: it is one unit, however many points it has. */
function climateSnapshot(
    device: TuyaDeviceShape,
    byCode: ReadonlyMap<string, unknown>,
    spec: TuyaSpec | null
): DeviceSnapshot {
    const { settings, current, unit } = tuyaClimate(byCode, spec);
    return {
        externalId: device.id,
        kind: "climate",
        name: device.name.trim() || "Tuya device",
        model: (device.product_name ?? "").trim() || (device.model ?? "").trim() || null,
        firmware: null,
        state: device.online ? (byCode.get("switch") === true ? "on" : "off") : "unknown",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: device.online,
        value: current === null ? null : String(current),
        unit: current === null ? null : `°${unit}`,
        climate: settings
    };
}

/** Every row a set of Tuya devices becomes: one per switch on each device Places
 *  can honestly operate, one per air conditioner, and nothing for the rest. An
 *  air conditioner is read with its specification, where it was fetched. */
export function tuyaSnapshots(
    devices: readonly TuyaDeviceShape[],
    specs: ReadonlyMap<string, TuyaSpec | null> = new Map()
): DeviceSnapshot[] {
    const snapshots: DeviceSnapshot[] = [];
    for (const device of devices) {
        const kind = CATEGORY_KINDS[device.category];
        if (!kind) continue;
        const byCode = new Map(device.status.map((point) => [point.code, point.value]));
        if (kind === "climate") {
            snapshots.push(climateSnapshot(device, byCode, specs.get(device.id) ?? null));
            continue;
        }
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

// --- air conditioners (category kt) -----------------------------------------------

/**
 * Tuya's standard instruction set for an air conditioner (category `kt`), as
 * their documentation lists it: `switch`, `temp_set` (an integer with a scale),
 * `mode` (`auto`, `cold`, `hot`, `wet`, `wind`, ...), `fan_speed_enum` (`low`,
 * `mid`, `high`, `auto`, `strong`), `switch_vertical`, `mode_eco`; and in the
 * status set `temp_current`. What a given unit actually has, and the range and
 * scale of its temperature, is in its own specification - asked once and kept
 * for a while, since it does not change while the unit is on the wall.
 *
 * Their words that have no Places equivalent are left out: an `eco` mode, floor
 * heating, and `strong` - which is a boost, not a speed.
 */
const KT_MODES: Readonly<Record<string, ClimateMode>> = {
    cold: "cool",
    hot: "heat",
    wet: "dry",
    wind: "fan",
    auto: "auto"
};

const KT_FANS: Readonly<Record<string, ClimateFan>> = {
    auto: "auto",
    low: "low",
    mid: "medium",
    high: "high"
};

const KT_OPTIONS: Readonly<Partial<Record<ClimateOption, string>>> = {
    swing: "switch_vertical",
    eco: "mode_eco"
};

const specPointSchema = z.object({
    code: z.string(),
    type: z.string().optional(),
    // Their values are a JSON document in a string.
    values: z.string().optional()
});

export const tuyaSpecSchema = z.object({
    functions: z.array(specPointSchema).max(200).default([]),
    status: z.array(specPointSchema).max(200).default([])
});

export type TuyaSpec = z.infer<typeof tuyaSpecSchema>;

const integerSchema = z.object({
    min: z.number().finite(),
    max: z.number().finite(),
    scale: z.number().int().min(0).max(6).default(0),
    step: z.number().finite().positive().default(1)
});

const enumSchema = z.object({ range: z.array(z.string()).max(50) });

function valuesOf(point: z.infer<typeof specPointSchema> | undefined): unknown {
    if (!point?.values) return null;
    try {
        return JSON.parse(point.values) as unknown;
    } catch {
        return null;
    }
}

function integerOf(point: z.infer<typeof specPointSchema> | undefined) {
    const parsed = integerSchema.safeParse(valuesOf(point));
    return parsed.success ? parsed.data : null;
}

function enumOf(point: z.infer<typeof specPointSchema> | undefined): string[] {
    const parsed = enumSchema.safeParse(valuesOf(point));
    return parsed.success ? parsed.data.range : [];
}

/** How long a unit's specification is kept before it is asked again. */
const SPEC_TTL_MS = 60 * 60 * 1000;
const specs = new Map<string, { spec: TuyaSpec; at: number }>();

/** A unit's specification, asked for at most once an hour. */
export async function tuyaSpecFor(
    deviceId: string,
    fetch: (deviceId: string) => Promise<unknown>
): Promise<TuyaSpec | null> {
    const kept = specs.get(deviceId);
    if (kept && Date.now() - kept.at < SPEC_TTL_MS) return kept.spec;
    const parsed = tuyaSpecSchema.safeParse(await fetch(deviceId));
    if (!parsed.success) return null;
    specs.set(deviceId, { spec: parsed.data, at: Date.now() });
    return parsed.data;
}

/** Whether a device is read as an air conditioner, and so needs its
 *  specification to be understood. */
export function needsSpec(device: Pick<TuyaDeviceShape, "category">): boolean {
    return CATEGORY_KINDS[device.category] === "climate";
}

/** The temperature point a unit is set by: Celsius where it has it. */
function targetPoint(spec: TuyaSpec): { code: string; unit: ClimateUnit } | null {
    const codes = spec.functions.map((point) => point.code);
    if (codes.includes("temp_set")) return { code: "temp_set", unit: "C" };
    if (codes.includes("temp_set_f")) return { code: "temp_set_f", unit: "F" };
    return null;
}

/** One unit's data points and specification, as Places' settings and reading. */
export function tuyaClimate(
    status: ReadonlyMap<string, unknown>,
    spec: TuyaSpec | null
): { settings: ClimateSettings | null; current: number | null; unit: ClimateUnit } {
    if (!spec) return { settings: null, current: null, unit: "C" };
    const fn = (code: string) => spec.functions.find((point) => point.code === code);
    const st = (code: string) =>
        spec.status.find((point) => point.code === code) ?? fn(code);
    const target = targetPoint(spec);
    const unit = target?.unit ?? "C";
    const range = target ? integerOf(fn(target.code)) : null;
    const scaled = (value: unknown, scale: number) =>
        typeof value === "number" && Number.isFinite(value) ? value / 10 ** scale : null;

    const currentCode = unit === "F" ? "temp_current_f" : "temp_current";
    const currentRange = integerOf(st(currentCode));
    const current = scaled(status.get(currentCode), currentRange?.scale ?? range?.scale ?? 0);

    if (!target || !range) return { settings: null, current, unit };
    const modes = enumOf(fn("mode")).flatMap((word) => (KT_MODES[word] ? [KT_MODES[word]!] : []));
    const fans = enumOf(fn("fan_speed_enum")).flatMap((word) =>
        KT_FANS[word] ? [KT_FANS[word]!] : []
    );
    const options: ClimateSettings["options"] = {};
    for (const [option, code] of Object.entries(KT_OPTIONS) as [ClimateOption, string][]) {
        if (fn(code)) options[option] = status.get(code) === true;
    }
    const factor = 10 ** range.scale;
    const settings: ClimateSettings = {
        mode: KT_MODES[String(status.get("mode"))] ?? null,
        modes: [...new Set(modes)],
        target: scaled(status.get(target.code), range.scale),
        min: range.min / factor,
        max: range.max / factor,
        step: range.step / factor,
        unit,
        fan: KT_FANS[String(status.get("fan_speed_enum"))] ?? null,
        fans: [...new Set(fans)],
        options
    };
    return { settings: settings.min < settings.max ? settings : null, current, unit };
}

/** What to send for one setting on one unit, in its own codes and scale. */
export function tuyaClimateCommands(
    action: DeviceAction,
    command: ClimateCommand | undefined,
    spec: TuyaSpec | null
): { code: string; value: unknown }[] {
    if (action === "turn-on" || action === "turn-off")
        return [{ code: "switch", value: action === "turn-on" }];
    if (!command || command.action !== action) throw new HomeError("Say what to set it to");
    if (!spec) throw new HomeError("That device has not said what it can be set to yet");
    const back = <T extends string>(table: Readonly<Record<string, T>>, ours: T, offered: string[]) =>
        offered.find((word) => table[word] === ours);
    const fn = (code: string) => spec.functions.find((point) => point.code === code);
    switch (command.action) {
        case "set-mode": {
            const word = back(KT_MODES, command.mode, enumOf(fn("mode")));
            if (!word) throw new HomeError("That mode is not one this device has");
            return [{ code: "mode", value: word }];
        }
        case "set-fan": {
            const word = back(KT_FANS, command.fan, enumOf(fn("fan_speed_enum")));
            if (!word) throw new HomeError("That fan speed is not one this device has");
            return [{ code: "fan_speed_enum", value: word }];
        }
        case "set-temperature": {
            const target = targetPoint(spec);
            const range = target ? integerOf(fn(target.code)) : null;
            if (!target || !range)
                throw new HomeError("That temperature is not one this device accepts");
            const value = Math.round(command.target * 10 ** range.scale);
            if (value < range.min || value > range.max)
                throw new HomeError("That temperature is not one this device accepts");
            return [{ code: target.code, value }];
        }
        case "set-option": {
            const code = KT_OPTIONS[command.option];
            if (!code || !fn(code)) throw new HomeError("That setting is not one this device has");
            return [{ code, value: command.on }];
        }
    }
}

/** The specifications of the air conditioners among these devices. One that
 *  cannot be read leaves that unit drawn without its settings rather than the
 *  whole account unread. */
export async function tuyaSpecsFor(
    devices: readonly TuyaDeviceShape[],
    fetch: (deviceId: string) => Promise<unknown>
): Promise<Map<string, TuyaSpec | null>> {
    const found = new Map<string, TuyaSpec | null>();
    for (const device of devices) {
        if (!needsSpec(device)) continue;
        found.set(device.id, await tuyaSpecFor(device.id, fetch).catch(() => null));
    }
    return found;
}

/** What to send for one press on one row, of any kind Places draws. */
export async function tuyaActionFor(
    device: { readonly externalId: string; readonly kind: string },
    action: DeviceAction,
    command: ClimateCommand | undefined,
    fetch: (deviceId: string) => Promise<unknown>
): Promise<{ deviceId: string; commands: { code: string; value: unknown }[] }> {
    if (device.kind !== "climate") return tuyaCommandFor(device.externalId, action);
    const spec = await tuyaSpecFor(device.externalId, fetch);
    return {
        deviceId: device.externalId,
        commands: tuyaClimateCommands(action, command, spec)
    };
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
