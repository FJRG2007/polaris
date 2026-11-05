/**
 * The MSmartHome cloud: the account a Comfee or Midea appliance is added to in
 * the MSmartHome app, read for the appliances on it and the token and key each
 * one's local handshake needs.
 *
 * A port of midea-local's `SmartHomeCloud` and `MSmartCloudSecurity` (MIT,
 * github.com/midea-lan/midea-local, `cloud.py` and `security.py`): the route
 * lookup, the login id, the login with both password hashes, the appliance list
 * and `getToken` for both of the UDP id forms. The app id, key, IoT key and HMAC
 * key are the MSmartHome app's own public constants, as `SUPPORTED_CLOUDS
 * ["SmartHome"]` in `cloud.py` writes them - not a secret of anybody's.
 *
 * The cloud is only how a unit is found and how its key is fetched. Commands go
 * to the unit on the local network (`midea-lan.ts`): midea-local has no way to
 * send one through this cloud, and nothing here invents one.
 *
 * Server-only.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const fromDecimal = (value: string) =>
    Buffer.from(BigInt(value).toString(16), "hex").toString("ascii");

/** `SUPPORTED_CLOUDS["SmartHome"]` in midea-local's `cloud.py`. */
export const MSMART_HOME = {
    appId: "1010",
    appKey: "ac21b9f9cbfe4ca5a88562ef25e2b768",
    iotKey: fromDecimal("7882822598523843940"),
    hmacKey: fromDecimal("117390035944627627450677220413733956185864939010425"),
    apiUrl: "https://mp-prod.appsmb.com/mas/v5/app/proxy"
} as const;

const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const md5Hex = (text: string) => createHash("md5").update(text, "utf8").digest("hex");

/** `CloudSecurity.get_deviceid`: the id this client signs in as, per account. */
export function cloudDeviceId(account: string): string {
    return sha256Hex(`Hello, ${account}!`).slice(0, 16);
}

/** `CloudSecurity.encrypt_password`. */
export function encryptPassword(loginId: string, password: string): string {
    return sha256Hex(`${loginId}${sha256Hex(password)}${MSMART_HOME.appKey}`);
}

/** `MSmartCloudSecurity.encrypt_iam_password`. */
export function encryptIamPassword(loginId: string, password: string): string {
    return sha256Hex(`${loginId}${md5Hex(md5Hex(password))}${MSMART_HOME.appKey}`);
}

/** `CloudSecurity.sign`: HMAC-SHA256 of the IoT key, the body and the random. */
export function sign(body: string, random: string): string {
    return createHmac("sha256", MSMART_HOME.hmacKey)
        .update(`${MSMART_HOME.iotKey}${body}${random}`)
        .digest("hex");
}

/** `CloudSecurity.get_udp_id` for methods 1 (big-endian) and 2 (little). */
export function udpId(applianceId: bigint, method: 1 | 2): string {
    const id = Buffer.alloc(8);
    id.writeBigUInt64BE(applianceId);
    const six = id.subarray(2);
    const digest = createHash("sha256")
        .update(method === 1 ? six : Buffer.from(six).reverse())
        .digest();
    for (let i = 0; i < 16; i++) digest[i]! ^= digest[i + 16]!;
    return digest.subarray(0, 16).toString("hex");
}

function appKeyCipher(): { key: Buffer; iv: Buffer } {
    const digest = sha256Hex(MSMART_HOME.appKey);
    return {
        key: Buffer.from(digest.slice(0, 16), "ascii"),
        iv: Buffer.from(digest.slice(16, 32), "ascii")
    };
}

function cbcEncrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
    const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
    return Buffer.concat([cipher.update(data), cipher.final()]);
}

function cbcDecrypt(key: Buffer, iv: Buffer, hex: string): string {
    const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
    return Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]).toString(
        "utf8"
    );
}

/** `MSmartCloudSecurity.encrypt_account`. */
export function encryptAccount(account: string): string {
    const { key, iv } = appKeyCipher();
    return cbcEncrypt(key, iv, Buffer.from(account, "utf8")).toString("hex");
}

export interface SessionKeys {
    readonly key: string;
    readonly iv: string;
}

/** `MSmartCloudSecurity.set_aes_keys`: the session's own key and IV, out of
 *  what the login answered. */
export function sessionKeys(accessToken: string, randomData: string): SessionKeys {
    const { key, iv } = appKeyCipher();
    return { key: cbcDecrypt(key, iv, accessToken), iv: cbcDecrypt(key, iv, randomData) };
}

/** `CloudSecurity.aes_decrypt` with the session's key, as a serial is read. */
export function decryptWithSession(keys: SessionKeys, hex: string): string {
    if (!hex) return "";
    return cbcDecrypt(Buffer.from(keys.key, "ascii"), Buffer.from(keys.iv, "ascii"), hex);
}

