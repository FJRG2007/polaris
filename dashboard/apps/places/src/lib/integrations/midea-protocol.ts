/**
 * The bytes a Midea appliance speaks on the local network, for the dehumidifier
 * (device type 0xA1) - which is what a Comfee dehumidifier is inside.
 *
 * Three layers, each ported from midea-local (MIT,
 * github.com/midea-lan/midea-local), the library Home Assistant's midea_ac_lan
 * runs on, and pinned in tests against vectors its own functions produced:
 *
 * - the appliance frame (`message.py`, `devices/a1/message.py`): `0xAA`, a
 *   ten-byte header, a body ending in a message id and a CRC8 (`crc8.py`), and
 *   a two's-complement sum over everything after the flag;
 * - the `5A5A` packet around it (`packet_builder.py`): a 40-byte header with a
 *   clock and the appliance id, the frame AES-128-ECB with the fixed local key,
 *   and an MD5 over the packet and a fixed salt;
 * - the `8370` envelope of protocol version 3 (`security.py`): a handshake that
 *   trades the cloud's token and key for a session key, then every packet
 *   AES-CBC with that session key and signed with SHA-256.
 *
 * Pure: no socket, no clock of its own. Server-only all the same, since the
 * session holds a key.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Device type of a dehumidifier. */
export const A1 = 0xa1;

const MESSAGE_SET = 0x02;
const MESSAGE_QUERY = 0x03;
const MESSAGE_NOTIFY1 = 0x04;
const MESSAGE_NOTIFY2 = 0x05;

/** Body types the a1 status is read from, and the new-protocol ones it is not. */
const BODY_A0 = 0xa0;
const NEW_PROTOCOL_BODIES = new Set([0xb0, 0xb1, 0xb5]);

// --- CRC8 and checksum ---------------------------------------------------------

/** `crc8_854_table`: the Dallas/Maxim CRC8 (reflected polynomial 0x8C). */
const CRC8_TABLE: readonly number[] = Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x8c : crc >>> 1;
    return crc;
});

export function crc8(data: Uint8Array): number {
    let crc = 0;
    for (const byte of data) crc = CRC8_TABLE[crc ^ byte]!;
    return crc;
}

/** `MessageBase.checksum` for an `0xAA` frame: the byte that makes the sum zero. */
export function frameChecksum(data: Uint8Array): number {
    let sum = 0;
    for (const byte of data) sum += byte;
    return (~sum + 1) & 0xff;
}

// --- a1 frames -------------------------------------------------------------------

/** The modes and fan speeds of an a1 unit by their codes, as midea-local names
 *  them (`MideaA1Device._default_modes`, `_default_speeds`). 11 is Auto as some
 *  units report it; 3 is the code sent for it. */
export const A1_MODES: Readonly<Record<number, A1Mode>> = {
    1: "manual",
    2: "continuous",
    3: "auto",
    4: "clothes_dry",
    5: "shoes_dry",
    10: "silent",
    11: "auto"
};
export type A1Mode = "manual" | "continuous" | "auto" | "clothes_dry" | "shoes_dry" | "silent";

export const A1_SPEEDS: Readonly<Record<number, A1Speed | null>> = {
    1: "lowest",
    40: "low",
    60: "medium",
    80: "high",
    102: "auto",
    127: null
};
export type A1Speed = "lowest" | "low" | "medium" | "high" | "auto";

/** `MIN_TARGET_HUMIDITY`, and the top of the range midea_ac_lan offers
 *  (`MideaA1Humidifier._attr_max_humidity`). */
export const A1_MIN_HUMIDITY = 35;
export const A1_MAX_HUMIDITY = 85;

/** What a dehumidifier reported, as `A1GeneralMessageBody` reads it. */
export interface A1Status {
    readonly power: boolean;
    readonly modeCode: number;
    readonly fanCode: number;
    readonly targetHumidity: number;
    readonly childLock: boolean;
    readonly anion: boolean;
    readonly pump: boolean;
    readonly pumpEnable: boolean;
    readonly tank: number;
    readonly waterLevelSet: number;
    readonly currentHumidity: number;
    readonly currentTemperature: number;
    readonly swing: boolean;
    readonly filterReminder: boolean;
    /** Derived as `MideaA1Device.process_message` does: a tank level at or past
     *  the level it was set to stop at. */
    readonly tankFull: boolean;
}

/** What a set message carries: everything, since a set replaces the unit's
 *  whole state - which is why one is built from a status just read. */
