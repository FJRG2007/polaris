/**
 * How a Philips air purifier seals what it says over its local protocol.
 *
 * Written from `coap/encryption.py` of aioairctrl (betaboon, MIT) and its
 * successor philips-airctrl 1.2.0 (domalab, MIT), the library Home Assistant's
 * Philips integration pins - byte for byte, and pinned in
 * `test/home/philips-coap.test.ts` to values their own code produced:
 *
 * - Every message carries an 8-hex-digit counter in front. The key and the IV
 *   are the two halves of `MD5("JiangPan" + counter)` written as upper-case hex,
 *   and each half is used as 16 ASCII bytes, not as the bytes the hex stands for.
 * - AES-128-CBC with PKCS#7 padding; the ciphertext travels as upper-case hex.
 * - After it, SHA-256 of `counter + ciphertext` as upper-case hex - a checksum
 *   anybody can compute, not a signature.
 * - Sending, the counter is the one the unit handed over at sync, plus one per
 *   message (wrapping at 32 bits, as philips-airctrl masks it). Receiving, it is
 *   whatever the unit put in front.
 *
 * None of this is secrecy: the secret is a constant in every copy of the app.
 * It is the unit's format, and it is followed because the unit refuses anything
 * else.
 *
 * Server-only.
 */

import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

const SECRET = "JiangPan";

/** A counter as the unit writes it: eight upper-case hex digits. */
const COUNTER = /^[0-9A-F]{8}$/;

export class PhilipsDigestError extends Error {
    constructor() {
        super("The air purifier's answer did not check out");
        this.name = "PhilipsDigestError";
    }
}

function keyAndIv(counter: string): { key: Buffer; iv: Buffer } {
    const hex = createHash("md5")
        .update(SECRET + counter, "utf8")
        .digest("hex")
        .toUpperCase();
    return { key: Buffer.from(hex.slice(0, 16), "ascii"), iv: Buffer.from(hex.slice(16), "ascii") };
}

function digest(counter: string, ciphertext: string): string {
    return createHash("sha256")
        .update(counter + ciphertext, "utf8")
        .digest("hex")
        .toUpperCase();
}

/** The counter after this one, as `_increment_client_key` writes it. */
export function nextCounter(counter: string): string {
    const next = (Number.parseInt(counter, 16) + 1) % 2 ** 32;
    return next.toString(16).toUpperCase().padStart(8, "0");
}

/** Seal a payload under a counter that has already been moved on. */
export function sealPhilips(counter: string, payload: string): string {
    if (!COUNTER.test(counter)) throw new Error("A counter is eight hex digits");
    const { key, iv } = keyAndIv(counter);
    const cipher = createCipheriv("aes-128-cbc", key, iv);
    const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()])
        .toString("hex")
        .toUpperCase();
    return counter + ciphertext + digest(counter, ciphertext);
}

/** Open what a unit sent: check the digest, then decrypt under the counter it
 *  carries. Throws `PhilipsDigestError` when the digest does not match. */
export function openPhilips(sealed: string): string {
    const text = sealed.trim();
    const counter = text.slice(0, 8);
    const ciphertext = text.slice(8, -64);
    const check = text.slice(-64);
    if (
        !COUNTER.test(counter.toUpperCase()) ||
        ciphertext.length === 0 ||
        !/^[0-9A-Fa-f]+$/.test(ciphertext) ||
        digest(counter, ciphertext) !== check
    ) {
        throw new PhilipsDigestError();
    }
    const { key, iv } = keyAndIv(counter);
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    try {
        return Buffer.concat([
            decipher.update(Buffer.from(ciphertext, "hex")),
            decipher.final()
        ]).toString("utf8");
    } catch {
        throw new PhilipsDigestError();
    }
}

/**
 * The client side of one conversation: the counter the unit handed over at
 * sync, moved on once per message sealed (`EncryptionContext`).
 */
export class PhilipsCipher {
    private counter: string;

    constructor(synced: string) {
        const counter = synced.trim().toUpperCase();
        if (!COUNTER.test(counter)) throw new PhilipsDigestError();
        this.counter = counter;
    }

    seal(payload: string): string {
        this.counter = nextCounter(this.counter);
        return sealPhilips(this.counter, payload);
    }
}

/**
 * JSON as Python's `json.dumps` writes it - `", "` between items and `": "`
 * after a key, non-ASCII escaped - which is what every client the units are
 * known to accept sends. Only the shapes a control message has are needed.
 */
export function pythonJson(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
    if (typeof value === "string") {
        return JSON.stringify(value).replace(
            /[\u007f-￿]/g,
            (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
        );
    }
    if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
    if (typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .map(([key, entry]) => `${pythonJson(key)}: ${pythonJson(entry)}`)
            .join(", ")}}`;
    }
    throw new Error("Not something a control message holds");
}
