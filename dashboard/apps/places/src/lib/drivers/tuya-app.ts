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
import type { Credentials, DeviceDriver } from "./contract";
import { tuyaCommandFor, tuyaSnapshots, tuyaSpeaking } from "./tuya-vocabulary";

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
        if (!tuya.tuyaNeedsRefresh(session)) return null;
        try {
            return toCredentials(await tuya.refreshTuyaSession(session));
        } catch (caught) {
            if (
                caught instanceof TuyaError &&
                caught.kind === "unreachable" &&
                session.expiresAt > Date.now()
            ) {
                return null;
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
        return tuyaSpeaking(async () => {
            const homes = await tuya.listTuyaHomes(session);
            // One device shared into two homes of the same account is one
            // device, and two rows of it would be two switches for one light.
            const devices = new Map<string, tuya.TuyaSharedDevice>();
            for (const home of homes) {
                for (const device of await tuya.listTuyaHomeDevices(session, home.id)) {
                    if (!devices.has(device.id)) devices.set(device.id, device);
                }
            }
            return tuyaSnapshots([...devices.values()]);
        });
    },

    async act(credentials, device, action) {
        const { deviceId, commands } = tuyaCommandFor(device.externalId, action);
        await tuyaSpeaking(() => tuya.sendTuyaCommands(sessionOf(credentials), deviceId, commands));
    },

    async forget(credentials) {
        await tuyaSpeaking(() => tuya.expireTuyaTerminal(sessionOf(credentials)));
    }
};
