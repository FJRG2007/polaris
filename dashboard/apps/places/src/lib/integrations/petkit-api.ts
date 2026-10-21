/**
 * The PETKIT cloud, as their phone app speaks it.
 *
 * PETKIT publishes no API. What is here is the protocol as the community
 * library `pypetkitapi` (Jezza34000/py-petkit-api, MIT licence) documents it
 * by speaking it, and as the Home Assistant integration built on it
 * (Jezza34000/homeassistant_petkit, MIT licence) drives a litter box with it.
 * Reimplemented from that behaviour, not copied:
 *
 * - https://github.com/Jezza34000/py-petkit-api/blob/main/pypetkitapi/const.py
 *   `PetkitDomain`, `PetkitEndpoint`, `Header`, `CLIENT_NFO`, `LOGIN_DATA`,
 *   the device type codes (`T3` ... `T7` are litter boxes).
 * - https://github.com/Jezza34000/py-petkit-api/blob/main/pypetkitapi/client.py
 *   `_get_base_url` (region -> gateway), `login`, `refresh_session`,
 *   `get_session_id` (the `F-Session` / `X-Session` headers), `_generate_header`,
 *   `_handle_response` (the `result` / `error.code` envelope), `_get_account_data`.
 * - https://github.com/Jezza34000/py-petkit-api/blob/main/pypetkitapi/litter_container.py
 *   `Litter` (`device_detail?id=`), `StateLitter`, `SettingsLitter`,
 *   `LitterRecord` (`getDeviceRecord` with `date`, `day` on a T3,
 *   `getDeviceRecordRelease` with `timestamp` and `type` on a T5/T6).
 * - https://github.com/Jezza34000/py-petkit-api/blob/main/pypetkitapi/command.py
 *   `controlDevice` (`id`, `kv` as JSON, `type` = the first word of the key),
 *   `updateSettings` (`id`, `kv`), `deodorantReset` (`deviceId`), `LBCommand`
 *   (0 clean, 1 dump, 2 deodorize, 9 maintenance, 10 N60 reset) and the
 *   `start_action` / `stop_action` / `continue_action` / `end_action` keys.
 *
 * The wire, as taken from there:
 *
 * - `GET https://passport.petkt.com/v1/regionservers` lists `{ id, name,
 *   gateway, accountType }`; the account's country (`id`, an ISO code) picks
 *   the gateway every later call goes to. China is `https://api.petkit.cn/6/`,
 *   which that list leaves out.
 * - `POST {gateway}user/login`, form-encoded: `oldVersion`, `client` (the
 *   phone's description, as Python prints a dict), `encrypt=1`, `region`,
 *   `username`, `password` = MD5 hex of the password. Answers `{ result: {
 *   session: { id, userId, expiresIn, createdAt } } }`.
 * - Every later call carries `F-Session` and `X-Session` with the session id.
 * - `GET group/family/list` -> `[{ groupId, deviceList: [{ deviceId,
 *   deviceType, deviceName, typeCode, ... }] }]`.
 * - `POST {type}/device_detail?id=` -> the unit, with `state` and `settings`.
 * - An error is `{ error: { code, msg } }`: 5 a session that has ended, 122 a
 *   refused password, 125 an address nobody registered, 1 a busy server.
 *
 * Their sign-in is one session per account: signing in here signs the phone
 * app out of the same account, which is why their own guidance is a second
 * PETKIT account the devices are shared with. The connection says so.
 *
 * Server-only. Nothing here logs a credential or a session.
 */

import { createHash } from "node:crypto";

export const PETKIT_PASSPORT = "https://passport.petkt.com/";
export const PETKIT_CHINA = "https://api.petkit.cn/6/";

/** The types a litter box reports as (`DEVICES_LITTER_BOX`). Which of them a
 *  given box is - a Pura Max is a `t4` - is the account's to say, never
 *  assumed from its name on the box. */
export const LITTER_TYPES = ["t3", "t4", "t5", "t6", "t7"] as const;
export type LitterType = (typeof LITTER_TYPES)[number];

const API_VERSION = "13.2.1";
const CLIENT = {
    locale: "en-US",
    name: "23127PN0CG",
    osVersion: "16.1",
    phoneBrand: "Xiaomi",
    platform: "android",
    source: "app.petkit-android",
    version: API_VERSION
} as const;
const TIMEOUT_MS = 20_000;

