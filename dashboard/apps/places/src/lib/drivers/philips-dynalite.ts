/**
 * Philips Dynalite lighting areas, through a Dynet Ethernet gateway, as lights.
 *
 * Modeled on Home Assistant's dynalite integration
 * (home-assistant.io/integrations/dynalite, built on python-dynalite-devices):
 * one connection is one gateway, reached over TCP on port 12345 unless it was
 * changed. A Dynet network does not announce its areas, so the ones to bring in
 * are typed - Home Assistant's `area` list.
 *
 * Each area is a light. On is preset 1 and off preset 4, the defaults of that
 * integration's "room" template (`DEFAULT_TEMPLATES`, `room_on: 1`,
 * `room_off: 4`), which is how a Dynalite area is usually programmed. Its state
 * is the preset it reports: 4 is off, any other is on, and an area that does
 * not answer is drawn as not known rather than as off.
 *
 * Server-only.
 */

import { HomeError } from "../home-error";
import { deviceHost } from "../integrations/lan-http";
import { dynetExchange } from "../integrations/dynet-link";
import { presetOf, requestPreset, selectPreset } from "../integrations/dynet";
import { DEFAULT_DYNALITE_PORT, dynaliteAreas, portOf } from "../device-connections";
import { DriverError, type Credentials, type DeviceDriver, type DeviceSnapshot } from "./contract";

export const PHILIPS_DYNALITE = "philips-dynalite";

/** The presets an area is switched with. */
export const AREA_ON = 1;
export const AREA_OFF = 4;

/** How long a sync listens for areas to report their presets. */
const LISTEN_MS = 1_500;
/** How long a command waits after writing, so a refusal can arrive. */
const COMMAND_MS = 200;

interface Gateway {
    readonly host: string;
    readonly port: number;
    readonly areas: number[];
}

function gatewayOf(credentials: Credentials): Gateway {
    const typed = credentials.host?.trim();
    if (!typed) throw new HomeError("That connection is missing the device's address");
    const host = deviceHost(typed);
    if (!host) throw new HomeError("Write the address as 192.168.1.30, with no path");
    const port = credentials.port?.trim() ? portOf(credentials.port) : DEFAULT_DYNALITE_PORT;
    if (port === null) throw new HomeError("Type a port number from 1 to 65535");
    const areas = dynaliteAreas(credentials.areas ?? "");
    if (!areas) throw new HomeError("List the area numbers to bring in");
    return { host, port, areas };
}

/** The preset each area last said it is in, from what was heard. */
async function presets(gateway: Gateway): Promise<Map<number, number>> {
    const heard = await dynetExchange(
        gateway.host,
        gateway.port,
        gateway.areas.map((area) => requestPreset(area)),
        LISTEN_MS
    );
    const found = new Map<number, number>();
    for (const message of heard) {
        if (!gateway.areas.includes(message.area)) continue;
        const preset = presetOf(message);
        if (preset !== null) found.set(message.area, preset);
    }
    return found;
}

function areaId(area: number): string {
    return `area-${area}`;
}

function areaOf(externalId: string): number {
    const found = /^area-(\d{1,3})$/.exec(externalId);
    const area = found ? Number(found[1]) : NaN;
    if (!Number.isInteger(area) || area < 1 || area > 255) {
        throw new DriverError("That device is not a Dynalite area.", "refused");
    }
    return area;
}

export const philipsDynaliteDriver: DeviceDriver = {
    connection: PHILIPS_DYNALITE,

    /** The gateway answers on its port. Areas are not required to answer: an
     *  area with nothing programmed on it is silent, and still switchable. */
    async verify(credentials) {
        const gateway = gatewayOf(credentials);
        await presets(gateway);
    },

    async list(credentials) {
        const gateway = gatewayOf(credentials);
        const known = await presets(gateway);
        return gateway.areas.map((area): DeviceSnapshot => {
            const preset = known.get(area);
            return {
                externalId: areaId(area),
                kind: "light",
                name: `Area ${area}`,
                model: "Dynalite area",
                firmware: null,
                state: preset === undefined ? "unknown" : preset === AREA_OFF ? "off" : "on",
                doorState: "none",
                batteryPercent: null,
                batteryCritical: false,
                online: true
            };
        });
    },

    async act(credentials, device, action) {
        if (action !== "turn-on" && action !== "turn-off") {
            throw new HomeError("A Dynalite area cannot be told to do that");
        }
        const gateway = gatewayOf(credentials);
        const area = areaOf(device.externalId);
        if (!gateway.areas.includes(area)) {
            throw new DriverError("That area is no longer on this connection.", "refused");
        }
        await dynetExchange(
            gateway.host,
            gateway.port,
            [selectPreset(area, action === "turn-on" ? AREA_ON : AREA_OFF)],
            COMMAND_MS
        );
    }
};
