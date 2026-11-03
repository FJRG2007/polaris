/**
 * Tuya through the Smart Life or Tuya Smart app, translated into the words Places
 * uses.
 *
 * Connected by pairing rather than by typing: the User Code from the app starts a
 * sign-in, the app scans the code Polaris shows, and what comes back is a token
 * pair that lasts a couple of hours and is traded for a new one before it lapses.
 * That trade is `renew`, and the account layer stores what it returns - so the
 * credentials this driver is handed are always the latest ones.
 *
 * The devices arrive per home of the app account, in the same shape the cloud
 * project gives them, so what they mean is `tuya-vocabulary` - the same rows, the
 * same ids, the same data point per gang.
 *
 * Server-only.
 */

import { z } from "zod";
import { HomeError } from "../home-error";
import * as tuya from "../integrations/tuya-sharing";
import { TuyaError } from "../integrations/tuya-api";
import * as local from "./tuya-local";
import { DriverError, type Credentials, type DeviceDriver } from "./contract";
import { tuyaActionFor, tuyaSnapshots, tuyaSpecsFor, tuyaSpeaking } from "./tuya-vocabulary";

export const TUYA_APP = "tuya-app";

/** A session, as the fields it is stored under. */
function toCredentials(session: tuya.TuyaSession): Credentials {
    return {
        userCode: session.userCode,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        uid: session.uid,
        expiresAt: String(session.expiresAt),
        terminalId: session.terminalId,
        endpoint: session.endpoint
    };
}

function sessionOf(credentials: Credentials): tuya.TuyaSession {
    const { userCode, accessToken, refreshToken, endpoint } = credentials;
    if (!userCode || !accessToken || !refreshToken || !endpoint) {
        throw new HomeError("That connection is missing its sign-in");
    }
    const expiresAt = Number(credentials.expiresAt);
    return {
        userCode,
        accessToken,
        refreshToken,
        uid: credentials.uid ?? "",
        // A time that cannot be read is treated as already past, so the next use
        // trades the token rather than trusting one of unknown age.
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
        terminalId: credentials.terminalId ?? "",
        endpoint
    };
}

function userCodeOf(fields: Credentials): string {
    const userCode = fields.userCode?.trim();
    if (!userCode) throw new HomeError("That connection is missing its sign-in");
    return userCode;
}

/** What the browser hands back between polls: the token behind the code on the
 *  screen, which it was shown anyway, and nothing else. */
const pairingStateSchema = z.object({ token: z.string().min(1).max(500) });

export const tuyaAppDriver: DeviceDriver = {
    connection: TUYA_APP,

    pair: {
        async start(fields) {
            const token = await tuyaSpeaking(() => tuya.requestTuyaQr(userCodeOf(fields)));
            return { state: { token }, qr: tuya.tuyaQrContent(token) };
        },

        async poll(fields, state) {
            const parsed = pairingStateSchema.safeParse(state);
            if (!parsed.success) throw new HomeError("That connection is missing its sign-in");
            let session: tuya.TuyaSession | null;
            try {
                session = await tuya.tuyaLoginResult(parsed.data.token, userCodeOf(fields));
            } catch (caught) {
                // A poll that did not get through is a poll to make again in a
                // few seconds, not a failed sign-in: the code on the screen is
                // still good, and the person holding the phone is mid-scan.
                if (caught instanceof TuyaError && caught.kind === "unreachable")
                    return { done: false };
                return tuyaSpeaking(() => Promise.reject(caught));
            }
            return session ? { done: true, credentials: toCredentials(session) } : { done: false };
        }
    },

    async renew(credentials) {
        const session = sessionOf(credentials);
        const keys = local.tuyaLocalRenewal(accountOf(credentials), credentials);
        if (!tuya.tuyaNeedsRefresh(session)) return keys;
        try {
            const renewed = toCredentials(await tuya.refreshTuyaSession(session));
            const lanKeys = keys?.[local.LAN_KEYS_FIELD] ?? credentials[local.LAN_KEYS_FIELD];
            return lanKeys ? { ...renewed, [local.LAN_KEYS_FIELD]: lanKeys } : renewed;
        } catch (caught) {
            if (
                caught instanceof TuyaError &&
                caught.kind === "unreachable" &&
                session.expiresAt > Date.now()
            ) {
                return keys;
            }
            return tuyaSpeaking(() => Promise.reject(caught));
        }
    },

    /** Whether the sign-in works: the homes on the account are the first thing
     *  every read asks for, so a sign-in that can list them can list the rest. */
    async verify(credentials) {
        await tuyaSpeaking(() => tuya.listTuyaHomes(sessionOf(credentials)));
    },

    async list(credentials) {
        const session = sessionOf(credentials);
        const account = accountOf(credentials);
        const source = {
            dpMap: async (id: string) => local.dpMapOf(await tuya.tuyaSharedDpMap(session, id))
        };
        let cloud: tuya.TuyaSharedDevice[] | null;
        let offline: unknown = null;
        try {
            cloud = await tuyaSpeaking(() => listAll(session));
        } catch (caught) {
            // With the internet down the devices on this network still answer:
            // the last list, read from each of them.
            if (!(caught instanceof DriverError) || caught.kind !== "unreachable") throw caught;
            cloud = null;
            offline = caught;
        }
        const read = await local.tuyaLocalRead(account, credentials, cloud, source);
        if (!read) throw offline;
        return tuyaSpeaking(async () => {
            const all = read.devices;
            const specs = cloud
                ? await tuyaSpecsFor(all, (id) => tuya.tuyaSharedSpecification(session, id))
                : new Map();
            return tuyaSnapshots(all, specs, read.reach);
        });
    },

    async act(credentials, device, action, command) {
        const session = sessionOf(credentials);
        await tuyaSpeaking(async () => {
            const { deviceId, commands } = await tuyaActionFor(
                device,
                action,
                command,
                (id) => tuya.tuyaSharedSpecification(session, id),
                (id) => local.tuyaLocalStatus(accountOf(credentials), credentials, id)
            );
            if (await local.tuyaLocalAct(accountOf(credentials), credentials, deviceId, commands))
                return;
            await tuya.sendTuyaCommands(session, deviceId, commands);
        });
    },

    async forget(credentials) {
        local.forgetTuyaLocal(accountOf(credentials));
        await tuyaSpeaking(() => tuya.expireTuyaTerminal(sessionOf(credentials)));
    }
};

/** Which account a set of credentials is, for the keys and places kept. */
function accountOf(credentials: Credentials): string {
    return `${TUYA_APP}:${credentials.uid || credentials.userCode || ""}`;
}

/** Every device on the account, once each. */
async function listAll(session: tuya.TuyaSession): Promise<tuya.TuyaSharedDevice[]> {
    const homes = await tuya.listTuyaHomes(session);
    // One device shared into two homes of the same account is one
    // device, and two rows of it would be two switches for one light.
    const devices = new Map<string, tuya.TuyaSharedDevice>();
    for (const home of homes) {
        for (const device of await tuya.listTuyaHomeDevices(session, home.id)) {
            if (!devices.has(device.id)) devices.set(device.id, device);
        }
    }
    return [...devices.values()];
}