/** Why a call failed, sorted the way a caller has to act on it. */
export type PetkitFailure = "expired" | "unauthorized" | "busy" | "unreachable" | "refused";

export class PetkitError extends Error {
    readonly failure: PetkitFailure;
    readonly code: number | null;

    constructor(message: string, failure: PetkitFailure, code: number | null = null) {
        super(message);
        this.name = "PetkitError";
        this.failure = failure;
        this.code = code;
    }
}

export interface PetkitSession {
    readonly id: string;
    readonly gateway: string;
    /** When it lapses, in epoch milliseconds. */
    readonly until: number;
}

export interface PetkitAccount {
    readonly email: string;
    /** The MD5 hex of the password, which is what their sign-in takes. */
    readonly passwordMd5: string;
    /** The ISO country the account was made in, as their app asks it. */
    readonly country: string;
    readonly timezone: string;
}

export type Fetcher = typeof fetch;

export function md5(text: string): string {
    return createHash("md5").update(text, "utf8").digest("hex");
}

/** The zone's offset from UTC in hours, written the way Python prints a float
 *  ("1.0", "5.5", "-3.0"), which is what their app sends. */
export function timezoneOffset(timezone: string, at: Date = new Date()): string {
    let hours = 0;
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        }).formatToParts(at);
        const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
        const local = Date.UTC(
            part("year"),
            part("month") - 1,
            part("day"),
            part("hour"),
            part("minute"),
            part("second")
        );
        hours = Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60_000) / 60;
    } catch {
        hours = 0;
    }
    return Number.isInteger(hours) ? `${hours}.0` : String(hours);
}

/** The phone's description, as `str(dict)` prints it in Python - single quotes
 *  and all - since that is the form their sign-in has always been sent. */
export function clientDescription(timezone: string, at: Date = new Date()): string {
    const fields: [string, string][] = [
        ...Object.entries(CLIENT),
        ["timezoneId", timezone],
        ["timezone", timezoneOffset(timezone, at)]
    ];
    const quote = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    return `{${fields.map(([key, value]) => `${quote(key)}: ${quote(value)}`).join(", ")}}`;
}

function headers(timezone: string, session?: PetkitSession): Record<string, string> {
    return {
        Accept: "*/*",
        "Accept-Language": "en-US;q=1, it-US;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "okhttp/3.14.9",
        "X-Img-Version": "1",
        "X-Locale": "en-US",
        "X-Client": `${CLIENT.platform}(${CLIENT.osVersion};${CLIENT.name})`,
        "X-Hour": "24",
        "X-TimezoneId": timezone,
        "X-Api-Version": API_VERSION,
        "X-Timezone": timezoneOffset(timezone),
        ...(session ? { "F-Session": session.id, "X-Session": session.id } : {})
    };
}

interface CallOptions {
    readonly method: "GET" | "POST";
    readonly query?: Readonly<Record<string, string | number>>;
    readonly form?: Readonly<Record<string, string | number>>;
    readonly session?: PetkitSession;
    readonly timezone: string;
}

function encode(values: Readonly<Record<string, string | number>>): string {
    return new URLSearchParams(
        Object.entries(values).map(([key, value]) => [key, String(value)])
    ).toString();
}