export interface A1Command {
    readonly power: boolean;
    readonly promptTone: boolean;
    readonly modeCode: number;
    readonly fanCode: number;
    readonly targetHumidity: number;
    readonly childLock: boolean;
    readonly swing: boolean;
    readonly anion: boolean;
    readonly pump: boolean;
    readonly pumpEnable: boolean;
    readonly waterLevelSet: number;
}

function frame(messageType: number, body: Uint8Array, protocolVersion: number): Buffer {
    const header = [0xaa, Math.min(10 + body.length, 0xff), A1, 0, 0, 0, 0, 0, protocolVersion];
    const out = Buffer.from([...header, Math.min(messageType, 0xff), ...body, 0]);
    out[out.length - 1] = frameChecksum(out.subarray(1, out.length - 1));
    return out;
}

function a1Body(bodyType: number, inner: readonly number[], messageId: number): Uint8Array {
    const body = [bodyType, ...inner, messageId];
    return Uint8Array.from([...body, crc8(Uint8Array.from(body))]);
}

/** `MessageQuery`: ask a dehumidifier for its whole state. */
export function a1Query(messageId: number, protocolVersion = 0): Buffer {
    const inner = [0x81, 0x00, 0xff, ...new Array<number>(16).fill(0)];
    return frame(MESSAGE_QUERY, a1Body(0x41, inner, messageId), protocolVersion);
}

/** `MessageSet`: tell it its whole state. */
export function a1Set(command: A1Command, messageId: number, protocolVersion = 0): Buffer {
    const inner = new Array<number>(20).fill(0);
    inner[0] = (command.power ? 0x01 : 0) | (command.promptTone ? 0x40 : 0) | 0x02;
    inner[1] = command.modeCode & 0xff;
    inner[2] = command.fanCode & 0xff;
    inner[6] = command.targetHumidity & 0xff;
    inner[7] = command.childLock ? 0x80 : 0;
    inner[8] =
        (command.anion ? 0x40 : 0) | (command.pump ? 0x08 : 0) | (command.pumpEnable ? 0x10 : 0);
    inner[9] = command.swing ? 0x08 : 0;
    inner[12] = command.waterLevelSet & 0xff;
    return frame(MESSAGE_SET, a1Body(0x48, inner, messageId), protocolVersion);
}

/** The set that keeps everything as the unit reported it. */
export function commandFromStatus(status: A1Status): A1Command {
    return {
        power: status.power,
        // midea-local's device keeps the beep on unless told otherwise.
        promptTone: true,
        modeCode: A1_MODES[status.modeCode] ? status.modeCode : 1,
        fanCode: status.fanCode in A1_SPEEDS ? status.fanCode : 40,
        targetHumidity: status.targetHumidity,
        childLock: status.childLock,
        swing: status.swing,
        anion: status.anion,
        pump: status.pump,
        pumpEnable: status.pumpEnable,
        waterLevelSet: status.waterLevelSet
    };
}

/** The code a mode is sent as: the first one with its name. */
export function a1ModeCode(mode: A1Mode): number {
    return Number(Object.entries(A1_MODES).find(([, name]) => name === mode)![0]);
}

export function a1SpeedCode(speed: A1Speed): number {
    return Number(Object.entries(A1_SPEEDS).find(([, name]) => name === speed)![0]);
}

/** The status in a frame from the unit, or null when it is not one. */
export function parseA1(data: Uint8Array): A1Status | null {
    if (data.length < 12 || data[0] !== 0xaa || data[2] !== A1) return null;
    const messageType = data[9]!;
    const body = data.subarray(10, data.length - 1);
    const bodyType = body[0]!;
    const general =
        ([MESSAGE_QUERY, MESSAGE_SET, MESSAGE_NOTIFY1].includes(messageType) &&
            !NEW_PROTOCOL_BODIES.has(bodyType)) ||
        (messageType === MESSAGE_NOTIFY2 && bodyType === BODY_A0);
    if (!general) return null;
    const byte = (index: number) => body[index] ?? 0;
    const bit = (index: number, at: number) => ((byte(index) >> at) & 1) === 1;
    const fan = byte(3) & 0x7f;
    const tank = byte(10) & 0x7f;
    const waterLevelSet = byte(15);
    return {
        power: bit(1, 0),
        modeCode: byte(2) & 0x0f,
        fanCode: fan >= 5 ? fan : 1,
        targetHumidity: Math.max(byte(7), A1_MIN_HUMIDITY),
        childLock: bit(8, 7),
        anion: bit(9, 6),
        pump: bit(9, 3),
        pumpEnable: bit(9, 4),
        tank,
        waterLevelSet,
        currentHumidity: byte(16),
        currentTemperature: (byte(17) - 50) / 2,
        swing: bit(19, 5),
        filterReminder: bit(9, 7),
        tankFull: tank ? tank >= waterLevelSet : false
    };
}

