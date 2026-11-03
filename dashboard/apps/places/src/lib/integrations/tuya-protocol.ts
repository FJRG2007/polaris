/**
 * Tuya's own protocol on the local network: the frames a Tuya plug, switch or
 * light speaks on TCP port 6668, and the datagrams it announces itself with.
 *
 * Pure: bytes in, bytes out, no socket. The wire is `tuya-lan`; this file is what
 * goes on it, so it can be checked against frames another implementation
 * produced without a device on the desk. Written from tinytuya's description of
 * the protocol (its `core` package and PROTOCOL.md), which is the reference the
 * Home Assistant local integrations are built on as well.
 *
 * Three versions are spoken, because three are on sale:
 *
 * - 3.3: 0x55AA frames checked by CRC32, the JSON inside encrypted with
 *   AES-128-ECB under the device's local key.
 * - 3.4: the same frames checked by HMAC-SHA256, and a session key agreed first
 *   (two nonces, each proved with an HMAC under the local key), which then
 *   encrypts and signs everything after.
 * - 3.5: the same agreement, and 0x6699 frames sealed with AES-GCM: the header is
 *   the associated data, the tag is the check.
 *
 * Server-only.
 */

import { z } from "zod";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export type TuyaVersion = "3.3" | "3.4" | "3.5";

export const TUYA_VERSIONS: readonly TuyaVersion[] = ["3.3", "3.4", "3.5"];

/** The port every Tuya device listens on for its app. */
export const TUYA_PORT = 6668;

/** Where devices announce themselves: plain (3.1), ECB (3.3/3.4), GCM (3.5). */
export const TUYA_DISCOVERY_PORTS = [6666, 6667, 7000] as const;

export const TUYA_CMD = {
    SESS_KEY_NEG_START: 3,
    SESS_KEY_NEG_RESP: 4,
    SESS_KEY_NEG_FINISH: 5,
    CONTROL: 7,
    STATUS: 8,
    HEART_BEAT: 9,
    DP_QUERY: 10,
    CONTROL_NEW: 13,
    DP_QUERY_NEW: 16,
    UPDATEDPS: 18,
    UDP_NEW: 19,
    BOARDCAST_LPV34: 35,
    LAN_EXT_STREAM: 64
} as const;

/** Commands sent without the version header in front of their payload. */
const NO_HEADER_CMDS: ReadonlySet<number> = new Set([
    TUYA_CMD.DP_QUERY,
    TUYA_CMD.DP_QUERY_NEW,
    TUYA_CMD.UPDATEDPS,
    TUYA_CMD.HEART_BEAT,
    TUYA_CMD.SESS_KEY_NEG_START,
    TUYA_CMD.SESS_KEY_NEG_RESP,
    TUYA_CMD.SESS_KEY_NEG_FINISH,
    TUYA_CMD.LAN_EXT_STREAM
]);

const PREFIX_55AA = 0x000055aa;
const SUFFIX_55AA = 0x0000aa55;
const PREFIX_6699 = 0x00006699;
const SUFFIX_6699 = 0x00009966;
const HEADER_55AA = 16;
const HEADER_6699 = 18;

/** Nothing a switch says comes near this; a header claiming more is corrupt. */
const MAX_PAYLOAD = 64 * 1024;

/** The key every device encrypts its announcements with: an MD5 of a string
 *  baked into the firmware, the same on every unit. */
export const TUYA_UDP_KEY = createHash("md5").update("yGAdlopoPVldABfn").digest();

/** "3.x" and twelve zero bytes: what precedes most payloads from 3.3 on. */
function versionHeader(version: TuyaVersion): Buffer {
    return Buffer.concat([Buffer.from(version, "ascii"), Buffer.alloc(12)]);
}

export class TuyaProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TuyaProtocolError";
    }
}

// --- crypto ------------------------------------------------------------------------

export function ecbEncrypt(key: Buffer, data: Buffer, pad = true): Buffer {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    cipher.setAutoPadding(pad);
    return Buffer.concat([cipher.update(data), cipher.final()]);
}

