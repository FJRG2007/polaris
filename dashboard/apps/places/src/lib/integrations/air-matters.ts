/**
 * The third Philips cloud: the "air-matters" backend (`www.api.air.philips.com`)
 * the Philips Air+ app (com.philips.ph.homecare) keeps its fans, heaters and some purifiers on - the CX
 * series stand fans such as the CX3550, and the AC3360 PureProtect Pet. Neither
 * Versuni list (the IoT registry and the HomeID backend) knows these devices.
 *
 * Unofficial. Everything here is from Yooork/HA_Philips_Air_Plus (MIT),
 * `airmatters_auth.py`, `oneid_login.py` and `device_connection.py`, read from
 * its source, not guessed:
 *
 * - The account is the same Philips (Gigya) account the emailed code signs in
 *   to, and the id this backend knows it by is Gigya's `UID` from that same
 *   sign-in (`verify_otp`), prefixed `PHILIPS:`.
 * - `enduser/v2/getToken/` trades that id for a seven-day JWT, but only with a
 *   `Signature` header: an HMAC keyed with a value the app carries inside its
 *   own code (`mSecret`). Philips hands it out nowhere else, which is why the
 *   person connecting uploads the app file and Polaris reads it out of that
 *   (`apk-secret.ts`). It is never part of Polaris.
 * - `enduser/deviceList/` lists the devices; `enduser/v2/mqttInfo/` hands out a
 *   pre-signed AWS IoT WebSocket address per device, good for one connection
 *   within the hour, with the client id it must be used with
 *   (`air-matters-link.ts`).
 *
 * The load balancer answers a transient 503 now and then, which the app's own
 * HTTP client hides by trying again; so does this, a bounded number of times.
 *
 * Nothing here logs: a body carries the JWT, a signed address or a device's id.
 *
 * Server-only.
 */

import { z } from "zod";
import { createHmac } from "node:crypto";
import { DriverError } from "../drivers/contract";

/** The app's id on this backend. Sent in the clear in every request body, the
 *  same class of value as the Gigya API key - an identifier, not a secret. */
const APP_ID = "9fd505fa9c7111e9a1e3061302926720";
const HOST = "https://www.api.air.philips.com/";
const USER_AGENT = "okhttp/4.9.3";

/** One call, first byte to last. */
const TIMEOUT_MS = 20_000;
/** How many times a 503 or an unreadable answer is asked again. */
const ATTEMPTS = 4;
const RETRY_GAP_MS = 1500;

/** What a value read out of the app looks like: `a_` and 32 hex digits. The
 *  prefix is what makes it unambiguous in a file full of hex. */
export const AIR_MATTERS_SECRET = /^a_[0-9a-f]{32}$/;

/** The answer for "not bound to this device", which the backend gives now and
 *  then for a device the list has just shown; it clears when asked again. */
const NOT_BOUND = 16002;

/** A JWT is renewed this long before it lapses. */
const RENEW_EARLY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function unreachable(): DriverError {
    return new DriverError("Philips' cloud could not be reached.", "unreachable");
}

/** The signed sign-in was refused: the account id or the value from the app is
 *  not one this backend takes. */
function refusedSignature(): DriverError {
    return new DriverError(
        "Philips' fan and heater cloud refused the sign-in. Upload the Philips Air+ app again.",
        "unauthorized"
    );
}

/** `URLEncoder.encode(value, "utf-8")` as Java does it: letters, digits and
 *  `-._*` kept, a space as `+`, every other byte as `%XX`. */
export function javaUrlEncode(value: string): string {
    let out = "";
    for (const char of value) {
        if (/^[A-Za-z0-9\-._*]$/.test(char)) out += char;
        else if (char === " ") out += "+";
        else {
            for (const byte of Buffer.from(char, "utf8")) {
                out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
            }
        }
    }
    return out;
}