/** One call, unwrapped from their envelope or thrown as a `PetkitError`. */
async function call(
    fetcher: Fetcher,
    base: string,
    path: string,
    options: CallOptions
): Promise<unknown> {
    const query = options.query ? `?${encode(options.query)}` : "";
    let response: Response;
    try {
        response = await fetcher(`${base}${path}${query}`, {
            method: options.method,
            headers: headers(options.timezone, options.session),
            body: options.form ? encode(options.form) : undefined,
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch {
        throw new PetkitError("PETKIT's servers did not answer", "unreachable");
    }
    if (response.status >= 500) throw new PetkitError("PETKIT's servers are busy", "busy");
    if (!response.ok) throw new PetkitError(`PETKIT answered HTTP ${response.status}`, "refused");
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new PetkitError("PETKIT answered in a shape Polaris does not read", "refused");
    }
    return unwrap(body);
}

/** Their `{ result }` / `{ error: { code, msg } }` envelope. */
export function unwrap(body: unknown): unknown {
    const record = asRecord(body);
    if (!record) throw new PetkitError("PETKIT answered in a shape Polaris does not read", "refused");
    const error = asRecord(record.error);
    if (error) {
        const code = Number(error.code ?? 0);
        const said = typeof error.msg === "string" ? error.msg.slice(0, 200) : "";
        if (code === 5) throw new PetkitError("The PETKIT sign-in has ended", "expired", code);
        if (code === 122)
            throw new PetkitError("PETKIT refused that email and password", "unauthorized", code);
        if (code === 125)
            throw new PetkitError("PETKIT has no account with that email", "unauthorized", code);
        if (code === 1) throw new PetkitError("PETKIT's servers are busy", "busy", code);
        throw new PetkitError(
            said ? `PETKIT refused it: ${said}` : `PETKIT refused it (code ${code})`,
            "refused",
            code
        );
    }
    if (!("result" in record))
        throw new PetkitError("PETKIT answered in a shape Polaris does not read", "refused");
    return record.result;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/** The gateway the account's country is served from. */
export async function gatewayFor(
    fetcher: Fetcher,
    country: string,
    timezone: string
): Promise<string> {
    const code = country.trim().toLowerCase();
    if (code === "cn" || code === "china") return PETKIT_CHINA;
    const result = asRecord(
        await call(fetcher, PETKIT_PASSPORT, "v1/regionservers", { method: "GET", timezone })
    );
    const list = Array.isArray(result?.list) ? result.list : [];
    for (const entry of list) {
        const server = asRecord(entry);
        if (!server || typeof server.gateway !== "string") continue;
        const id = String(server.id ?? "").toLowerCase();
        const name = String(server.name ?? "").toLowerCase();
        if ((id === code || name === code) && /^https:\/\//.test(server.gateway)) {
            return server.gateway.endsWith("/") ? server.gateway : `${server.gateway}/`;
        }
    }
    throw new PetkitError("PETKIT has no servers for that country", "refused");
}

/** The session out of a sign-in's answer. */
export function sessionOf(result: unknown, gateway: string, now: number = Date.now()): PetkitSession {
    const session = asRecord(asRecord(result)?.session);
    const id = typeof session?.id === "string" ? session.id : "";
    const expiresIn = Number(session?.expiresIn ?? 0);
    if (!id || !Number.isFinite(expiresIn) || expiresIn <= 0)
        throw new PetkitError("PETKIT answered in a shape Polaris does not read", "refused");
    return { id, gateway, until: now + expiresIn * 1000 };
}

export async function login(fetcher: Fetcher, account: PetkitAccount): Promise<PetkitSession> {
    const gateway = await gatewayFor(fetcher, account.country, account.timezone);
    const result = await call(fetcher, gateway, "user/login", {
        method: "POST",
        timezone: account.timezone,
        form: {
            oldVersion: API_VERSION,
            client: clientDescription(account.timezone),
            encrypt: "1",
            region: account.country.trim().toLowerCase(),
            username: account.email,
            password: account.passwordMd5
        }
    });
    return sessionOf(result, gateway);
}

/** One device on the account, as the family list names it. */
export interface PetkitDevice {
    readonly id: number;
    readonly type: string;
    readonly typeCode: number;
    readonly name: string;
}

/** Every device in every family the account belongs to, owned or shared. */
export function devicesOf(result: unknown): PetkitDevice[] {
    const families = Array.isArray(result) ? result : [];
    const seen = new Map<number, PetkitDevice>();
    for (const family of families) {
        const list = asRecord(family)?.deviceList;
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            const device = asRecord(entry);
            const id = Number(device?.deviceId);
            const type = typeof device?.deviceType === "string" ? device.deviceType.toLowerCase() : "";
            if (!device || !Number.isSafeInteger(id) || !type) continue;
            const name = typeof device.deviceName === "string" ? device.deviceName.trim() : "";
            seen.set(id, { id, type, typeCode: Number(device.typeCode ?? 0) || 0, name });
        }
    }
    return [...seen.values()];
}

export async function listDevices(
    fetcher: Fetcher,
    session: PetkitSession,
    timezone: string
): Promise<PetkitDevice[]> {
    return devicesOf(
        await call(fetcher, session.gateway, "group/family/list", {
            method: "GET",
            session,
            timezone
        })
    );
}

export function isLitterType(type: string): type is LitterType {
    return (LITTER_TYPES as readonly string[]).includes(type);
}

/** Path segments are the device's own type code, so only ever one of ours. */
function prefix(type: string): LitterType {
    if (!isLitterType(type)) throw new PetkitError("That is not a litter box", "refused");
    return type;
}

export async function deviceDetail(
    fetcher: Fetcher,
    session: PetkitSession,
    timezone: string,
    device: { readonly id: number; readonly type: string }
): Promise<Record<string, unknown>> {
    const result = await call(fetcher, session.gateway, `${prefix(device.type)}/device_detail`, {
        method: "POST",
        query: { id: device.id },
        session,
        timezone
    });
    const record = asRecord(result);
    if (!record) throw new PetkitError("PETKIT answered in a shape Polaris does not read", "refused");
    return record;
}

/** YYYYMMDD in the zone the account reads its day in. */
export function dayStamp(timezone: string, at: Date = new Date()): string {
    try {
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        })
            .format(at)
            .replace(/-/g, "");
    } catch {
        return at.toISOString().slice(0, 10).replace(/-/g, "");
    }
}

