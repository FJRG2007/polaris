/**
 * Philips devices on the fan and heater cloud (`integrations/air-matters.ts`),
 * in Places' words: what a device's shadow says, and what to write to it.
 *
 * Every code is Yooork/HA_Philips_Air_Plus `const.py` and `fan.py`, verified
 * there against a physical CX3550/01 stand fan and an AC3360/11 purifier:
 *
 * - `D03102` power, 0 or 1, on both.
 * - `D0310C` the mode, sent back as a signed byte (130 arrives as -126). On the
 *   CX3550 1, 2 and 3 are the manual speeds (with `D0310D` the level), 17 sleep
 *   and 130 natural wind; it has no turbo. On the AC3360 it is one of eight
 *   named modes.
 * - `D0320F` oscillation on the CX3550: reported 23040 while swinging, and
 *   switched on by writing the angle, 90; writing 23040 is refused.
 * - `D03103` the AC3360's button lock, `D03105` its display (123 bright, 115
 *   low, 0 off), and its PM2.5, allergen index, temperature and humidity on the
 *   same keys the local purifiers use, so they go through `philipsMeasures`.
 * - `ConnectType` "Online" while the device is connected to the cloud.
 *
 * A fan, a purifier and whatever else this cloud serves is drawn as an air
 * device rather than a climate one: an air conditioner here aims at a
 * temperature with a range, and no source documents the target or the range of
 * the heaters on this cloud. A model that is neither of the two verified ones
 * is listed with its power and what it reports, offers no control at all, and
 * is named "not supported yet" when connected - a heater switched on from a
 * guessed code is not a risk worth taking.
 *
 * Server-only.
 */

import * as kinds from "../device-kinds";
import { HomeError } from "../home-error";
import { philipsMeasures } from "./philips-coap";
import type { DeviceSnapshot } from "./contract";
import type { AirMattersDevice } from "../integrations/air-matters";
import type { ShadowValue } from "../integrations/air-matters-link";

/** A device of this cloud is keyed with this before its id, so the driver can
 *  tell it from a device of the Versuni clouds on the same connection. */
export const AIR_MATTERS_PREFIX = "am:";

const POWER = "D03102";
const MODE = "D0310C";
const LEVEL = "D0310D";
const OSCILLATE = "D0320F";
const BUTTON_LOCK = "D03103";
const DISPLAY = "D03105";

const OSCILLATE_ON = 90;
const DISPLAY_ON = 123;

/** What one verified model can be set to. */
interface ShadowModel {
    readonly modes: Partial<Readonly<Record<kinds.AirMode, number>>>;
    readonly speeds: Partial<Readonly<Record<kinds.AirSpeed, number>>>;
    readonly options: readonly kinds.AirOption[];
}

export const AIR_MATTERS_MODELS: Readonly<Record<"cx3550" | "ac3360", ShadowModel>> = {
    cx3550: {
        modes: { sleep: 17, natural: 130 },
        speeds: { speed_1: 1, speed_2: 2, speed_3: 3 },
        options: ["oscillate"]
    },
    ac3360: {
        modes: {
            auto: 0,
            sleep: 17,
            low: 1,
            medium: 2,
            high: 3,
            eco: 16,
            turbo: 18,
            pet_hair: 49
        },
        speeds: {},
        options: ["childLock", "light"]
    }
};

/** Which verified model a device is, by its model or its type exactly as the
 *  source recognises them (`is_ac3360_device`), or null. */
export function airMattersModel(
    device: Pick<AirMattersDevice, "model" | "type">
): ShadowModel | null {
    const model = (device.model ?? "").trim().toUpperCase();
    const type = (device.type ?? "").trim();
    if (model.startsWith("AC3360") || type === "LavenderLite") return AIR_MATTERS_MODELS.ac3360;
    if (model.startsWith("CX3550") || type === "Trident") return AIR_MATTERS_MODELS.cx3550;
    return null;
}

function numberOf(value: ShadowValue | undefined): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
    return null;
}

/** A mode as the unsigned byte the tables are written in. */
function modeOf(reported: Readonly<Record<string, ShadowValue>>): number | null {
    const value = numberOf(reported[MODE]);
    return value === null ? null : value & 0xff;
}

