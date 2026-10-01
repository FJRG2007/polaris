/**
 * Gree air conditioners on the same network, as devices - the units the Gree+
 * app drives, and the many sold under other names with the same Wi-Fi module.
 *
 * Local, like Home Assistant's `gree` integration and from the same library's
 * protocol (`integrations/gree-api.ts`): no account, no cloud, nothing that
 * stops working when Gree's servers do.
 *
 * One connection is the units it found. Left without an address it looks for
 * them: a broadcast, and a datagram to every address on this server's own
 * subnet, which is the half that works from inside a container (see
 * `gree-udp.ts`). Given an address it asks that one. Every unit found is bound
 * there and then, and its key - which is what lets anything on the network
 * drive it - is stored with the connection, encrypted like every other
 * credential.
 *
 * A unit that moves to a new address (its lease ran out) is looked for again by
 * its MAC, at most every few minutes, and the new address is kept through
 * `renew` so the key is never asked for twice.
 *
 * Server-only.
 */

import { z } from "zod";
import { HomeError } from "../home-error";
import * as gree from "../integrations/gree-api";
import { GREE_BROADCAST } from "../integrations/gree-udp";
import { forbiddenAddress } from "../integrations/lan-address";
import { subnetTargets, unitAddressOf } from "../integrations/lan-unit";
import {
    CLIMATE_FANS,
    type ClimateCommand,
    type ClimateFan,
    type ClimateMode,
    climateCommandOf,
    type ClimateSettings,
    type DeviceAction
} from "../device-kinds";
import { DriverError, type Credentials, type DeviceDriver, type DeviceSnapshot } from "./contract";

export const GREE_LOCAL = "gree-local";

// --- what the columns mean (greeclimate `device.py`) ----------------------------

/** `Mode`: Auto 0, Cool 1, Dry 2, Fan 3, Heat 4. */
const MODES: readonly ClimateMode[] = ["auto", "cool", "dry", "fan", "heat"];
/** `FanSpeed`: Auto 0 to High 5, in our order already. */
const FANS: readonly ClimateFan[] = CLIMATE_FANS;

/** `TEMP_MIN`/`TEMP_MAX` and their Fahrenheit twins. */
const RANGE = { C: { min: 8, max: 30 }, F: { min: 46, max: 86 } } as const;
/** What `TemSen` is offset by on firmware before 4. */
const SENSOR_OFFSET = 40;

/** `generate_temperature_record`: a Fahrenheit value as the Celsius the unit
 *  stores and the bit that says which of two Fahrenheit values it was. */
export function fahrenheitRecord(f: number): { temSet: number; temRec: number } {
    const celsius = ((f - 32) * 5) / 9;
    const temSet = Math.round(celsius);
    return { temSet, temRec: celsius - temSet > 0 ? 1 : 0 };
}

/** `_convert_to_units` for Fahrenheit: the value in the table whose record is
 *  this one, preferring the one whose bit matches. */
export function fahrenheitOf(temSet: number, temRec: number): number | null {
    const candidates: number[] = [];
    for (let f = -76; f <= 140; f += 1) {
        const record = fahrenheitRecord(f);
        if (record.temSet === temSet) {
            if (record.temRec === temRec) return f;
            candidates.push(f);
        }
    }
    return candidates[0] ?? null;
}

