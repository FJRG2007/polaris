/**
 * A Tapo camera's own local API, for the one thing ONVIF does not carry:
 * privacy mode ("lens mask").
 *
 * HTTPS on port 443 of the camera, JSON, the API the Tapo app uses on the LAN.
 * Each call signs in, does its work and is done - nothing is held between
 * presses, because a session the camera dropped is a second failure to explain.
 * A failed sign-in counts towards the camera's lockout, so there is exactly one
 * per call and a lockout the camera reports is passed on with its wait. The one
 * exception is the newest firmware (TPAP), which hashes the password one of two
 * ways and says which only by refusing the other - the Tapo app tries MD5 and
 * then SHA-256, and so does this.
 *
 * The camera's certificate is its own, so it is pinned: the first successful
 * call records its fingerprint and every later one must present the same.
 *
 * The transport is a parameter so the whole exchange can be replayed from
 * recorded answers (test/home/tapo-privacy.test.ts).
 *
 * Server-only.
 */

import { randomBytes } from "node:crypto";
import * as crypto from "./tapo-camera-crypto";
import * as tpap from "./tapo-tpap-crypto";
import { lanRequest, jsonOf } from "./lan-http";
import { DriverError } from "../drivers/contract";

/** Why a camera would not take the call, in terms the screen can say. */
export type TapoFailure =
    /** The password is not the one the camera holds. */
    | "password"
    /** Signed in, but as an account that may not control the camera - the
     *  camera account made for RTSP, on firmware that wants the app password. */
    | "account"
    /** Too many failed sign-ins; `waitSeconds` says for how long. */
    | "locked"
    /** A sign-in step nobody has documented (an unknown password transform
     *  on the newest firmware). */
    | "unsupported"
    /** A different certificate than the one recorded for this camera. */
    | "certificate"
    | "unreachable"
    | "failed";

export class TapoError extends Error {
    constructor(
        readonly failure: TapoFailure,
        readonly waitSeconds = 0
    ) {
        super(`tapo ${failure}`);
        this.name = "TapoError";
    }
}

export interface TapoAnswer {
    readonly status: number;
    readonly json: unknown;
    /** The body as it came, for the newest firmware's sealed answers. */
    readonly raw?: Buffer;
    /** The certificate's SHA-256 fingerprint, for the pin. */
    readonly fingerprint: string | null;
}

export type TapoTransport = (request: {
    readonly url: string;
    readonly body: string | Buffer;
    readonly headers: Readonly<Record<string, string>>;
    readonly pin: string | null;
}) => Promise<TapoAnswer>;

export interface TapoCamera {
    readonly address: string;
    readonly port?: number;
    readonly username: string;
    readonly password: string;
    /** The fingerprint recorded on the first call, or null for that first one. */
    readonly pin: string | null;
}

const HEADERS = {
    Accept: "application/json",
    "User-Agent": "Tapo CameraClient Android",
    requestByApp: "true",
    "Content-Type": "application/json; charset=UTF-8"
} as const;

const TIMEOUT_MS = 8000;

/** The real network, through the LAN client every Places device uses. */
export const lanTransport: TapoTransport = async ({ url, body, headers, pin }) => {
    try {
        const response = await lanRequest({
            url,
            method: "POST",
            headers,
            body,
            timeoutMs: TIMEOUT_MS,
            trust: { pin }
        });
        return {
            status: response.status,
            json: jsonOf(response),
            raw: response.body,
            fingerprint: response.certificate?.fingerprint ?? null
        };
    } catch (caught) {
        if (caught instanceof DriverError && caught.kind === "unauthorized")
            throw new TapoError("certificate");
        throw new TapoError("unreachable");
    }
};

type Json = Record<string, unknown>;

function record(value: unknown): Json {
    return value && typeof value === "object" ? (value as Json) : {};
}

function errorCode(value: unknown): number {
    const code = record(value).error_code;
    return typeof code === "number" ? code : 0;
}

