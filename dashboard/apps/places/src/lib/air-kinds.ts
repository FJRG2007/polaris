/**
 * Air purifiers and humidifiers: what they can be set to, what they measure and
 * how worn their filters are.
 *
 * Its own kind rather than an air conditioner with fewer buttons. An air
 * conditioner aims at a temperature and has a fan; a purifier aims at nothing,
 * runs a preset or a fan speed, and is mostly read - the dust in the room, the
 * humidity, the life left in three filters. Folding one into the other would
 * leave a temperature stepper on every purifier and a filter list on every air
 * conditioner, each control there only to be hidden again.
 *
 * Pure and client-safe, like `device-kinds`, which re-exports it: a row, the
 * panel, the automation editor and the service all read these words.
 *
 * The words for presets and speeds are Home Assistant's (`PresetMode` in the
 * Philips integration, which is also what its fan entities report), so a Philips
 * reached locally and the same unit reached through Home Assistant read alike.
 * Each driver translates to these once; nothing above a driver sees `D0310C`.
 */

import { z } from "zod";
import type { PlacesTranslator } from "./i18n";
import { englishPlaces as en } from "../../messages";

/** The presets a unit can run, slowest-sounding first. A unit offers the ones
 *  its own app does. */
export const AIR_MODES = [
    "auto",
    "auto_plus",
    "allergen",
    "allergy_sleep",
    "bacteria",
    "pollution",
    "gas",
    "sleep",
    "night",
    "gentle",
    "low",
    "medium",
    "high",
    "speed_1",
    "speed_2",
    "speed_3",
    "turbo",
    "natural",
    "ventilation",
    "eco",
    "pet_hair"
] as const;
export type AirMode = (typeof AIR_MODES)[number];

/** The fan speeds a unit can be put on, in no particular order: a unit lists
 *  its own, slowest first, and that order is the one drawn. */
export const AIR_SPEEDS = [
    "sleep",
    "night",
    "gentle",
    "low",
    "medium",
    "high",
    "speed_1",
    "speed_2",
    "speed_3",
    "speed_4",
    "speed_5",
    "speed_6",
    "speed_7",
    "speed_8",
    "speed_9",
    "speed_10",
    "speed_11",
    "speed_12",
    "turbo"
] as const;
export type AirSpeed = (typeof AIR_SPEEDS)[number];

/** The switches some units have: the lock on the buttons, the light of the
 *  display, on a purifier that also humidifies whether it humidifies, on a fan
 *  whether it swings from side to side, whether the buttons beep, and whether
 *  Auto runs as the Air+ app's Auto+ (the AI version that learns the room). */
export const AIR_OPTIONS = [
    "childLock",
    "light",
    "humidify",
    "oscillate",
    "beep",
    "autoPlus"
] as const;
export type AirOption = (typeof AIR_OPTIONS)[number];

/** The filters a unit reports. A combined unit has three; a humidifier has a
 *  wick and nothing else. */
export const AIR_FILTERS = ["pre", "hepa", "carbon", "wick", "nanoprotect"] as const;
export type AirFilter = (typeof AIR_FILTERS)[number];

/** How worn a filter is. `soon` and `now` are the two worth acting on. */
export const FILTER_STATES = ["ok", "soon", "now"] as const;
export type FilterState = (typeof FILTER_STATES)[number];

/** What a unit measures about the room. Each is optional: a humidifier has no
 *  particle sensor, and an old purifier no thermometer. `gas` is the level of
 *  gases and odours (VOCs) the units with a gas sensor report, 1 to 4. */
export const AIR_MEASURES = ["pm25", "allergen", "gas", "humidity", "temperature"] as const;
export type AirMeasure = (typeof AIR_MEASURES)[number];

/** The units each measure is in, as a person writes them. The allergen index
 *  is a bare number from 1 to 12, and the gas level a step written L1 to L4. */
export const MEASURE_UNITS: Readonly<Record<AirMeasure, string>> = {
    pm25: "µg/m³",
    allergen: "",
    gas: "",
    humidity: "%",
    temperature: "°C"
};

const percent = z.number().finite().min(0).max(100);

const filterSchema = z.object({
    kind: z.enum(AIR_FILTERS),
    /** Life left as a share of a new one, where the unit says what new is. */
    percent: percent.nullable(),
    /** Hours of use left. */
    hours: z.number().finite().min(0).max(1_000_000).nullable(),
    state: z.enum(FILTER_STATES)
});

export type AirFilterReading = z.infer<typeof filterSchema>;

const MAX_FILTERS = AIR_FILTERS.length + 1;

