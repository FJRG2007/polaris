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
 * Regions. The sign-in has none: Philips' Gigya key lives in one data centre,
 * EU1 (`cdc.accounts.home.id` is its custom name), and Gigya's US1 and AU1 hosts
 * answer that key with `301001 Invalid data center` pointing back there. The
 * HomeID backend is one host for every country too: each of its 79 countries
 * lists `deviceRegion: "WO"`, worldwide. Only the IoT registry and its broker
 * are regional, and which region a country uses is asked of Versuni's own
 * configuration service, the way the Air+ app asks it (`philipsRegionFor`).
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

/**
 * One of Versuni's IoT regions: the API the app reads its devices and its MQTT
 * signature from, and the broker its units talk to.
 *
 * Which one an account uses is Versuni's to say. The Air+ app asks its
 * configuration service with the country picked at sign-up, and the service
 * answers the region's AWS code and both hosts - `{"region":"eu-west-1",
 * "api":"prod.eu-da.iot.versuni.com","iot":"ats.prod.eu-da.iot.versuni.com"}`.
 * The request is in kwesolowski/node-red-contrib-philips-airplus
 * (`docs/api-reverse-engineered.md`, "Configuration API", captured from the
 * app), and the service is named in Ka3seBr0t/HA_Philips_Air_Plus
 * (`notes/finding_fan_architecture.md`).
 */
export interface PhilipsRegion {
    /** The AWS region code (`eu-west-1`): what the screen names, as an area. */
    readonly region: string;
    /** The REST API's host. */
    readonly api: string;
    /** The MQTT broker's host. */
    readonly broker: string;
}

/**
 * The only region known without asking, and what every connection made before
 * there was a choice uses: EU, the hosts both community integrations hard-code
 * (`const.py`) and the one the configuration service answered for each of the
 * 280 country codes asked on 2026-10-02.
 *
 * Deliberately not here: `prod.us-da` and `prod.ap-da`, which ShorMeneses/
 * philips-airplus-homeassistant tries as fallbacks (`FALLBACK_API_HOSTS`). Neither
 * name resolves, no certificate has ever been logged for either (certificate
 * transparency for `*.iot.versuni.com` shows only `eu-da` and `global-da`), and
 * Ka3seBr0t's notes record trying them, `cn-da` too, and finding nothing.
 */
export const PHILIPS_EU: PhilipsRegion = {
    region: "eu-west-1",
    api: "prod.eu-da.iot.versuni.com",
    broker: "ats.prod.eu-da.iot.versuni.com"
};

/** Versuni's configuration service. Public: it answers without a sign-in. */
const CONFIGURATION = "https://prod.global-da.iot.versuni.com/configuration";

/** A host a token may be sent to: one of Versuni's IoT names, and nothing
 *  else, whatever the configuration answered. */
const VERSUNI_IOT_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.iot\.versuni\.com$/;

export function isVersuniIotHost(host: string): boolean {
    return host.length <= 200 && VERSUNI_IOT_HOST.test(host);
}

/** How long one country's answer is kept: the service sends it with a day's
 *  cache itself, and a region does not move under an account. */
const REGION_TTL_MS = 6 * 60 * 60 * 1000;
/** How long the configuration service is waited on before EU is assumed. */
const REGION_TIMEOUT_MS = 5_000;

const regionSchema = z.object({
    region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
    api: z.string().refine(isVersuniIotHost),
    iot: z.string().refine(isVersuniIotHost)
});

/** Each country's answer, by code. Bounded by the countries Philips serves. */
const regions = new Map<string, { region: PhilipsRegion; at: number }>();

/** For tests: forget every answer. */
export function resetPhilipsRegions(): void {
    regions.clear();
}

/**
 * The region a country's accounts are in, as Versuni's configuration answers
 * it, and whether it did answer. A service that is down, slow or answering
 * something Polaris cannot vouch for is EU: where every account is today, and
 * still a working answer rather than no sign-in at all.
 */
export async function philipsRegionFor(
    country: string,
    now: () => number = Date.now
): Promise<{ region: PhilipsRegion; answered: boolean }> {
    const code = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return { region: PHILIPS_EU, answered: false };
    const known = regions.get(code);
    if (known && now() - known.at < REGION_TTL_MS) return { region: known.region, answered: true };
    try {
        const response = await fetch(`${CONFIGURATION}?countryCode=${code}`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(REGION_TIMEOUT_MS)
        });
        if (!response.ok) return { region: PHILIPS_EU, answered: false };
        const parsed = regionSchema.safeParse(JSON.parse(await response.text()) as unknown);
        if (!parsed.success) return { region: PHILIPS_EU, answered: false };
        const region = {
            region: parsed.data.region,
            api: parsed.data.api,
            broker: parsed.data.iot
        };
        regions.set(code, { region, at: now() });
        return { region, answered: true };
    } catch {
        return { region: PHILIPS_EU, answered: false };
    }
}

/** How many other regions one sign-in asks, side by side, and how long each
 *  is given: a region that holds the account answers in well under a second. */
