/**
 * The Tuya cloud API, as much of it as Places needs.
 *
 * Tuya devices can be reached two ways and only one of them is a fair thing to
 * ask of somebody running Polaris. Every one of these plugs and switches also
 * speaks a local protocol on its own network, and that is genuinely better - no
 * round trip to another continent, and it keeps working when their servers do
 * not - but it is opened with a per-device local key that is only obtainable from
 * the cloud account in the first place. So the cloud is the way in, and a local
 * transport is a driver to add beside it rather than instead of it.
 *
 * What makes this awkward is not the endpoints, which are three, but the signing:
 * every request carries an HMAC over the method, a hash of the body, and the path
 * with its query sorted, and the string being signed is different for the call
 * that fetches a token than for every call that uses one. Getting that wrong
 * answers "sign invalid" for reasons no error message explains, so it is written
 * once, here, and never assembled at a call site.
 *
 * Every response is parsed against a schema before anything reads it: this is
 * somebody else's server, and a shape that changed under us has to fail here,
 * saying so, rather than three layers further in as an undefined.
 *
 * Server-only. The credentials never leave it.
 */

import { z } from "zod";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { tuyaHost } from "@/lib/integrations/tuya-regions";

/** Long enough for a plug on the far side of a cloud round trip, short enough
 *  that a screen waiting on it is not left there. */
const TIMEOUT_MS = 15_000;

/** The SHA-256 of an empty body, which is what every GET signs. Computed rather
 *  than pasted so nothing here depends on a constant nobody can check. */
const EMPTY_BODY_SHA = createHash("sha256").update("").digest("hex");

/**
 * What went wrong, in a sentence, plus whether the credentials are the problem.
 *
 * The distinction is the reason this is not a plain Error: a refused key has to
 * mark the connection and say so on screen, and a plug that would not answer has
 * to leave everything exactly where it was.
 */
export class TuyaError extends Error {
    readonly kind: "unauthorized" | "rate-limited" | "refused" | "unreachable";

    constructor(message: string, kind: TuyaError["kind"]) {
        super(message);
        this.name = "TuyaError";
        this.kind = kind;
    }
}

/** Their codes for "what you signed with is not going to work", as against the
 *  ones that mean a device or a request was wrong. The first sort has to stop the
 *  connection and ask for new credentials; the second must not. */
const UNAUTHORIZED_CODES = new Set([1001, 1002, 1003, 1004, 1005, 1010, 1011, 1013, 1106, 1114]);

const envelopeSchema = z.object({
    success: z.boolean().optional(),
    code: z.number().int().optional(),
    msg: z.string().optional(),
    result: z.unknown().optional()
});

const tokenSchema = z.object({
    access_token: z.string(),
    /** Seconds, and always well under two hours in practice. */
    expire_time: z.number().int().optional(),
    uid: z.string().optional()
});

const statusSchema = z.object({
    code: z.string(),
    value: z.unknown()
});

const deviceSchema = z.object({
    id: z.string(),
    name: z.string().default(""),
    /** Their taxonomy: kg a switch, cz a socket, dj a light, and a hundred more. */
    category: z.string().default(""),
    product_name: z.string().default(""),
    model: z.string().default(""),
    online: z.boolean().default(false),
    status: z.array(statusSchema).default([])
});

const deviceListSchema = z.object({
    devices: z.array(deviceSchema).default([]),
    last_row_key: z.string().optional(),
    has_more: z.boolean().default(false)
});

export type TuyaDevice = z.infer<typeof deviceSchema>;
export type TuyaStatus = z.infer<typeof statusSchema>;

export interface TuyaCredentials {
    readonly accessId: string;
    readonly accessSecret: string;
    readonly region: string;
}

/**
 * The signature, which is the whole difficulty of this API.
 *
 * The string signed is the method, the hash of the body, an empty line where
 * additional signed headers would go, and the path with its query already sorted.
 * That is then prefixed with the key, the token where there is one, the timestamp
 * and the nonce - and it is the presence of the token in that prefix that makes
 * the token call different from every other call.
 */
function signature(
    credentials: TuyaCredentials,
    method: string,
    path: string,
    body: string,
    t: string,
    nonce: string,
    accessToken: string
): string {
    const contentSha = body ? createHash("sha256").update(body).digest("hex") : EMPTY_BODY_SHA;
    const stringToSign = `${method}\n${contentSha}\n\n${path}`;
    const payload = `${credentials.accessId}${accessToken}${t}${nonce}${stringToSign}`;
    return createHmac("sha256", credentials.accessSecret).update(payload).digest("hex").toUpperCase();
}

/** A path with its query in the order the signature expects: sorted by key,
 *  ascending. Built here rather than at a call site because a query assembled in
 *  a different order signs a different string and is refused with no clue why. */
function pathWithQuery(path: string, query: Readonly<Record<string, string | number | undefined>>): string {
    const entries = Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([key, value]) => [key, String(value)] as const)
        .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return path;
    return `${path}?${entries.map(([key, value]) => `${key}=${value}`).join("&")}`;
}