function hmacHex(data: string, key: string): string {
    return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/** The `Signature` of a getToken: `HMAC(HMAC(bodyParams, secret), username)`,
 *  each as lowercase hex (`_signature`). */
export function airMattersSignature(timestamp: string, username: string, secret: string): string {
    const params = `app_id=${APP_ID}&timestamp=${timestamp}&username=${javaUrlEncode(username)}`;
    return hmacHex(hmacHex(params, secret), username);
}

/** The name the backend knows an account by. */
export function airMattersUsername(userId: string): string {
    return `PHILIPS:${userId}`;
}

const envelopeSchema = z
    .object({
        meta: z.object({ code: z.coerce.number() }).passthrough().optional(),
        data: z.unknown().optional()
    })
    .passthrough();

/**
 * One request, answered: the envelope's code and data. A 503 or a body that is
 * not the envelope is asked again a few times; anything else is the answer.
 */
async function request(
    path: string,
    init: RequestInit,
    retryCodes: readonly number[] = []
): Promise<{ status: number; code: number | null; data: unknown }> {
    let last: { status: number; code: number | null; data: unknown } | null = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(RETRY_GAP_MS);
        let response: Response;
        try {
            response = await fetch(`${HOST}${path}`, {
                ...init,
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
        } catch {
            continue;
        }
        if (response.status === 503) continue;
        let body: unknown;
        try {
            body = JSON.parse(await response.text()) as unknown;
        } catch {
            continue;
        }
        const parsed = envelopeSchema.safeParse(body);
        if (!parsed.success || !parsed.data.meta) continue;
        last = { status: response.status, code: parsed.data.meta.code, data: parsed.data.data };
        if (!retryCodes.includes(parsed.data.meta.code)) return last;
    }
    if (last) return last;
    throw unreachable();
}

/** When a JWT lapses, in milliseconds, from its own `exp`; null where it says
 *  nothing readable. */
export function jwtExpiry(token: string): number | null {
    const part = token.split(".")[1];
    if (!part) return null;
    try {
        const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
            exp?: unknown;
        };
        return typeof claims.exp === "number" && Number.isFinite(claims.exp)
            ? claims.exp * 1000
            : null;
    } catch {
        return null;
    }
}

export interface AirMattersToken {
    readonly token: string;
    readonly expiresAt: number;
}

/** A JWT for the account: the signed `getToken` (`get_jwt`). */
export async function airMattersToken(
    userId: string,
    secret: string,
    now: () => number = Date.now
): Promise<AirMattersToken> {
    const username = airMattersUsername(userId);
    const timestamp = String(Math.floor(now() / 1000));
    const answer = await request("enduser/v2/getToken/", {
        method: "POST",
        headers: {
            "user-agent": USER_AGENT,
            "content-type": "application/json;charset:utf-8",
            signature: airMattersSignature(timestamp, username, secret)
        },
        body: JSON.stringify({ timestamp, username, app_id: APP_ID })
    });
    const token = z.object({ token: z.string().min(1).max(8000) }).safeParse(answer.data);
    if (answer.code !== 0 || !token.success) {
        if (answer.status >= 500) throw unreachable();
        throw refusedSignature();
    }
    return {
        token: token.data.token,
        // A token that does not say when it ends is renewed after a day.
        expiresAt: jwtExpiry(token.data.token) ?? now() + RENEW_EARLY_MS
    };
}

/** Whether a token is close enough to its end to be traded now. */
export function airMattersNeedsToken(token: AirMattersToken | undefined, now = Date.now()) {
    return !token || token.expiresAt - now <= RENEW_EARLY_MS;
}

/** One device on the account, as much of it as Polaris keeps. */
export interface AirMattersDevice {
    /** Its id, which is also its AWS IoT thing. */
    readonly id: string;
    readonly name: string;
    /** The model (`CX3550/01`), where the list gives one. */
    readonly model: string | null;
    /** Its internal type (`Trident`, `LavenderLite`). */
    readonly type: string | null;
}

function text(value: unknown, max = 200): string {
    if (typeof value === "string") return value.trim().slice(0, max);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
}

/** A list entry as a device, or null for one with no id. Field by field, so one
 *  odd field is that field missing rather than the device. */
export function airMattersDevice(raw: unknown): AirMattersDevice | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    const id = text(entry.device_id, 100);
    // Ids are the AWS thing name, so they are only ever this shape; anything
    // else would end up in an MQTT topic.
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return null;
    const info =
        entry.device_info && typeof entry.device_info === "object"
            ? (entry.device_info as Record<string, unknown>)
            : {};
    return {
        id,
        name: text(info.name) || text(info.device_alias),
        model: text(info.modelid, 60) || null,
        type: text(info.type, 60) || null
    };
}

