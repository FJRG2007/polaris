/**
 * A Tapo camera's own local API, for the one thing ONVIF does not carry:
 * privacy mode ("lens mask").
 *
 * HTTPS on port 443 of the camera, JSON, the API the Tapo app uses on the LAN.
 * Each call signs in, does its work and is done - nothing is held between
 * presses, because a session the camera dropped is a second failure to explain.
 * A failed sign-in counts towards the camera's lockout, so there is exactly one
 * per call and a lockout the camera reports is passed on with its wait.
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
    /** Firmware with the newest sign-in, which Polaris does not speak yet. */
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
    /** The certificate's SHA-256 fingerprint, for the pin. */
    readonly fingerprint: string | null;
}

export type TapoTransport = (request: {
    readonly url: string;
    readonly body: string;
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
    cnonce: string = cnonceNow()
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
    if (firstCode === -40211) throw new TapoError("unsupported");
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
    cnonce?: string
): Promise<{ private: boolean; pin: string | null }> {
    const { session, pin } = await signIn(camera, send, cnonce);
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