/**
 * How a purifier is set, what it can be set to, and what it last read.
 *
 * Stored on the device row as one document, refreshed by every sync. The row's
 * own reading (`value`/`unit`) is the one figure a list shows - the dust, or the
 * humidity on a humidifier - and the rest lives here.
 */
export const airSettingsSchema = z.object({
    mode: z.enum(AIR_MODES).nullable(),
    modes: z.array(z.enum(AIR_MODES)).max(AIR_MODES.length),
    speed: z.enum(AIR_SPEEDS).nullable(),
    speeds: z.array(z.enum(AIR_SPEEDS)).max(AIR_SPEEDS.length),
    /** The humidity it aims for, on a unit that humidifies. */
    humidity: z
        .object({
            target: percent.nullable(),
            min: percent,
            max: percent,
            step: z.number().finite().positive().max(50)
        })
        .refine((range) => range.min < range.max)
        .nullable(),
    options: z.object({
        childLock: z.boolean().optional(),
        light: z.boolean().optional(),
        humidify: z.boolean().optional(),
        oscillate: z.boolean().optional(),
        beep: z.boolean().optional(),
        autoPlus: z.boolean().optional()
    }),
    readings: z.object({
        pm25: z.number().finite().min(0).max(10_000).optional(),
        allergen: z.number().finite().min(0).max(100).optional(),
        gas: z.number().finite().min(0).max(100).optional(),
        humidity: percent.optional(),
        temperature: z.number().finite().min(-50).max(100).optional()
    }),
    filters: z.array(filterSchema).max(MAX_FILTERS)
});

export type AirSettings = z.infer<typeof airSettingsSchema>;