const FALLBACK_LIMIT = 4;
const FALLBACK_TIMEOUT_MS = 8_000;

/**
 * The regions worth asking after `tried` came back empty: EU and every other
 * region the configuration service has named for any country, at most
 * `FALLBACK_LIMIT` of them. Never a host nobody has answered with.
 */
export function otherPhilipsRegions(tried: readonly PhilipsRegion[]): PhilipsRegion[] {
    const others: PhilipsRegion[] = [];
    for (const region of [PHILIPS_EU, ...[...regions.values()].map((entry) => entry.region)]) {
        if (tried.some((seen) => seen.api === region.api)) continue;
        if (others.some((seen) => seen.api === region.api)) continue;
        others.push(region);
    }
    return others.slice(0, FALLBACK_LIMIT);
}

/** A region as stored on a connection, or EU for one made before there was a
 *  choice - or one whose stored hosts are not Versuni's. */
export function storedPhilipsRegion(stored: {
    readonly iotRegion?: string;
    readonly iotApi?: string;
    readonly iotBroker?: string;
}): PhilipsRegion {
    const { iotRegion, iotApi, iotBroker } = stored;
    if (!iotRegion || !iotApi || !iotBroker) return PHILIPS_EU;
    if (!isVersuniIotHost(iotApi) || !isVersuniIotHost(iotBroker)) return PHILIPS_EU;
    return { region: iotRegion, api: iotApi, broker: iotBroker };
}

function iotBase(region: PhilipsRegion): string {
    return `https://${region.api}/api/da`;
}

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

async function call(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = TIMEOUT_MS
): Promise<Response> {
    try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
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
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json"
        },
        body: new URLSearchParams(values).toString()
    };
}

// --- step 1 and 2: the emailed code ---------------------------------------------

const gigyaSchema = z
    .object({
        errorCode: z.number().optional(),
        errorMessage: z.string().max(500).optional(),
        vToken: z.string().max(4000).optional(),
        sessionInfo: z.object({ cookieValue: z.string().max(4000).optional() }).optional(),
        gmidTicket: z.string().max(4000).optional(),
        UID: z.string().max(200).optional()
    })
    .passthrough();

/**
 * A refusal with what Philips itself said after it, so a refusal for any reason
 * is never reported as a wrong code. Only Gigya's short error title and code are
 * kept: its details can echo back what was sent.
 */
function philipsSaid(sentence: string, answer: { errorCode?: number; errorMessage?: string }) {
    const words = (answer.errorMessage ?? "")
        .replace(/[^\x20-\x7e]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
    const code = answer.errorCode === undefined ? "" : String(answer.errorCode);
    const said = words && code ? `${words} (${code})` : words || code;
    return said ? `${sentence} Philips said: ${said}.` : sentence;
}

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
            philipsSaid(
                "Philips did not send a code to that address. Check it is the one you sign in to the Air+ app with.",
                answer
            ),
            "refused"
        );
    }
    return answer.vToken;
}

/** The code from the email, traded for a Gigya session, with the account's id
 *  at Gigya - which is also how Philips' fan and heater cloud knows the account
 *  (`verify_otp` in the Air+ fan integration). */
async function sessionFor(
    email: string,
    code: string,
    vToken: string
): Promise<{ session: string; uid: string }> {
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
            philipsSaid("Philips did not accept the code. Check it, or ask for a new one.", answer),
            "unauthorized"
        );
    }
    return { session, uid: answer.UID?.trim() ?? "" };
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
    const expiresAt = answer.exp ? answer.exp * 1000 : now + (answer.expires_in ?? 60 * 60) * 1000;
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
async function tokenCall(
    values: Readonly<Record<string, string>>,
    client: PhilipsClient,
    previous = ""
) {
    const response = await call(`${ISSUER}/token`, form(values));
    const body = await json(response);
    const parsed = tokenSchema.safeParse(body);
    if (parsed.success) return sessionOf(parsed.data, client, previous);
    const error = z.object({ error: z.string() }).safeParse(body);
    if (
        response.status === 401 ||
        (error.success &&
            (error.data.error === "invalid_grant" || error.data.error === "invalid_token"))
    ) {
        throw signedOut();
    }
    throw response.status >= 500 ? unreachable() : garbled();
}

/** A Gigya session as tokens for one client, through `authorize` with
 *  `prompt=none` - the browser-free flow of `_http_oauth`. */
