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
        vToken: z.string().max(4000).optional(),
        sessionInfo: z.object({ cookieValue: z.string().max(4000).optional() }).optional(),
        gmidTicket: z.string().max(4000).optional(),
        UID: z.string().max(200).optional()
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
            "That code is not right or has expired. Ask for a new one.",
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

async function iot(path: string, accessToken: string): Promise<unknown> {
    const response = await call(`${IOT}${path}`, {
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
    accessToken: string
): Promise<{ status: number; body: unknown }> {
    const response = await call(`${IOT}${path}`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    });
    if (!response.ok) return { status: response.status, body: null };
    return { status: response.status, body: await json(response) };
}

export async function listPhilipsDevices(accessToken: string): Promise<PhilipsCloudDevice[]> {
    return unique(deviceItems(await iot("/user/self/device", accessToken)).map(philipsCloudDevice));
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

/**
 * The appliances the HomeID backend lists for an account: its discovery
 * document names the profile, the profile embeds the appliances or links to
 * them, and the link is read with skipped pairings included - the chain of
 * `get_appliances_via_homeid` in the HomeID integration, which the Air+
 * integration also falls back to.
 */
export async function listHomeIdAppliances(accessToken: string): Promise<unknown[]> {
    const discoveryResponse = await call(`${HOMEID_BACKEND}/.well-known/tenant/oneka`);
    if (!discoveryResponse.ok) throw new HomeIdStatus(discoveryResponse.status);
    const discovery = await json(discoveryResponse);
    const profileUrl = isRecord(discovery) ? discovery.profileUrl : undefined;
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

/** Where a device list was read from, and how it is read again on every sync. */
export type PhilipsSource = "iot" | "homeid-app";

/** One place Polaris looked, as the reader is told about it. */
export interface PhilipsLookup {
    /** Which app's sign-in, and which list. */
    readonly where:
        | "Air+"
        | "HomeID"
        | "HomeID app"
        | "HomeID account"
        | "Air+ account"
        | "Philips Air";
    /** How many appliances it listed, or null where it could not be read. */
    readonly count: number | null;
    /** Each appliance's model code or type, as Philips wrote it. */
    readonly models: readonly string[];
    /** Why it could not be read: an HTTP status, or that it was not reached. */
    readonly failure?: string;
}

/** What a sign-in found, everywhere it looked, in words with nothing private in
 *  them: no token, no id, no address - counts and model codes only. */
export function philipsLookupSummary(lookups: readonly PhilipsLookup[]): string {
    return lookups
        .map((lookup) => {
            if (lookup.count === null) return `${lookup.where}: ${lookup.failure ?? "-"}`;
            const models = lookup.models.slice(0, 8).join(", ");
            const more = lookup.models.length > 8 ? ", ..." : "";
            return lookup.count === 0
                ? `${lookup.where}: 0`
                : `${lookup.where}: ${lookup.count} (${models}${more})`;
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
    models: readonly (string | null)[]
): PhilipsLookup {
    return { where, count: models.length, models: models.map((model) => model ?? "?") };
}

/** What a sign-in found on Philips' Versuni side, and where. */
export interface PhilipsFound {
    readonly session: PhilipsSession;
    readonly userId: string;
    readonly source: PhilipsSource;
    readonly devices: PhilipsCloudDevice[];
}

/** A signed-in account and what was found on it. */
export interface PhilipsDiscovery {
    /** The list to keep reading, or null where no list held anything. */
    readonly found: PhilipsFound | null;
    /** Whether that list holds an air device, rather than kitchen ones only. */
    readonly hasAir: boolean;
    readonly lookups: readonly PhilipsLookup[];
}

/**
 * Everywhere a device on this account can be listed on Philips' Versuni side,
 * in order, until one lists an air device:
 *
 * 1. the IoT registry with the Air+ app's token - a purifier paired in the Air+
 *    app is only shown to that client (both integrations);
 * 2. the IoT registry with the HomeID app's token, for one paired there;
 * 3. the HomeID backend's own appliance list with that token (`email_auth.py`'s
 *    last resort, `get_appliances_via_homeid`).
 *
 * A failure in one is noted and the next is tried: what one list refuses
 * another may hold. Where none holds an air device, the first list holding
 * anything at all - a kitchen appliance - is the one kept; where none holds
 * anything, nothing is, and the caller goes on to Philips' third cloud. What
 * was seen in each place comes back either way, for the screen to say.
 */
export async function discoverPhilipsDevices(
    gigyaSession: string,
    airplus: PhilipsSession
): Promise<PhilipsDiscovery> {
    const lookups: PhilipsLookup[] = [];
    /** Sessions the IoT API would not name the account for: asked once. */
    const refused = new Set<PhilipsSession>();
    const candidates: {
        session: PhilipsSession;
        source: PhilipsSource;
        devices: PhilipsCloudDevice[];
    }[] = [];

    const registry = async (
        where: PhilipsLookup["where"],
        session: PhilipsSession
    ): Promise<PhilipsCloudDevice[]> => {
        try {
            const answer = await iotAnswer("/user/self/device", session.accessToken);
            if (answer.body === null) {
                lookups.push({ where, count: null, models: [], failure: `HTTP ${answer.status}` });
                return [];
            }
            const devices = unique(deviceItems(answer.body).map(philipsCloudDevice));
            lookups.push(
                seenLookup(
                    where,
                    devices.map((device) => device.model)
                )
            );
            return devices;
        } catch (caught) {
            lookups.push({ where, count: null, models: [], failure: failureOf(caught) });
            return [];
        }
    };

    const fromAirplus = await registry("Air+", airplus);
    candidates.push({ session: airplus, source: "iot", devices: fromAirplus });
    if (airOf(fromAirplus).length > 0) {
        const userId = await philipsUserId(airplus.accessToken);
        return {
            found: { session: airplus, userId, source: "iot", devices: fromAirplus },
            hasAir: true,
            lookups
        };
    }

    let homeid: PhilipsSession | null = null;
    try {
        homeid = await tokensFor(gigyaSession, "homeid");
    } catch (caught) {
        const failure = failureOf(caught);
        lookups.push({ where: "HomeID", count: null, models: [], failure });
        lookups.push({ where: "HomeID app", count: null, models: [], failure });
    }
    if (homeid) {
        const fromHomeId = await registry("HomeID", homeid);
        candidates.push({ session: homeid, source: "iot", devices: fromHomeId });
        if (airOf(fromHomeId).length > 0) {
            const userId = await philipsUserId(homeid.accessToken);
            return {
                found: { session: homeid, userId, source: "iot", devices: fromHomeId },
                hasAir: true,
                lookups
            };
        }
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
        }
        candidates.push({ session: homeid, source: "homeid-app", devices: fromApp });
        if (airOf(fromApp).length > 0) {
            try {
                const userId = await philipsUserId(homeid.accessToken);
                return {
                    found: { session: homeid, userId, source: "homeid-app", devices: fromApp },
                    hasAir: true,
                    lookups
                };
            } catch (caught) {
                refused.add(homeid);
                lookups.push({
                    where: "HomeID account",
                    count: null,
                    models: [],
                    failure: failureOf(caught)
                });
            }
        }
    }

    // No air device anywhere it could be driven from: keep the first list that
    // holds anything at all - a kitchen appliance - which goes over the same
    // link.
    for (const candidate of candidates) {
        if (candidate.devices.length === 0 || refused.has(candidate.session)) continue;
        try {
            const userId = await philipsUserId(candidate.session.accessToken);
            return {
                found: { ...candidate, userId },
                hasAir: airOf(candidate.devices).length > 0,
                lookups
            };
        } catch (caught) {
            refused.add(candidate.session);
            lookups.push({
                where: candidate.session === airplus ? "Air+ account" : "HomeID account",
                count: null,
                models: [],
                failure: failureOf(caught)
            });
        }
    }
    return { found: null, hasAir: false, lookups };
}

/** The devices of a connection, from where it found them when it was made. */
export async function listPhilipsSource(
    accessToken: string,
    source: PhilipsSource
): Promise<PhilipsCloudDevice[]> {
    if (source === "iot") return listPhilipsDevices(accessToken);
    try {
        return unique((await listHomeIdAppliances(accessToken)).map(philipsHomeIdAppliance));
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