async function call(
    credentials: TuyaCredentials,
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; accessToken?: string } = {}
): Promise<unknown> {
    const t = Date.now().toString();
    const nonce = randomUUID();
    const body = options.body === undefined ? "" : JSON.stringify(options.body);
    const sign = signature(credentials, method, path, body, t, nonce, options.accessToken ?? "");

    let response: Response;
    try {
        response = await fetch(`${tuyaHost(credentials.region)}${path}`, {
            method,
            cache: "no-store",
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
                client_id: credentials.accessId,
                sign,
                t,
                nonce,
                sign_method: "HMAC-SHA256",
                ...(options.accessToken ? { access_token: options.accessToken } : {}),
                ...(body ? { "Content-Type": "application/json" } : {})
            },
            body: body || undefined
        });
    } catch {
        throw new TuyaError("Tuya could not be reached. Try again in a moment.", "unreachable");
    }

    const text = await response.text().catch(() => "");
    let payload: unknown = null;
    if (text) {
        try {
            payload = JSON.parse(text) as unknown;
        } catch {
            payload = null;
        }
    }

    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success) throw new TuyaError("Tuya answered with something unexpected.", "refused");

    if (parsed.data.success === false) {
        const code = parsed.data.code ?? 0;
        // Their own sentence where there is one: "sign invalid" and "no
        // permissions" are worth reading, and one Polaris invented in their place
        // would be a guess about somebody else's console.
        const detail = parsed.data.msg?.trim();
        if (UNAUTHORIZED_CODES.has(code)) {
            throw new TuyaError(
                detail
                    ? `Tuya refused the keys: ${detail}.`
                    : "Tuya refused the keys. They may have been revoked, or the project may not cover these devices.",
                "unauthorized"
            );
        }
        throw new TuyaError(detail ? `Tuya refused the request: ${detail}.` : "Tuya refused the request.", "refused");
    }

    return parsed.data.result;
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

/**
 * Tokens, kept for as long as they last.
 *
 * One is good for a couple of hours, and every call needs one. Fetching a fresh
 * token per request would double the traffic and hit their rate limit on a house
 * with a few dozen plugs, so it is held in the process and asked for again a
 * minute before it lapses - a minute rather than at the moment, because a token
 * that expires in flight fails the call it was fetched for.
 */
const tokens = new Map<string, { token: string; uid: string; expiresAt: number }>();

const TOKEN_MARGIN_MS = 60_000;

export async function tuyaToken(credentials: TuyaCredentials): Promise<{ token: string; uid: string }> {
    const key = `${credentials.region}:${credentials.accessId}`;
    const held = tokens.get(key);
    if (held && held.expiresAt > Date.now()) return { token: held.token, uid: held.uid };

    const result = await call(credentials, "GET", "/v1.0/token?grant_type=1");
    const parsed = tokenSchema.safeParse(result);
    if (!parsed.success) throw new TuyaError("Tuya answered with something unexpected.", "refused");

    const lifetime = (parsed.data.expire_time ?? 7200) * 1000;
    const fresh = {
        token: parsed.data.access_token,
        uid: parsed.data.uid ?? "",
        expiresAt: Date.now() + Math.max(TOKEN_MARGIN_MS, lifetime - TOKEN_MARGIN_MS)
    };
    tokens.set(key, fresh);
    return { token: fresh.token, uid: fresh.uid };
}

/** Forget a token, for when the account has been disconnected or its keys
 *  replaced. A held token for keys nobody has any more is a call waiting to be
 *  made on somebody else's behalf. */
export function forgetTuyaToken(credentials: TuyaCredentials): void {
    tokens.delete(`${credentials.region}:${credentials.accessId}`);
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** How many devices one page asks for. Their ceiling is 100, and a house that
 *  needs a second page gets one. */
const PAGE_SIZE = 100;

/** A ceiling on the pages one read walks, so a misbehaving cursor cannot spin
 *  here forever. Two thousand devices is not a house. */
const MAX_PAGES = 20;

/**
 * Every device on the app account this project is linked to.
 *
 * Asked by app user rather than by project: what somebody has is what is in their
 * Smart Life app, and the project is only the thing that was given permission to
 * see it. The status of each comes back in the same answer, so a house of thirty
 * plugs is one call rather than thirty-one.
 */
export async function listTuyaDevices(credentials: TuyaCredentials): Promise<TuyaDevice[]> {
    const { token } = await tuyaToken(credentials);
    const devices: TuyaDevice[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
        const path = pathWithQuery("/v1.0/iot-01/associated-users/devices", {
            size: PAGE_SIZE,
            last_row_key: cursor
        });
        const result = await call(credentials, "GET", path, { accessToken: token });
        const parsed = deviceListSchema.safeParse(result);
        if (!parsed.success) throw new TuyaError("Tuya answered with something unexpected.", "refused");
        devices.push(...parsed.data.devices);
        if (!parsed.data.has_more || !parsed.data.last_row_key) break;
        cursor = parsed.data.last_row_key;
    }
    return devices;
}

/** One device's data points, now. Used before a command rather than on a read:
 *  what a plug calls its own switch is its own business, and the answer is in
 *  here. */
export async function tuyaStatus(credentials: TuyaCredentials, deviceId: string): Promise<TuyaStatus[]> {
    const { token } = await tuyaToken(credentials);
    const result = await call(
        credentials,
        "GET",
        `/v1.0/devices/${encodeURIComponent(deviceId)}/status`,
        { accessToken: token }
    );
    const parsed = z.array(statusSchema).safeParse(result);
    if (!parsed.success) throw new TuyaError("Tuya answered with something unexpected.", "refused");
    return parsed.data;
}

/** Tell a device to do something. Their call answers when they have accepted it,
 *  which for a plug on wifi is a good proxy for it having happened. */
export async function tuyaCommand(
    credentials: TuyaCredentials,
    deviceId: string,
    commands: readonly { code: string; value: unknown }[]
): Promise<void> {
    const { token } = await tuyaToken(credentials);
    await call(credentials, "POST", `/v1.0/devices/${encodeURIComponent(deviceId)}/commands`, {
        accessToken: token,
        body: { commands }
    });
}
