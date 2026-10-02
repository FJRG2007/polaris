/**
 * Philips devices through the Philips account: for a unit Polaris cannot reach
 * on its own network - on another Wi-Fi, in another building - and for the
 * models whose firmware has no local control at all.
 *
 * Connected by pairing: the account's email gets a one-time code from Philips,
 * the code is typed into the dialog, and what is stored is what that sign-in
 * gives (`integrations/philips-cloud.ts`). Philips keeps devices in three
 * places, and one sign-in reaches all three:
 *
 * - the Versuni IoT registry and the HomeID backend: Air+ purifiers, and the
 *   kitchen appliances of the HomeID app (`philips-kitchen.ts`), driven over
 *   the MQTT link the apps keep (`integrations/philips-cloud-link.ts`) with a
 *   token pair renewed before it lapses;
 * - the "air-matters" cloud of the Philips Air+ app (com.philips.ph.homecare): CX fans, heaters and some
 *   purifiers (`philips-air-matters.ts`), signed in with the same account's id
 *   and a value read out of the app (`integrations/air-matters.ts`), and driven
 *   through each device's AWS IoT shadow (`integrations/air-matters-link.ts`).
 *
 * The third is only asked when the first two hold no air device, because it
 * needs the person to upload the app: that is a step of its own in the dialog
 * (`pair.file`), which says why.
 *
 * Unofficial, and said so on the screen: Philips publishes none of this, and a
 * change on their side can stop it working with no notice.
 *
 * What the Versuni purifiers can do is the models table of the community
 * integration, NikGro/philips-air-plus-homeassistant `models.yaml`, with the
 * AC0650's mode values from renaudallard/homeassistant_philips_homeid `fan.py`,
 * which reads them off the decompiled app (`MujiOperationMode`) and disagrees
 * with the first on that one model. Everything they measure and every filter is
 * read through the local driver's own mapping (`philipsMeasures`): the keys are
 * the same over the cloud.
 *
 * Server-only.
 */

import { z } from "zod";
import * as kinds from "../device-kinds";
import { HomeError } from "../home-error";
import * as kitchen from "./philips-kitchen";
import { philipsMeasures } from "./philips-coap";
import * as air from "../integrations/air-matters";
import * as airMatters from "./philips-air-matters";
import * as cloud from "../integrations/philips-cloud";
import { readAppSecret } from "../integrations/apk-secret";
import { dropPairing, holdPairing, readPairing } from "../pairing-vault";
import { closeShadowLinks, shadowLink } from "../integrations/air-matters-link";
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

/** Where the connection's Versuni devices are listed. A connection made before
 *  there was a choice read the IoT registry, and still does; one made where the
 *  Versuni side held nothing reads none of it. */
function sourceOf(credentials: Credentials): cloud.PhilipsSource | null {
    if (credentials.source === "none") return null;
    return credentials.source === "homeid-app" ? "homeid-app" : "iot";
}

/** Whether the connection reaches the Versuni side at all. */
function hasVersuni(credentials: Credentials): boolean {
    return sourceOf(credentials) !== null && Boolean(credentials.accessToken);
}

/** Whether the connection reaches the fan and heater cloud. */
function hasAirMatters(credentials: Credentials): boolean {
    return (
        Boolean(credentials.airMattersUser) &&
        air.AIR_MATTERS_SECRET.test(credentials.airMattersSecret ?? "")
    );
}

function versuniDevicesOf(credentials: Credentials): Promise<cloud.PhilipsCloudDevice[]> {
    const source = sourceOf(credentials);
    if (!source || !credentials.accessToken) return Promise.resolve([]);
    return cloud.listPhilipsSource(sessionOf(credentials).accessToken, source);
}

/** What a device is, by the model it reports. */
function isKitchen(model: string | null): boolean {
    return cloud.philipsApplianceKind(model) === "kitchen";
}

/**
 * The models found that Polaris cannot set the modes of yet: drawn all the same,
 * with their power and what they report, and named to whoever connected them so
 * "not supported yet" is said once rather than discovered row by row. A kitchen
 * appliance is not one of them: it is meant to be watched.
 */
