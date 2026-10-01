/**
 * The Philips Air+ account: signing in with an emailed code, keeping the sign-in
 * alive, and the account's devices - the cloud the Air+ app itself uses.
 *
 * Unofficial. Philips publishes no API for this; every endpoint, client id and
 * parameter here is the one the community Home Assistant integrations use and
 * were read from their source, not guessed:
 *
 * - NikGro/philips-air-plus-homeassistant (MIT, a fork of ShorMeneses/
 *   philips-airplus-homeassistant): `email_auth.py` for the email code and the
 *   exchange of its session for OIDC tokens, `auth.py` for the refresh, `api.py`
 *   and `const.py` for the Versuni IoT API.
 * - renaudallard/homeassistant_philips_homeid (BSD-2-Clause): `cloud_auth.py`
 *   and `cloud_api.py`, the same sign-in with the Air+ and HomeID clients side by
 *   side, and which failures are a refused sign-in rather than an outage.
 *
 * The sign-in is three steps and keeps no password anywhere:
 *
 * 1. Gigya (Philips' account provider, `cdc.accounts.home.id`) emails a one-time
 *    code: `accounts.auth.otp.email.sendCode` answers a `vToken`.
 * 2. The code and the `vToken` are traded for a Gigya session
 *    (`accounts.auth.otp.email.login`).
 * 3. That session is turned into OIDC tokens without a browser: `authorize` with
 *    `prompt=none` and PKCE answers a redirect carrying a `context`;
 *    `socialize.getIDs` gives a `gmidTicket`; `authorize/continue` with both and
 *    the session answers a redirect carrying the code; `token` trades the code
 *    for an access token and a refresh token.
 *
 * Tokens are minted for the Air+ app's client first. An account whose purifier
 * was added in the HomeID app instead lists nothing with those, so the same
 * session is tried again with the HomeID client - both sources do exactly this.
 * The client that worked is stored, because a refresh token can only be renewed
 * by the client it was issued to.
 *
 * Nothing here logs. A response body names tokens, signatures and - in the
 * device list - each unit's local keys, so none of it is ever written anywhere
 * but into the fields this file returns.
 *
 * Server-only.
 */

import { z } from "zod";
import { DriverError } from "../drivers/contract";
import { createHash, randomBytes } from "node:crypto";

/** Gigya's API key for Philips' accounts, which is also the OIDC tenant. */
const GIGYA_API_KEY = "4_JGZWlP8eQHpEqkvQElolbA";
const GIGYA = "https://cdc.accounts.home.id";
const ISSUER = `${GIGYA}/oidc/op/v1.0/${GIGYA_API_KEY}`;

/** The Versuni IoT API the app reads its devices and its MQTT signature from. */
const IOT = "https://prod.eu-da.iot.versuni.com/api/da";

/** The two public clients a sign-in can be minted for. Neither has a secret. */
export const PHILIPS_CLIENTS = {
    airplus: {
        id: "-XsK7O6iEkLml77yDGDUi0ku",
        redirect: "com.philips.air://loginredirect",
        scope: [
            "openid email profile address DI.Account.read DI.Account.write DI.AccountProfile.read",
            "DI.AccountProfile.write DI.AccountGeneralConsent.read DI.AccountGeneralConsent.write",
            "DI.GeneralConsent.read subscriptions profile_extended consents DI.AccountSubscription.read",
            "DI.AccountSubscription.write"
        ].join(" ")
    },
    homeid: {
        id: "-u6aTznrxp9_9e_0a57CpvEG",
        redirect: "com.philips.ka.oneka.app.prod://oauthredirect",
        scope: [
            "openid profile email offline_access",
            "DI.Account.read DI.AccountProfile.read DI.AccountProfile.write",
            "DI.AccountGeneralConsent.read DI.AccountGeneralConsent.write",
            "DI.GeneralConsent.read DI.GeneralConsent.write",
            "VoiceProvider.read VoiceProvider.write",
            "subscriptions consent profile_extended",
            "DI.AccountSubscription.write DI.AccountSubscription.read"
        ].join(" ")
    }
} as const;

export type PhilipsClient = keyof typeof PHILIPS_CLIENTS;

/** A whole call, from the first byte to the last. A sign-in server that has not
 *  answered in this long is not going to, and the dialog is waiting on it. */
const TIMEOUT_MS = 20_000;

/** How long before its end a token is traded for a new one (`TOKEN_REFRESH_BUFFER`). */
export const REFRESH_EARLY_MS = 15 * 60 * 1000;

/** Gigya's answer for an address that started signing up and never finished. */
const PENDING_REGISTRATION = 206001;

