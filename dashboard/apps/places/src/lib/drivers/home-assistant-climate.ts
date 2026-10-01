/**
 * A Home Assistant `climate.*` entity, as an air conditioner.
 *
 * Their climate entity carries everything as attributes (`hvac_modes`,
 * `min_temp`, `max_temp`, `target_temp_step`, `temperature`,
 * `current_temperature`, `fan_mode(s)`, `swing_mode(s)`, `preset_mode(s)`), and
 * its state is the HVAC mode itself, `off` included. Commands are the climate
 * services: `turn_on`, `turn_off`, `set_hvac_mode`, `set_temperature`,
 * `set_fan_mode`, `set_swing_mode`, `set_preset_mode`.
 *
 * Words with no Places equivalent are left out rather than forced into one: a
 * fan mode called "focus" is not a speed, and offering it as "medium" would be a
 * control that does something else.
 *
 * Server-only.
 */

import { HomeError } from "../home-error";
import type { HomeAssistantState } from "../integrations/home-assistant-api";
import type {
    ClimateCommand,
    ClimateFan,
    ClimateMode,
    ClimateSettings,
    DeviceAction
} from "../device-kinds";

/** Home Assistant's `HVACMode`, as ours. `heat_cool` is the one that reads as
 *  automatic where a unit has no `auto` of its own. */
const MODES: Readonly<Record<string, ClimateMode>> = {
    cool: "cool",
    heat: "heat",
    dry: "dry",
    fan_only: "fan",
    auto: "auto"
};

/** The fan words integrations use, as ours. Their constants (`FAN_AUTO`,
 *  `FAN_LOW`, `FAN_MEDIUM`, `FAN_HIGH`) plus the in-between words Gree's and
 *  others' integrations add. */
const FANS: Readonly<Record<string, ClimateFan>> = {
    auto: "auto",
    low: "low",
    "medium low": "medium-low",
    medium_low: "medium-low",
    medium: "medium",
    mid: "medium",
    middle: "medium",
    "medium high": "medium-high",
    medium_high: "medium-high",
    high: "high"
};

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
}

function numberOf(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** Our word for each of theirs a unit offers, and the way back. */
function modeTable(entity: HomeAssistantState): Map<ClimateMode, string> {
    const table = new Map<ClimateMode, string>();
    const offered = strings(entity.attributes.hvac_modes);
    for (const word of offered) {
        const mode = MODES[word];
        if (mode && !table.has(mode)) table.set(mode, word);
    }
    if (!table.has("auto") && offered.includes("heat_cool")) table.set("auto", "heat_cool");
    return table;
}

function fanTable(entity: HomeAssistantState): Map<ClimateFan, string> {
    const table = new Map<ClimateFan, string>();
    for (const word of strings(entity.attributes.fan_modes)) {
        const fan = FANS[word.toLowerCase()];
        if (fan && !table.has(fan)) table.set(fan, word);
    }
    return table;
}

/** The swing word that means "swinging" on this entity, or null when it has no
 *  plain on and off. */
function swingOn(entity: HomeAssistantState): string | null {
    const offered = strings(entity.attributes.swing_modes);
    if (!offered.includes("off")) return null;
    return ["on", "vertical", "both", "horizontal"].find((word) => offered.includes(word)) ?? null;
}

const PRESET_OPTIONS = { eco: "eco", turbo: "boost" } as const;

/** A climate entity's attributes as Places' settings, in the install's unit. */
export function haClimateSettings(
    entity: HomeAssistantState,
    unit: "C" | "F"
): ClimateSettings | null {
    const attributes = entity.attributes;
    const min = numberOf(attributes.min_temp) ?? (unit === "F" ? 45 : 7);
    const max = numberOf(attributes.max_temp) ?? (unit === "F" ? 95 : 35);
    if (!(min < max)) return null;
    const modes = modeTable(entity);
    const fans = fanTable(entity);
    const mode = [...modes].find(([, word]) => word === entity.state)?.[0] ?? null;
    const fanWord = text(attributes.fan_mode);
    const fan = [...fans].find(([, word]) => word === fanWord)?.[0] ?? null;
    const options: ClimateSettings["options"] = {};
    if (swingOn(entity)) options.swing = text(attributes.swing_mode) !== "off";
    const presets = strings(attributes.preset_modes);
    for (const [option, word] of Object.entries(PRESET_OPTIONS) as [
        keyof typeof PRESET_OPTIONS,
        string
    ][]) {
        if (presets.includes(word) && presets.includes("none"))
            options[option] = text(attributes.preset_mode) === word;
    }
    return {
        mode,
        modes: [...modes.keys()],
        target: numberOf(attributes.temperature),
        min,
        max,
        step: numberOf(attributes.target_temp_step) ?? 1,
        unit,
        fan,
        fans: [...fans.keys()],
        options
    };
}

/** The service and its data for one action on one climate entity. */
export function haClimateService(
    entity: HomeAssistantState,
    action: DeviceAction,
    command: ClimateCommand | undefined
): { service: string; data: Record<string, unknown> } {
    if (action === "turn-on") return { service: "turn_on", data: {} };
    if (action === "turn-off") return { service: "turn_off", data: {} };
    if (!command || command.action !== action) throw new HomeError("Say what to set it to");
    switch (command.action) {
        case "set-mode": {
            const word = modeTable(entity).get(command.mode);
            if (!word) throw new HomeError("That mode is not one this device has");
            return { service: "set_hvac_mode", data: { hvac_mode: word } };
        }
        case "set-temperature":
            if (
                numberOf(entity.attributes.temperature) === null &&
                (numberOf(entity.attributes.target_temp_low) !== null ||
                    numberOf(entity.attributes.target_temp_high) !== null)
            )
                throw new HomeError("This device takes a range rather than one temperature");
            return { service: "set_temperature", data: { temperature: command.target } };
        case "set-fan": {
            const word = fanTable(entity).get(command.fan);
            if (!word) throw new HomeError("That fan speed is not one this device has");
            return { service: "set_fan_mode", data: { fan_mode: word } };
        }
        case "set-option": {
            if (command.option === "swing") {
                const on = swingOn(entity);
                if (!on) throw new HomeError("That setting is not one this device has");
                return { service: "set_swing_mode", data: { swing_mode: command.on ? on : "off" } };
            }
            if (command.option === "eco" || command.option === "turbo") {
                const word = PRESET_OPTIONS[command.option];
                return {
                    service: "set_preset_mode",
                    data: { preset_mode: command.on ? word : "none" }
                };
            }
            throw new HomeError("That setting is not one this device has");
        }
    }
}