/** Stored settings, read back, or null for anything that is not them. */
export function airSettings(value: unknown): AirSettings | null {
    const parsed = airSettingsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

const readingsShape = airSettingsSchema.shape.readings.shape;

/**
 * Settings as a driver reported them, made fit to store: a reading or a filter
 * outside what the schema takes is dropped rather than losing the whole
 * document, and the filters are cut to as many as it holds.
 */
export function storableAir(settings: AirSettings | null | undefined): AirSettings | null {
    if (!settings) return null;
    const readings: AirSettings["readings"] = {};
    for (const measure of AIR_MEASURES) {
        const parsed = readingsShape[measure].safeParse(settings.readings[measure]);
        if (parsed.success && parsed.data !== undefined) readings[measure] = parsed.data;
    }
    const filters = settings.filters
        .filter((filter) => filterSchema.safeParse(filter).success)
        .slice(0, MAX_FILTERS);
    return airSettings({ ...settings, readings, filters });
}

/**
 * Whether a filter needs changing, on the scale Home Assistant's Philips
 * integration uses (`PhilipsFilterSensor.extra_state_attributes`): with a known
 * total, 5% left is now and 15% is soon; with only hours, a day is now and
 * three days is soon.
 */
export function filterState(percentLeft: number | null, hoursLeft: number | null): FilterState {
    if (percentLeft !== null) return percentLeft <= 5 ? "now" : percentLeft <= 15 ? "soon" : "ok";
    if (hoursLeft !== null) return hoursLeft <= 24 ? "now" : hoursLeft <= 72 ? "soon" : "ok";
    return "ok";
}

/** The most worn of a unit's filters, which is the one a person has to act on:
 *  `now` before `soon` before `ok`, and the least life left among equals. */
export function wornFilter(settings: AirSettings | null | undefined): AirFilterReading | null {
    const rank = (filter: AirFilterReading) => FILTER_STATES.indexOf(filter.state);
    let worst: AirFilterReading | null = null;
    for (const filter of settings?.filters ?? []) {
        if (!worst || rank(filter) > rank(worst)) worst = filter;
        else if (rank(filter) === rank(worst) && (filter.percent ?? 101) < (worst.percent ?? 101))
            worst = filter;
    }
    return worst;
}

/** The lowest life left among the filters that report it as a share, or null
 *  where none do. What "filter life below 10%" compares. */
export function filterLife(settings: AirSettings | null | undefined): number | null {
    const shares = (settings?.filters ?? [])
        .map((filter) => filter.percent)
        .filter((value): value is number => value !== null);
    return shares.length === 0 ? null : Math.min(...shares);
}

/**
 * How good the air is, as words rather than a figure: best first.
 *
 * The six levels of the European Air Quality Index (European Environment
 * Agency), which is also the order a rank compares in - 1 is Good, 6 is
 * Extremely poor - so "Poor or worse" is a rank of 4 or more.
 */
export const AIR_QUALITY_LEVELS = [
    "good",
    "fair",
    "moderate",
    "poor",
    "veryPoor",
    "extremelyPoor"
] as const;
export type AirQualityLevel = (typeof AIR_QUALITY_LEVELS)[number];

/**
 * PM2.5 bands in µg/m³: the highest concentration each level still covers.
 *
 * The EEA's revised European Air Quality Index (ETC HE Report 2024/17, "EEA's
 * revision of the European air quality index bands", published 2025; the bands
 * on airindex.eea.europa.eu): Good 0-5, Fair 6-15, Moderate 16-50, Poor 51-90,
 * Very poor 91-140, Extremely poor above 140. Good and Fair are the WHO 2021 Air
 * Quality Guidelines (5 µg/m³ annual, 15 µg/m³ over 24 hours); the upper bands
 * follow the WHO interim targets. A purifier reports a whole number, and a
 * fraction is read against the same edges (5.4 is still Good, 5.6 is Fair).
 */
const PM25_BANDS: readonly (readonly [number, AirQualityLevel])[] = [
    [5, "good"],
    [15, "fair"],
    [50, "moderate"],
    [90, "poor"],
    [140, "veryPoor"]
];

/**
 * Philips' Indoor Allergen Index bands, for a unit that reports the index and
 * no PM2.5: 1-3 Good, 4-6 Fair, 7-9 Poor, 10-12 Very poor - the four colours of
 * the air-quality light in Philips' own manuals (Series 1000 AC1711: blue,
 * blue-purple, purple-red, red). Its scale has no Moderate and no Extremely
 * poor, so those are never said from it.
 */
const ALLERGEN_BANDS: readonly (readonly [number, AirQualityLevel])[] = [
    [3, "good"],
    [6, "fair"],
    [9, "poor"]
];

function banded(
    value: number,
    bands: readonly (readonly [number, AirQualityLevel])[],
    above: AirQualityLevel
): AirQualityLevel {
    const rounded = Math.round(value);
    return bands.find(([edge]) => rounded <= edge)?.[1] ?? above;
}

/**
 * Philips' gas level, for a unit with a gas (VOC and odour) sensor: L1 Good, L2
 * Fair, L3 Poor, L4 Very poor - the four colours of the air-quality light in
 * the PureProtect Pro 4200 manual (AC4220/AC4221: blue, blue-purple,
 * purple-red, red). Like the allergen index, its scale has no Moderate and no
 * Extremely poor.
 */
const GAS_BANDS: readonly (readonly [number, AirQualityLevel])[] = [
    [1, "good"],
    [2, "fair"],
    [3, "poor"]
];

/** How good the air is, judged by PM2.5. */
export function pm25Quality(microgramsPerCubicMetre: number): AirQualityLevel {
    return banded(microgramsPerCubicMetre, PM25_BANDS, "extremelyPoor");
}

/** How good the air is, judged by Philips' allergen index. */
export function allergenQuality(index: number): AirQualityLevel {
    return banded(index, ALLERGEN_BANDS, "veryPoor");
}

/** How good the air is, judged by Philips' gas level. */
export function gasQuality(level: number): AirQualityLevel {
    return banded(level, GAS_BANDS, "veryPoor");
}

/**
 * How good the air is where a unit is, and which figure said so: PM2.5 where it
 * measures it, since the index is a scale of the maker's own, and the allergen
 * index where it is all there is. A unit that also measures gas is judged by
 * the worse of its dust and its gas, as its own light is ("determined by the
 * highest index between PM2.5 and Gas", the 4200 manual); gas wins a tie only
 * where there is no dust figure. Null on a unit that measures none of them - a
 * humidifier is not a judge of dust.
 */
export function airQuality(
    settings: AirSettings | null | undefined
): { level: AirQualityLevel; measure: "pm25" | "allergen" | "gas" } | null {
    const pm25 = settings?.readings.pm25;
    const allergen = settings?.readings.allergen;
    const dust =
        pm25 !== undefined
            ? { level: pm25Quality(pm25), measure: "pm25" as const }
            : allergen !== undefined
              ? { level: allergenQuality(allergen), measure: "allergen" as const }
              : null;
    const gas = settings?.readings.gas;
    if (gas === undefined) return dust;
    const fromGas = { level: gasQuality(gas), measure: "gas" as const };
    if (!dust) return fromGas;
    return airQualityRank(fromGas.level) > airQualityRank(dust.level) ? fromGas : dust;
}

/** A level's place in the order, 1 for Good: what an automation compares. */
export function airQualityRank(level: AirQualityLevel): number {
    return AIR_QUALITY_LEVELS.indexOf(level) + 1;
}

/** The level at a rank, or null for a number that is not one. */
export function airQualityAt(rank: number): AirQualityLevel | null {
    return Number.isInteger(rank) ? (AIR_QUALITY_LEVELS[rank - 1] ?? null) : null;
}

export function airQualityText(level: AirQualityLevel, t: PlacesTranslator = en): string {
    return t(`devices.air.quality.${level}`);
}

/** What to do about it, in one line: open the windows, or keep the unit on. */
export function airQualityHint(level: AirQualityLevel, t: PlacesTranslator = en): string {
    return t(`devices.air.qualityHints.${level}`);
}

/**
 * One change to a purifier, with what it is changed to.
 *
 * The same action words as an air conditioner's where they mean the same thing
 * - a mode, a fan speed, a switch - with this kind's own values, and one of its
 * own for the humidity a humidifier aims at.
 */
export const airCommandSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("set-mode"), mode: z.enum(AIR_MODES) }),
    z.object({ action: z.literal("set-fan"), speed: z.enum(AIR_SPEEDS) }),
    z.object({
        action: z.literal("set-option"),
        option: z.enum(AIR_OPTIONS),
        on: z.boolean()
    }),
    z.object({ action: z.literal("set-humidity"), target: percent })
]);

