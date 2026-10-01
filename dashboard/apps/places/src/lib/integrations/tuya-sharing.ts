/**
 * Tuya through the app the devices are already in: sign in by scanning a code.
 *
 * The other way into a Tuya account (`tuya-api`) asks for a developer project in
 * their IoT console, linked to the app account by hand - which is a morning's
 * work and the most common reason nothing shows up. This one asks for the User
 * Code the Smart Life or Tuya Smart app shows under Me, the settings gear,
 * Account and Security; shows a code to scan with that app; and is signed in the
 * moment somebody confirms it there.
 *
 * It is the protocol of Tuya's own device-sharing SDK (`tuya-device-sharing-sdk`,
 * `tuya_sharing/user.py`, `customerapi.py`, `home.py`, `device.py`), which is what
 * Home Assistant's Tuya integration is built on - and it is signed in under Home
 * Assistant's client id and schema (`homeassistant/components/tuya/const.py`),
 * which is the one Tuya's app accepts for this kind of sign-in. Every detail
 * below is theirs rather than inferred:
 *
 * - The sign-in is two unsigned calls to one fixed host: one asks for a QR token
 *   for a user code, the other asks whether that token has been accepted, and
 *   answers with the tokens, a terminal id and the endpoint every later call
 *   goes to.
 * - Every later call is encrypted as well as signed. A request id is drawn per
 *   call; the MD5 of it joined to the refresh token is the signing key; the first
 *   16 hex characters of an HMAC of that key under the request id are an AES-GCM
 *   key; the query and the body are each sent as `encdata`, the base64 of a
 *   12-character nonce followed by the base64 of the ciphertext; the answer's
 *   `result` comes back sealed the same way.
 * - The signature is an HMAC-SHA256, under the signing key, of the headers that
 *   carry a value as `name=value` joined with `||`, then the encrypted query,
 *   then the encrypted body.
 * - A token lasts `expire_time` seconds from the `t` of the answer that carried
 *   it, and is traded for a new pair a minute before that.
 *
 * `test/home/tuya-sharing.test.ts` holds the key, the ciphertext and the
 * signature to values computed by the SDK's own functions.
 *
 * Server-only. The tokens never leave it.
 */

import { z } from "zod";
import { TuyaError } from "./tuya-api";
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    randomInt,
    randomUUID
} from "node:crypto";

/** Home Assistant's client id and schema for this sign-in, as their integration
 *  declares them. The QR code the app scans is only accepted for a client it
 *  knows, and this is the one it knows for a home server signing in. */
export const TUYA_SHARING_CLIENT_ID = "HA_3y9q4ak7g4ephrvke";
export const TUYA_SHARING_SCHEMA = "haauthorize";

/** Where the sign-in happens, before an account's own endpoint is known. */
const LOGIN_HOST = "https://apigw.iotbing.com";

/** What the app is shown, with the token in it. The app reads this prefix. */
export function tuyaQrContent(token: string): string {
    return `tuyaSmart--qrLogin?token=${token}`;
}

const TIMEOUT_MS = 15_000;

/** A token is traded this long before it lapses, as the SDK does: one that
 *  expires in flight fails the call it was used for. */
const REFRESH_MARGIN_MS = 60_000;

// ---------------------------------------------------------------------------
// The sealing and the signature
// ---------------------------------------------------------------------------

/** The characters the SDK draws a nonce from. */
const NONCE_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";

/** The signing key for one request: MD5 of its id joined to the refresh token. */
export function hashKeyFor(requestId: string, refreshToken: string): string {
    return createHash("md5").update(`${requestId}${refreshToken}`, "utf8").digest("hex");
}

/**
 * The AES key for one request: an HMAC of the signing key under the request id,
 * as hex, cut to 16 characters - which are used as the key's 16 bytes.
 *
 * The SDK mixes a session id into this when there is one. Nothing it sends ever
 * has one (it is always empty), so that branch has nothing to do here.
 */