/** A signed-in account, as it is stored. */
export interface PhilipsSession {
    readonly accessToken: string;
    /** Empty where the token endpoint gave none: such a sign-in lasts as long as
     *  its access token and is then connected again. */
    readonly refreshToken: string;
    /** When the access token lapses, in milliseconds. */
    readonly expiresAt: number;
    readonly client: PhilipsClient;
}

/** One purifier on the account, as much of it as Polaris keeps. */
export interface PhilipsCloudDevice {
    /** The device's id in Philips' cloud; what its row is keyed by. */
    readonly id: string;
    /** Its AWS IoT thing, which is what its MQTT topics are named after. */
    readonly thing: string;
    readonly name: string;
    /** The model as the account lists it (`AC0651/10`), where it does. */
    readonly model: string | null;
}

function unreachable(): DriverError {
    return new DriverError("Philips' cloud could not be reached.", "unreachable");
}

function garbled(): DriverError {
    return new DriverError(
        "Philips' cloud answered in a way Polaris could not read.",
        "unreachable"
    );
}

function signedOut(): DriverError {
    return new DriverError(
        "Philips no longer accepts this sign-in. Connect the account again.",
        "unauthorized"
    );
}

async function call(url: string, init: RequestInit = {}): Promise<Response> {
    try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
        throw unreachable();
    }
}

async function json(response: Response): Promise<unknown> {
    try {
        return JSON.parse(await response.text()) as unknown;
    } catch {
        throw garbled();
    }
}

function form(values: Readonly<Record<string, string>>): RequestInit {
    return {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(values).toString()
    };
}

// --- step 1 and 2: the emailed code ---------------------------------------------

const gigyaSchema = z
    .object({
        errorCode: z.number().optional(),
        vToken: z.string().max(4000).optional(),
        sessionInfo: z.object({ cookieValue: z.string().max(4000).optional() }).optional(),
        gmidTicket: z.string().max(4000).optional()
    })
    .passthrough();

async function gigya(endpoint: string, values: Readonly<Record<string, string>>) {
    const response = await call(`${GIGYA}/${endpoint}`, form(values));
    const parsed = gigyaSchema.safeParse(await json(response));
    if (!parsed.success) throw garbled();
    return parsed.data;
}

/** Have a one-time code emailed to an address. The answer is the `vToken` the
 *  code is checked against: useless without the code, which only the inbox has. */
export async function requestPhilipsCode(email: string): Promise<string> {
    const answer = await gigya("accounts.auth.otp.email.sendCode", {
        email,
        apiKey: GIGYA_API_KEY,
        format: "json"
    });
    if (answer.errorCode !== 0 || !answer.vToken) {
        throw new DriverError(
            "Philips did not send a code to that address. Check it is the one you sign in to the Air+ app with.",
            "refused"
        );
    }
    return answer.vToken;
}

/** The code from the email, traded for a Gigya session. */
async function sessionFor(email: string, code: string, vToken: string): Promise<string> {
    const answer = await gigya("accounts.auth.otp.email.login", {
        email,
        code,
        vToken,
        apiKey: GIGYA_API_KEY,
        format: "json"
    });
    if (answer.errorCode === PENDING_REGISTRATION) {
        throw new DriverError(
            "That address is not a finished Philips account yet. Sign in once in the Philips Air+ app, then try again.",
            "refused"
        );
    }
    const session = answer.sessionInfo?.cookieValue;
    if (answer.errorCode !== 0 || !session) {
        throw new DriverError(
            "That code is not right or has expired. Ask for a new one.",
            "unauthorized"
        );
    }
    return session;
}

// --- step 3: the session as tokens ----------------------------------------------

