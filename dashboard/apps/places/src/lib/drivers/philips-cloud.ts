/**
 * Philips Air+ purifiers through the Philips account, as devices: for a unit
 * Polaris cannot reach on its own network - on another Wi-Fi, in another
 * building - and for the models whose firmware has no local control at all.
 *
 * Connected by pairing: the account's email gets a one-time code from Philips,
 * the code is typed into the dialog, and what is stored is the token pair it
 * signs in with (`integrations/philips-cloud.ts`), renewed before it lapses.
 * The units are then driven over the same MQTT link the Air+ app keeps
 * (`integrations/philips-cloud-link.ts`).
 *
 * Unofficial, and said so on the screen: Philips publishes none of this, and a
 * change on their side can stop it working with no notice.
 *
 * What the units can do is the models table of the community integration,
 * NikGro/philips-air-plus-homeassistant `models.yaml`, with the AC0650's mode
 * values from renaudallard/homeassistant_philips_homeid `fan.py`, which reads
 * them off the decompiled app (`MujiOperationMode`) and disagrees with the
 * first on that one model. Everything they measure and every filter is read
 * through the local driver's own mapping (`philipsMeasures`): the keys are the
 * same over the cloud.
 *
 * Server-only.
 */

import { z } from "zod";
import * as kinds from "../device-kinds";
import { HomeError } from "../home-error";
import { philipsMeasures } from "./philips-coap";
import * as cloud from "../integrations/philips-cloud";
import { cloudLink, closeCloudLinks, type CloudAuth } from "../integrations/philips-cloud-link";
import { DriverError, type Credentials, type DeviceDriver, type DeviceSnapshot } from "./contract";

export const PHILIPS_CLOUD = "philips-cloud";

/** The key a unit's running mode is read from and written to (`D0310C`), and
 *  its fan level (`D0310D`: 0 while it is not blowing). */
const MODE_KEY = "D0310C";
const FAN_KEY = "D0310D";

/** One model's modes and speeds, as the values `D0310C` takes. */
interface CloudModel {
    readonly modes: Partial<Readonly<Record<kinds.AirMode, number>>>;
    readonly speeds: Partial<Readonly<Record<kinds.AirSpeed, number>>>;
}

/**
 * Every model the sources list, matched by prefix as `model_manager.py` does
 * (`AC1715/11`, `AC1715/70` and `AC1715/71` are one entry). The app's "Fast" on
 * the AC1715 is a step between Medium and Turbo, which Places calls High. The
 * AC3221's values are the source's own unverified mapping, from the local
 * protocol of that family rather than a captured cloud message.
 */
export const PHILIPS_CLOUD_MODELS: Readonly<Record<string, CloudModel>> = {
    AC0650: { modes: { gentle: 1, sleep: 17, turbo: 18 }, speeds: {} },
    AC0651: { modes: { auto: 0, medium: 1, sleep: 17, turbo: 18 }, speeds: {} },
    AC1715: { modes: { auto: 0, medium: 1, high: 2, sleep: 17, turbo: 18 }, speeds: {} },
    AC3221: {
        modes: { auto: 0, medium: 19, sleep: 17, turbo: 18 },
        speeds: { speed_1: 1, speed_2: 2, speed_3: 3, speed_4: 4, speed_5: 5 }
    }
};

export function philipsCloudModel(model: string | null): CloudModel | null {
    const upper = (model ?? "").trim().toUpperCase();
    if (!upper) return null;
    const prefix = Object.keys(PHILIPS_CLOUD_MODELS).find((key) => upper.startsWith(key));
    return prefix ? PHILIPS_CLOUD_MODELS[prefix]! : null;
}

/** A unit's ports as Places' settings. A mode value that names no preset of the
 *  model is shown as no preset rather than guessed at. */
export function philipsCloudAir(
    properties: Readonly<Record<string, string | number | boolean>>,
    model: CloudModel | null
): kinds.AirSettings {
    const modes = Object.entries(model?.modes ?? {}) as [kinds.AirMode, number][];
    const speeds = Object.entries(model?.speeds ?? {}) as [kinds.AirSpeed, number][];
    const running = properties[MODE_KEY];
    return {
        mode: modes.find(([, value]) => value === running)?.[0] ?? null,
        modes: modes.map(([mode]) => mode),
        speed: speeds.find(([, value]) => value === running)?.[0] ?? null,
        speeds: speeds.map(([speed]) => speed),
        humidity: null,
        options: {},
        ...philipsMeasures(properties, null)
    };
}

/** On or off: the shadow's word where it has one, else whether the fan is
 *  turning (`fan.py` in the Air+ integration), else not known. */
function powerOf(powerOn: boolean | null, properties: Readonly<Record<string, unknown>>) {
    if (powerOn !== null) return powerOn ? "on" : "off";
    const fan = properties[FAN_KEY];
    return typeof fan === "number" ? (fan !== 0 ? "on" : "off") : "unknown";
}