/**
 * What went wrong with the cloud, sorted the way the driver has to answer it.
 * The codes are midea-local's (`exceptions.CLOUD_ERRORS`).
 */
export class MideaCloudError extends Error {
    readonly reason: "password" | "locked" | "crowded" | "unreachable" | "refused";
    readonly code: number | null;

    constructor(message: string, reason: MideaCloudError["reason"], code: number | null = null) {
        super(message);
        this.name = "MideaCloudError";
        this.reason = reason;
        this.code = code;
    }
}

function cloudFailure(code: number, message: string): MideaCloudError {
    if (code === 3101 || code === 3102)
        return new MideaCloudError("MSmartHome refused that email or password.", "password", code);
    if (code === 3106 || code === 3144)
        return new MideaCloudError(
            "MSmartHome ended the sign-in. Sign in again.",
            "password",
            code
        );
    if (code === 7610)
        return new MideaCloudError(
            "MSmartHome locked the account for about five minutes after too many tries. Try again then.",
            "locked",
            code
        );
    if (code === 65027)
        return new MideaCloudError(
            "Too many phones and apps are signed in to that MSmartHome account. Sign out of one and try again.",
            "crowded",
            code
        );
    if (code === 3201)
        return new MideaCloudError(
            "That appliance belongs to another MSmartHome account.",
            "refused",
            code
        );
    return new MideaCloudError(
        `MSmartHome answered with error ${code}${message ? ` (${message})` : ""}.`,
        "refused",
        code
    );
}

export type Fetcher = typeof fetch;

let fetcher: Fetcher = (input, init) => fetch(input, init);

/** Replace how the cloud is called; for tests. No argument restores it. */
export function setMideaFetcher(next?: Fetcher): void {
    fetcher = next ?? ((input, init) => fetch(input, init));
}

let pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Replace the back-off between retries; for tests. */
export function setMideaPause(next?: (ms: number) => Promise<void>): void {
    pause = next ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

/** A signed-in MSmartHome session. Kept only for the length of one sync. */
export interface MideaSession {
    readonly apiUrl: string;
    readonly account: string;
    readonly uid: string | null;
    readonly accessToken: string | null;
    readonly keys: SessionKeys | null;
}

function stamp(): string {
    return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** `MideaCloud._make_general_data`. */
function generalData(session: MideaSession): Record<string, unknown> {
    return {
        src: MSMART_HOME.appId,
        format: "2",
        stamp: stamp(),
        platformId: "1",
        deviceId: cloudDeviceId(session.account),
        reqId: randomBytes(16).toString("hex"),
        uid: session.uid,
        clientType: "1",
        appId: MSMART_HOME.appId,
        language: "en_US"
    };
}

/** The proxy address for an endpoint: the route's base with `alias` set, the
 *  slashes in it left as they are. */
function endpointUrl(apiUrl: string, endpoint: string): string {
    const base = apiUrl.split("?")[0];
    return `${base}?alias=${encodeURI(endpoint)}`;
}

/** What every MSmartHome endpoint answers with. */
type CloudReply = { code?: unknown; msg?: unknown; data?: unknown };

/**
 * `SmartHomeCloud._api_request`: one signed call, retried on 9999 and on a
 * connection that fails, as midea-local retries them. Answers the `data` of a
 * zero code; any other code is a `MideaCloudError` when `strict`, and null when
 * not.
 */
async function request(
    session: MideaSession,
    endpoint: string,
    data: Record<string, unknown>,
    strict: boolean
): Promise<Record<string, unknown> | null> {
    const body = JSON.stringify({
        reqId: randomBytes(16).toString("hex"),
        stamp: stamp(),
        ...data
    });
    const random = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
        "content-type": "application/json; charset=utf-8",
        secretVersion: "1",
        sign: sign(body, random),
        random,
        "x-recipe-app": MSMART_HOME.appId,
        authorization: `Basic ${Buffer.from(`${MSMART_HOME.appKey}:${MSMART_HOME.iotKey}`).toString("base64")}`
    };
    if (session.uid) headers.uid = session.uid;
    if (session.accessToken) headers.accessToken = session.accessToken;
    let answer: CloudReply | null = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        try {
            const response = await fetcher(endpointUrl(session.apiUrl, endpoint), {
                method: "POST",
                headers,
                body,
                cache: "no-store",
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
            answer = (await response.json()) as CloudReply;
        } catch {
            answer = null;
            continue;
        }
        if (Number(answer?.code) !== 9999 || attempt === ATTEMPTS - 1) break;
        await pause(1_000 * (attempt + 1));
    }
    if (!answer)
        throw new MideaCloudError(
            "MSmartHome could not be reached. Try again in a moment.",
            "unreachable"
        );
    const code = Number(answer.code);
    if (code === 0 && answer.data && typeof answer.data === "object")
        return answer.data as Record<string, unknown>;
    if (strict) throw cloudFailure(code, typeof answer.msg === "string" ? answer.msg : "");
    return null;
}

const text = (value: unknown) =>
    typeof value === "string" ? value : value == null ? "" : String(value);

/** `SmartHomeCloud.login`, with `_re_route` before it. */
export async function signIn(account: string, password: string): Promise<MideaSession> {
    let session: MideaSession = {
        apiUrl: MSMART_HOME.apiUrl,
        account,
        uid: null,
        accessToken: null,
        keys: null
    };
    const routed =
        (await request(
            session,
            "/v1/unitcenter/router/user/name",
            {
                ...generalData(session),
                clientType: 8,
                clientSrc: 8,
                userType: "0",
                userName: encryptAccount(account)
            },
            false
        )) ??
        (await request(
            session,
            "/v1/multicloud/platform/user/route",
            { ...generalData(session), userType: "0", userName: account },
            false
        ));
    const masUrl = text(routed?.masUrl);
    if (masUrl.startsWith("https://")) session = { ...session, apiUrl: masUrl };

    const idAnswer = await request(
        session,
        "/v1/user/login/id/get",
        { ...generalData(session), loginAccount: account },
        true
    );
    const loginId = text(idAnswer?.loginId);
    if (!loginId) throw new MideaCloudError("MSmartHome does not know that email.", "password");

    const { uid: _uid, ...iotData } = generalData(session);
    const at = stamp();
    const answer = await request(
        session,
        "/mj/user/login",
        {
            iotData: {
                ...iotData,
                iampwd: encryptIamPassword(loginId, password),
                loginAccount: account,
                password: encryptPassword(loginId, password),
                stamp: at
            },
            data: { appKey: MSMART_HOME.appKey, deviceId: cloudDeviceId(account), platform: "2" },
            stamp: at
        },
        true
    );
    const mdata = (answer?.mdata ?? {}) as Record<string, unknown>;
    if (!answer || !text(answer.uid) || !text(mdata.accessToken))
        throw new MideaCloudError(
            "MSmartHome did not finish the sign-in. Try again in a moment.",
            "refused"
        );
    return {
        ...session,
        uid: text(answer.uid),
        accessToken: text(mdata.accessToken),
        keys: sessionKeys(text(answer.accessToken), text(answer.randomData))
    };
}

/** One appliance on the account, as `SmartHomeCloud.list_appliances` reads it. */
export interface MideaAppliance {
    readonly id: string;
    readonly name: string;
    /** The device type: 0xA1 for a dehumidifier. */
    readonly type: number;
    /** `sn8`, the model code inside the serial. */
    readonly model: string;
    readonly online: boolean;
}

export async function listAppliances(session: MideaSession): Promise<MideaAppliance[]> {
    const answer = await request(
        session,
        "/v1/appliance/user/list/get",
        generalData(session),
        true
    );
    const list = Array.isArray(answer?.list) ? (answer.list as Record<string, unknown>[]) : [];
    return list.flatMap((entry) => {
        const id = text(entry.id);
        const type = Number.parseInt(text(entry.type), 16);
        if (!/^\d{1,20}$/.test(id) || !Number.isFinite(type)) return [];
        let serial = "";
        try {
            serial = session.keys ? decryptWithSession(session.keys, text(entry.sn)) : "";
        } catch {
            serial = "";
        }
        return [
            {
                id,
                name: text(entry.name) || id,
                type,
                model: serial.length > 17 ? serial.slice(9, 17) : "",
                online: text(entry.onlineStatus) === "1"
            }
        ];
    });
}

/** A token and key for the local handshake. */
export interface MideaKey {
    readonly token: string;
    readonly key: string;
}

/** `MideaCloud.get_cloud_keys`: the token and key for each UDP id form the
 *  cloud knows, method 1 first. A unit answers to one of them. */
export async function applianceKeys(
    session: MideaSession,
    applianceId: string
): Promise<MideaKey[]> {
    const keys: MideaKey[] = [];
    for (const method of [1, 2] as const) {
        const udpid = udpId(BigInt(applianceId), method);
        const answer = await request(
            session,
            "/v1/iot/secure/getToken",
            { ...generalData(session), udpid, applianceCodes: applianceId },
            true
        );
        const tokens = Array.isArray(answer?.tokenlist)
            ? (answer.tokenlist as Record<string, unknown>[])
            : [];
        for (const token of tokens) {
            if (text(token.udpId) !== udpid) continue;
            const found = {
                token: text(token.token).toLowerCase(),
                key: text(token.key).toLowerCase()
            };
            if (/^[0-9a-f]+$/.test(found.token) && /^[0-9a-f]{64}$/.test(found.key))
                keys.push(found);
        }
    }
    return keys;
}