export function secretFor(requestId: string, hashKey: string): string {
    return createHmac("sha256", requestId).update(hashKey, "utf8").digest("hex").slice(0, 16);
}

function randomNonce(): string {
    let nonce = "";
    for (let index = 0; index < 12; index += 1) {
        nonce += NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)];
    }
    return nonce;
}

/** Seal a string: the base64 of the nonce, then the base64 of the ciphertext with
 *  its tag. A 12-byte nonce encodes to 16 characters with no padding, which is
 *  why the two halves can simply be joined and still read as one base64 string
 *  on the way back. */
export function sealTuya(plain: string, secret: string, nonce: string = randomNonce()): string {
    const cipher = createCipheriv(
        "aes-128-gcm",
        Buffer.from(secret, "utf8"),
        Buffer.from(nonce, "utf8")
    );
    const sealed = Buffer.concat([
        cipher.update(plain, "utf8"),
        cipher.final(),
        cipher.getAuthTag()
    ]);
    return Buffer.from(nonce, "utf8").toString("base64") + sealed.toString("base64");
}

export function openTuya(data: string, secret: string): string {
    const raw = Buffer.from(data, "base64");
    if (raw.length < 12 + 16)
        throw new TuyaError("Tuya answered with something unexpected.", "refused");
    const decipher = createDecipheriv(
        "aes-128-gcm",
        Buffer.from(secret, "utf8"),
        raw.subarray(0, 12)
    );
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([
        decipher.update(raw.subarray(12, raw.length - 16)),
        decipher.final()
    ]).toString("utf8");
}

/** The headers that are signed, in the order they are signed in. */
const SIGNED_HEADERS = ["X-appKey", "X-requestId", "X-sid", "X-time", "X-token"] as const;

export function signTuya(
    hashKey: string,
    headers: Readonly<Record<string, string>>,
    query: string,
    body: string
): string {
    const signed = SIGNED_HEADERS.filter((name) => (headers[name] ?? "") !== "")
        .map((name) => `${name}=${headers[name]}`)
        .join("||");
    return createHmac("sha256", hashKey).update(`${signed}${query}${body}`, "utf8").digest("hex");
}

/**
 * JSON as the SDK writes it: no spaces, and everything outside ASCII escaped.
 *
 * What is sealed is these exact bytes, so a name with an accent in it has to be
 * written the way the other end expects it rather than the way JavaScript would.
 */
