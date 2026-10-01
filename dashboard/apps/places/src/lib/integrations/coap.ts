/**
 * CoAP messages (RFC 7252) as bytes, and bytes back as messages - as much of it
 * as a Philips air purifier needs.
 *
 * That is: requests and responses, confirmable or not, with a token, the
 * Uri-Path, Observe (RFC 7641) and Max-Age options, and a payload. No blockwise
 * transfer and no proxying: a unit's status fits in one datagram, and nothing
 * here talks to anything but the unit. Options this does not know are skipped
 * on the way in by their length, as the RFC asks of an elective option.
 *
 * Pure. Pinned in `test/home/philips-coap.test.ts` to the bytes aiocoap - the
 * CoAP library under every Philips client - writes for the same messages.
 */

export const COAP_PORT = 5683;

export const CoapType = { CON: 0, NON: 1, ACK: 2, RST: 3 } as const;
export type CoapType = (typeof CoapType)[keyof typeof CoapType];

/** Method and response codes as one byte: class in the top three bits. */
export const CoapCode = {
    EMPTY: 0,
    GET: 1,
    POST: 2,
    CHANGED: (2 << 5) | 4,
    CONTENT: (2 << 5) | 5
} as const;

const OPTION_OBSERVE = 6;
const OPTION_URI_PATH = 11;
const OPTION_MAX_AGE = 14;

export interface CoapMessage {
    readonly type: CoapType;
    readonly code: number;
    readonly messageId: number;
    readonly token: Buffer;
    /** Path segments, as the Uri-Path options carry them. */
    readonly path?: readonly string[];
    /** Present to register (0) or deregister (1) an observation, and on every
     *  notification as its sequence number. */
    readonly observe?: number;
    readonly maxAge?: number;
    readonly payload?: Buffer;
}

/** A whole number as the shortest big-endian bytes, zero as none at all. */
function uint(value: number): Buffer {
    const bytes: number[] = [];
    let left = value;
    while (left > 0) {
        bytes.unshift(left & 0xff);
        left = Math.floor(left / 256);
    }
    return Buffer.from(bytes);
}

function readUint(bytes: Buffer): number {
    let value = 0;
    for (const byte of bytes) value = value * 256 + byte;
    return value;
}

/** The 4-bit nibble for a delta or a length, and the bytes that extend it. */
function nibble(value: number): { nibble: number; extended: Buffer } {
    if (value < 13) return { nibble: value, extended: Buffer.alloc(0) };
    if (value < 269) return { nibble: 13, extended: Buffer.from([value - 13]) };
    const extended = Buffer.alloc(2);
    extended.writeUInt16BE(value - 269);
    return { nibble: 14, extended };
}

export function encodeCoap(message: CoapMessage): Buffer {
    if (message.token.length > 8) throw new Error("A CoAP token is at most eight bytes");
    const options: { number: number; value: Buffer }[] = [];
    if (message.observe !== undefined)
        options.push({ number: OPTION_OBSERVE, value: uint(message.observe) });
    for (const segment of message.path ?? []) {
        options.push({ number: OPTION_URI_PATH, value: Buffer.from(segment, "utf8") });
    }
    if (message.maxAge !== undefined)
        options.push({ number: OPTION_MAX_AGE, value: uint(message.maxAge) });
    options.sort((a, b) => a.number - b.number);

    const parts: Buffer[] = [];
    const header = Buffer.alloc(4);
    header[0] = (1 << 6) | (message.type << 4) | message.token.length;
    header[1] = message.code;
    header.writeUInt16BE(message.messageId & 0xffff, 2);
    parts.push(header, message.token);
    let previous = 0;
    for (const option of options) {
        const delta = nibble(option.number - previous);
        const length = nibble(option.value.length);
        parts.push(
            Buffer.from([(delta.nibble << 4) | length.nibble]),
            delta.extended,
            length.extended,
            option.value
        );
        previous = option.number;
    }
    if (message.payload && message.payload.length > 0)
        parts.push(Buffer.from([0xff]), message.payload);
    return Buffer.concat(parts);
}

/** A datagram as a message, or null for anything that is not a well-formed
 *  CoAP version 1 message. */
export function decodeCoap(data: Buffer): CoapMessage | null {
    if (data.length < 4) return null;
    const version = data[0]! >> 6;
    const type = ((data[0]! >> 4) & 0x3) as CoapType;
    const tokenLength = data[0]! & 0xf;
    if (version !== 1 || tokenLength > 8 || data.length < 4 + tokenLength) return null;
    const code = data[1]!;
    const messageId = data.readUInt16BE(2);
    const token = Buffer.from(data.subarray(4, 4 + tokenLength));
    let at = 4 + tokenLength;
    let number = 0;
    const path: string[] = [];
    let observe: number | undefined;
    let maxAge: number | undefined;
    let payload: Buffer | undefined;
    const extend = (value: number): number | null => {
        if (value < 13) return value;
        if (value === 13) {
            if (at + 1 > data.length) return null;
            return data[at++]! + 13;
        }
        if (value === 14) {
            if (at + 2 > data.length) return null;
            const read = data.readUInt16BE(at) + 269;
            at += 2;
            return read;
        }
        return null;
    };
    while (at < data.length) {
        const first = data[at++]!;
        if (first === 0xff) {
            payload = Buffer.from(data.subarray(at));
            if (payload.length === 0) return null;
            break;
        }
        const delta = extend(first >> 4);
        const length = extend(first & 0xf);
        if (delta === null || length === null || at + length > data.length) return null;
        number += delta;
        const value = data.subarray(at, at + length);
        at += length;
        if (number === OPTION_OBSERVE) observe = readUint(value);
        else if (number === OPTION_URI_PATH) path.push(value.toString("utf8"));
        else if (number === OPTION_MAX_AGE) maxAge = readUint(value);
    }
    return {
        type,
        code,
        messageId,
        token,
        ...(path.length > 0 ? { path } : {}),
        ...(observe !== undefined ? { observe } : {}),
        ...(maxAge !== undefined ? { maxAge } : {}),
        ...(payload ? { payload } : {})
    };
}
