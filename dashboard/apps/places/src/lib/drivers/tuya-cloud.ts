/**
 * Tuya over a developer project in their cloud, translated into the words Places
 * uses.
 *
 * The second way into a Tuya account, for somebody who already has a project in
 * the Tuya IoT console or wants one. The first is `tuya-app`, which signs in with
 * the app the devices are already in. Both hand back the same devices in the
 * same shape, so what that shape means - which category is which kind, and a
 * switch being a data point rather than a device - lives in `tuya-vocabulary`
 * and not here.
 *
 * Server-only.
 */

import { HomeError } from "../home-error";
import { climateCommandOf } from "../device-kinds";
import * as tuya from "../integrations/tuya-api";
import type { Credentials, DeviceDriver } from "./contract";
import { tuyaActionFor, tuyaSnapshots, tuyaSpecsFor, tuyaSpeaking } from "./tuya-vocabulary";

export const TUYA_CLOUD = "tuya-cloud";

function credentialsOf(credentials: Credentials): tuya.TuyaCredentials {
    const accessId = credentials.accessId;
    const accessSecret = credentials.accessSecret;
    if (!accessId || !accessSecret) throw new HomeError("That connection is missing its keys");
    return { accessId, accessSecret, region: credentials.region || "eu" };
}

export const tuyaCloudDriver: DeviceDriver = {
    connection: TUYA_CLOUD,

    /**
     * Whether the keys work, and whether the project can actually see anything.
     *
     * Both, because they are different mistakes with the same symptom. Keys that
     * are refused are a typo or a revoked secret; keys that work and list nothing
     * are a project the app account was never linked to, which is the single most
     * common way this is set up wrong - and the screen has to be able to tell
     * somebody which of the two they have.
     */
    async verify(credentials) {
        await tuyaSpeaking(() => tuya.listTuyaDevices(credentialsOf(credentials)));
    },

    async list(credentials) {
        const keys = credentialsOf(credentials);
        return tuyaSpeaking(async () => {
            const devices = await tuya.listTuyaDevices(keys);
            const specs = await tuyaSpecsFor(devices, (id) => tuya.tuyaSpecification(keys, id));
            return tuyaSnapshots(devices, specs);
        });
    },

    async act(credentials, device, action, command) {
        const keys = credentialsOf(credentials);
        await tuyaSpeaking(async () => {
            const { deviceId, commands } = await tuyaActionFor(
                device,
                action,
                climateCommandOf(command),
                (id) => tuya.tuyaSpecification(keys, id)
            );
            await tuya.tuyaCommand(keys, deviceId, commands);
        });
    }
};
