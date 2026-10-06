/**
 * An IKEA DIRIGERA hub, as devices.
 *
 * One connection is the hub, and it brings what is paired to it: lights and
 * outlets to switch, and the three sensors whose readings the reference library
 * names - a door or window contact, a movement sensor, and the air sensor's
 * temperature and humidity. Blinds, air purifiers and remotes are on the same
 * hub and are left out until Polaris has an honest control for them.
 *
 * Pairing happens in `verify`, because it is the only moment somebody is at the
 * hub: Connect is selected, the hub's action button is pressed, and what comes
 * back - the token and the certificate the hub answered with - is what is stored
 * in place of the address that was typed. Kept whole inside this driver so a
 * pairing screen can later drive the same call.
 *
 * Server-only.
 */

import { HomeError } from "../home-error";
import { BINARY_WORDS } from "../device-kinds";
import * as ikea from "../integrations/dirigera-api";
import { deviceHost } from "../integrations/lan-http";
import { DriverError, type Credentials, type DeviceDriver, type DeviceSnapshot } from "./contract";

export const DIRIGERA_HUB = "dirigera-hub";

function hostOf(credentials: Credentials): string {
    const typed = credentials.host?.trim();
    if (!typed) throw new HomeError("That connection is missing the device's address");
    const host = deviceHost(typed);
    if (!host) throw new HomeError("Write the address as 192.168.1.30, with no path");
    return host;
}

function hubOf(credentials: Credentials): ikea.DirigeraHub {
    const token = credentials.token?.trim();
    const fingerprint = credentials.fingerprint?.trim();
    if (!token || !fingerprint) {
        throw new DriverError(
            "The DIRIGERA hub no longer accepts Polaris. Connect it again and press the hub's button.",
            "unauthorized"
        );
    }
    return { host: hostOf(credentials), token, fingerprint };
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function numberOf(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function base(device: ikea.DirigeraDevice) {
    const battery = numberOf(device.attributes.batteryPercentage);
    return {
        name: text(device.attributes.customName) || text(device.attributes.model) || "IKEA device",
        model: text(device.attributes.model) || null,
        firmware: text(device.attributes.firmwareVersion) || null,
        doorState: "none" as const,
        batteryPercent: battery,
        batteryCritical: battery !== null && battery <= 15,
        online: device.isReachable
    };
}

function sensor(
    device: ikea.DirigeraDevice,
    externalId: string,
    name: string,
    value: string,
    unit: string
): DeviceSnapshot {
    return { ...base(device), externalId, kind: "sensor", name, state: "unknown", value, unit };
}

/** One device from the hub as the rows it makes - none for what is skipped. */
function rowsOf(device: ikea.DirigeraDevice): DeviceSnapshot[] {
    const attributes = device.attributes;
    if (device.type === "light" || device.type === "outlet") {
        const on = attributes.isOn;
        return [
            {
                ...base(device),
                externalId: device.id,
                kind: device.type === "light" ? "light" : "outlet",
                state:
                    !device.isReachable || typeof on !== "boolean" ? "unknown" : on ? "on" : "off"
            }
        ];
    }
    const own = base(device);
    if (device.deviceType === "openCloseSensor" && typeof attributes.isOpen === "boolean") {
        const words = BINARY_WORDS.door!;
        return [sensor(device, device.id, own.name, attributes.isOpen ? words.on : words.off, "")];
    }
    if (device.deviceType === "motionSensor" && typeof attributes.isDetected === "boolean") {
        const words = BINARY_WORDS.motion!;
        return [
            sensor(device, device.id, own.name, attributes.isDetected ? words.on : words.off, "")
        ];
    }
    if (device.deviceType === "environmentSensor") {
        const rows: DeviceSnapshot[] = [];
        const temperature = numberOf(attributes.currentTemperature);
        const humidity = numberOf(attributes.currentRH);
        if (temperature !== null) {
            rows.push(
                sensor(device, `${device.id}#temperature`, own.name, String(temperature), "°C")
            );
        }
        if (humidity !== null)
            rows.push(sensor(device, `${device.id}#humidity`, own.name, String(humidity), "%"));
        return rows;
    }
    return [];
}

export const dirigeraHubDriver: DeviceDriver = {
    connection: DIRIGERA_HUB,

    /** Pair: wait for the hub's button, keep the token and the hub's certificate,
     *  and read the devices once with them before anything is stored. */
    async verify(credentials) {
        const hub = await ikea.pairHub(hostOf(credentials));
        await ikea.hubDevices(hub);
        return { host: credentials.host!.trim(), token: hub.token, fingerprint: hub.fingerprint };
    },

    async list(credentials) {
        return (await ikea.hubDevices(hubOf(credentials))).flatMap(rowsOf);
    },

    /** The hub's event stream. A device's sensors are rows of their own
     *  (`<id>#temperature`), so an event about it names those too. */
    async listen(credentials, changed, signal) {
        await ikea.listenHub(
            hubOf(credentials),
            (deviceId) =>
                changed(
                    deviceId ? [deviceId, `${deviceId}#temperature`, `${deviceId}#humidity`] : []
                ),
            signal
        );
    },

    async act(credentials, device, action) {
        if (action !== "turn-on" && action !== "turn-off") {
            throw new HomeError("An IKEA device cannot be told to do that");
        }
        await ikea.setOn(hubOf(credentials), device.externalId, action === "turn-on");
    }
};