/** A PKCE pair: the verifier kept here, its S256 challenge sent. */
export function pkcePair(): { verifier: string; challenge: string } {
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

/** One query parameter of a redirect's `Location`, which may be a custom
 *  scheme (`com.philips.air://loginredirect?code=...`). */
function redirectParam(response: Response, name: string): string {
    if (response.status < 300 || response.status >= 400) throw garbled();
    const location = response.headers.get("location") ?? "";
    const query = location.includes("?") ? location.slice(location.indexOf("?") + 1) : "";
    return new URLSearchParams(query).get(name) ?? "";
}

const tokenSchema = z.object({
    access_token: z.string().min(1).max(8000),
    refresh_token: z.string().max(8000).optional(),
    expires_in: z.coerce.number().finite().positive().optional(),
    exp: z.coerce.number().finite().positive().optional()
});

/** A token answer as a session. `exp` is when, in seconds; `expires_in` is how
 *  long from now. Neither is an hour, which is what such tokens last elsewhere. */
function sessionOf(
    answer: z.infer<typeof tokenSchema>,
    client: PhilipsClient,
    previousRefresh = ""
): PhilipsSession {
    const now = Date.now();
    const expiresAt = answer.exp
        ? answer.exp * 1000
        : now + (answer.expires_in ?? 60 * 60) * 1000;
    return {
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token ?? previousRefresh,
        expiresAt,
        client
    };
}

/** What the token endpoint says, read as a refusal or an outage: `invalid_grant`,
 *  `invalid_token` and a 401 are the sign-in being refused; anything else is
 *  worth trying again (`refresh_tokens` in the HomeID integration). */
async function tokenCall(values: Readonly<Record<string, string>>, client: PhilipsClient, previous = "") {
    const response = await call(`${ISSUER}/token`, form(values));
    const body = await json(response);
    const parsed = tokenSchema.safeParse(body);
    if (parsed.success) return sessionOf(parsed.data, client, previous);
    const error = z.object({ error: z.string() }).safeParse(body);
    if (
        response.status === 401 ||
        (error.success && (error.data.error === "invalid_grant" || error.data.error === "invalid_token"))
    ) {
        throw signedOut();
    }
    throw response.status >= 500 ? unreachable() : garbled();
}

/** A Gigya session as tokens for one client, through `authorize` with
 *  `prompt=none` - the browser-free flow of `_http_oauth`. */
export async function tokensFor(gigyaSession: string, client: PhilipsClient): Promise<PhilipsSession> {
    const spec = PHILIPS_CLIENTS[client];
    const { verifier, challenge } = pkcePair();
    const authorize = new URLSearchParams({
        client_id: spec.id,
        response_type: "code",
        redirect_uri: spec.redirect,
        scope: spec.scope,
        state: randomBytes(16).toString("base64url"),
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "none"
    });
    const first = await call(`${ISSUER}/authorize?${authorize.toString()}`, { redirect: "manual" });
    const context = redirectParam(first, "context");
    if (!context) throw garbled();

    const ids = await gigya("socialize.getIDs", {
        APIKey: GIGYA_API_KEY,
        includeTicket: "true",
        format: "json"
    });
    if (!ids.gmidTicket) throw garbled();

    const resume = new URLSearchParams({
        context,
        login_token: gigyaSession,
        gmidTicket: ids.gmidTicket,
        client_id: spec.id
    });
    const second = await call(`${ISSUER}/authorize/continue?${resume.toString()}`, {
        redirect: "manual"
    });
    if (redirectParam(second, "errorMessage")) throw signedOut();
    const code = redirectParam(second, "code");
    if (!code) throw garbled();

    return tokenCall(
        {
            client_id: spec.id,
            grant_type: "authorization_code",
            code,
            redirect_uri: spec.redirect,
            code_verifier: verifier
        },
        client
    );
}

/** The emailed code, all the way to tokens. */
export async function signInWithCode(
    email: string,
    code: string,
    vToken: string
): Promise<{ gigyaSession: string; session: PhilipsSession }> {
    const gigyaSession = await sessionFor(email, code, vToken);
    return { gigyaSession, session: await tokensFor(gigyaSession, "airplus") };
}

/** Whether a session is close enough to its end to be renewed now. */
export function philipsNeedsRefresh(session: PhilipsSession, now: number = Date.now()): boolean {
    return session.expiresAt - now <= REFRESH_EARLY_MS;
}

/** A new access token for the refresh token, from the client it was issued to. */
export async function refreshPhilipsSession(session: PhilipsSession): Promise<PhilipsSession> {
    if (!session.refreshToken) throw signedOut();
    return tokenCall(
        {
            grant_type: "refresh_token",
            refresh_token: session.refreshToken,
            client_id: PHILIPS_CLIENTS[session.client].id
        },
        session.client,
        session.refreshToken
    );
}

// --- the IoT API ----------------------------------------------------------------

async function iot(path: string, accessToken: string): Promise<unknown> {
    const response = await call(`${IOT}${path}`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    });
    // A 403 is the API refusing the token, not an outage (`get_devices`).
    if (response.status === 401 || response.status === 403) throw signedOut();
    if (!response.ok) throw response.status >= 500 ? unreachable() : garbled();
    return json(response);
}