export function ecbDecrypt(key: Buffer, data: Buffer): Buffer {
    if (data.length === 0 || data.length % 16 !== 0) {
        throw new TuyaProtocolError("Encrypted payload is not whole blocks");
    }
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    try {
        return Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
        // A wrong key comes out as padding that does not check.
        throw new TuyaProtocolError("Payload did not decrypt with this key");
    }
}

function gcmSeal(
    key: Buffer,
    iv: Buffer,
    aad: Buffer,
    data: Buffer
): { body: Buffer; tag: Buffer } {
    const cipher = createCipheriv("aes-128-gcm", key, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return { body, tag: cipher.getAuthTag() };
}

function gcmOpen(key: Buffer, iv: Buffer, aad: Buffer, data: Buffer, tag: Buffer): Buffer {
    const decipher = createDecipheriv("aes-128-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
        throw new TuyaProtocolError("Frame did not authenticate with this key");
    }
}

function crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function hmac(key: Buffer, data: Buffer): Buffer {
    return createHmac("sha256", key).update(data).digest();
}

/** A local key as the device holds it: sixteen bytes of text. */
export function localKeyBytes(localKey: string): Buffer {
    const key = Buffer.from(localKey, "utf8");
    if (key.length !== 16) throw new TuyaProtocolError("A local key is sixteen characters");
    return key;
}

// --- frames ------------------------------------------------------------------------

export interface TuyaFrame {
    readonly seqno: number;
    readonly cmd: number;
    /** The device's return code, on a frame it sent; null on one we send. */
    readonly retcode: number | null;
    readonly payload: Buffer;
}

/** A 0x55AA frame, ended by a CRC32 or, from 3.4, an HMAC under `hmacKey`. */
export function pack55aa(seqno: number, cmd: number, payload: Buffer, hmacKey?: Buffer): Buffer {
    const endLength = hmacKey ? 36 : 8;
    const header = Buffer.alloc(HEADER_55AA);
    header.writeUInt32BE(PREFIX_55AA, 0);
    header.writeUInt32BE(seqno >>> 0, 4);
    header.writeUInt32BE(cmd, 8);
    header.writeUInt32BE(payload.length + endLength, 12);
    const body = Buffer.concat([header, payload]);
    const check = hmacKey ? hmac(hmacKey, body) : uint32(crc32(body));
    return Buffer.concat([body, check, uint32(SUFFIX_55AA)]);
}

/** A 0x6699 frame (3.5): the payload sealed with AES-GCM, the header after the
 *  prefix as associated data. `retcode` is only for frames a device sends. */
export function pack6699(
    seqno: number,
    cmd: number,
    payload: Buffer,
    key: Buffer,
    iv: Buffer = randomBytes(12),
    retcode: number | null = null
): Buffer {
    const raw = retcode === null ? payload : Buffer.concat([uint32(retcode), payload]);
    const header = Buffer.alloc(HEADER_6699);
    header.writeUInt32BE(PREFIX_6699, 0);
    header.writeUInt16BE(0, 4);
    header.writeUInt32BE(seqno >>> 0, 6);
    header.writeUInt32BE(cmd, 10);
    header.writeUInt32BE(12 + raw.length + 16, 14);
    const { body, tag } = gcmSeal(key, iv, header.subarray(4), raw);
    return Buffer.concat([header, iv, body, tag, uint32(SUFFIX_6699)]);
}

function uint32(value: number): Buffer {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0, 0);
    return out;
}

export interface ParseOptions {
    /** The HMAC key of a 3.4 frame, or the GCM key of a 3.5 one. None for 3.3. */
    readonly key?: Buffer | null;
    /** Whether the device put a return code first, as it does on what it
     *  sends; "guess" for an announcement, which may or may not have one. */
    readonly retcode?: boolean | "guess";
}

/**
 * The first whole frame in `buffer`, and the bytes after it; null while the
 * frame is still arriving. Throws on bytes that are not a frame, or a frame
 * whose check fails - a reader drops the connection rather than resyncing.
 */