export function unsupportedModels(devices: readonly cloud.PhilipsCloudDevice[]): string[] {
    return [
        ...new Set(
            devices
                .map((device) => device.model)
                .filter(
                    (model): model is string =>
                        model !== null && !isKitchen(model) && !philipsCloudModel(model)
                )
        )
    ];
}

/** The address as Philips knows it: one account, however it was typed. */
export function philipsEmail(fields: Credentials): string {
    const email = (fields.email ?? "").trim().toLowerCase();
    if (!email) throw new HomeError("That connection is missing its sign-in");
    return email;
}

/** Whose link and token caches a connection uses. */
function accountOf(credentials: Credentials): string {
    return credentials.email ?? credentials.userId ?? credentials.airMattersUser ?? "";
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
    const account = accountOf(credentials);
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
    const devices = await versuniDevicesOf(credentials);
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

/** One Versuni device as a row: a purifier, or a kitchen appliance. */
async function versuniSnapshot(
    credentials: Credentials,
    account: string,
    device: cloud.PhilipsCloudDevice
): Promise<DeviceSnapshot> {
    const link = cloudLink(account, device.thing);
    const appliance = isKitchen(device.model);
    const ports = appliance
        ? { status: kitchen.kitchenPorts(device.model).status, slow: [] }
        : undefined;
    try {
        const { state, online } = await overLink(credentials, device.id, (auth) =>
            link.read(auth, ports)
        );
        return appliance
            ? kitchenSnapshot(device, state, online)
            : philipsCloudSnapshot(device, state, online);
    } catch (caught) {
        if (caught instanceof DriverError && caught.kind === "unauthorized") throw caught;
        // One unit that did not answer is drawn as not answering, with what
        // was last heard; the rest of the account is not.
        return versuniUnheard(account, device);
    }
}

/** A Versuni device as last heard, drawn as not answering. */
function versuniUnheard(account: string, device: cloud.PhilipsCloudDevice): DeviceSnapshot {
    const heard = cloudLink(account, device.thing).state;
    return isKitchen(device.model)
        ? kitchenSnapshot(device, heard, false)
        : philipsCloudSnapshot(device, heard, false);
}

/** Every Versuni row of a sync, listed afresh. */
async function versuniSnapshots(
    credentials: Credentials,
    account: string
): Promise<DeviceSnapshot[]> {
    const devices = await versuniDevicesOf(credentials);
    listed.set(account, devices);
    return Promise.all(devices.map((device) => versuniSnapshot(credentials, account, device)));
}

/** A kitchen appliance as a row: what it is doing, never a purifier's controls. */
export function kitchenSnapshot(
    device: cloud.PhilipsCloudDevice,
    heard: {
        properties: Readonly<Record<string, string | number | boolean>>;
        powerOn: boolean | null;
        model: string | null;
    } | null,
    online: boolean
): DeviceSnapshot {
    const model = device.model ?? heard?.model ?? null;
    const properties = heard?.properties ?? {};
    return {
        externalId: device.id,
        kind: "appliance",
        name: device.name || `Philips ${model ?? device.id.slice(-4)}`,
        model,
        firmware: null,
        state: kitchen.kitchenPower(properties, heard?.powerOn ?? null),
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online,
        appliance: kitchen.kitchenAppliance(properties, model)
    };
}

/** Stop a kitchen appliance, the way its own architecture stops. A refused
 *  pause on a Venus does not stop the stop: it is offered outside a cook too,
 *  where a pause has nothing to act on (`async_airfryer_stop`). */
async function stopAppliance(
    credentials: Credentials,
    account: string,
    device: cloud.PhilipsCloudDevice
): Promise<void> {
    const link = cloudLink(account, device.thing);
    const model = device.model ?? link.state.model;
    const steps = kitchen.kitchenStop(model, link.state.properties);
    if (!steps) throw new HomeError("That device cannot be told to do that");
    const ports = kitchen.kitchenPorts(model);
    for (const [index, values] of steps.entries()) {
        const last = index === steps.length - 1;
        try {
            await overLink(credentials, device.id, (auth) => link.write(auth, values, ports));
        } catch (caught) {
            if (!last && caught instanceof DriverError && caught.kind === "refused") continue;
            throw caught;
        }
    }
}

// --- the fan and heater cloud ------------------------------------------------------

/** Each account's token for the fan and heater cloud, good for a week. */
const airTokens = new Map<string, air.AirMattersToken>();
/** Each account's fan and heater cloud devices as last listed. */
const airListed = new Map<string, readonly air.AirMattersDevice[]>();

async function airTokenFor(credentials: Credentials, fresh = false): Promise<string> {
    const account = accountOf(credentials);
    const known = airTokens.get(account);
    if (!fresh && known && !air.airMattersNeedsToken(known)) return known.token;
    const next = await air.airMattersToken(
        credentials.airMattersUser ?? "",
        credentials.airMattersSecret ?? ""
    );
    airTokens.set(account, next);
    return next.token;
}

async function airDevicesOf(credentials: Credentials): Promise<air.AirMattersDevice[]> {
    if (!hasAirMatters(credentials)) return [];
    const devices = await air.listAirMattersDevices(await airTokenFor(credentials));
    airListed.set(accountOf(credentials), devices);
    return devices;
}

/** A fresh single-use address for one device's shadow. */
function airTarget(credentials: Credentials, deviceId: string) {
    return async () => air.airMattersMqttTarget(await airTokenFor(credentials), deviceId);
}

async function airSnapshots(credentials: Credentials): Promise<DeviceSnapshot[]> {
    const account = accountOf(credentials);
    const devices = await airDevicesOf(credentials);
    return Promise.all(
        devices.map(async (device) => {
            const link = shadowLink(account, device.id);
            try {
                return airMatters.airMattersSnapshot(
                    device,
                    await link.read(airTarget(credentials, device.id))
                );
            } catch (caught) {
                if (caught instanceof DriverError && caught.kind === "unauthorized") throw caught;
                return airUnheard(account, device);
            }
        })
    );
}

/** A fan and heater cloud device as last heard, drawn as not answering. */
function airUnheard(account: string, device: air.AirMattersDevice): DeviceSnapshot {
    return airMatters.airMattersSnapshot(device, {
        reported: shadowLink(account, device.id).reported,
        answered: false
    });
}

/**
 * The rows of a sync across both clouds. One cloud that is down keeps what it
 * last listed, drawn as not answering, so the other's devices still update; a
 * refused sign-in on either, both down, or a cloud down before it was ever
 * listed fails the sync as a whole.
 */
function acrossClouds(
    results: readonly PromiseSettledResult<DeviceSnapshot[]>[],
    unheard: readonly (() => DeviceSnapshot[] | undefined)[]
): DeviceSnapshot[] {
    const failed = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    const refused = failed.find(
        (result) => result.reason instanceof DriverError && result.reason.kind === "unauthorized"
    );
    if (refused) throw refused.reason;
    if (failed.length === results.length && failed.length > 0) throw failed[0]!.reason;
    return results.flatMap((result, index) => {
        if (result.status === "fulfilled") return result.value;
        const kept = unheard[index]!();
        if (!kept) throw result.reason;
        return kept;
    });
}

async function actOnAir(
    credentials: Credentials,
    id: string,
    action: kinds.DeviceAction,
    command: kinds.DeviceCommand | undefined
): Promise<void> {
    if (!hasAirMatters(credentials)) {
        throw new DriverError("That device is not on this Philips account.", "refused");
    }
    const account = accountOf(credentials);
    const device =
        airListed.get(account)?.find((entry) => entry.id === id) ??
        (await airDevicesOf(credentials)).find((entry) => entry.id === id);
    if (!device) throw new DriverError("That device is not on this Philips account.", "refused");
    const link = shadowLink(account, device.id);
    const reportedModel = link.reported.D01S05;
    const model = airMatters.airMattersModel({
        model: device.model ?? (typeof reportedModel === "string" ? reportedModel : null),
        type: device.type
    });
    const desired = airMatters.airMattersDesired(model, action, command);
    await link.desire(airTarget(credentials, device.id), desired);
}

// --- pairing ------------------------------------------------------------------------

/** What a sign-in that found no air device carries to the step after it. */
const TICKET = "philips-cloud.ticket";
/** What reading the uploaded app gave. */
const APP_VALUE = "philips-cloud.app";
/** How long either may be used: time to find and upload the app. */
const STEP_MS = 30 * 60 * 1000;

/** What the browser hands back between the steps: the `vToken` the emailed
 *  code is checked against, the code once it is typed, and - past the code -
 *  handles to the sign-in and to the value read from the app, both held on
 *  the server (`pairing-vault.ts`), or a choice to go on without the app. None
 *  of it signs anything in on its own. */
const pairingStateSchema = z.object({
    vToken: z.string().min(1).max(4000).optional(),
    code: z
        .string()
        .transform((value) => value.replace(/\s+/g, ""))
        .pipe(z.string().min(1).max(32))
        .optional(),
    ticket: z.string().min(1).max(100).optional(),
    appSecret: z.string().min(1).max(100).optional(),
    skip: z.literal("1").optional()
});

type PairingState = z.infer<typeof pairingStateSchema>;

/** The Versuni part of a connection, as it is stored. */
function versuniCredentials(email: string, found: cloud.PhilipsFound): Credentials {
    return { ...toCredentials(email, found.session, found.userId), source: found.source };
}

/** The refusal for an account with nothing on it anywhere. */
function nothingFound(summary: string): never {
    console.warn(`places: a Philips account sign-in found nothing to drive (${summary})`);
    throw new DriverError(
        `Polaris found no device on this Philips account. What it saw: ${summary}. Check that the device is in a Philips app under this same email.`,
        "refused"
    );
}

/** The step after the code: the sign-in held on the server, the found Versuni devices and
 *  what was seen, waiting for the app to be uploaded. */
async function afterCode(email: string, state: PairingState & { code: string; vToken: string }) {
    const { gigyaSession, session, uid } = await cloud.signInWithCode(
        email,
        state.code,
        state.vToken
    );
    const found = await cloud.discoverPhilipsDevices(gigyaSession, session);
    const summary = cloud.philipsLookupSummary(found.lookups);
    if (found.found && found.hasAir) {
        const unsupported = unsupportedModels(found.found.devices);
        return {
            done: true as const,
            credentials: versuniCredentials(email, found.found),
            ...(unsupported.length > 0 ? { unsupported } : {})
        };
    }
    // Without the account's id there is no asking the third cloud.
    if (!uid) {
        if (found.found) {
            return { done: true as const, credentials: versuniCredentials(email, found.found) };
        }
        nothingFound(summary);
    }
    const ticket = holdPairing(
        TICKET,
        {
            email,
            uid,
            versuni: found.found ? JSON.stringify(versuniCredentials(email, found.found)) : "",
            summary
        },
        STEP_MS
    );
    return {
        done: false as const,
        next: {
            step: "file" as const,
            state: { ticket },
            summary,
            skippable: found.found !== null
        }
    };
}

/** The last step: the fan and heater cloud, signed in with the value from the
 *  uploaded app - or the Versuni devices alone, where the person went on
 *  without it. */
async function afterFile(email: string, state: PairingState) {
    const ticket = readPairing(TICKET, state.ticket);
    if (ticket.email !== email) {
        throw new HomeError("That step took too long and has run out. Start connecting again.");
    }
    const versuni = ticket.versuni ? (JSON.parse(ticket.versuni) as Credentials) : null;
    if (state.skip) {
        if (!versuni) throw new HomeError("Upload the Philips Air+ app file to go on");
        dropPairing(state.ticket);
        return { done: true as const, credentials: versuni };
    }
    const { secret } = readPairing(APP_VALUE, state.appSecret);
    if (!secret || !air.AIR_MATTERS_SECRET.test(secret)) {
        throw new HomeError("That step took too long and has run out. Start connecting again.");
    }
    const uid = ticket.uid ?? "";
    const token = await air.airMattersToken(uid, secret);
    const devices = await air.listAirMattersDevices(token.token);
    const summary = cloud.philipsLookupSummary([
        { where: "Philips Air", count: devices.length, models: devices.map((d) => d.model ?? "?") }
    ]);
    const seen = ticket.summary ? `${ticket.summary}; ${summary}` : summary;
    // Whatever happens next, these have been used.
    dropPairing(state.ticket);
    dropPairing(state.appSecret);
    if (devices.length === 0) {
        if (versuni) return { done: true as const, credentials: versuni };
        nothingFound(seen);
    }
    airTokens.set(email, token);
    airListed.set(email, devices);
    const unsupported = airMatters.unsupportedAirMatters(devices);
    return {
        done: true as const,
        credentials: {
            ...(versuni ?? { email, source: "none" }),
            airMattersUser: uid,
            airMattersSecret: secret
        },
        ...(unsupported.length > 0 ? { unsupported } : {})
    };
}

export const philipsCloudDriver: DeviceDriver = {
    connection: PHILIPS_CLOUD,

    pair: {
        async start(fields) {
            return { state: { vToken: await cloud.requestPhilipsCode(philipsEmail(fields)) } };
        },

        async poll(fields, state) {
            const parsed = pairingStateSchema.safeParse(state);
            if (!parsed.success) throw new HomeError("That connection is missing its sign-in");
            const email = philipsEmail(fields);
            const { ticket, code, vToken } = parsed.data;
            if (ticket) return afterFile(email, parsed.data);
            if (!vToken) throw new HomeError("That connection is missing its sign-in");
            if (!code) throw new HomeError("Enter the code from the email");
            return afterCode(email, { ...parsed.data, code, vToken });
        },

        /** The app uploaded at the file step: the signing value read out of it,
         *  held here for the poll after - the browser gets a handle, never the
         *  value. The file itself is the caller's to delete, and is never kept. */
        async file(path) {
            const secret = await readAppSecret(path);
            return { appSecret: holdPairing(APP_VALUE, { secret }, STEP_MS) };
        }
    },

    async renew(credentials) {
        if (!hasVersuni(credentials)) return null;
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

    /** Whether the sign-in works: each list the connection reads is what every
     *  read starts with. */
    async verify(credentials) {
        await Promise.all([versuniDevicesOf(credentials), airDevicesOf(credentials)]);
    },

    async list(credentials) {
        const account = accountOf(credentials);
        const sides = await Promise.allSettled([
            versuniSnapshots(credentials, account),
            airSnapshots(credentials)
        ]);
        return acrossClouds(sides, [
            () => listed.get(account)?.map((device) => versuniUnheard(account, device)),
            () => airListed.get(account)?.map((device) => airUnheard(account, device))
        ]);
    },

    async act(credentials, device, action, command) {
        if (device.externalId.startsWith(airMatters.AIR_MATTERS_PREFIX)) {
            return actOnAir(
                credentials,
                device.externalId.slice(airMatters.AIR_MATTERS_PREFIX.length),
                action,
                command
            );
        }
        const account = accountOf(credentials);
        const found = await deviceOf(credentials, account, device.externalId);
        if (!found) {
            throw new DriverError("That device is not on this Philips account.", "refused");
        }
        if (isKitchen(found.model)) {
            if (action !== "stop") throw new HomeError("That device cannot be told to do that");
            return stopAppliance(credentials, account, found);
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
        const account = accountOf(credentials);
        signatures.delete(account);
        listed.delete(account);
        airTokens.delete(account);
        airListed.delete(account);
        closeCloudLinks(account);
        closeShadowLinks(account);
    }
};