function numberOf(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The firmware's major version from `hid` (`...V3.31.bin`). */
function firmwareOf(status: gree.GreeStatus): string | null {
    const hid = typeof status.hid === "string" ? status.hid : "";
    return /V([\d.]+)\.bin$/.exec(hid)?.[1] ?? null;
}

/**
 * The room's temperature, or null when the unit has no sensor reading.
 *
 * `current_temperature`: firmware 4 reports it as is, earlier firmware with 40
 * added, and 0 means no reading. A reading under 40 can only be the plain kind,
 * which is how the library tells firmware 4 apart when `hid` does not say.
 * The library falls back to the target when there is no reading; that would be
 * a room drawn at exactly the temperature asked for, so here it is left out.
 */
export function greeCurrent(status: gree.GreeStatus, unit: "C" | "F"): number | null {
    const sensor = numberOf(status.TemSen);
    if (sensor === null) return null;
    const major = Number((firmwareOf(status) ?? "").split(".")[0]);
    const plain = major === 4 || (sensor > 0 && sensor < SENSOR_OFFSET);
    if (!plain && sensor === 0) return null;
    const celsius = plain ? sensor : sensor - SENSOR_OFFSET;
    return unit === "F" ? fahrenheitOf(celsius, numberOf(status.TemRec) ?? 0) : celsius;
}

/** Vertical swing: 1 and 7-11 are the swinging positions, 2-6 fixed ones. */
function swinging(value: number): boolean {
    return value === 1 || (value >= 7 && value <= 11);
}

/** A unit's columns, as Places' settings. */
export function greeSettings(status: gree.GreeStatus): ClimateSettings {
    const unit = numberOf(status.TemUn) === 1 ? "F" : "C";
    const set = numberOf(status.SetTem);
    const target =
        set === null ? null : unit === "F" ? fahrenheitOf(set, numberOf(status.TemRec) ?? 0) : set;
    const mode = numberOf(status.Mod);
    const fan = numberOf(status.WdSpd);
    const options: ClimateSettings["options"] = {};
    const swing = numberOf(status.SwUpDn);
    if (swing !== null) options.swing = swinging(swing);
    const turbo = numberOf(status.Tur);
    if (turbo !== null) options.turbo = turbo !== 0;
    const quiet = numberOf(status.Quiet);
    if (quiet !== null) options.quiet = quiet !== 0;
    const eco = numberOf(status.SvSt);
    if (eco !== null) options.eco = eco !== 0;
    return {
        mode: mode === null ? null : (MODES[mode] ?? null),
        modes: ["cool", "heat", "dry", "fan", "auto"],
        target,
        min: RANGE[unit].min,
        max: RANGE[unit].max,
        step: 1,
        unit,
        fan: fan === null ? null : (FANS[fan] ?? null),
        fans: [...FANS],
        options
    };
}

/**
 * What to send for one action, in the unit's own columns.
 *
 * A target goes with the unit and the record bit, as `push_state_update` sends
 * it, so a unit set to Fahrenheit lands on the value that was asked for rather
 * than its Celsius neighbor.
 */
export function greeValues(
    action: DeviceAction,
    command: ClimateCommand | undefined,
    unit: "C" | "F"
): Record<string, number> {
    if (action === "turn-on") return { Pow: 1 };
    if (action === "turn-off") return { Pow: 0 };
    if (!command || command.action !== action) throw new HomeError("Say what to set it to");
    switch (command.action) {
        case "set-mode":
            return { Mod: MODES.indexOf(command.mode) };
        case "set-fan":
            return { WdSpd: FANS.indexOf(command.fan) };
        case "set-temperature": {
            const range = RANGE[unit];
            const target = Math.round(command.target);
            if (target < range.min || target > range.max)
                throw new HomeError("That temperature is not one this device accepts");
            if (unit === "C") return { SetTem: target, TemUn: 0, TemRec: 0 };
            const record = fahrenheitRecord(target);
            return { SetTem: record.temSet, TemUn: 1, TemRec: record.temRec };
        }
        case "set-option":
            switch (command.option) {
                case "swing":
                    return { SwUpDn: command.on ? 1 : 0 };
                case "turbo":
                    return { Tur: command.on ? 1 : 0 };
                // `quiet.setter`: 2 is on.
                case "quiet":
                    return { Quiet: command.on ? 2 : 0 };
                case "eco":
                    return { SvSt: command.on ? 1 : 0 };
            }
    }
    throw new HomeError("That device cannot be told to do that");
}

/** One unit, as a row. */
export function greeSnapshot(unit: gree.GreeUnit, status: gree.GreeStatus | null): DeviceSnapshot {
    const name = unit.name || `Gree ${unit.mac.slice(-4)}`;
    if (!status) {
        return {
            externalId: unit.mac,
            kind: "climate",
            name,
            model: unit.model || null,
            firmware: null,
            state: "unknown",
            doorState: "none",
            batteryPercent: null,
            batteryCritical: false,
            online: false
        };
    }
    const settings = greeSettings(status);
    const current = greeCurrent(status, settings.unit);
    return {
        externalId: unit.mac,
        kind: "climate",
        name,
        model: unit.model || null,
        firmware: firmwareOf(status),
        state: numberOf(status.Pow) === 1 ? "on" : "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        value: current === null ? null : String(current),
        unit: current === null ? null : `°${settings.unit}`,
        climate: settings
    };
}

// --- where the units are ------------------------------------------------------

const unitsSchema = z.array(gree.greeUnitSchema).max(64);

/** The units a connection is bound to. */
function unitsOf(credentials: Credentials): gree.GreeUnit[] {
    let raw: unknown;
    try {
        raw = JSON.parse(credentials.units ?? "");
    } catch {
        raw = null;
    }
    const parsed = unitsSchema.safeParse(raw);
    if (!parsed.success || parsed.data.length === 0) {
        throw new DriverError(
            "Polaris is not paired with these air conditioners any more. Connect them again.",
            "unauthorized"
        );
    }
    return parsed.data;
}

/** Where a scan for units is sent when nobody typed an address: the broadcast,
 *  and every address on this server's own network. */
async function scanTargets(): Promise<string[]> {
    return [GREE_BROADCAST, ...(await subnetTargets())];
}

/** Units that stopped answering at their address, found again by MAC. Kept per
 *  process and handed to the account through `renew`. */
const moved = new Map<string, string>();
/** When each connection last went looking, so a unit that is simply off is not
 *  looked for on every sync. */
const looked = new Map<string, number>();
const LOOK_AGAIN_MS = 5 * 60 * 1000;

function located(unit: gree.GreeUnit): gree.GreeUnit {
    const address = moved.get(unit.mac);
    return address ? { ...unit, address } : unit;
}

/** Look for units that are not where they were, at most every few minutes. */
async function relocate(units: readonly gree.GreeUnit[]): Promise<void> {
    const key = units
        .map((unit) => unit.mac)
        .sort()
        .join(",");
    const now = Date.now();
    if (now - (looked.get(key) ?? 0) < LOOK_AGAIN_MS) return;
    looked.set(key, now);
    const found = await gree.scanGree(await scanTargets());
    for (const unit of units) {
        const seen = found.find((entry) => entry.mac === unit.mac);
        if (seen && seen.address !== unit.address && !forbiddenAddress(seen.address)) {
            moved.set(unit.mac, seen.address);
        }
    }
}

async function unitOf(credentials: Credentials, mac: string): Promise<gree.GreeUnit> {
    const unit = unitsOf(credentials).find((entry) => entry.mac === mac);
    if (!unit) throw new HomeError("That device is not here");
    return located(unit);
}

export const greeLocalDriver: DeviceDriver = {
    connection: GREE_LOCAL,

    /**
     * Find the units - at the address typed, or on the network - and bind to
     * each. What is stored is the units and their keys, not what was typed.
     */
    async verify(credentials) {
        const typed = credentials.host?.trim() ?? "";
        const targets = typed ? [await unitAddressOf(typed)] : await scanTargets();
        const found = (await gree.scanGree(targets)).filter(
            (unit) => !forbiddenAddress(unit.address)
        );
        if (found.length === 0) {
            throw new DriverError(
                typed
                    ? "No Gree air conditioner answered at that address. Check it is switched on at the wall and on the same network as Polaris."
                    : "No Gree air conditioner answered on this network. Type the unit's address instead: your router lists it among the connected devices.",
                "unreachable"
            );
        }
        const units: gree.GreeUnit[] = [];
        for (const unit of found) {
            const bound = await gree.bindGree(unit);
            if (!bound) continue;
            units.push({
                mac: unit.mac,
                address: unit.address,
                key: bound.key,
                cipher: bound.cipher,
                name: unit.name.slice(0, 120),
                model: unit.model.slice(0, 120)
            });
        }
        if (units.length === 0) {
            throw new DriverError(
                "The air conditioner answered but would not pair. Switch it off at the wall for a minute and try again.",
                "refused"
            );
        }
        return { host: typed, units: JSON.stringify(units) };
    },

    async list(credentials) {
        const units = unitsOf(credentials);
        const read = async (unit: gree.GreeUnit) => {
            try {
                return await gree.readGree(located(unit));
            } catch (caught) {
                if (caught instanceof DriverError) return null;
                throw caught;
            }
        };
        let statuses = await Promise.all(units.map(read));
        const lost = units.filter((_, index) => statuses[index] === null);
        if (lost.length > 0) {
            const before = lost.map((unit) => located(unit).address);
            await relocate(units);
            if (lost.some((unit, index) => located(unit).address !== before[index])) {
                statuses = await Promise.all(
                    units.map((unit, index) => statuses[index] ?? read(unit))
                );
            }
        }
        return units.map((unit, index) => greeSnapshot(unit, statuses[index] ?? null));
    },

    async act(credentials, device, action, command) {
        const unit = await unitOf(credentials, device.externalId);
        // The unit the target is in is the unit's own, read now: a remote
        // switched to Fahrenheit since the last sync changes what 24 means.
        const unitOfMeasure =
            action === "set-temperature"
                ? numberOf((await gree.readGree(unit, ["TemUn"])).TemUn) === 1
                    ? "F"
                    : "C"
                : "C";
        await gree.commandGree(unit, greeValues(action, climateCommandOf(command), unitOfMeasure));
    },

    /** Keep a unit's new address once it has been found there. */
    async renew(credentials) {
        let units: gree.GreeUnit[];
        try {
            units = unitsOf(credentials);
        } catch {
            return null;
        }
        if (!units.some((unit) => located(unit).address !== unit.address)) return null;
        return { ...credentials, units: JSON.stringify(units.map(located)) };
    }
};