const deviceSchema = z
    .object({
        uuid: z.string().max(200).optional(),
        id: z.union([z.string(), z.number()]).optional(),
        thingName: z.string().max(200).optional(),
        name: z.string().max(200).optional(),
        deviceName: z.string().max(200).optional(),
        friendlyName: z.string().max(200).optional(),
        ctn: z.string().max(60).optional(),
        type: z.string().max(60).optional(),
        deviceType: z.string().max(60).optional()
    })
    .passthrough();

/** The list as the API answers it: bare, or under `devices`, `data` or `items`. */
function deviceItems(body: unknown): unknown[] {
    if (Array.isArray(body)) return body;
    if (body && typeof body === "object") {
        for (const key of ["devices", "data", "items"]) {
            const value = (body as Record<string, unknown>)[key];
            if (Array.isArray(value)) return value;
        }
    }
    return [];
}

/** A list item as a device, or null for one with no id to key it by. Only these
 *  fields are taken: an item also carries the unit's local keys, which Polaris
 *  has no use for and does not keep. */
export function philipsCloudDevice(raw: unknown): PhilipsCloudDevice | null {
    const parsed = deviceSchema.safeParse(raw);
    if (!parsed.success) return null;
    const item = parsed.data;
    const id = (item.uuid || (item.id === undefined ? "" : String(item.id))).trim();
    if (!id) return null;
    const bare = id.startsWith("da-") ? id.slice(3) : id;
    const model = (item.ctn || item.deviceType || item.type || "").trim();
    return {
        id: bare,
        thing: item.thingName?.trim() || `da-${bare}`,
        name: (item.name || item.deviceName || item.friendlyName || "").trim(),
        model: model && model.toLowerCase() !== "unknown" ? model : null
    };
}

export async function listPhilipsDevices(accessToken: string): Promise<PhilipsCloudDevice[]> {
    const devices: PhilipsCloudDevice[] = [];
    for (const raw of deviceItems(await iot("/user/self/device", accessToken))) {
        const device = philipsCloudDevice(raw);
        if (device && !devices.some((seen) => seen.id === device.id)) devices.push(device);
    }
    return devices;
}

/** The account's id in the IoT API, which every MQTT client id starts with. */
export async function philipsUserId(accessToken: string): Promise<string> {
    const parsed = z
        .object({ id: z.union([z.string().min(1).max(200), z.number()]) })
        .safeParse(await iot("/user/self", accessToken));
    if (!parsed.success) throw garbled();
    return String(parsed.data.id);
}

/** The AWS IoT custom-authorizer signature for one access token. It has to
 *  match the token presented with it, so a new token needs a new one. */
export async function philipsSignature(accessToken: string): Promise<string> {
    const parsed = z
        .object({ signature: z.string().min(1).max(8000) })
        .safeParse(await iot("/user/self/signature", accessToken));
    if (!parsed.success) throw garbled();
    return parsed.data.signature;
}

/**
 * A signed-in account with something on it to drive.
 *
 * The Air+ client's tokens first; when its list is empty, the same Gigya session
 * as the HomeID client's, for a purifier added in that app. An account with
 * nothing on it under either is refused here, where the reader can still be told
 * to add the unit in the app, rather than stored as a connection with nothing.
 */
export async function signedInWithDevices(
    gigyaSession: string,
    airplus: PhilipsSession
): Promise<{ session: PhilipsSession; devices: PhilipsCloudDevice[] }> {
    const devices = await listPhilipsDevices(airplus.accessToken);
    if (devices.length > 0) return { session: airplus, devices };
    const homeid = await tokensFor(gigyaSession, "homeid");
    const others = await listPhilipsDevices(homeid.accessToken);
    if (others.length > 0) return { session: homeid, devices: others };
    throw new DriverError(
        "There is no air purifier on this Philips account. Add it in the Air+ app first.",
        "refused"
    );
}

/**
 * The MQTT client id for one device: the account's id, the device's, and a
 * suffix of Polaris' own - `build_client_id`. The broker allows one connection
 * per client id, so without the suffix Polaris and the phone would keep cutting
 * each other off. A 32-hex account id is written as the UUID it is.
 */
export function philipsClientId(userId: string, deviceId: string): string {
    const device = deviceId.startsWith("da-") ? deviceId.slice(3) : deviceId;
    const user = userId.trim();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuid.test(user) && uuid.test(device)) return `${user}_${device}_polaris`;
    if (/^[0-9a-f]{32}$/i.test(user) && uuid.test(device)) {
        const dashed = `${user.slice(0, 8)}-${user.slice(8, 12)}-${user.slice(12, 16)}-${user.slice(16, 20)}-${user.slice(20)}`;
        return `${dashed}_${device}_polaris`;
    }
    return `client-${device}_polaris`;
}