/** What a shadow says, as Places' air settings. */
export function airMattersAir(
    reported: Readonly<Record<string, ShadowValue>>,
    model: ShadowModel | null
): kinds.AirSettings {
    const modes = Object.entries(model?.modes ?? {}) as [kinds.AirMode, number][];
    const speeds = Object.entries(model?.speeds ?? {}) as [kinds.AirSpeed, number][];
    const running = modeOf(reported);
    const options: kinds.AirSettings["options"] = {};
    for (const option of model?.options ?? []) {
        if (option === "oscillate") {
            const swing = numberOf(reported[OSCILLATE]);
            if (swing !== null) options.oscillate = swing !== 0;
        } else if (option === "childLock") {
            const lock = numberOf(reported[BUTTON_LOCK]);
            if (lock !== null) options.childLock = lock === 1;
        } else if (option === "light") {
            const display = numberOf(reported[DISPLAY]);
            if (display !== null) options.light = display !== 0;
        }
    }
    return {
        mode: modes.find(([, value]) => value === running)?.[0] ?? null,
        modes: modes.map(([mode]) => mode),
        speed: speeds.find(([, value]) => value === running)?.[0] ?? null,
        speeds: speeds.map(([speed]) => speed),
        humidity: null,
        options,
        ...philipsMeasures(reported, null)
    };
}

function text(value: ShadowValue | undefined): string | null {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : null;
}

/** One device as a row: what it is, whether it is on and what it reads. */
export function airMattersSnapshot(
    device: AirMattersDevice,
    heard: { reported: Readonly<Record<string, ShadowValue>>; answered: boolean } | null
): DeviceSnapshot {
    const reported = heard?.reported ?? {};
    const model = device.model ?? text(reported.D01S05);
    const name = device.name || text(reported.D01S03) || `Philips ${model ?? device.id.slice(-4)}`;
    const power = numberOf(reported[POWER]);
    const connect = reported.ConnectType;
    const online = typeof connect === "string" ? connect === "Online" : (heard?.answered ?? false);
    const air =
        Object.keys(reported).length > 0
            ? airMattersAir(reported, airMattersModel({ model, type: device.type }))
            : null;
    const headline = air ? kinds.airHeadline(air) : null;
    return {
        externalId: `${AIR_MATTERS_PREFIX}${device.id}`,
        kind: "air",
        name,
        model,
        firmware: text(reported.D01S12),
        state: power === null ? "unknown" : power === 1 ? "on" : "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online,
        value: headline?.value ?? null,
        unit: headline ? kinds.MEASURE_UNITS[headline.measure] || null : null,
        air
    };
}

/**
 * What to write to the shadow for one action. A setting turns the device on
 * with it, as the app and `fan.py` do; a manual speed on the CX3550 sets the
 * level and mirrors it into the mode.
 */
export function airMattersDesired(
    model: ShadowModel | null,
    action: kinds.DeviceAction,
    command: kinds.DeviceCommand | undefined
): Record<string, number> {
    if (!model) throw new HomeError("That device cannot be told to do that");
    if (action === "turn-on") return { [POWER]: 1 };
    if (action === "turn-off") return { [POWER]: 0 };
    const setting = kinds.airCommandOf(command);
    if (!setting || setting.action !== action) throw new HomeError("Say what to set it to");
    if (setting.action === "set-mode") {
        const value = model.modes[setting.mode];
        if (value === undefined) throw new HomeError("That mode is not one this device has");
        return { [POWER]: 1, [MODE]: value };
    }
    if (setting.action === "set-fan") {
        const value = model.speeds[setting.speed];
        if (value === undefined) throw new HomeError("That fan speed is not one this device has");
        return { [POWER]: 1, [LEVEL]: value, [MODE]: value };
    }
    if (setting.action === "set-option" && model.options.includes(setting.option)) {
        if (setting.option === "oscillate") return { [OSCILLATE]: setting.on ? OSCILLATE_ON : 0 };
        if (setting.option === "childLock") return { [BUTTON_LOCK]: setting.on ? 1 : 0 };
        if (setting.option === "light") return { [DISPLAY]: setting.on ? DISPLAY_ON : 0 };
    }
    throw new HomeError("That setting is not one this device has");
}

/** The models found that Polaris lists but cannot operate. */
export function unsupportedAirMatters(devices: readonly AirMattersDevice[]): string[] {
    return [
        ...new Set(
            devices
                .filter((device) => !airMattersModel(device))
                .map((device) => device.model ?? device.type ?? "?")
        )
    ];
}