/** Where today's visits are read from, and with what, per type. */
export function recordsRequest(
    device: { readonly id: number; readonly type: string; readonly typeCode: number },
    timezone: string,
    at: Date = new Date()
): { path: string; query: Record<string, string | number> } {
    const type = prefix(device.type);
    if (type === "t5" || type === "t6")
        return {
            path: `${type}/getDeviceRecordRelease`,
            query: {
                timestamp: Math.floor(at.getTime() / 1000),
                deviceId: device.id,
                type: device.typeCode
            }
        };
    return {
        path: `${type}/getDeviceRecord`,
        query: { [type === "t3" ? "day" : "date"]: Number(dayStamp(timezone, at)), deviceId: device.id }
    };
}

export async function deviceRecords(
    fetcher: Fetcher,
    session: PetkitSession,
    timezone: string,
    device: { readonly id: number; readonly type: string; readonly typeCode: number }
): Promise<unknown[]> {
    const request = recordsRequest(device, timezone);
    const result = await call(fetcher, session.gateway, request.path, {
        method: "POST",
        query: request.query,
        session,
        timezone
    });
    if (Array.isArray(result)) return result;
    const list = asRecord(result)?.list;
    return Array.isArray(list) ? list : [];
}

/** What `controlDevice` is sent: the key's first word is its `type`. */
export function controlForm(
    id: number,
    key: "start_action" | "stop_action" | "continue_action" | "end_action",
    value: number
): Record<string, string | number> {
    return { id, kv: JSON.stringify({ [key]: value }), type: key.split("_")[0]! };
}

export async function controlDevice(
    fetcher: Fetcher,
    session: PetkitSession,
    timezone: string,
    device: { readonly id: number; readonly type: string },
    key: "start_action" | "stop_action" | "continue_action" | "end_action",
    value: number
): Promise<void> {
    await call(fetcher, session.gateway, `${prefix(device.type)}/controlDevice`, {
        method: "POST",
        form: controlForm(device.id, key, value),
        session,
        timezone
    });
}

export async function updateSettings(
    fetcher: Fetcher,
    session: PetkitSession,
    timezone: string,
    device: { readonly id: number; readonly type: string },
    kv: Readonly<Record<string, number>>
): Promise<void> {
    await call(fetcher, session.gateway, `${prefix(device.type)}/updateSettings`, {
        method: "POST",
        form: { id: device.id, kv: JSON.stringify(kv) },
        session,
        timezone
    });
}

/** The N50 deodorizer's counter back to full (`deodorantReset`). */
export async function resetDeodorant(
    fetcher: Fetcher,
    session: PetkitSession,
    timezone: string,
    device: { readonly id: number; readonly type: string }
): Promise<void> {
    await call(fetcher, session.gateway, `${prefix(device.type)}/deodorantReset`, {
        method: "POST",
        form: { deviceId: device.id },
        session,
        timezone
    });
}
