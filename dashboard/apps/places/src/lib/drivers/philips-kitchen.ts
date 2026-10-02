/**
 * Philips kitchen appliances on the Versuni cloud - airfryers, multicookers,
 * espresso machines - as Places' appliance kind: what they are doing, and the
 * one thing they may be told from here, to stop.
 *
 * From renaudallard/homeassistant_philips_homeid (BSD-2-Clause), read from its
 * source: `local_models.py` (which model is which architecture, the status
 * words), `mqtt_api.py` (the cloud's port names and its key spellings) and
 * `coordinator.py` (`async_airfryer_stop`):
 *
 * - A SPECTRE airfryer (HD9200, HD9255, HD9280, HD9285) and a VENUS 1 one
 *   (HD9875, HD9876) report on `Status` and are told on `Control`; a VENUS 2
 *   (HD9880) on `venusaf_s` and `venusaf_c`. A Venus spells some keys its own
 *   way (`disp_time`, `total_time`, `method`, `curr_temp`).
 * - What is read: `status`, the set and reached temperatures (`temp`,
 *   `cur_temp`, in the unit `temp_unit` names - true is Fahrenheit), the time
 *   set and left in seconds (`time`, `cur_time`) and the recipe's name where
 *   one runs (`recipeName`).
 * - Stop: a SPECTRE goes to `standby`. A Venus acknowledges a bare standby in
 *   the middle of a cook and carries on cooking, so it is paused and then sent
 *   to `mainmenu` - and since `mainmenu` is also what wakes a Venus, nothing is
 *   sent to one that is already in standby.
 *
 * Deliberately not offered, though the source can do some of it: start, keep
 * warm, a programme or a temperature. Each of those sets an appliance heating,
 * and from a screen somewhere else nobody is there to see what is in it. Stop is
 * offered only on the three airfryer families whose stop is verified; a
 * multicooker or an espresso machine is watched and not driven (the espresso
 * machines of this cloud speak protobuf on their ports, which the source
 * decodes and this does not, so one shows its power from the shadow and no
 * readings).
 *
 * Pure and server-side.
 */

import * as kinds from "../device-kinds";
import type { CloudValue } from "../integrations/philips-cloud-link";

/** How an airfryer is wired, by its architecture. */
type Architecture = "spectre" | "venus1" | "venus2";

const MODEL_ARCHITECTURE: Readonly<Record<string, Architecture>> = {
    HD9200: "spectre",
    HD9255: "spectre",
    HD9280: "spectre",
    HD9285: "spectre",
    HD9875: "venus1",
    HD9876: "venus1",
    HD9880: "venus2"
};

/** What sort of kitchen appliance a model is, by the HomeID integration's own
 *  rules (`get_device_type`), or null for anything else. */
export function kitchenType(model: string | null): kinds.ApplianceType | null {
    const lower = (model ?? "").toLowerCase();
    if (
        lower.startsWith("hd9") ||
        lower.includes("airfryer") ||
        lower.includes("venus") ||
        lower.includes("spectre")
    ) {
        return "airfryer";
    }
    if (lower.startsWith("nx") || lower.includes("nutrimax") || lower.includes("hermes")) {
        return "multicooker";
    }
    if (
        lower.includes("espresso") ||
        lower.includes("coffee") ||
        lower.includes("flash_entry") ||
        /\b(ep|sm)\d/.test(lower)
    ) {
        return "espresso";
    }
    return null;
}

/** The airfryer architecture of a model, by its code or the codename some
 *  units report instead, or null where it is not known for certain. */
export function kitchenArchitecture(model: string | null): Architecture | null {
    const upper = (model ?? "").trim().toUpperCase();
    const code = Object.keys(MODEL_ARCHITECTURE).find((prefix) => upper.startsWith(prefix));
    if (code) return MODEL_ARCHITECTURE[code]!;
    if (upper.includes("SPECTRE")) return "spectre";
    if (upper.includes("VENUS2") || upper.includes("VENUS 2")) return "venus2";
    if (upper.includes("VENUS1") || upper.includes("VENUS 1")) return "venus1";
    return null;
}

/** The ports an appliance reports on and is told on. */
export function kitchenPorts(model: string | null): { status: string; control: string } {
    return kitchenArchitecture(model) === "venus2"
        ? { status: "venusaf_s", control: "venusaf_c" }
        : { status: "Status", control: "Control" };
}

/** A Venus's own spellings, as the SPECTRE ones (`_VENUS_KEY_MAP` and
 *  `_NCP_PROPERTY_MAP`). */
const VENUS_KEYS: Readonly<Record<string, string>> = {
    disp_time: "cur_time",
    total_time: "time",
    method: "preset",
    curr_temp: "cur_temp",
    current_temp: "cur_temp"
};

function numberOf(value: CloudValue | undefined): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
    return null;
}

function bounded(value: number | null, min: number, max: number): number | null {
    return value !== null && value >= min && value <= max ? value : null;
}

/** The statuses in which an airfryer is on (`_handle_ncp_response`). */
const ON: ReadonlySet<string> = new Set([
    "cooking",
    "pause",
    "setting",
    "precook",
    "parasetting",
    "maintain",
    "user_action",
    "idle",
    "finish"
]);

/** What an appliance reports, as Places' appliance view. */
export function kitchenAppliance(
    properties: Readonly<Record<string, CloudValue>>,
    model: string | null
): kinds.ApplianceView | null {
    const type = kitchenType(model);
    if (!type) return null;
    const read: Record<string, CloudValue> = { ...properties };
    for (const [venus, spectre] of Object.entries(VENUS_KEYS)) {
        if (read[venus] !== undefined && read[spectre] === undefined) read[spectre] = read[venus]!;
    }
    const recipe = read.recipeName;
    const remaining = bounded(numberOf(read.cur_time), 0, 7 * 24 * 60 * 60);
    const total = bounded(numberOf(read.time), 0, 7 * 24 * 60 * 60);
    return {
        type,
        status: kinds.applianceStatus(read.status),
        program: typeof recipe === "string" && recipe.trim() ? recipe.trim().slice(0, 120) : null,
        target: bounded(numberOf(read.temp), -50, 400),
        current: bounded(numberOf(read.cur_temp), -50, 400),
        unit: read.temp_unit === true ? "F" : "C",
        remaining: remaining === null ? null : Math.round(remaining),
        total: total === null ? null : Math.round(total),
        stoppable: type === "airfryer" && kitchenArchitecture(model) !== null
    };
}

/** On or off: the airfryer's status where it says one, else the shadow. */
export function kitchenPower(
    properties: Readonly<Record<string, CloudValue>>,
    powerOn: boolean | null
): kinds.DeviceState {
    const status = properties.status;
    if (typeof status === "string" && status) return ON.has(status) ? "on" : "off";
    if (powerOn !== null) return powerOn ? "on" : "off";
    return "unknown";
}

/**
 * What to send, in order, to stop an appliance - nothing at all for a Venus
 * already in standby, which the stop would wake. Null for one that cannot be
 * stopped from here.
 */
export function kitchenStop(
    model: string | null,
    properties: Readonly<Record<string, CloudValue>>
): Record<string, CloudValue>[] | null {
    if (kitchenType(model) !== "airfryer") return null;
    const architecture = kitchenArchitecture(model);
    if (architecture === "spectre") return [{ status: "standby" }];
    if (architecture === "venus1" || architecture === "venus2") {
        if (properties.status === "standby") return [];
        return [{ status: "pause" }, { status: "mainmenu" }];
    }
    return null;
}