export function parseFrame(
    buffer: Buffer,
    options: ParseOptions = {}
): { frame: TuyaFrame; rest: Buffer } | null {
    if (buffer.length < 4) return null;
    const prefix = buffer.readUInt32BE(0);
    const retcode = options.retcode ?? true;
    if (prefix === PREFIX_55AA) {
        if (buffer.length < HEADER_55AA) return null;
        const seqno = buffer.readUInt32BE(4);
        const cmd = buffer.readUInt32BE(8);
        const length = buffer.readUInt32BE(12);
        if (length > MAX_PAYLOAD) throw new TuyaProtocolError("Frame claims to be too large");
        const total = HEADER_55AA + length;
        if (buffer.length < total) return null;
        const endLength = options.key ? 36 : 8;
        if (length < endLength) throw new TuyaProtocolError("Frame is too short");
        const checked = buffer.subarray(0, total - endLength);
        const check = buffer.subarray(total - endLength, total - 4);
        const expected = options.key ? hmac(options.key, checked) : uint32(crc32(checked));
        if (!expected.equals(check)) throw new TuyaProtocolError("Frame check failed");
        if (buffer.readUInt32BE(total - 4) !== SUFFIX_55AA) {
            throw new TuyaProtocolError("Frame suffix is wrong");
        }
        let body = buffer.subarray(HEADER_55AA, total - endLength);
        let code: number | null = null;
        const hasCode =
            retcode === "guess"
                ? body.length >= 4 && body.readUInt32BE(0) === 0
                : retcode && body.length >= 4;
        if (hasCode) {
            code = body.readUInt32BE(0);
            body = body.subarray(4);
        }
        return {
            frame: { seqno, cmd, retcode: code, payload: Buffer.from(body) },
            rest: buffer.subarray(total)
        };
    }
    if (prefix === PREFIX_6699) {
        if (buffer.length < HEADER_6699) return null;
        const seqno = buffer.readUInt32BE(6);
        const cmd = buffer.readUInt32BE(10);
        const length = buffer.readUInt32BE(14);
        if (length > MAX_PAYLOAD) throw new TuyaProtocolError("Frame claims to be too large");
        const total = HEADER_6699 + length + 4;
        if (buffer.length < total) return null;
        if (length < 28) throw new TuyaProtocolError("Frame is too short");
        if (!options.key) throw new TuyaProtocolError("A 3.5 frame needs its key");
        if (buffer.readUInt32BE(total - 4) !== SUFFIX_6699) {
            throw new TuyaProtocolError("Frame suffix is wrong");
        }
        const iv = buffer.subarray(HEADER_6699, HEADER_6699 + 12);
        const tag = buffer.subarray(total - 20, total - 4);
        const sealed = buffer.subarray(HEADER_6699 + 12, total - 20);
        let body = gcmOpen(options.key, iv, buffer.subarray(4, HEADER_6699), sealed, tag);
        let code: number | null = null;
        const hasCode =
            retcode === "guess"
                ? body.length > 4 && body[0] !== 0x7b && body[4] === 0x7b
                : retcode && body.length >= 4;
        if (hasCode) {
            code = body.readUInt32BE(0);
            body = body.subarray(4);
        }
        return {
            frame: { seqno, cmd, retcode: code, payload: body },
            rest: buffer.subarray(total)
        };
    }
    throw new TuyaProtocolError("Not a Tuya frame");
}

// --- session -----------------------------------------------------------------------

/** One connection's keys and counter. `key` is the local key until a 3.4 or
 *  3.5 session has been agreed, and the session key after. */
export interface TuyaSession {
    readonly version: TuyaVersion;
    readonly localKey: Buffer;
    key: Buffer;
    seqno: number;
}

export function newSession(version: TuyaVersion, localKey: Buffer): TuyaSession {
    return { version, localKey, key: localKey, seqno: 1 };
}