export type AirCommand = z.infer<typeof airCommandSchema>;

/** Why a command cannot go to this unit, or null when it can. The same answer
 *  in the browser, where it decides what is drawn, and on the server. */
export function airCommandIssue(settings: AirSettings | null, command: AirCommand): string | null {
    if (!settings) return "That device has not said what it can be set to yet";
    switch (command.action) {
        case "set-mode":
            return settings.modes.includes(command.mode)
                ? null
                : "That mode is not one this device has";
        case "set-fan":
            return settings.speeds.includes(command.speed)
                ? null
                : "That fan speed is not one this device has";
        case "set-option":
            return settings.options[command.option] === undefined
                ? "That setting is not one this device has"
                : null;
        case "set-humidity": {
            const range = settings.humidity;
            if (!range) return "That device does not humidify";
            const steps = (command.target - range.min) / range.step;
            return command.target >= range.min &&
                command.target <= range.max &&
                Math.abs(steps - Math.round(steps)) < 1e-6
                ? null
                : "That humidity is not one this device accepts";
        }
    }
}

/** The settings once a command has landed: what the row shows the moment it is
 *  pressed, and what the service stores once the unit has accepted it. A preset
 *  and a speed are one choice on the unit, so picking either clears the other
 *  until the unit says what it is running. */
export function applyAir(settings: AirSettings, command: AirCommand): AirSettings {
    switch (command.action) {
        case "set-mode":
            return { ...settings, mode: command.mode, speed: null };
        case "set-fan":
            return { ...settings, speed: command.speed, mode: null };
        case "set-option":
            return { ...settings, options: { ...settings.options, [command.option]: command.on } };
        case "set-humidity":
            return settings.humidity
                ? { ...settings, humidity: { ...settings.humidity, target: command.target } }
                : settings;
    }
}

/** The one figure a list shows for a unit: the dust where it measures it, the
 *  humidity on a humidifier, nothing on one that measures neither. The gas
 *  level is never the headline: a bare L2 says nothing on a row. */
export function airHeadline(
    settings: AirSettings
): { value: string; unit: string; measure: AirMeasure } | null {
    for (const measure of ["pm25", "humidity", "allergen"] as const) {
        const value = settings.readings[measure];
        if (value !== undefined)
            return { value: String(value), unit: MEASURE_UNITS[measure], measure };
    }
    return null;
}

export function airModeText(mode: AirMode, t: PlacesTranslator = en): string {
    return t(`devices.air.modes.${mode}`);
}

export function airSpeedText(speed: AirSpeed, t: PlacesTranslator = en): string {
    return t(`devices.air.speeds.${speed}`);
}

export function airOptionText(option: AirOption, t: PlacesTranslator = en): string {
    return t(`devices.air.options.${option}`);
}

export function airFilterText(filter: AirFilter, t: PlacesTranslator = en): string {
    return t(`devices.air.filters.${filter}`);
}

export function filterStateText(state: FilterState, t: PlacesTranslator = en): string {
    return t(`devices.air.filterStates.${state}`);
}

export function airMeasureText(measure: AirMeasure, t: PlacesTranslator = en): string {
    return t(`devices.air.measures.${measure}`);
}

/** A measure as a person reads it: the number, then its unit closed up where
 *  it is a symbol. */
export function measureLine(measure: AirMeasure, value: number): string {
    // Written the way the unit's own display and manual write it.
    if (measure === "gas") return `L${Math.round(value)}`;
    const unit = MEASURE_UNITS[measure];
    const rounded = Math.round(value * 10) / 10;
    const text = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
    if (!unit) return text;
    return /^[%°]/.test(unit) ? `${text}${unit}` : `${text} ${unit}`;
}
