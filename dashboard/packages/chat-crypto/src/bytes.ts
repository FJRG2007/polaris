/**
 * Byte helpers shared by every module of the package: a canonical encoding for
 * what a key or an envelope is bound to, base64url for carrying envelopes, and
 * the one random source.
 *
 * Nothing here compares secrets. Envelopes are ciphertext, so encoding them is
 * not the side channel section 11.1 item 11 of the design warns about; the one
 * secret that arrives as text (OPAQUE's export key) goes through the platform's
 * own decoder when it has one and is imported into WebCrypto straight away.
 */

const encoder = new TextEncoder();

/** The only randomness in the package: the platform CSPRNG. A test asserts no
 *  weaker generator appears anywhere in the source (design 11.1 item 12). */
export function randomBytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * A typed, length-prefixed, unambiguous encoding of a list of fields: each one
 * is a tag byte (text, bytes or number), a 32-bit length and the value.
 *
 * Every derivation and every AEAD is bound to one of these, so "user a, lock bc"
 * and "user ab, lock c" can never encode to the same bytes - a plain join with a
 * separator would let a crafted id shift a boundary.
 */
export function canonical(...fields: ReadonlyArray<string | Uint8Array | number>): Uint8Array {
    const tags: number[] = [];
    const parts = fields.map((field) => {
        tags.push(typeof field === "number" ? 0x6e : typeof field === "string" ? 0x73 : 0x62);
        if (typeof field === "number") {
            if (!Number.isInteger(field) || field < 0 || field > 0xffffffff)
                throw new RangeError("A bound number is an unsigned 32-bit integer");
            const out = new Uint8Array(4);
            new DataView(out.buffer).setUint32(0, field);
            return out;
        }
        return typeof field === "string" ? encoder.encode(field) : field;
    });
    const total = parts.reduce((sum, part) => sum + 5 + part.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let offset = 0;
    parts.forEach((part, index) => {
        out[offset] = tags[index]!;
        view.setUint32(offset + 1, part.length);
        out.set(part, offset + 5);
        offset += 5 + part.length;
    });
    return out;
}

export function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** A copy with its own ArrayBuffer, which is the shape WebCrypto's typings want. */
export function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(bytes.length));
    out.set(bytes);
    return out;
}

interface Base64Native {
    fromBase64?: (value: string, options: { alphabet: "base64url" | "base64" }) => Uint8Array;
}

interface Base64NativeInstance {
    toBase64?: (options: { alphabet: "base64url"; omitPadding: boolean }) => string;
}

export function toBase64Url(bytes: Uint8Array): string {
    const native = (bytes as unknown as Base64NativeInstance).toBase64;
    if (typeof native === "function")
        return native.call(bytes, { alphabet: "base64url", omitPadding: true });
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Throws on anything that is not base64url, rather than decoding garbage. */
export function fromBase64Url(value: string): Uint8Array {
    if (!BASE64URL.test(value) || value.length % 4 === 1)
        throw new TypeError("Not a base64url value");
    const native = (Uint8Array as unknown as Base64Native).fromBase64;
    if (typeof native === "function") return native(value, { alphabet: "base64url" });
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
    return out;
}
