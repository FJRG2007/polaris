/**
 * Home Assistant's air purifiers and humidifiers, as one device each.
 *
 * A purifier in Home Assistant is a `fan.*` entity - power, `preset_mode(s)`,
 * `percentage` and `percentage_step` (the fan entity's state attributes), driven
 * by `fan.turn_on`/`turn_off`, `fan.set_preset_mode` and `fan.set_percentage` -
 * with its dust, humidity, temperature and filters as sibling `sensor.*`
 * entities on the same device, and on a combined unit a `humidifier.*` entity
 * (`humidity`, `min_humidity`, `max_humidity`, `target_humidity_step`, `mode`,
 * `available_modes`; `humidifier.set_humidity`, `set_mode`, `turn_on`/`off`).
 * Which entities share a device comes from Home Assistant's own template
 * functions (`homeAssistantDevices`); the REST states do not say.
 *
 * A fan is taken as a purifier only when its device has something a purifier
 * has - an air-quality, humidity or filter sensor, or a humidifier - so a
 * ceiling fan is not drawn with a filter list. A humidifier with no fan beside
 * it is a device of its own.
 *
 * Presets keep their own words where they are ones Places knows (the Philips
 * integration's are all among them); others are left out rather than forced
 * into one. A fan's speed is its percentage, offered as the steps the entity
 * itself has. The child lock and display light are the device's switch and
 * light whose names say so, which is how the Philips integration names them;
 * sensors are told apart by device class, and filters and the allergen index by
 * name, since nothing else on a state says what they measure.
 *
 * Server-only.
 */

import * as kinds from "../device-kinds";
import { HomeError } from "../home-error";
import type { HomeAssistantState } from "../integrations/home-assistant-api";

/** What a purifier is made of in Home Assistant: the entity that carries its
 *  power, and the ones beside it on the same device. */
export interface HaAirUnit {
    readonly primary: HomeAssistantState;
    readonly humidifier: HomeAssistantState | null;
    readonly sensors: readonly HomeAssistantState[];
    readonly childLock: HomeAssistantState | null;
    readonly light: HomeAssistantState | null;
}

/** `FanEntityFeature.SET_SPEED`. */
const SET_SPEED = 1;
/** Speeds are offered as the steps the entity has, up to this many. */
const MAX_STEPS = 12;

const AIR_DEVICE_CLASSES = new Set([
    "pm25",
    "pm10",
    "pm1",
    "aqi",
    "volatile_organic_compounds",
    "volatile_organic_compounds_parts",
    "humidity"
]);