/** The lockout wait a login answer carries, wherever this firmware puts it. */
export function lockoutSeconds(answer: unknown): number {
    const top = record(answer);
    for (const holder of [top.data, record(top.result).data, top.error_info]) {
        const left = Number(record(holder).sec_left ?? 0);
        if (left > 0) return left;
    }
    return 0;
}

/** A signed-in session: where to send, and how to wrap it. */
interface Session {
    readonly url: string;
    readonly secure: crypto.SecureSession | null;
    /** The newest firmware's sealed channel, instead of `secure`. */
    readonly tpap?: tpap.TpapChannel;
    seq: number;
    readonly pin: string | null;
}

function cnonceNow(): string {
    return randomBytes(8).toString("hex").toUpperCase();
}

/**
 * Sign in once. The encrypt_type 3 login is sent first: a camera that speaks it
 * answers with its nonce and proof, one that does not answers anything else and
 * gets the old hashed login instead.
 */
export async function signIn(
    camera: TapoCamera,
    send: TapoTransport = lanTransport,
    cnonce: string = cnonceNow(),
    bytes: (size: number) => Buffer = randomBytes
): Promise<{ session: Session; pin: string | null }> {
    const origin = `https://${camera.address}:${camera.port ?? 443}`;
    const headers = { ...HEADERS, Referer: origin };
    const post = async (body: Json, pin: string | null) => {
        const answer = await send({ url: `${origin}/`, body: JSON.stringify(body), headers, pin });
        return answer;
    };

    const first = await post(
        { method: "login", params: { cnonce, encrypt_type: "3", username: camera.username } },
        camera.pin
    );
    const pin = camera.pin ?? first.fingerprint;
    const firstCode = errorCode(first.json);
    if (firstCode === -40211) return { pin, session: await tpapSignIn(origin, camera, pin, post, bytes) };
    const wait = lockoutSeconds(first.json);
    const data = record(record(record(first.json).result).data);
    const offered = Array.isArray(data.encrypt_type) ? data.encrypt_type.map(String) : [];

    if (firstCode === -40413 && offered.includes("3")) {
        const nonce = typeof data.nonce === "string" ? data.nonce : "";
        const confirm = typeof data.device_confirm === "string" ? data.device_confirm : "";
        if (!nonce || !confirm) throw new TapoError(wait > 0 ? "locked" : "password", wait);
        const hash = crypto.confirmedHash(camera.password, cnonce, nonce, confirm);
        if (!hash) throw new TapoError(wait > 0 ? "locked" : "password", wait);
        const hashed = crypto.hashedPassword(camera.password, hash);
        const second = await post(
            {
                method: "login",
                params: {
                    cnonce,
                    encrypt_type: "3",
                    digest_passwd: crypto.digestPassword(hashed, cnonce, nonce),
                    username: camera.username
                }
            },
            pin
        );
        const result = record(record(second.json).result);
        const secondWait = lockoutSeconds(second.json);
        if (secondWait > 0) throw new TapoError("locked", secondWait);
        if (typeof result.stok !== "string" || typeof result.start_seq !== "number")
            throw new TapoError("password");
        if (typeof result.user_group === "string" && result.user_group !== "root")
            throw new TapoError("account");
        return {
            pin,
            session: {
                url: `${origin}/stok=${result.stok}/ds`,
                secure: crypto.secureSession(hashed, cnonce, nonce),
                seq: result.start_seq,
                pin
            }
        };
    }
    if (wait > 0) throw new TapoError("locked", wait);

    // The old firmware: the password's MD5, and the answer is the token.
    const plain = await post(
        {
            method: "login",
            params: {
                hashed: true,
                password: crypto.hashedPassword(camera.password, "md5"),
                username: camera.username
            }
        },
        pin
    );
    const plainWait = lockoutSeconds(plain.json);
    if (plainWait > 0) throw new TapoError("locked", plainWait);
    const stok = record(record(plain.json).result).stok;
    if (errorCode(plain.json) !== 0 || typeof stok !== "string")
        throw new TapoError(errorCode(plain.json) === -40211 ? "unsupported" : "password");
    return { pin, session: { url: `${origin}/stok=${stok}/ds`, secure: null, seq: 0, pin } };
}

