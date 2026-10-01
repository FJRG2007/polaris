/**
 * Everything a Home Assistant install has, as devices.
 *
 * One connection brings the whole house: whatever Home Assistant already talks
 * to - Zigbee, Z-Wave, a hundred cloud integrations - arrives through its own
 * API, so a house that has it needs nothing else here. The same domains are
 * taken as from a broker (`mqtt-discovery`): switches, lights, locks and the two
 * kinds of sensor - and air conditioners, from `climate.*`
 * (`home-assistant-climate.ts`). Covers and media players are left out until
 * Polaris has an honest control for them.
 *
 * An entity id is the row's id, because it is what Home Assistant itself keeps
 * stable across renames and restarts.
 *
 * Server-only.
 */

import { HomeError } from "../home-error";
import * as ha from "../integrations/home-assistant-api";
import { BINARY_WORDS, type DeviceKind } from "../device-kinds";
import { haClimateService, haClimateSettings } from "./home-assistant-climate";
import { DriverError, type Credentials, type DeviceDriver, type DeviceSnapshot } from "./contract";

export const HOME_ASSISTANT = "home-assistant";

function homeOf(credentials: Credentials): ha.HomeAssistant {
    const url = credentials.url?.trim();
    const token = credentials.token?.trim();
    if (!url) throw new HomeError("That connection is missing the device's address");
    if (!token) throw new HomeError("That connection is missing its token");
    const home = ha.homeAssistant(url, token);
    if (!home)
        throw new HomeError("Write the address as http://homeassistant.local:8123, with no path");
    return home;
}

function domainOf(entityId: string): string {
    return entityId.split(".")[0] ?? "";
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/** The kind an entity is drawn as, or null for a domain that is skipped. A
 *  switch whose device class is `outlet` is a socket. */
function kindOf(entity: ha.HomeAssistantState): DeviceKind | null {
    switch (domainOf(entity.entity_id)) {
        case "switch":
            return text(entity.attributes.device_class) === "outlet" ? "outlet" : "switch";
        case "light":
            return "light";
        case "lock":
            return "lock";
        case "climate":
            return "climate";
        case "sensor":
        case "binary_sensor":
            return "sensor";
        default:
            return null;
    }
}

/** Home Assistant's lock states (`LockState`), as the ones Places draws. */
const LOCK_STATES: Readonly<Record<string, DeviceSnapshot["state"]>> = {
    locked: "locked",
    unlocked: "unlocked",
    open: "unlatched",
    jammed: "jammed",
    locking: "moving",
    unlocking: "moving",
    opening: "moving"
};

function stateOf(kind: DeviceKind, raw: string): DeviceSnapshot["state"] {
    if (kind === "sensor") return "unknown";
    if (kind === "lock") return LOCK_STATES[raw] ?? "unknown";
    // A climate entity's state is its HVAC mode, and every one but `off` is on.
    if (kind === "climate") return raw === "off" ? "off" : raw === "unknown" ? "unknown" : "on";
    return raw === "on" ? "on" : raw === "off" ? "off" : "unknown";
}

function readingOf(entity: ha.HomeAssistantState): { value: string; unit: string } | null {
    const raw = entity.state;
    if (raw === "unavailable" || raw === "unknown" || !raw) return null;
    if (domainOf(entity.entity_id) === "binary_sensor") {
        const words = BINARY_WORDS[text(entity.attributes.device_class)];
        const on = raw === "on";
        return { value: words ? (on ? words.on : words.off) : on ? "On" : "Off", unit: "" };
    }
    return { value: raw, unit: text(entity.attributes.unit_of_measurement) };
}

/** An air conditioner's room temperature, as its reading. */
function climateReading(
    entity: ha.HomeAssistantState,
    unit: "C" | "F"
): { value: string; unit: string } | null {
    const current = entity.attributes.current_temperature;
    return typeof current === "number" && Number.isFinite(current)
        ? { value: String(current), unit: `°${unit}` }
        : null;
}

function toSnapshot(entity: ha.HomeAssistantState, unit: "C" | "F" = "C"): DeviceSnapshot | null {
    const kind = kindOf(entity);
    if (!kind) return null;
    // "unavailable" is Home Assistant saying it cannot reach the device.
    const online = entity.state !== "unavailable";
    const reading =
        kind === "sensor"
            ? readingOf(entity)
            : kind === "climate"
              ? climateReading(entity, unit)
              : null;
    return {
        externalId: entity.entity_id,
        kind,
        name: text(entity.attributes.friendly_name) || entity.entity_id,
        model: null,
        firmware: null,
        state: online ? stateOf(kind, entity.state) : "unknown",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online,
        value: reading?.value ?? null,
        unit: reading?.unit ?? null,
        climate: kind === "climate" && online ? haClimateSettings(entity, unit) : null
    };
}

/** The service an action is, per domain. */
function serviceFor(domain: string, action: string): string | null {
    if (domain === "switch" || domain === "light") {
        return action === "turn-on" ? "turn_on" : action === "turn-off" ? "turn_off" : null;
    }
    if (domain === "lock") {
        return action === "lock"
            ? "lock"
            : action === "unlock"
              ? "unlock"
              : action === "unlatch"
                ? "open"
                : null;
    }
    return null;
}

export const homeAssistantDriver: DeviceDriver = {
    connection: HOME_ASSISTANT,

    /** Whether the token opens the API, and whether there is anything in the
     *  house Polaris can draw. */
    async verify(credentials) {
        const home = homeOf(credentials);
        await ha.checkHomeAssistant(home);
        const states = await ha.homeAssistantStates(home);
        if (!states.some((entity) => kindOf(entity) !== null)) {
            throw new DriverError(
                "Home Assistant has no switches, lights, locks or sensors for Polaris to show.",
                "refused"
            );
        }
    },

    async list(credentials) {
        const home = homeOf(credentials);
        const states = await ha.homeAssistantStates(home);
        // Only asked when there is an air conditioner to read in it.
        const unit = states.some((entity) => domainOf(entity.entity_id) === "climate")
            ? await ha.homeAssistantTemperatureUnit(home)
            : "C";
        return states.flatMap((entity) => {
            const snapshot = toSnapshot(entity, unit);
            return snapshot ? [snapshot] : [];
        });
    },

    async act(credentials, device, action, command) {
        const domain = domainOf(device.externalId);
        if (domain === "climate") {
            // Read now: what a mode or a fan speed is called is the entity's own,
            // and the way back to its word is from what it offers today.
            const home = homeOf(credentials);
            const entity = await ha.homeAssistantState(home, device.externalId);
            if (!entity) throw new HomeError("That device is not here");
            const { service, data } = haClimateService(entity, action, command);
            await ha.callService(home, domain, service, device.externalId, data);
            return;
        }
        const service = serviceFor(domain, action);
        if (!service) throw new HomeError("That device cannot be told to do that");
        await ha.callService(homeOf(credentials), domain, service, device.externalId);
    }
};