function domainOf(entityId: string): string {
    return entityId.split(".")[0] ?? "";
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function numberOf(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    return null;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isFilter(entity: HomeAssistantState): boolean {
    return domainOf(entity.entity_id) === "sensor" && /filter|wick/.test(entity.entity_id);
}

/** What only an air purifier has beside it: a room's temperature is not enough. */
function isAirSensor(entity: HomeAssistantState): boolean {
    if (domainOf(entity.entity_id) !== "sensor") return false;
    return AIR_DEVICE_CLASSES.has(text(entity.attributes.device_class)) || isFilter(entity) || /allergen/.test(entity.entity_id);
}

/**
 * Every purifier and humidifier in a house, from its states and which entities
 * share a device. Each entity belongs to at most one unit.
 */
export function haAirUnits(
    states: readonly HomeAssistantState[],
    devices: ReadonlyMap<string, readonly string[]>
): HaAirUnit[] {
    const byId = new Map(states.map((entity) => [entity.entity_id, entity]));
    const siblingsOf = (entity: HomeAssistantState) =>
        (devices.get(entity.entity_id) ?? [])
            .filter((id) => id !== entity.entity_id)
            .flatMap((id) => {
                const found = byId.get(id);
                return found ? [found] : [];
            });
    const units: HaAirUnit[] = [];
    const taken = new Set<string>();
    const build = (primary: HomeAssistantState, siblings: HomeAssistantState[]): HaAirUnit => ({
        primary,
        humidifier:
            domainOf(primary.entity_id) === "humidifier"
                ? primary
                : (siblings.find((entity) => domainOf(entity.entity_id) === "humidifier") ?? null),
        sensors: siblings.filter(
            (entity) => isAirSensor(entity) || (domainOf(entity.entity_id) === "sensor" && text(entity.attributes.device_class) === "temperature")
        ),
        childLock: siblings.find((entity) => domainOf(entity.entity_id) === "switch" && /child_lock/.test(entity.entity_id)) ?? null,
        light: siblings.find((entity) => domainOf(entity.entity_id) === "light" && /display|backlight/.test(entity.entity_id)) ?? null
    });
    for (const entity of states) {
        if (domainOf(entity.entity_id) !== "fan") continue;
        const siblings = siblingsOf(entity);
        const purifier = siblings.some(
            (sibling) => isAirSensor(sibling) || domainOf(sibling.entity_id) === "humidifier"
        );
        if (!purifier) continue;
        const unit = build(entity, siblings);
        units.push(unit);
        if (unit.humidifier) taken.add(unit.humidifier.entity_id);
    }
    for (const entity of states) {
        if (domainOf(entity.entity_id) !== "humidifier" || taken.has(entity.entity_id)) continue;
        units.push(build(entity, siblingsOf(entity)));
    }
    return units;
}

/** How many speed steps a fan has, from its own `percentage_step`, or none when
 *  it cannot be set to a speed. */
function stepsOf(fan: HomeAssistantState): number {
    if (domainOf(fan.entity_id) !== "fan") return 0;
    const features = numberOf(fan.attributes.supported_features) ?? 0;
    if ((features & SET_SPEED) === 0) return 0;
    const step = numberOf(fan.attributes.percentage_step);
    if (!step || step <= 0) return 0;
    return Math.max(1, Math.min(MAX_STEPS, Math.round(100 / step)));
}

function speedWords(steps: number): kinds.AirSpeed[] {
    return Array.from({ length: steps }, (_, index) => `speed_${index + 1}` as kinds.AirSpeed);
}

/** `percentage_to_ordered_list_item`: which step a percentage falls on. */
function stepOf(percentage: number, steps: number): number {
    return Math.max(1, Math.min(steps, Math.ceil((percentage * steps) / 100)));
}

/** Our preset words among the ones an entity offers, by its own word. */
function presetsOf(unit: HaAirUnit): Map<kinds.AirMode, string> {
    const primary = unit.primary;
    const offered =
        domainOf(primary.entity_id) === "fan"
            ? strings(primary.attributes.preset_modes)
            : strings(primary.attributes.available_modes);
    const table = new Map<kinds.AirMode, string>();
    for (const word of offered) {
        const mode = kinds.AIR_MODES.find((entry) => entry === word.toLowerCase());
        if (mode && !table.has(mode)) table.set(mode, word);
    }
    return table;
}

function filterKind(entityId: string): kinds.AirFilter {
    if (/wick/.test(entityId)) return "wick";
    if (/hepa/.test(entityId)) return "hepa";
    if (/carbon/.test(entityId)) return "carbon";
    if (/nano/.test(entityId)) return "nanoprotect";
    return "pre";
}

/** A temperature sensor's value in Celsius, whatever the install shows. */
function celsius(entity: HomeAssistantState): number | null {
    const value = numberOf(entity.state);
    if (value === null) return null;
    const unit = text(entity.attributes.unit_of_measurement);
    return unit.includes("F") ? Math.round(((value - 32) * 5) / 9 * 10) / 10 : value;
}

/** A unit's entities as Places' settings. */
export function haAirSettings(unit: HaAirUnit): kinds.AirSettings {
    const primary = unit.primary;
    const presets = presetsOf(unit);
    const word = text(primary.attributes[domainOf(primary.entity_id) === "fan" ? "preset_mode" : "mode"]);
    const steps = stepsOf(primary);
    const percentage = numberOf(primary.attributes.percentage);

    const readings: kinds.AirSettings["readings"] = {};
    const filters: kinds.AirFilterReading[] = [];
    for (const sensor of unit.sensors) {
        const deviceClass = text(sensor.attributes.device_class);
        const value = numberOf(sensor.state);
        if (value === null) continue;
        if (isFilter(sensor)) {
            const unitOf = text(sensor.attributes.unit_of_measurement);
            const percent = unitOf === "%" ? Math.max(0, Math.min(100, value)) : null;
            const hours = unitOf === "h" ? Math.max(0, value) : null;
            if (percent === null && hours === null) continue;
            filters.push({ kind: filterKind(sensor.entity_id), percent, hours, state: kinds.filterState(percent, hours) });
        } else if (deviceClass === "pm25") readings.pm25 ??= value;
        else if (deviceClass === "humidity" && value >= 0 && value <= 100) readings.humidity ??= value;
        else if (deviceClass === "temperature") readings.temperature ??= celsius(sensor) ?? undefined;
        else if (/allergen/.test(sensor.entity_id)) readings.allergen ??= value;
    }
    const current = numberOf(unit.humidifier?.attributes.current_humidity);
    if (readings.humidity === undefined && current !== null && current >= 0 && current <= 100) readings.humidity = current;

    let humidity: kinds.AirSettings["humidity"] = null;
    if (unit.humidifier) {
        const min = numberOf(unit.humidifier.attributes.min_humidity) ?? 0;
        const max = numberOf(unit.humidifier.attributes.max_humidity) ?? 100;
        if (min < max) {
            const target = numberOf(unit.humidifier.attributes.humidity);
            humidity = {
                target: target === null ? null : Math.max(min, Math.min(max, target)),
                min,
                max,
                step: numberOf(unit.humidifier.attributes.target_humidity_step) ?? 1
            };
        }
    }

    const options: kinds.AirSettings["options"] = {};
    if (unit.childLock) options.childLock = unit.childLock.state === "on";
    if (unit.light) options.light = unit.light.state === "on";
    // A purifier with a humidifier beside it: humidifying is that entity's power.
    if (unit.humidifier && unit.humidifier !== primary) options.humidify = unit.humidifier.state === "on";

    return {
        mode: [...presets].find(([, offered]) => offered === word)?.[0] ?? null,
        modes: [...presets.keys()],
        speed: steps > 0 && percentage !== null && percentage > 0 ? (`speed_${stepOf(percentage, steps)}` as kinds.AirSpeed) : null,
        speeds: speedWords(steps),
        humidity,
        options,
        readings,
        filters
    };
}

/** The entity, service and data for one action on one purifier. */
export function haAirService(
    unit: HaAirUnit,
    action: kinds.DeviceAction,
    command: kinds.DeviceCommand | undefined
): { entityId: string; domain: string; service: string; data: Record<string, unknown> } {
    const primary = unit.primary;
    const domain = domainOf(primary.entity_id);
    const on = (entity: HomeAssistantState, value: boolean) => ({
        entityId: entity.entity_id,
        domain: domainOf(entity.entity_id),
        service: value ? "turn_on" : "turn_off",
        data: {}
    });
    if (action === "turn-on") return on(primary, true);
    if (action === "turn-off") return on(primary, false);
    const setting = kinds.airCommandOf(command);
    if (!setting || setting.action !== action) throw new HomeError("Say what to set it to");
    switch (setting.action) {
        case "set-mode": {
            const word = presetsOf(unit).get(setting.mode);
            if (!word) throw new HomeError("That mode is not one this device has");
            return domain === "fan"
                ? { entityId: primary.entity_id, domain, service: "set_preset_mode", data: { preset_mode: word } }
                : { entityId: primary.entity_id, domain, service: "set_mode", data: { mode: word } };
        }
        case "set-fan": {
            const steps = stepsOf(primary);
            const step = Number(setting.speed.replace("speed_", ""));
            if (steps === 0 || !Number.isInteger(step) || step < 1 || step > steps) {
                throw new HomeError("That fan speed is not one this device has");
            }
            return {
                entityId: primary.entity_id,
                domain,
                service: "set_percentage",
                data: { percentage: Math.round((step * 100) / steps) }
            };
        }
        case "set-humidity":
            if (!unit.humidifier) throw new HomeError("That device does not humidify");
            return {
                entityId: unit.humidifier.entity_id,
                domain: "humidifier",
                service: "set_humidity",
                data: { humidity: setting.target }
            };
        case "set-option": {
            const target =
                setting.option === "childLock"
                    ? unit.childLock
                    : setting.option === "light"
                      ? unit.light
                      : unit.humidifier && unit.humidifier !== primary
                        ? unit.humidifier
                        : null;
            if (!target) throw new HomeError("That setting is not one this device has");
            return on(target, setting.on);
        }
    }
}