export function tuyaJson(value: unknown): string {
    return JSON.stringify(value).replace(
        /[\u0080-￿]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
}

// ---------------------------------------------------------------------------
// A session
// ---------------------------------------------------------------------------

/** Everything a signed-in account is used with. What is stored, encrypted, on
 *  the account row. */
export interface TuyaSession {
    readonly userCode: string;
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly uid: string;
    /** When the access token lapses, in milliseconds. */
    readonly expiresAt: number;
    readonly terminalId: string;
    /** Where every call for this account goes. Tuya's own answer, checked. */
    readonly endpoint: string;
}

/**
 * The endpoint Tuya names for an account, or a refusal.
 *
 * It arrives in their answer and every later call - with the account's tokens -
 * is sent to it, so it is held to being an https address with a host name before
 * it is believed: never plain http, never an address on somebody's network typed
 * as an IP, never a URL with credentials in it.
 */
export function tuyaEndpoint(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new TuyaError("Tuya answered with something unexpected.", "refused");
    }
    const ipLiteral =
        /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":") || url.hostname.startsWith("[");
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        ipLiteral ||
        url.search ||
        url.hash
    ) {
        throw new TuyaError("Tuya answered with something unexpected.", "refused");
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** Whether a session's token is close enough to its end to be traded now. */
export function tuyaNeedsRefresh(session: TuyaSession, now: number = Date.now()): boolean {
    return session.expiresAt - REFRESH_MARGIN_MS <= now;
}

async function send(url: string, init: RequestInit): Promise<Response> {
    try {
        return await fetch(url, {
            ...init,
            cache: "no-store",
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch {
        throw new TuyaError("Tuya could not be reached. Try again in a moment.", "unreachable");
    }
}

async function json(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => "");
    try {
        return text ? (JSON.parse(text) as unknown) : null;
    } catch {
        return null;
    }
}

const envelopeSchema = z.object({
    success: z.boolean().optional(),
    code: z.union([z.number(), z.string()]).optional(),
    msg: z.string().optional(),
    t: z.number().optional(),
    result: z.unknown().optional()
});

// ---------------------------------------------------------------------------
// The sign-in
// ---------------------------------------------------------------------------

const qrSchema = z.object({ qrcode: z.string().min(1).max(500) });

/**
 * Ask for a code to show, for the account a user code belongs to.
 *
 * Refused when the code is not one Tuya knows, and their own words say why - a
 * user code typed from the wrong screen is the likeliest mistake.
 */
export async function requestTuyaQr(userCode: string): Promise<string> {
    const query = new URLSearchParams({
        clientid: TUYA_SHARING_CLIENT_ID,
        usercode: userCode,
        schema: TUYA_SHARING_SCHEMA
    });
    const response = await send(`${LOGIN_HOST}/v1.0/m/life/home-assistant/qrcode/tokens?${query}`, {
        method: "POST"
    });
    const envelope = envelopeSchema.safeParse(await json(response));
    if (!envelope.success)
        throw new TuyaError("Tuya answered with something unexpected.", "refused");
    if (envelope.data.success !== true) {
        const detail = envelope.data.msg?.trim();
        throw new TuyaError(
            detail
                ? `Tuya refused the User Code: ${detail}.`
                : "Tuya refused the User Code. Check it in the app under Me, Settings, Account and Security.",
            "refused"
        );
    }
    const result = qrSchema.safeParse(envelope.data.result);
    if (!result.success) throw new TuyaError("Tuya answered with something unexpected.", "refused");
    return result.data.qrcode;
}

const loginSchema = z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    uid: z.string().default(""),
    /** Seconds from `t`. */
    expire_time: z.number(),
    terminal_id: z.string().min(1),
    endpoint: z.string().min(1)
});

/**
 * Whether the code has been scanned and confirmed yet: the session once it has,
 * and null until then.
 *
 * Not yet is the SDK's "not successful" and nothing more specific - it does not
 * tell a code nobody has scanned from one that has lapsed - so both read as
 * waiting here, and how long to wait is the screen's to decide.
 */
export async function tuyaLoginResult(
    qrToken: string,
    userCode: string
): Promise<TuyaSession | null> {
    const query = new URLSearchParams({ clientid: TUYA_SHARING_CLIENT_ID, usercode: userCode });
    const response = await send(
        `${LOGIN_HOST}/v1.0/m/life/home-assistant/qrcode/tokens/${encodeURIComponent(qrToken)}?${query}`,
        { method: "GET" }
    );
    const envelope = envelopeSchema.safeParse(await json(response));
    if (!envelope.success || envelope.data.success !== true) return null;
    const result = loginSchema.safeParse(envelope.data.result);
    if (!result.success) throw new TuyaError("Tuya answered with something unexpected.", "refused");
    const t = envelope.data.t ?? Date.now();
    return {
        userCode,
        accessToken: result.data.access_token,
        refreshToken: result.data.refresh_token,
        uid: result.data.uid,
        expiresAt: t + result.data.expire_time * 1000,
        terminalId: result.data.terminal_id,
        endpoint: tuyaEndpoint(result.data.endpoint)
    };
}

// ---------------------------------------------------------------------------
// Signed calls
// ---------------------------------------------------------------------------

/** One sealed, signed call, and its answer opened. */
async function call(
    session: TuyaSession,
    method: "GET" | "POST",
    path: string,
    options: {
        params?: Record<string, unknown>;
        body?: Record<string, unknown>;
        /** Set on the token trade: a refusal of that one is the account being
         *  signed out, not one request being turned down. */
        signedOutIfRefused?: boolean;
    } = {}
): Promise<{ result: unknown; t: number | undefined }> {
    const requestId = randomUUID();
    const hashKey = hashKeyFor(requestId, session.refreshToken);
    const secret = secretFor(requestId, hashKey);

    const query =
        options.params && Object.keys(options.params).length > 0
            ? sealTuya(tuyaJson(options.params), secret)
            : "";
    const body =
        options.body && Object.keys(options.body).length > 0
            ? sealTuya(tuyaJson(options.body), secret)
            : "";

    const headers: Record<string, string> = {
        "X-appKey": TUYA_SHARING_CLIENT_ID,
        "X-requestId": requestId,
        "X-sid": "",
        "X-time": String(Date.now())
    };
    if (session.accessToken) headers["X-token"] = session.accessToken;
    headers["X-sign"] = signTuya(hashKey, headers, query, body);

    const url = `${tuyaEndpoint(session.endpoint)}${path}${query ? `?encdata=${encodeURIComponent(query)}` : ""}`;
    const response = await send(url, {
        method,
        headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
        body: body ? JSON.stringify({ encdata: body }) : undefined
    });
    if (!response.ok)
        throw new TuyaError("Tuya could not be reached. Try again in a moment.", "unreachable");

    const envelope = envelopeSchema.safeParse(await json(response));
    if (!envelope.success)
        throw new TuyaError("Tuya answered with something unexpected.", "refused");
    if (envelope.data.success !== true) {
        if (options.signedOutIfRefused) {
            throw new TuyaError(
                "Tuya no longer accepts this sign-in. Scan a new code from the app.",
                "unauthorized"
            );
        }
        // Their own sentence where there is one, as the cloud client does: a
        // sentence Polaris invented in its place would be a guess.
        const detail = envelope.data.msg?.trim();
        throw new TuyaError(
            detail ? `Tuya refused the request: ${detail}.` : "Tuya refused the request.",
            "refused"
        );
    }

    const sealed = envelope.data.result;
    if (typeof sealed !== "string") return { result: sealed, t: envelope.data.t };
    let opened: string;
    try {
        opened = openTuya(sealed, secret);
    } catch {
        throw new TuyaError("Tuya answered with something unexpected.", "refused");
    }
    try {
        return { result: JSON.parse(opened) as unknown, t: envelope.data.t };
    } catch {
        return { result: opened, t: envelope.data.t };
    }
}

const refreshSchema = z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    uid: z.string().default(""),
    expireTime: z.number()
});