// --- 5A5A packets -----------------------------------------------------------------

/** `LocalSecurity`'s fixed key and salt, as midea-local writes them (decimal). */
const LOCAL_KEY = Buffer.from(
    BigInt("141661095494369103254425781617665632877").toString(16),
    "hex"
);
const LOCAL_SALT = Buffer.from(
    BigInt(
        "233912452794221312800602098970898185176935770387238278451789080441632479840061417076563"
    ).toString(16),
    "hex"
);

function ecb(data: Uint8Array, encrypt: boolean): Buffer {
    const cipher = encrypt
        ? createCipheriv("aes-128-ecb", LOCAL_KEY, null)
        : createDecipheriv("aes-128-ecb", LOCAL_KEY, null);
    return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** `PacketBuilder.packet_time`: the UTC clock as two-digit pairs, last first. */
export function packetTime(now: Date): Buffer {
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
    const clock = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    const text = `${date}${clock}${pad(now.getUTCMilliseconds() * 1000, 6)}`;
    const pairs: number[] = [];
    for (let i = 0; i < 16; i += 2) pairs.unshift(Number(text.slice(i, i + 2)));
    return Buffer.from(pairs);
}

/** `PacketBuilder.finalize`: a frame in a packet for the appliance `deviceId`. */
export function packet(deviceId: bigint, command: Uint8Array, time: Uint8Array): Buffer {
    const header = Buffer.alloc(40);
    header.set([0x5a, 0x5a, 0x01, 0x11, 0x00, 0x00, 0x20, 0x00]);
    header.set(time.subarray(0, 8), 12);
    header.writeBigUInt64LE(deviceId, 20);
    const body = Buffer.concat([header, ecb(command, true)]);
    body.writeUInt16LE(body.length + 16, 4);
    return Buffer.concat([body, createHash("md5").update(body).update(LOCAL_SALT).digest()]);
}

/** The frame inside a packet from the unit, as `MideaDevice.parse_message`
 *  takes it out; null for a heartbeat, a short packet or one that does not
 *  decrypt. */
export function unpacket(message: Uint8Array): Buffer | null {
    if (message.length <= 56) return null;
    const payloadType = message[2]! + (message[3]! << 8);
    if (payloadType === 0x1001 || payloadType === 0x0001) return null;
    const payloadLength = message[4]! + (message[5]! << 8) - 56;
    if (payloadLength % 16 !== 0) return null;
    try {
        return ecb(message.subarray(40, message.length - 16), false);
    } catch {
        return null;
    }
}

/** `discover.BROADCAST_MSG`, what a unit answers on UDP 6445. */
export const DISCOVERY_MESSAGE = Buffer.from(
    [
        "5a5a011148009200000000000000000000000000000000000000000000000000",
        "00000000000000007f75bd6b3e4f8b762e849c6e578d6590036e9d4342a50f1f",
        "569eb8ec918e92e5"
    ].join(""),
    "hex"
);

/** The appliance id in a discovery answer, as `discover.py` reads it, or null
 *  for anything that is not one. */
export function discoveredId(data: Uint8Array): bigint | null {
    if (data.length < 104) return null;
    let packetData = Buffer.from(data);
    if (
        packetData[0] === 0x83 &&
        packetData[1] === 0x70 &&
        packetData[8] === 0x5a &&
        packetData[9] === 0x5a
    )
        packetData = packetData.subarray(8, packetData.length - 16);
    else if (packetData[0] !== 0x5a || packetData[1] !== 0x5a) return null;
    const id = Buffer.alloc(8);
    packetData.copy(id, 0, 20, 26);
    return id.readBigUInt64LE(0);
}

// --- 8370 (protocol version 3) ---------------------------------------------------

export const HANDSHAKE_REQUEST = 0x0;
export const HANDSHAKE_RESPONSE = 0x1;
export const ENCRYPTED_RESPONSE = 0x3;
export const ENCRYPTED_REQUEST = 0x6;

/** Why a v3 exchange broke, in the terms the driver needs. */
export class MideaProtocolError extends Error {
    readonly reason: "auth" | "format";

    constructor(message: string, reason: MideaProtocolError["reason"]) {
        super(message);
        this.name = "MideaProtocolError";
        this.reason = reason;
    }
}

function cbc(key: Uint8Array, data: Uint8Array, encrypt: boolean): Buffer {
    const algorithm = `aes-${key.length * 8}-cbc`;
    const iv = Buffer.alloc(16);
    const cipher = encrypt
        ? createCipheriv(algorithm, key, iv).setAutoPadding(false)
        : createDecipheriv(algorithm, key, iv).setAutoPadding(false);
    return Buffer.concat([cipher.update(data), cipher.final()]);
}

const sha256 = (...parts: Uint8Array[]) => {
    const hash = createHash("sha256");
    for (const part of parts) hash.update(part);
    return hash.digest();
};

/**
 * One v3 session: `LocalSecurity`'s request counter, session key and the
 * envelope both ways. `random` is how padding is filled; tests pin it.
 */
export class Session8370 {
    private tcpKey: Buffer | null = null;
    private requestCount = 0;

    constructor(private readonly random: (size: number) => Buffer = randomBytes) {}

    /** `LocalSecurity.tcp_key`: the session key out of the handshake answer. */
    accept(response: Uint8Array, key: Uint8Array): Buffer {
        if (Buffer.from(response).toString("latin1") === "ERROR")
            throw new MideaProtocolError("The device refused the key", "auth");
        if (response.length !== 64)
            throw new MideaProtocolError("The handshake answer was not 64 bytes", "auth");
        const plain = cbc(key, response.subarray(0, 32), false);
        if (!sha256(plain).equals(Buffer.from(response.subarray(32))))
            throw new MideaProtocolError("The handshake answer did not match the key", "auth");
        this.tcpKey = Buffer.from(plain.map((byte, index) => byte ^ key[index]!));
        this.requestCount = 0;
        return this.tcpKey;
    }

    /** `LocalSecurity.encode_8370`. */
    encode(data: Uint8Array, messageType: number): Buffer {
        const encrypted = messageType === ENCRYPTED_RESPONSE || messageType === ENCRYPTED_REQUEST;
        let payload: Buffer = Buffer.from(data);
        let size = payload.length;
        let padding = 0;
        if (encrypted && (size + 2) % 16 !== 0) {
            padding = 16 - ((size + 2) & 0xf);
            size += padding + 32;
            payload = Buffer.concat([payload, this.random(padding)]);
        }
        const header = Buffer.from([
            0x83,
            0x70,
            (size >> 8) & 0xff,
            size & 0xff,
            0x20,
            (padding << 4) | messageType
        ]);
        const count = Buffer.from([(this.requestCount >> 8) & 0xff, this.requestCount & 0xff]);
        this.requestCount = this.requestCount + 1 >= 0xffff ? 0 : this.requestCount + 1;
        const body = Buffer.concat([count, payload]);
        if (!encrypted) return Buffer.concat([header, body]);
        if (!this.tcpKey) throw new MideaProtocolError("No session yet", "auth");
        return Buffer.concat([header, cbc(this.tcpKey, body, true), sha256(header, body)]);
    }

    /** `LocalSecurity.decode_8370`: the messages complete in `data`, and what is
     *  left over for the next read. */
    decode(data: Buffer): { messages: Buffer[]; rest: Buffer } {
        const messages: Buffer[] = [];
        let rest = data;
        while (rest.length >= 6) {
            if (rest[0] !== 0x83 || rest[1] !== 0x70)
                throw new MideaProtocolError("Not an 8370 message", "format");
            const size = rest.readUInt16BE(2) + 8;
            if (rest.length < size) break;
            const header = rest.subarray(0, 6);
            if (header[4] !== 0x20) throw new MideaProtocolError("Missing byte 4", "format");
            const padding = header[5]! >> 4;
            const messageType = header[5]! & 0xf;
            let body = rest.subarray(6, size);
            rest = rest.subarray(size);
            if (messageType === ENCRYPTED_RESPONSE || messageType === ENCRYPTED_REQUEST) {
                if (!this.tcpKey) throw new MideaProtocolError("No session yet", "auth");
                const sign = body.subarray(body.length - 32);
                body = cbc(this.tcpKey, body.subarray(0, body.length - 32), false);
                if (!sha256(header, body).equals(sign))
                    throw new MideaProtocolError("A message did not match its signature", "format");
                if (padding) body = body.subarray(0, body.length - padding);
            }
            messages.push(Buffer.from(body.subarray(2)));
        }
        return { messages, rest: Buffer.from(rest) };
    }
}