/** The literal user every TPAP sign-in names, hashed the way the camera's
 *  discover answer says. */
const TPAP_USER = "admin";

/** A refused passcode on `pake_share`; anything else is not worth a retry. */
const TPAP_WRONG_PASSCODE = -40401;

function tpapOffer(json: unknown): tpap.PakeRegister & { extra: tpap.ExtraCrypt } {
    const offer = record(record(json).result);
    const iterations = Number(offer.iterations);
    if (
        typeof offer.dev_salt !== "string" ||
        typeof offer.dev_share !== "string" ||
        typeof offer.dev_random !== "string" ||
        !Number.isInteger(iterations) ||
        iterations < 1 ||
        iterations > 10_000_000
    )
        throw new TapoError("failed");
    return {
        dev_salt: offer.dev_salt,
        dev_share: offer.dev_share,
        dev_random: offer.dev_random,
        iterations,
        extra: record(offer.extra_crypt)
    };
}

/**
 * The newest firmware's sign-in (SPAKE2+, see tapo-tpap-crypto.ts). It takes
 * the Tapo app account's password only - the camera account made for RTSP is
 * never accepted here, so that one is refused without spending an attempt.
 */
async function tpapSignIn(
    origin: string,
    camera: TapoCamera,
    pin: string | null,
    post: (body: Json, pin: string | null) => Promise<TapoAnswer>,
    bytes: (size: number) => Buffer
): Promise<Session> {
    if (camera.username !== TPAP_USER || !camera.password) throw new TapoError("account");
    const discovered = await post({ method: "login", params: { sub_method: "discover" } }, pin);
    const info = record(record(record(discovered.json).result).tpap);
    if (Array.isArray(info.pake) && !info.pake.includes(2)) throw new TapoError("unsupported");
    const username = info.user_hash_type === 1 ? tpap.sha256HexUpper(TPAP_USER) : tpap.md5Hex(TPAP_USER);

    for (const passcode of [tpap.md5Hex(camera.password), tpap.sha256HexUpper(camera.password)]) {
        const userRandom = bytes(32);
        const register = await post(
            {
                method: "login",
                params: {
                    sub_method: "pake_register",
                    username,
                    user_random: userRandom.toString("base64"),
                    cipher_suites: [1],
                    encryption: ["aes_128_ccm"],
                    passcode_type: "userpw"
                }
            },
            pin
        );
        const registerWait = lockoutSeconds(register.json);
        if (registerWait > 0) throw new TapoError("locked", registerWait);
        const offer = tpapOffer(register.json);
        const credential = tpap.applyExtraCrypt(passcode, offer.extra);
        if (credential === null) throw new TapoError("unsupported");
        let client: tpap.PakeClient;
        try {
            client = tpap.pakeClient(offer, userRandom, credential, bytes(32));
        } catch {
            throw new TapoError("failed");
        }
        const share = await post(
            {
                method: "login",
                params: {
                    sub_method: "pake_share",
                    user_share: client.userShare.toString("base64"),
                    user_confirm: client.userConfirm.toString("base64")
                }
            },
            pin
        );
        const shareWait = lockoutSeconds(share.json);
        if (shareWait > 0) throw new TapoError("locked", shareWait);
        const done = record(record(share.json).result);
        if (typeof done.stok !== "string" || typeof done.dev_confirm !== "string") {
            if (errorCode(share.json) === TPAP_WRONG_PASSCODE) continue;
            throw new TapoError("failed");
        }
        // Only the camera that holds the password can confirm the key; an
        // answer that does not is not from the camera this row names.
        if (!client.deviceConfirms(Buffer.from(done.dev_confirm, "base64"))) throw new TapoError("failed");
        const seq = Number(done.start_seq);
        if (!Number.isInteger(seq)) throw new TapoError("failed");
        return {
            url: `${origin}/stok=${done.stok}/ds`,
            secure: null,
            tpap: { key: client.key, nonce: client.nonce },
            seq,
            pin
        };
    }
    throw new TapoError("password");
}

