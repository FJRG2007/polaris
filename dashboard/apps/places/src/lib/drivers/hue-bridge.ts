/**
 * A Philips Hue bridge, as devices.
 *
 * One connection is one bridge, and it brings every light and smart plug paired
 * to it. What is a row is a light service, not a device: that is what is switched,
 * and a fixture with two independently switched halves has two of them.
 *
 * Pairing happens in `verify`, because it is the only moment a person is standing
 * at the bridge: the button is pressed, Connect is selected, and what comes back
 * - the key, and the bridge's id that every later call checks the certificate
 * against - is what is stored in place of the address that was typed. Kept
 * whole inside this driver so a pairing screen can later drive the same call.
 *
 * Server-only.
 */

import { HomeError } from "../home-error";
import * as hue from "../integrations/hue-api";
import type { DeviceKind } from "../device-kinds";
import { deviceHost } from "../integrations/lan-http";
import { subnetTargets } from "../integrations/lan-unit";
import { forbiddenAddress } from "../integrations/lan-address";
import {
    DriverError,
    type Credentials,
    type DeviceDriver,
    type DeviceSnapshot,
    type DiscoveredUnit
} from "./contract";

export const HUE_BRIDGE = "hue-bridge";

function hostOf(credentials: Credentials): string {
    const typed = credentials.host?.trim();
    if (!typed) throw new HomeError("That connection is missing the device's address");
    const host = deviceHost(typed);
    if (!host) throw new HomeError("Write the address as 192.168.1.30, with no path");
    return host;
}

function bridgeOf(credentials: Credentials): hue.HueBridge {
    const appKey = credentials.appKey?.trim();
    const bridgeId = credentials.bridgeId?.trim();
    // Both are written by pairing. A connection without them was never paired,
    // and the only thing that fixes that is pairing it.
    if (!appKey || !bridgeId) {
        throw new DriverError(
            "The Hue bridge no longer accepts Polaris. Connect it again, pressing the button on the bridge first.",
            "unauthorized"
        );
    }
    return { host: hostOf(credentials), appKey, bridgeId };
}

/** A plug says so in its archetype, on the light or on the device. */
function kindOf(light: hue.HueLight, device: hue.HueDevice | undefined): DeviceKind {
    return light.metadata.archetype === "plug" || device?.product_data.product_archetype === "plug"
        ? "outlet"
        : "light";
}

/** How long one address of the sweep is given to answer as a bridge. */
const SWEEP_TIMEOUT_MS = 1_500;
/** How many addresses are asked at once. */
const SWEEP_PARALLEL = 32;

/**
 * The bridges on the network, the way Home Assistant's hue integration finds
 * them (home-assistant.io/integrations/hue, aiohue's discovery): Signify's
 * discovery service first, then - where it lists none, or the server cannot
 * reach it - every address of this server's /24, since mDNS from a container's
 * bridge network never reaches the LAN. Every candidate has to prove it is a
 * bridge the way pairing does, with Hue's certificate, so a name the service
 * hands back is never trusted on its own.
 */
export async function findBridges(): Promise<DiscoveredUnit[]> {
    const listed = (await hue.nupnpAddresses()).filter((address) => !forbiddenAddress(address));
    const candidates =
        listed.length > 0
            ? listed
            : (await subnetTargets()).filter((address) => !forbiddenAddress(address));
    const found: DiscoveredUnit[] = [];
    const seen = new Set<string>();
    for (let at = 0; at < candidates.length; at += SWEEP_PARALLEL) {
        const batch = candidates.slice(at, at + SWEEP_PARALLEL);
        const answers = await Promise.allSettled(
            batch.map((address) => hue.bridgeAt(address, SWEEP_TIMEOUT_MS))
        );
        answers.forEach((answer, index) => {
            if (answer.status !== "fulfilled") return;
            if (seen.has(answer.value.bridgeId)) return;
            seen.add(answer.value.bridgeId);
            found.push({
                name: answer.value.name.slice(0, 120),
                model: answer.value.model.slice(0, 120),
                mac: answer.value.mac,
                address: batch[index]!
            });
        });
    }
    return found;
}

export const hueBridgeDriver: DeviceDriver = {
    connection: HUE_BRIDGE,

    discover: findBridges,

    /**
     * Find the bridge, pair with it unless a key was given, and prove the key
     * works. What is returned is what the connection keeps.
     */
    async verify(credentials) {
        const host = hostOf(credentials);
        const bridgeId = await hue.identifyBridge(host);
        const appKey = credentials.appKey?.trim() || (await hue.pairBridge(host, bridgeId));
        const bridge = { host, bridgeId, appKey };
        await hue.readBridge(bridge);
        return { host: credentials.host!.trim(), appKey, bridgeId };
    },

    async list(credentials) {
        const bridge = bridgeOf(credentials);
        const { lights, devices, connectivity } = await hue.readBridge(bridge);
        const byId = new Map(devices.map((device) => [device.id, device]));
        const reachable = new Map(
            connectivity.map((entry) => [entry.owner.rid, entry.status === "connected"])
        );
        const perDevice = new Map<string, number>();
        for (const light of lights)
            perDevice.set(light.owner.rid, (perDevice.get(light.owner.rid) ?? 0) + 1);

        return lights.map((light): DeviceSnapshot => {
            const device = byId.get(light.owner.rid);
            const online = reachable.get(light.owner.rid) ?? true;
            const shared = (perDevice.get(light.owner.rid) ?? 0) > 1;
            // One light on a device reads as the device's name, which is the one
            // somebody gave it in the Hue app. Several read as their own.
            const name =
                (shared ? light.metadata.name : device?.metadata.name) ||
                light.metadata.name ||
                device?.metadata.name ||
                "Hue light";
            return {
                externalId: light.id,
                kind: kindOf(light, device),
                name: name.trim(),
                model:
                    device?.product_data.product_name?.trim() ||
                    device?.product_data.model_id?.trim() ||
                    null,
                firmware: device?.product_data.software_version?.trim() || null,
                state: !online || !light.on ? "unknown" : light.on.on ? "on" : "off",
                doorState: "none",
                batteryPercent: null,
                batteryCritical: false,
                online
            };
        });
    },

    async act(credentials, device, action) {
        if (action !== "turn-on" && action !== "turn-off") {
            throw new HomeError("A Hue light cannot be told to do that");
        }
        await hue.switchLight(bridgeOf(credentials), device.externalId, action === "turn-on");
    }
};