/** The account's devices (`get_device_list`). */
export async function listAirMattersDevices(token: string): Promise<AirMattersDevice[]> {
    const answer = await request("enduser/deviceList/", {
        headers: { "user-agent": USER_AGENT, authorization: `jwt ${token}` }
    });
    if (answer.code !== 0) {
        if (answer.status === 401 || answer.status === 403) throw refusedSignature();
        throw unreachable();
    }
    const list = Array.isArray(answer.data) ? answer.data : [];
    const found: AirMattersDevice[] = [];
    for (const raw of list) {
        const device = airMattersDevice(raw);
        if (device && !found.some((seen) => seen.id === device.id)) found.push(device);
    }
    return found;
}

/** Where one connection to a device's shadow goes, and as whom. */
export interface AirMattersTarget {
    readonly hostname: string;
    /** The path with its signed query, byte for byte as it was handed out. */
    readonly path: string;
    readonly clientId: string;
}

/**
 * An `mqttInfo` entry as somewhere to connect: the broker's name from
 * `endpoint` (or `host`, written as a name or a whole address), and the signed
 * `path`. Only ever an AWS IoT broker: the address came off the network, and
 * nothing else gets a connection from here.
 */
export function airMattersTarget(raw: unknown): AirMattersTarget | null {
    if (!raw || typeof raw !== "object") return null;
    const entry = raw as Record<string, unknown>;
    const path = text(entry.path, 8000);
    const clientId = text(entry.client_id, 200);
    let hostname = text(entry.endpoint, 300) || text(entry.host, 8000);
    if (hostname.includes("://")) {
        try {
            hostname = new URL(hostname).hostname;
        } catch {
            return null;
        }
    }
    hostname = hostname.split("/")[0]!.split(":")[0]!.toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.amazonaws\.com$/.test(hostname)) return null;
    if (!path.startsWith("/") || !clientId) return null;
    return { hostname, path, clientId };
}

/** A fresh, single-use address for one device (`get_mqtt_info`). */
export async function airMattersMqttTarget(
    token: string,
    deviceId: string
): Promise<AirMattersTarget> {
    const answer = await request(
        "enduser/v2/mqttInfo/",
        {
            method: "POST",
            headers: {
                "user-agent": USER_AGENT,
                "content-type": "application/json;charset:utf-8",
                authorization: `jwt ${token}`
            },
            body: JSON.stringify({ device_id: [deviceId] })
        },
        [NOT_BOUND]
    );
    if (answer.code !== 0) {
        if (answer.status === 401 || answer.status === 403) throw refusedSignature();
        throw unreachable();
    }
    const infos =
        answer.data && typeof answer.data === "object"
            ? (answer.data as { mqttinfos?: unknown }).mqttinfos
            : undefined;
    const entry = Array.isArray(infos)
        ? infos.find(
              (info) =>
                  info &&
                  typeof info === "object" &&
                  (info as { device_id?: unknown }).device_id === deviceId
          )
        : undefined;
    const target = airMattersTarget(entry);
    if (!target) throw unreachable();
    return target;
}