/** One message to the device, framed and encrypted as its version expects. */
export function encodeMessage(
    session: TuyaSession,
    cmd: number,
    payload: Buffer,
    iv?: Buffer
): Buffer {
    const seqno = session.seqno;
    session.seqno += 1;
    const headed = NO_HEADER_CMDS.has(cmd)
        ? payload
        : Buffer.concat([versionHeader(session.version), payload]);
    if (session.version === "3.5") return pack6699(seqno, cmd, headed, session.key, iv);
    if (session.version === "3.4") {
        return pack55aa(seqno, cmd, ecbEncrypt(session.key, headed), session.key);
    }
    const encrypted = ecbEncrypt(session.key, payload);
    const body = NO_HEADER_CMDS.has(cmd)
        ? encrypted
        : Buffer.concat([versionHeader("3.3"), encrypted]);
    return pack55aa(seqno, cmd, body);
}

/** Read frames off a connection with this session's keys. */
export function parseOptionsFor(session: TuyaSession): ParseOptions {
    return { key: session.version === "3.3" ? null : session.key, retcode: true };
}

/**
 * What a frame from the device says, as JSON; null for an acknowledgement with
 * nothing in it. Throws on a payload that is not this device's.
 */
export function decodePayload(session: TuyaSession, frame: TuyaFrame): unknown {
    let body = frame.payload;
    if (body.length === 0) return null;
    const header = versionHeader(session.version);
    if (session.version === "3.4") body = ecbDecrypt(session.key, body);
    if (body.subarray(0, 3).equals(header.subarray(0, 3))) body = body.subarray(header.length);
    if (session.version === "3.3") body = ecbDecrypt(session.key, body);
    const text = body.toString("utf8").replace(/\0+$/, "").trim();
    if (text.length === 0) return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new TuyaProtocolError(
            `Device answered something that is not JSON: ${text.slice(0, 40)}`
        );
    }
}

const dpsSchema = z.record(z.string(), z.unknown());
const statusSchema = z.union([
    z.object({ dps: dpsSchema }).passthrough(),
    z.object({ data: z.object({ dps: dpsSchema }).passthrough() }).passthrough()
]);

/** The data points in a decoded answer, by number; null where it has none. */
export function dpsOf(decoded: unknown): Record<string, unknown> | null {
    const parsed = statusSchema.safeParse(decoded);
    if (!parsed.success) return null;
    const data = parsed.data as {
        dps?: Record<string, unknown>;
        data?: { dps: Record<string, unknown> };
    };
    return data.dps ?? data.data?.dps ?? null;
}

/** The first message of a 3.4/3.5 session: our nonce, under the local key. */
export function negotiationStart(session: TuyaSession, nonce: Buffer, iv?: Buffer): Buffer {
    session.key = session.localKey;
    return encodeMessage(session, TUYA_CMD.SESS_KEY_NEG_START, nonce, iv);
}

/**
 * The device's answer to our nonce, checked; and what to send back. The device
 * proves it holds the local key with an HMAC of our nonce, and the session key
 * is both nonces XORed and encrypted under the local key - ECB for 3.4, the
 * GCM keystream at our nonce for 3.5. Afterwards `session.key` is that key.
 */
export function negotiationFinish(
    session: TuyaSession,
    nonce: Buffer,
    answer: TuyaFrame,
    iv?: Buffer
): Buffer {
    if (answer.cmd !== TUYA_CMD.SESS_KEY_NEG_RESP) {
        throw new TuyaProtocolError("Device did not answer the key agreement");
    }
    const body =
        session.version === "3.4" ? ecbDecrypt(session.localKey, answer.payload) : answer.payload;
    if (body.length < 48) throw new TuyaProtocolError("Key agreement answer is too short");
    const remote = body.subarray(0, 16);
    if (!hmac(session.localKey, nonce).equals(body.subarray(16, 48))) {
        throw new TuyaProtocolError("Device does not hold this local key");
    }
    const finish = encodeMessage(
        session,
        TUYA_CMD.SESS_KEY_NEG_FINISH,
        hmac(session.localKey, remote),
        iv
    );
    session.key = sessionKeyOf(session.version, session.localKey, nonce, remote);
    return finish;
}