export function philipsCloudSnapshot(
    device: cloud.PhilipsCloudDevice,
    heard: {
        properties: Readonly<Record<string, string | number | boolean>>;
        powerOn: boolean | null;
        model: string | null;
    } | null,
    online: boolean
): DeviceSnapshot {
    const modelName = heard?.model ?? device.model;
    const name = device.name || `Philips ${modelName ?? device.id.slice(-4)}`;
    if (!heard || Object.keys(heard.properties).length === 0) {
        return {
            externalId: device.id,
            kind: "air",
            name,
            model: modelName,
            firmware: null,
            state: heard ? powerOf(heard.powerOn, {}) : "unknown",
            doorState: "none",
            batteryPercent: null,
            batteryCritical: false,
            online
        };
    }
    const air = philipsCloudAir(heard.properties, philipsCloudModel(modelName));
    const headline = kinds.airHeadline(air);
    return {
        externalId: device.id,
        kind: "air",
        name,
        model: modelName,
        firmware: null,
        state: powerOf(heard.powerOn, heard.properties),
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online,
        value: headline?.value ?? null,
        unit: headline ? kinds.MEASURE_UNITS[headline.measure] || null : null,
        air
    };
}

/** What to write on the `Control` port for one setting. */
export function philipsCloudValues(
    model: CloudModel | null,
    command: kinds.AirCommand
): Record<string, number> {
    if (command.action === "set-mode") {
        const value = model?.modes[command.mode];
        if (value === undefined) throw new HomeError("That mode is not one this device has");
        return { [MODE_KEY]: value };
    }
    if (command.action === "set-fan") {
        const value = model?.speeds[command.speed];
        if (value === undefined) throw new HomeError("That fan speed is not one this device has");
        return { [MODE_KEY]: value };
    }
    throw new HomeError("That setting is not one this device has");
}

// --- the stored sign-in ---------------------------------------------------------

const clientSchema = z.enum(["airplus", "homeid"]);

function sessionOf(credentials: Credentials): cloud.PhilipsSession {
    const { accessToken } = credentials;
    if (!accessToken) throw new HomeError("That connection is missing its sign-in");
    const expiresAt = Number(credentials.expiresAt);
    const client = clientSchema.safeParse(credentials.client);
    return {
        accessToken,
        refreshToken: credentials.refreshToken ?? "",
        // A time that cannot be read is treated as already past, so the next use
        // renews rather than trusting a token of unknown age.
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
        client: client.success ? client.data : "airplus"
    };
}

function toCredentials(email: string, session: cloud.PhilipsSession, userId: string): Credentials {
    return {
        email,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresAt: String(session.expiresAt),
        client: session.client,
        userId
    };
}

/** Where the connection's devices are listed. A connection made before there
 *  was a choice read the IoT registry, and still does. */
function sourceOf(credentials: Credentials): cloud.PhilipsSource {
    return credentials.source === "homeid-app" ? "homeid-app" : "iot";
}

function devicesOf(credentials: Credentials): Promise<cloud.PhilipsCloudDevice[]> {
    return cloud.listPhilipsSource(sessionOf(credentials).accessToken, sourceOf(credentials));
}

/**
 * The models found that Polaris cannot set the modes of yet: drawn all the same,
 * with their power and what they report, and named to whoever connected them so
 * "not supported yet" is said once rather than discovered row by row.
 */
export function unsupportedModels(devices: readonly cloud.PhilipsCloudDevice[]): string[] {
    return [
        ...new Set(
            devices
                .map((device) => device.model)
                .filter((model): model is string => model !== null && !philipsCloudModel(model))
        )
    ];
}

/** The address as Philips knows it: one account, however it was typed. */
export function philipsEmail(fields: Credentials): string {
    const email = (fields.email ?? "").trim().toLowerCase();
    if (!email) throw new HomeError("That connection is missing its sign-in");
    return email;
}

/** The signature for each access token, so a sync does not ask for a new one
 *  every minute. Only the latest per account is kept. */
const signatures = new Map<string, { token: string; signature: string }>();

async function authFor(
    credentials: Credentials,
    deviceId: string,
    fresh = false
): Promise<CloudAuth> {
    const session = sessionOf(credentials);
    const userId = credentials.userId || (await cloud.philipsUserId(session.accessToken));
    const account = credentials.email ?? userId;
    let known = signatures.get(account);
    if (fresh || !known || known.token !== session.accessToken) {
        known = {
            token: session.accessToken,
            signature: await cloud.philipsSignature(session.accessToken)
        };
        signatures.set(account, known);
    }
    return {
        accessToken: session.accessToken,
        signature: known.signature,
        clientId: cloud.philipsClientId(userId, deviceId)
    };
}

/** Each account's devices as last listed, so a command does not list them again. */
const listed = new Map<string, readonly cloud.PhilipsCloudDevice[]>();