/**
 * Trades in flight, by the refresh token they were started with, and kept for a
 * while after they finish.
 *
 * Two reads of the same account at once would otherwise both trade the same
 * refresh token, and the second may be refused for a token the first has just
 * used up - which would mark a perfectly good account as signed out. The answer
 * is also kept a few minutes after, for the read that loaded the old token from
 * the row a moment before the new one was written over it.
 */
const renewals = new Map<string, { readonly promise: Promise<TuyaSession>; readonly at: number }>();
const RENEWAL_MEMORY_MS = 5 * 60_000;

export function refreshTuyaSession(session: TuyaSession): Promise<TuyaSession> {
    const now = Date.now();
    for (const [token, entry] of renewals) {
        if (now - entry.at > RENEWAL_MEMORY_MS) renewals.delete(token);
    }
    const held = renewals.get(session.refreshToken);
    if (held) return held.promise;

    const promise = (async () => {
        // A refusal of the refresh token is the account being signed out -
        // revoked in the app, or unused for too long. Anything else (the
        // network, their servers) leaves the sign-in exactly as it was.
        const answer = await call(
            session,
            "GET",
            `/v1.0/m/token/${encodeURIComponent(session.refreshToken)}`,
            {
                signedOutIfRefused: true
            }
        );
        const parsed = refreshSchema.safeParse(answer.result);
        if (!parsed.success)
            throw new TuyaError("Tuya answered with something unexpected.", "refused");
        return {
            ...session,
            accessToken: parsed.data.accessToken,
            refreshToken: parsed.data.refreshToken,
            uid: parsed.data.uid || session.uid,
            expiresAt: (answer.t ?? Date.now()) + parsed.data.expireTime * 1000
        };
    })();
    renewals.set(session.refreshToken, { promise, at: now });
    promise.catch(() => renewals.delete(session.refreshToken));
    return promise;
}