export function sessionKeyOf(
    version: TuyaVersion,
    localKey: Buffer,
    local: Buffer,
    remote: Buffer
): Buffer {
    const mixed = Buffer.from(local.subarray(0, 16).map((byte, index) => byte ^ remote[index]!));
    if (version === "3.4") return ecbEncrypt(localKey, mixed, false);
    return gcmSeal(localKey, local.subarray(0, 12), Buffer.alloc(0), mixed).body;
}

// --- payloads ----------------------------------------------------------------------

/** Asking a device for every data point it has. */
export function queryMessage(
    session: TuyaSession,
    deviceId: string,
    now: number = Date.now()
): { cmd: number; payload: Buffer } {
    if (session.version === "3.3") {
        const t = String(Math.floor(now / 1000));
        return {
            cmd: TUYA_CMD.DP_QUERY,
            payload: json({ gwId: deviceId, devId: deviceId, uid: deviceId, t })
        };
    }
    return { cmd: TUYA_CMD.DP_QUERY_NEW, payload: json({}) };
}

/** Setting data points, by number. */
export function controlMessage(
    session: TuyaSession,
    deviceId: string,
    dps: Readonly<Record<string, unknown>>,
    now: number = Date.now()
): { cmd: number; payload: Buffer } {
    const seconds = Math.floor(now / 1000);
    if (session.version === "3.3") {
        return {
            cmd: TUYA_CMD.CONTROL,
            payload: json({ devId: deviceId, uid: deviceId, t: String(seconds), dps })
        };
    }
    return {
        cmd: TUYA_CMD.CONTROL_NEW,
        payload: json({ protocol: 5, t: seconds, data: { dps } })
    };
}

export function heartbeatMessage(deviceId: string): { cmd: number; payload: Buffer } {
    return { cmd: TUYA_CMD.HEART_BEAT, payload: json({ gwId: deviceId, devId: deviceId }) };
}

function json(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(value), "utf8");
}

// --- discovery ---------------------------------------------------------------------

const announcementSchema = z.object({
    ip: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/),
    gwId: z.string().min(1).max(64),
    version: z.string().max(8).optional(),
    productKey: z.string().max(64).optional()
});

export interface TuyaAnnouncement {
    readonly id: string;
    readonly address: string;
    readonly version: TuyaVersion | null;
    readonly productKey: string | null;
}

/** One announcement datagram, read; null for anything that is not one. */
export function parseAnnouncement(datagram: Buffer): TuyaAnnouncement | null {
    let text: string;
    try {
        if (datagram.length >= 4 && datagram.readUInt32BE(0) === PREFIX_6699) {
            const parsed = parseFrame(datagram, { key: TUYA_UDP_KEY, retcode: "guess" });
            if (!parsed) return null;
            text = parsed.frame.payload.toString("utf8");
        } else if (datagram.length >= 4 && datagram.readUInt32BE(0) === PREFIX_55AA) {
            const parsed = parseFrame(datagram, { retcode: "guess" });
            if (!parsed) return null;
            const body = parsed.frame.payload;
            text =
                body[0] === 0x7b
                    ? body.toString("utf8")
                    : ecbDecrypt(TUYA_UDP_KEY, body).toString("utf8");
        } else {
            text = ecbDecrypt(TUYA_UDP_KEY, datagram).toString("utf8");
        }
    } catch {
        return null;
    }
    let value: unknown;
    try {
        value = JSON.parse(text.replace(/\0+$/, ""));
    } catch {
        return null;
    }
    const parsed = announcementSchema.safeParse(value);
    if (!parsed.success) return null;
    const version = TUYA_VERSIONS.find((entry) => entry === parsed.data.version) ?? null;
    return {
        id: parsed.data.gwId,
        address: parsed.data.ip,
        version,
        productKey: parsed.data.productKey ?? null
    };
}