/** A `/ds` request on the newest firmware: sealed, and the answer opened.
 *  A plain JSON answer is the camera refusing before it decrypted anything. */
async function tpapRoundTrip(
    session: Session,
    channel: tpap.TpapChannel,
    inner: string,
    send: TapoTransport,
    headers: Record<string, string>
): Promise<Json> {
    const body = tpap.sealRequest(channel, session.seq, inner);
    session.seq += 1;
    const answer = await send({
        url: session.url,
        body,
        headers: { ...headers, "Content-Type": "application/octet-stream", Accept: "application/octet-stream" },
        pin: session.pin
    });
    const raw = answer.raw ?? Buffer.alloc(0);
    if (raw[0] === 0x7b) throw new TapoError("failed");
    try {
        return record(JSON.parse(tpap.openReply(channel, raw)));
    } catch {
        throw new TapoError("failed");
    }
}

/** One method inside `multipleRequest`, wrapped when the session is secure.
 *  Answers that method's own `result`. */
async function call(
    session: Session,
    method: string,
    params: Json,
    send: TapoTransport,
    headers: Record<string, string>
): Promise<Json> {
    const inner = JSON.stringify({ method: "multipleRequest", params: { requests: [{ method, params }] } });
    if (session.tpap) return firstResult(await tpapRoundTrip(session, session.tpap, inner, send, headers));
    let body = inner;
    const extra: Record<string, string> = {};
    if (session.secure) {
        body = JSON.stringify({
            method: "securePassthrough",
            params: { request: crypto.encryptRequest(session.secure, inner) }
        });
        extra.Seq = String(session.seq);
        extra.Tapo_tag = crypto.requestTag(session.secure.hashed, session.secure.cnonce, body, session.seq);
        session.seq += 1;
    }
    const answer = await send({ url: session.url, body, headers: { ...headers, ...extra }, pin: session.pin });
    let json = record(answer.json);
    const wrapped = record(json.result).response;
    if (session.secure && typeof wrapped === "string") {
        try {
            json = record(JSON.parse(crypto.decryptResponse(session.secure, wrapped)));
        } catch {
            throw new TapoError("failed");
        }
    }
    return firstResult(json);
}

/** The single method's own answer inside a `multipleRequest` reply. */
function firstResult(json: Json): Json {
    if (errorCode(json) !== 0) throw new TapoError("failed");
    const responses = record(json.result).responses;
    const first = record(Array.isArray(responses) ? responses[0] : undefined);
    if (errorCode(first) !== 0) throw new TapoError("failed");
    return record(first.result);
}

/** Whether the lens mask is on, as the camera reports it. */
function maskOf(result: Json): boolean {
    const enabled = record(record(result.lens_mask).lens_mask_info).enabled;
    if (enabled === "on") return true;
    if (enabled === "off") return false;
    throw new TapoError("failed");
}

const READ = { lens_mask: { name: ["lens_mask_info"] } };

/**
 * Read privacy, or set it and read it back. The answer is the camera's own,
 * not the one asked for, and the certificate pin to store.
 */
export async function lensMask(
    camera: TapoCamera,
    wanted: boolean | null,
    send: TapoTransport = lanTransport,
    cnonce?: string,
    bytes?: (size: number) => Buffer
): Promise<{ private: boolean; pin: string | null }> {
    const { session, pin } = await signIn(camera, send, cnonce, bytes);
    const origin = `https://${camera.address}:${camera.port ?? 443}`;
    const headers = { ...HEADERS, Referer: origin };
    if (wanted !== null) {
        await call(
            session,
            "setLensMaskConfig",
            { lens_mask: { lens_mask_info: { enabled: wanted ? "on" : "off" } } },
            send,
            headers
        );
    }
    const state = maskOf(await call(session, "getLensMaskConfig", READ, send, headers));
    return { private: state, pin };
}