const text = z
    .string()
    .nullish()
    .transform((value) => value ?? "");

const homesSchema = z.array(z.object({ ownerId: z.union([z.string(), z.number()]), name: text }));

export async function listTuyaHomes(session: TuyaSession): Promise<{ id: string; name: string }[]> {
    const { result } = await call(session, "GET", "/v1.0/m/life/users/homes");
    const parsed = homesSchema.safeParse(result);
    if (!parsed.success) throw new TuyaError("Tuya answered with something unexpected.", "refused");
    return parsed.data.map((home) => ({ id: String(home.ownerId), name: home.name }));
}

const pointSchema = z.object({ code: z.string(), value: z.unknown() });

const sharedDeviceSchema = z.object({
    id: z.string().min(1),
    name: text,
    category: text,
    product_name: text,
    online: z
        .boolean()
        .nullish()
        .transform((value) => value ?? false),
    // Kept only where a point has a code and a value, as the SDK does: a point
    // described by number alone is its local form and means nothing here.
    status: z
        .array(z.unknown())
        .nullish()
        .transform((points) =>
            (points ?? []).flatMap((point) => {
                const parsed = pointSchema.safeParse(point);
                return parsed.success && "value" in (point as object) ? [parsed.data] : [];
            })
        )
});

export type TuyaSharedDevice = z.infer<typeof sharedDeviceSchema>;

/** The devices in one home, with the state of each in the same answer. */
export async function listTuyaHomeDevices(
    session: TuyaSession,
    homeId: string
): Promise<TuyaSharedDevice[]> {
    const { result } = await call(session, "GET", "/v1.0/m/life/ha/home/devices", {
        params: { homeId }
    });
    const parsed = z.array(z.unknown()).safeParse(result);
    if (!parsed.success) throw new TuyaError("Tuya answered with something unexpected.", "refused");
    return parsed.data.flatMap((entry) => {
        const device = sharedDeviceSchema.safeParse(entry);
        return device.success ? [device.data] : [];
    });
}

/** What a device accepts and reports, with each data point's range - the
 *  device-sharing SDK's `update_device_specification`. Unchecked here: the
 *  vocabulary that reads it validates it. */
export async function tuyaSharedSpecification(
    session: TuyaSession,
    deviceId: string
): Promise<unknown> {
    const { result } = await call(
        session,
        "GET",
        `/v1.1/m/life/${encodeURIComponent(deviceId)}/specifications`
    );
    return result;
}

export async function sendTuyaCommands(
    session: TuyaSession,
    deviceId: string,
    commands: readonly { code: string; value: unknown }[]
): Promise<void> {
    await call(session, "POST", `/v1.1/m/thing/${encodeURIComponent(deviceId)}/commands`, {
        body: { commands }
    });
}

/** Sign this terminal out, as Home Assistant does when the integration is
 *  removed: the tokens stop working at Tuya rather than only being forgotten
 *  here. */
export async function expireTuyaTerminal(session: TuyaSession): Promise<void> {
    await call(session, "POST", "/v1.0/m/token/terminal/expire", {
        body: { accessToken: session.accessToken, terminalId: session.terminalId }
    });
}