/** The device on the account, from the last listing or a fresh one when it is
 *  not in it. */
async function deviceOf(
    credentials: Credentials,
    account: string,
    id: string
): Promise<cloud.PhilipsCloudDevice | undefined> {
    const known = listed.get(account)?.find((entry) => entry.id === id);
    if (known) return known;
    const devices = await devicesOf(credentials);
    listed.set(account, devices);
    return devices.find((entry) => entry.id === id);
}

/** Run something over a link; a broker that refused the credentials is given
 *  one fresh signature before the refusal is believed. */
async function overLink<T>(
    credentials: Credentials,
    deviceId: string,
    run: (auth: CloudAuth) => Promise<T>
): Promise<T> {
    try {
        return await run(await authFor(credentials, deviceId));
    } catch (caught) {
        if (!(caught instanceof DriverError) || caught.kind !== "unauthorized") throw caught;
        return run(await authFor(credentials, deviceId, true));
    }
}

/** What the browser hands back between the two steps: the `vToken` the emailed
 *  code is checked against, and the code once it is typed. The token signs
 *  nothing in without the code, and the code only reaches the inbox. */
const pairingStateSchema = z.object({
    vToken: z.string().min(1).max(4000),
    code: z
        .string()
        .transform((value) => value.replace(/\s+/g, ""))
        .pipe(z.string().min(1).max(32))
        .optional()
});

export const philipsCloudDriver: DeviceDriver = {
    connection: PHILIPS_CLOUD,

    pair: {
        async start(fields) {
            return { state: { vToken: await cloud.requestPhilipsCode(philipsEmail(fields)) } };
        },

        async poll(fields, state) {
            const parsed = pairingStateSchema.safeParse(state);
            if (!parsed.success) throw new HomeError("That connection is missing its sign-in");
            if (!parsed.data.code) throw new HomeError("Enter the code from the email");
            const email = philipsEmail(fields);
            const { gigyaSession, session } = await cloud.signInWithCode(
                email,
                parsed.data.code,
                parsed.data.vToken
            );
            const found = await cloud.discoverPhilipsDevices(gigyaSession, session);
            const userId = await cloud.philipsUserId(found.session.accessToken);
            const unsupported = unsupportedModels(found.devices);
            return {
                done: true,
                credentials: {
                    ...toCredentials(email, found.session, userId),
                    source: found.source
                },
                ...(unsupported.length > 0 ? { unsupported } : {})
            };
        }
    },

    async renew(credentials) {
        const session = sessionOf(credentials);
        if (!cloud.philipsNeedsRefresh(session)) return null;
        try {
            const next = await cloud.refreshPhilipsSession(session);
            return {
                ...credentials,
                ...toCredentials(credentials.email ?? "", next, credentials.userId ?? "")
            };
        } catch (caught) {
            // An outage while the token still has a while to run is not a reason
            // to stop: the next use tries again.
            if (
                caught instanceof DriverError &&
                caught.kind === "unreachable" &&
                session.expiresAt > Date.now()
            ) {
                return null;
            }
            throw caught;
        }
    },

    /** Whether the sign-in works: the account's device list is what every read
     *  starts with. */
    async verify(credentials) {
        await devicesOf(credentials);
    },

    async list(credentials) {
        const devices = await devicesOf(credentials);
        const account = credentials.email ?? credentials.userId ?? "";
        listed.set(account, devices);
        return Promise.all(
            devices.map(async (device) => {
                try {
                    const { state, online } = await overLink(credentials, device.id, (auth) =>
                        cloudLink(account, device.thing).read(auth)
                    );
                    return philipsCloudSnapshot(device, state, online);
                } catch (caught) {
                    if (caught instanceof DriverError && caught.kind === "unauthorized")
                        throw caught;
                    // One unit that did not answer is drawn as not answering,
                    // with what was last heard; the rest of the account is not.
                    const link = cloudLink(account, device.thing);
                    return philipsCloudSnapshot(device, link.state, false);
                }
            })
        );
    },

    async act(credentials, device, action, command) {
        const account = credentials.email ?? credentials.userId ?? "";
        const found = await deviceOf(credentials, account, device.externalId);
        if (!found) {
            throw new DriverError("That device is not on this Philips account.", "refused");
        }
        const link = cloudLink(account, found.thing);
        if (action === "turn-on" || action === "turn-off") {
            await overLink(credentials, found.id, (auth) => link.power(auth, action === "turn-on"));
            return;
        }
        const setting = kinds.airCommandOf(command);
        if (!setting || setting.action !== action) throw new HomeError("Say what to set it to");
        const values = philipsCloudValues(
            philipsCloudModel(link.state.model ?? found.model),
            setting
        );
        await overLink(credentials, found.id, (auth) => link.write(auth, values));
    },

    async forget(credentials) {
        const account = credentials.email ?? credentials.userId ?? "";
        signatures.delete(account);
        listed.delete(account);
        closeCloudLinks(account);
    }
};