export async function tokensFor(
    gigyaSession: string,
    client: PhilipsClient
): Promise<PhilipsSession> {
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

/** The emailed code, all the way to tokens, with the account's Gigya id. */
export async function signInWithCode(
    email: string,
    code: string,
    vToken: string
): Promise<{ gigyaSession: string; session: PhilipsSession; uid: string }> {
    const { session: gigyaSession, uid } = await sessionFor(email, code, vToken);
    return { gigyaSession, session: await tokensFor(gigyaSession, "airplus"), uid };
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

async function iot(path: string, accessToken: string, region: PhilipsRegion): Promise<unknown> {
    const response = await call(`${iotBase(region)}${path}`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    });
    // A 403 is the API refusing the token, not an outage (`get_devices`).
    if (response.status === 401 || response.status === 403) throw signedOut();
    if (!response.ok) throw response.status >= 500 ? unreachable() : garbled();
    return json(response);
}

/** One field of a list item as text: a string or a number, whatever else the
 *  item carries beside it. A `null` name, a numeric type or an object where a
 *  string was expected is that field missing - never the whole device. */
function textField(item: Readonly<Record<string, unknown>>, ...keys: string[]): string {
    for (const key of keys) {
        const value = item[key];
        if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The list as the API answers it: bare, under `devices`, `data` or `items`, or -
 * the fallback of `api.py` - under any key holding objects with an id.
 */
export function deviceItems(body: unknown): Record<string, unknown>[] {
    const records = (list: unknown[]) => list.filter(isRecord);
    if (Array.isArray(body)) return records(body);
    if (!isRecord(body)) return [];
    for (const key of ["devices", "data", "items"]) {
        const value = body[key];
        if (Array.isArray(value)) return records(value);
    }
    for (const value of Object.values(body)) {
        if (
            Array.isArray(value) &&
            value.some((entry) => isRecord(entry) && (entry.uuid || entry.id || entry.thingName))
        ) {
            return records(value);
        }
    }
    return [];
}

/** A model or type as Philips writes it, or null for one that says nothing. */
function modelOf(item: Readonly<Record<string, unknown>>): string | null {
    const model = textField(item, "ctn", "modelNumber", "deviceType", "type").slice(0, 60);
    return model && model.toLowerCase() !== "unknown" ? model : null;
}

/** A list item as a device, or null for one with no id to key it by. Only these
 *  fields are taken: an item also carries the unit's local keys, which Polaris
 *  has no use for and does not keep. */
export function philipsCloudDevice(raw: unknown): PhilipsCloudDevice | null {
    if (!isRecord(raw)) return null;
    const id = textField(raw, "uuid", "id");
    if (!id) return null;
    const bare = id.startsWith("da-") ? id.slice(3) : id;
    return {
        id: bare,
        thing: textField(raw, "thingName") || `da-${bare}`,
        name: textField(raw, "name", "deviceName", "friendlyName"),
        model: modelOf(raw)
    };
}

/**
 * An appliance of the HomeID backend as a device, the way `_normalize_appliances`
 * in the Air+ integration does: keyed by its `externalDeviceId` (the id the IoT
 * registry uses), its thing named after that id, as for any device whose list
 * entry gives none.
 */
export function philipsHomeIdAppliance(raw: unknown): PhilipsCloudDevice | null {
    if (!isRecord(raw)) return null;
    const id = textField(raw, "externalDeviceId", "id", "macAddress");
    if (!id) return null;
    const bare = id.startsWith("da-") ? id.slice(3) : id;
    return {
        id: bare,
        thing: `da-${bare}`,
        name: textField(raw, "name", "friendlyName"),
        model: modelOf(raw)
    };
}

/**
 * What a model is, by its code, on the rules of the HomeID integration
 * (`get_device_type`): an AC is an air purifier; an HD9, an NX and an EP or SM
 * are kitchen appliances an account can hold beside it. Anything else - a
 * humidifier, a code nobody recognises, no code at all - is drawn as an air
 * device rather than hidden: the screen can say what it is not, a missing row
 * cannot.
 */
export function philipsApplianceKind(model: string | null): "air" | "kitchen" {
    const lower = (model ?? "").toLowerCase();
    if (
        lower.startsWith("hd9") ||
        lower.includes("airfryer") ||
        lower.includes("venus") ||
        lower.includes("spectre") ||
        lower.startsWith("nx") ||
        lower.includes("nutrimax") ||
        lower.includes("hermes") ||
        lower.includes("espresso") ||
        lower.includes("coffee") ||
        lower.includes("flash_entry") ||
        /\b(ep|sm)\d/.test(lower)
    ) {
        return "kitchen";
    }
    return "air";
}

function unique(devices: readonly (PhilipsCloudDevice | null)[]): PhilipsCloudDevice[] {
    const found: PhilipsCloudDevice[] = [];
    for (const device of devices) {
        if (device && !found.some((seen) => seen.id === device.id)) found.push(device);
    }
    return found;
}

/** What an IoT call answered: the body, or the HTTP status it failed with. */
async function iotAnswer(
    path: string,
    accessToken: string,
    region: PhilipsRegion,
    timeoutMs: number = TIMEOUT_MS
): Promise<{ status: number; body: unknown }> {
    const response = await call(
        `${iotBase(region)}${path}`,
        { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } },
        timeoutMs
    );
    if (!response.ok) return { status: response.status, body: null };
    return { status: response.status, body: await json(response) };
}

export async function listPhilipsDevices(
    accessToken: string,
    region: PhilipsRegion = PHILIPS_EU
): Promise<PhilipsCloudDevice[]> {
    return unique(
        deviceItems(await iot("/user/self/device", accessToken, region)).map(philipsCloudDevice)
    );
}

/** The account's id in the IoT API, which every MQTT client id starts with. */
export async function philipsUserId(
    accessToken: string,
    region: PhilipsRegion = PHILIPS_EU
): Promise<string> {
    const parsed = z
        .object({ id: z.union([z.string().min(1).max(200), z.number()]) })
        .safeParse(await iot("/user/self", accessToken, region));
    if (!parsed.success) throw garbled();
    return String(parsed.data.id);
}

/** The AWS IoT custom-authorizer signature for one access token. It has to
 *  match the token presented with it, so a new token needs a new one. */
export async function philipsSignature(
    accessToken: string,
    region: PhilipsRegion = PHILIPS_EU
): Promise<string> {
    const parsed = z
        .object({ signature: z.string().min(1).max(8000) })
        .safeParse(await iot("/user/self/signature", accessToken, region));
    if (!parsed.success) throw garbled();
    return parsed.data.signature;
}

/** The HomeID backend: where the HomeID app keeps the appliances it paired. */
const HOMEID_BACKEND = "https://www.backend.vbs.versuni.com";

/** The app's own headers for that backend (`DefaultRequestInterceptor`, as the
 *  HomeID integration sends them). Its discovery document must be fetched
 *  without a content type, or it answers 403. */
function homeIdHeaders(accessToken: string): Record<string, string> {
    return {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.oneka.v2.0+json",
        "accept-language": "en-GB",
        "user-agent": "HomeID/8.16.0 (com.philips.ka.oneka.app; build:8160001; Android 14)",
        "x-user-agent": "Android 14;8.16.0"
    };
}

/** A link as the backend writes one: absolute, or a path under its API, with
 *  any `{template}` part dropped (`get_appliances_via_homeid`). */
function backendUrl(href: string): string {
    const plain = href.replace(/\{[^}]*\}/g, "");
    const url = plain.startsWith("/") ? `${HOMEID_BACKEND}/api${plain}` : plain;
    // Only ever Philips' own backend: a link is followed, never trusted to
    // send a token somewhere else.
    if (!url.startsWith(`${HOMEID_BACKEND}/`)) throw garbled();
    return url;
}

function backendQuery(href: string, query: Readonly<Record<string, string>>): string {
    const url = new URL(backendUrl(href));
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
}

async function homeIdGet(url: string, accessToken: string): Promise<unknown> {
    const response = await call(url, { headers: homeIdHeaders(accessToken) });
    if (response.status === 401 || response.status === 403) throw signedOut();
    if (!response.ok) throw new HomeIdStatus(response.status);
    return json(response);
}

/** A failed HomeID backend call, by its status, for the summary. */
class HomeIdStatus extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`);
    }
}

/** The backend's discovery document: public, and the same for everyone. */
async function homeIdDiscovery(): Promise<Record<string, unknown>> {
    const response = await call(`${HOMEID_BACKEND}/.well-known/tenant/oneka`);
    if (!response.ok) throw new HomeIdStatus(response.status);
    const discovery = await json(response);
    if (!isRecord(discovery)) throw garbled();
    return discovery;
}

/**
 * The appliances the HomeID backend lists for an account: its discovery
 * document names the profile, the profile embeds the appliances or links to
 * them, and the link is read with skipped pairings included - the chain of
 * `get_appliances_via_homeid` in the HomeID integration, which the Air+
 * integration also falls back to.
 */
export async function listHomeIdAppliances(accessToken: string): Promise<unknown[]> {
    const discovery = await homeIdDiscovery();
    const profileUrl = discovery.profileUrl;
    if (typeof profileUrl !== "string" || !profileUrl) throw garbled();
    const ts = String(Date.now());
    const profile = await homeIdGet(backendQuery(profileUrl, { ts }), accessToken);
    if (!isRecord(profile)) return [];

    const embedded = isRecord(profile._embedded) ? profile._embedded.userAppliances : undefined;
    const inline =
        isRecord(embedded) && isRecord(embedded._embedded) ? embedded._embedded.item : undefined;
    if (Array.isArray(inline) && inline.length > 0) return inline;

    const links = isRecord(profile._links) ? profile._links : {};
    let href = "";
    for (const name of ["userAppliances", "customerAppliances", "appliances", "devices"]) {
        const link = links[name];
        if (isRecord(link) && typeof link.href === "string" && link.href) {
            href = link.href;
            break;
        }
    }
    if (!href) return [];
    const body = await homeIdGet(
        backendQuery(href, { ts, includeSkippedPairing: "true" }),
        accessToken
    );
    if (Array.isArray(body)) return body;
    if (isRecord(body) && isRecord(body._embedded) && Array.isArray(body._embedded.item)) {
        return body._embedded.item;
    }
    return [];
}

/**
 * Who an account is to the HomeID backend's own sign-in: the address it signs
 * in with, the country it is set up in (which names the backend "space" its
 * appliances live in), and its Gigya id where it is known.
 */
export interface HomeIdAccount {
    readonly email: string;
    readonly country: string;
    readonly uid?: string;
}

/**
 * The HomeID app's own sign-in to its backend. The discovery document names
 * it (`authorizationUrl`, `/api/v2/auth/Consumer$login`), which answers a 308
 * to this path; the request is the app's as TA2k/ioBroker.nutriu (MIT,
 * `main.js`, `getConsumerLogin`) sends it from a capture of the NutriU app,
 * which shares the backend and the HomeID client. Probed on 2026-10-04: it
 * takes only `application/vnd.api+json`, refuses a body with no email and no
 * space, and answers a forged token with 401 `invalid_token`.
 *
 * It is what signing in to the HomeID app does, so for an account that never
 * has, it may set up its HomeID profile on Philips' side as the app would. It
 * is only sent after the backend has failed the shortcut, and never with a
 * name or anything the account did not already give Philips.
 */
const CONSUMER_LOGIN = `${HOMEID_BACKEND}/api/v2/auth/Consumer/Login`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const spaceSchema = z
    .object({
        countryCode: z.string().regex(/^[A-Z]{2}$/),
        spaceId: z.string().regex(UUID),
        backendBaseUrl: z.string().min(1).max(500)
    })
    .passthrough();

const consumerSchema = z.object({
    data: z.object({
        attributes: z.object({ token: z.string().min(1).max(8000) }).passthrough()
    })
});

/** The space a country's accounts live in, as the discovery document lists
 *  it, or null for a country it does not list. */
export function homeIdSpaceOf(
    discovery: Readonly<Record<string, unknown>>,
    country: string
): { spaceId: string; base: string } | null {
    const spaces = Array.isArray(discovery.spaces) ? discovery.spaces : [];
    const code = country.trim().toUpperCase();
    for (const raw of spaces) {
        const space = spaceSchema.safeParse(raw);
        if (!space.success || space.data.countryCode !== code) continue;
        // Only ever Philips' own backend, whatever the document says.
        const base = backendUrl(space.data.backendBaseUrl).replace(/\/+$/, "");
        return { spaceId: space.data.spaceId, base };
    }
    return null;
}

/** Backend tokens from the sign-in above, by the access token they were made
 *  from: that token is renewed hourly, and with it this is made again. */
const consumers = new Map<string, { token: string; at: number }>();
const CONSUMER_TTL_MS = 30 * 60 * 1000;
const MAX_CONSUMERS = 200;

/** For tests: forget every backend token. */
export function resetHomeIdConsumers(): void {
    consumers.clear();
}

async function consumerToken(
    accessToken: string,
    account: HomeIdAccount,
    spaceId: string
): Promise<string> {
    const known = consumers.get(accessToken);
    if (known && Date.now() - known.at < CONSUMER_TTL_MS) return known.token;
    const headers = homeIdHeaders(accessToken);
    delete headers.authorization;
    const response = await call(`${CONSUMER_LOGIN}?requestLocation=onboarding`, {
        method: "POST",
        headers: {
            ...headers,
            accept: "application/vnd.api+json",
            "content-type": "application/vnd.api+json",
            "api-version": "2.0.0"
        },
        body: JSON.stringify({
            data: {
                type: "consumerLoginRequest",
                attributes: {
                    identityProvider: "DI",
                    token: accessToken,
                    email: account.email,
                    countryCode: account.country.trim().toUpperCase(),
                    spaceId,
                    ...(account.uid ? { userUUID: account.uid } : {})
                }
            }
        }),
        redirect: "manual"
    });
    if (response.status === 401 || response.status === 403) throw signedOut();
    if (!response.ok) throw new HomeIdStatus(response.status);
    const parsed = consumerSchema.safeParse(await json(response));
    if (!parsed.success) throw garbled();
    const token = parsed.data.data.attributes.token;
    if (consumers.size >= MAX_CONSUMERS) {
        for (const [key, entry] of consumers) {
            if (Date.now() - entry.at >= CONSUMER_TTL_MS) consumers.delete(key);
        }
        if (consumers.size >= MAX_CONSUMERS) consumers.clear();
    }
    consumers.set(accessToken, { token, at: Date.now() });
    return token;
}

/**
 * The appliances of an account the way the HomeID app itself reads them: its
 * sign-in to the backend first, then the country's space's own list with the
 * token that answers (`getDeviceList` in ioBroker.nutriu).
 *
 * The community integrations skip the sign-in and hand the backend the Philips
 * token directly (`get_appliances_via_homeid`), which works for most accounts.
 * For some the backend answers that shortcut with a 500 - renaudallard/
 * homeassistant_philips_homeid #32 and #36, cleared there by signing out of the
 * app, in again and re-adding the device: that is, by the app's own sign-in.
 * This is that sign-in, done here, so the reader does not have to.
 */
export async function listHomeIdAppliancesAsApp(
    accessToken: string,
    account: HomeIdAccount
): Promise<unknown[]> {
    const space = homeIdSpaceOf(await homeIdDiscovery(), account.country);
    if (!space) throw new HomeIdStatus(404);
    const token = await consumerToken(accessToken, account, space.spaceId);
    const url = backendQuery(`${space.base}/Profile/self/Appliance`, {
        page: "1",
        size: "50",
        ts: String(Date.now())
    });
    const body = await homeIdGet(url, token);
    if (Array.isArray(body)) return body;
    if (isRecord(body) && isRecord(body._embedded) && Array.isArray(body._embedded.item)) {
        return body._embedded.item;
    }
    return [];
}

/** Whether a HomeID backend failure is the backend failing to build the
 *  answer (a 5xx or a 429), rather than refusing the request. */
function homeIdServerError(caught: unknown): boolean {
    return caught instanceof HomeIdStatus && (caught.status >= 500 || caught.status === 429);
}

/**
 * The HomeID backend's list, the shortcut first and the app's own sign-in
 * after it where the shortcut fails on the backend's side and the account's
 * country is known. Which one answered comes back with the list. Where the
 * app's sign-in fails too, what is thrown is the shortcut's own failure, not
 * the fallback's: the shortcut is the one that was actually asked for.
 */
async function homeIdAppliancesEither(
    accessToken: string,
    account: HomeIdAccount | undefined
): Promise<{ items: unknown[]; viaApp: boolean }> {
    try {
        return { items: await listHomeIdAppliances(accessToken), viaApp: false };
    } catch (caught) {
        if (!account?.country || !homeIdServerError(caught)) throw caught;
        try {
            return { items: await listHomeIdAppliancesAsApp(accessToken, account), viaApp: true };
        } catch {
            throw caught;
        }
    }
}

/** Where a device list was read from, and how it is read again on every sync. */
export type PhilipsSource = "iot" | "homeid-app";

/** One place Polaris looked, as the reader is told about it. */
export interface PhilipsLookup {
    /** Which app's sign-in, and which list. */
    readonly where:
        | "Air+"
        | "HomeID"
        | "HomeID app"
        | "HomeID app sign-in"
        | "HomeID account"
        | "Air+ account"
        | "Philips Air"
        | "Local network";
    /** The IoT region it was asked in (`eu-west-1`), for a list that lives in
     *  one. The HomeID backend and the fan and heater cloud are one for the
     *  whole world, and name none. */
    readonly region?: string;
    /** How many appliances it listed, or null where it could not be read. */
    readonly count: number | null;
    /** Each appliance's model code or type, as Philips wrote it. */
    readonly models: readonly string[];
    /** Why it could not be read: an HTTP status, or that it was not reached. */
    readonly failure?: string;
}

/** What a sign-in found, everywhere it looked, in words with nothing private in
 *  them: no token, no id, no address - counts, model codes and the region each
 *  list was asked in. */
export function philipsLookupSummary(lookups: readonly PhilipsLookup[]): string {
    return lookups
        .map((lookup) => {
            const where = lookup.region ? `${lookup.where} (${lookup.region})` : lookup.where;
            if (lookup.count === null) return `${where}: ${lookup.failure ?? "-"}`;
            const models = lookup.models.slice(0, 8).join(", ");
            const more = lookup.models.length > 8 ? ", ..." : "";
            return lookup.count === 0
                ? `${where}: 0`
                : `${where}: ${lookup.count} (${models}${more})`;
        })
        .join("; ");
}

function failureOf(caught: unknown): string {
    if (caught instanceof HomeIdStatus) return `HTTP ${caught.status}`;
    if (caught instanceof DriverError && caught.kind === "unauthorized") return "HTTP 401/403";
    if (caught instanceof DriverError && caught.kind === "unreachable") return "network";
    return "format";
}

/** The devices of a list that are air devices. */
function airOf(devices: readonly PhilipsCloudDevice[]): PhilipsCloudDevice[] {
    return devices.filter((device) => philipsApplianceKind(device.model) === "air");
}

/** One lookup that read a list, as the reader is told about it. */
export function seenLookup(
    where: PhilipsLookup["where"],
    models: readonly (string | null)[],
    region?: string
): PhilipsLookup {
    return {
        where,
        ...(region ? { region } : {}),
        count: models.length,
        models: models.map((model) => model ?? "?")
    };
}

/** What a sign-in found on Philips' Versuni side, and where. */
export interface PhilipsFound {
    readonly session: PhilipsSession;
    readonly userId: string;
    readonly source: PhilipsSource;
    readonly devices: PhilipsCloudDevice[];
    /** The IoT region the list was read in, which every sync and command uses. */
    readonly region: PhilipsRegion;
    /** For a list read from the HomeID backend: the country its space is, so
     *  a sync can sign in the way the app does when the shortcut fails. */
    readonly homeIdCountry?: string;
}

/** A signed-in account and what was found on it. */
export interface PhilipsDiscovery {
    /** The list to keep reading, or null where no list held anything. */
    readonly found: PhilipsFound | null;
    /** Whether that list holds an air device, rather than kitchen ones only. */
    readonly hasAir: boolean;
    readonly lookups: readonly PhilipsLookup[];
    /** The region asked first: the one the account's country is in. */
    readonly asked: PhilipsRegion;
    /** Every region asked, the first one included. */
    readonly tried: readonly PhilipsRegion[];
    /**
     * Whether the HomeID backend failed with a server error. That is Philips
     * failing to build the account's appliance list, almost always over a
     * broken appliance record on its side; removing the device in the HomeID
     * app and adding it again rebuilds it (renaudallard/
     * homeassistant_philips_homeid, issues #32 and #36). Not a region.
     */
    readonly homeIdBroken: boolean;
}

/** One list read in one region: what the reader is told, and what it held. */
async function registryLookup(
    where: PhilipsLookup["where"],
    session: PhilipsSession,
    region: PhilipsRegion,
    timeoutMs: number = TIMEOUT_MS
): Promise<{ lookup: PhilipsLookup; devices: PhilipsCloudDevice[] }> {
    try {
        const answer = await iotAnswer("/user/self/device", session.accessToken, region, timeoutMs);
        if (answer.body === null) {
            return {
                lookup: {
                    where,
                    region: region.region,
                    count: null,
                    models: [],
                    failure: `HTTP ${answer.status}`
                },
                devices: []
            };
        }
        const devices = unique(deviceItems(answer.body).map(philipsCloudDevice));
        return {
            lookup: seenLookup(
                where,
                devices.map((device) => device.model),
                region.region
            ),
            devices
        };
    } catch (caught) {
        return {
            lookup: {
                where,
                region: region.region,
                count: null,
                models: [],
                failure: failureOf(caught)
            },
            devices: []
        };
    }
}

/**
 * Everywhere a device on this account can be listed on Philips' Versuni side,
 * in order, until one lists an air device:
 *
 * 1. the IoT registry of the account's own region with the Air+ app's token -
 *    a purifier paired in the Air+ app is only shown to that client (both
 *    integrations);
 * 2. the same registry with the HomeID app's token, for one paired there;
 * 3. the HomeID backend's own appliance list with that token (`email_auth.py`'s
 *    last resort, `get_appliances_via_homeid`) - one for the whole world;
 * 4. the registries of every other region known, side by side and briefly,
 *    for an account whose country was picked wrong.
 *
 * A failure in one is noted and the next is tried: what one list refuses
 * another may hold. Where none holds an air device, the first list holding
 * anything at all - a kitchen appliance - is the one kept; where none holds
 * anything, nothing is, and the caller goes on to Philips' third cloud. What
 * was seen in each place comes back either way, for the screen to say.
 */
export async function discoverPhilipsDevices(
    gigyaSession: string,
    airplus: PhilipsSession,
    asked: PhilipsRegion = PHILIPS_EU,
    account?: HomeIdAccount
): Promise<PhilipsDiscovery> {
    const lookups: PhilipsLookup[] = [];
    const tried: PhilipsRegion[] = [asked];
    /** Sessions the IoT API of a region would not name the account for:
     *  asked once each. */
    const refused = new Set<string>();
    const refusal = (session: PhilipsSession, region: PhilipsRegion) =>
        `${session.client} ${region.api}`;
    const candidates: {
        session: PhilipsSession;
        source: PhilipsSource;
        devices: PhilipsCloudDevice[];
        region: PhilipsRegion;
        homeIdCountry?: string;
    }[] = [];

    const answer = (found: PhilipsFound | null, hasAir: boolean): PhilipsDiscovery => ({
        found,
        hasAir,
        lookups,
        asked,
        tried,
        // Broken only while nothing on the backend answered: the app's own
        // sign-in reading the list clears what the shortcut's failure said.
        homeIdBroken:
            lookups.some(
                (lookup) =>
                    lookup.where === "HomeID app" && /^HTTP 5\d\d$/.test(lookup.failure ?? "")
            ) &&
            !lookups.some(
                (lookup) => lookup.where === "HomeID app sign-in" && lookup.count !== null
            )
    });
    /** The country a list read from the HomeID backend is kept with. */
    const homeIdCountry = account?.country ? { homeIdCountry: account.country } : {};
    const air = async (
        session: PhilipsSession,
        source: PhilipsSource,
        devices: PhilipsCloudDevice[],
        region: PhilipsRegion
    ) => {
        const userId = await philipsUserId(session.accessToken, region);
        const kept = source === "homeid-app" ? homeIdCountry : {};
        return answer({ session, userId, source, devices, region, ...kept }, true);
    };
    const registry = async (
        where: PhilipsLookup["where"],
        session: PhilipsSession,
        region: PhilipsRegion
    ) => {
        const read = await registryLookup(where, session, region);
        lookups.push(read.lookup);
        candidates.push({ session, source: "iot", devices: read.devices, region });
        return read.devices;
    };

    const fromAirplus = await registry("Air+", airplus, asked);
    if (airOf(fromAirplus).length > 0) return air(airplus, "iot", fromAirplus, asked);

    let homeid: PhilipsSession | null = null;
    try {
        homeid = await tokensFor(gigyaSession, "homeid");
    } catch (caught) {
        const failure = failureOf(caught);
        lookups.push({ where: "HomeID", region: asked.region, count: null, models: [], failure });
        lookups.push({ where: "HomeID app", count: null, models: [], failure });
    }
    if (homeid) {
        const fromHomeId = await registry("HomeID", homeid, asked);
        if (airOf(fromHomeId).length > 0) return air(homeid, "iot", fromHomeId, asked);
        let fromApp: PhilipsCloudDevice[] = [];
        try {
            fromApp = unique(
                (await listHomeIdAppliances(homeid.accessToken)).map(philipsHomeIdAppliance)
            );
            lookups.push(
                seenLookup(
                    "HomeID app",
                    fromApp.map((device) => device.model)
                )
            );
        } catch (caught) {
            lookups.push({
                where: "HomeID app",
                count: null,
                models: [],
                failure: failureOf(caught)
            });
            // The backend failing on the shortcut: the app's own sign-in, which
            // is what clears that for the community integrations' users.
            if (account?.country && homeIdServerError(caught)) {
                try {
                    fromApp = unique(
                        (await listHomeIdAppliancesAsApp(homeid.accessToken, account)).map(
                            philipsHomeIdAppliance
                        )
                    );
                    lookups.push(
                        seenLookup(
                            "HomeID app sign-in",
                            fromApp.map((device) => device.model)
                        )
                    );
                } catch (again) {
                    lookups.push({
                        where: "HomeID app sign-in",
                        count: null,
                        models: [],
                        failure: failureOf(again)
                    });
                }
            }
        }
        candidates.push({
            session: homeid,
            source: "homeid-app",
            devices: fromApp,
            region: asked,
            ...homeIdCountry
        });
        if (airOf(fromApp).length > 0) {
            try {
                return await air(homeid, "homeid-app", fromApp, asked);
            } catch (caught) {
                refused.add(refusal(homeid, asked));
                lookups.push({
                    where: "HomeID account",
                    region: asked.region,
                    count: null,
                    models: [],
                    failure: failureOf(caught)
                });
            }
        }
    }

    // Nothing in the account's own region: every other region known, all at
    // once and briefly, read back in a fixed order so the first that holds an
    // air device wins the same way every time.
    const others = otherPhilipsRegions([asked]);
    tried.push(...others);
    const sessions: [PhilipsLookup["where"], PhilipsSession][] = [["Air+", airplus]];
    if (homeid) sessions.push(["HomeID", homeid]);
    const elsewhere = await Promise.all(
        others.flatMap((region) =>
            sessions.map(async ([where, session]) => ({
                region,
                session,
                read: await registryLookup(where, session, region, FALLBACK_TIMEOUT_MS)
            }))
        )
    );
    for (const { region, session, read } of elsewhere) {
        lookups.push(read.lookup);
        candidates.push({ session, source: "iot", devices: read.devices, region });
    }
    for (const { region, session, read } of elsewhere) {
        if (airOf(read.devices).length === 0) continue;
        try {
            return await air(session, "iot", read.devices, region);
        } catch (caught) {
            refused.add(refusal(session, region));
            lookups.push({
                where: session === airplus ? "Air+ account" : "HomeID account",
                region: region.region,
                count: null,
                models: [],
                failure: failureOf(caught)
            });
        }
    }

    // No air device anywhere it could be driven from: keep the first list that
    // holds anything at all - a kitchen appliance - which goes over the same
    // link.
    for (const candidate of candidates) {
        const key = refusal(candidate.session, candidate.region);
        if (candidate.devices.length === 0 || refused.has(key)) continue;
        try {
            const userId = await philipsUserId(candidate.session.accessToken, candidate.region);
            return answer({ ...candidate, userId }, airOf(candidate.devices).length > 0);
        } catch (caught) {
            refused.add(key);
            lookups.push({
                where: candidate.session === airplus ? "Air+ account" : "HomeID account",
                region: candidate.region.region,
                count: null,
                models: [],
                failure: failureOf(caught)
            });
        }
    }
    return answer(null, false);
}

/** The devices of a connection, from where it found them when it was made. */
export async function listPhilipsSource(
    accessToken: string,
    source: PhilipsSource,
    region: PhilipsRegion = PHILIPS_EU,
    account?: HomeIdAccount
): Promise<PhilipsCloudDevice[]> {
    if (source === "iot") return listPhilipsDevices(accessToken, region);
    try {
        const { items } = await homeIdAppliancesEither(accessToken, account);
        return unique(items.map(philipsHomeIdAppliance));
    } catch (caught) {
        if (caught instanceof HomeIdStatus) {
            throw caught.status >= 500 ? unreachable() : garbled();
        }
        throw caught;
    }
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
