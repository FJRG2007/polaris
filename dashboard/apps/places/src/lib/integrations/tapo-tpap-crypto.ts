/**
 * The arithmetic of the newest Tapo sign-in ("TPAP"), with nothing that talks
 * to the network, so every value can be checked against a recorded one.
 *
 * Firmware that answers the encrypt_type 3 login with -40211 (a C200 on 1.4.6,
 * for one) signs in with SPAKE2+ over P-256 instead: the password never crosses
 * the wire, both sides prove they derived the same key, and every request after
 * it is AES-128-CCM to `/stok=<stok>/ds`.
 *
 * Follows pytapo's TPAP transport (`pytapo/transport/tpap/spake2p.py` and
 * `tpap.py`), itself ported from the reverse-engineered client at
 * https://github.com/freeKC/tapo-v4-protocol. The M and N points are RFC 9383's
 * for P-256. node:crypto has no elliptic point addition, so the curve maths is
 * done here with BigInt; nothing secret depends on its timing beyond the one
 * login it serves.
 *
 * Server-only.
 */

import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    hkdfSync,
    pbkdf2,
    timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);

/**
 * The most work a camera may ask of one sign-in, as SHA-256-crypt rounds and
 * PBKDF2 iterations. Both come from `pake_register`, before anything proves the
 * answer is the camera's own, and a camera has to do the same work itself - so
 * anything far past these is refused rather than run on the dashboard.
 */
export const MAX_CRYPT_ROUNDS = 100_000;
export const MAX_PAKE_ITERATIONS = 100_000;

type Point = { readonly x: bigint; readonly y: bigint } | null;

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const G: Point = {
    x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n
};

function mod(value: bigint, by: bigint = P): bigint {
    const rest = value % by;
    return rest < 0n ? rest + by : rest;
}

function power(base: bigint, exponent: bigint): bigint {
    let result = 1n;
    let square = mod(base);
    let left = exponent;
    while (left > 0n) {
        if (left & 1n) result = (result * square) % P;
        square = (square * square) % P;
        left >>= 1n;
    }
    return result;
}

/** The inverse modulo P, by the extended Euclidean algorithm. */
function inverse(value: bigint): bigint {
    let [low, high] = [mod(value), P];
    let [lm, hm] = [1n, 0n];
    while (low > 1n) {
        const ratio = high / low;
        [lm, hm] = [hm - lm * ratio, lm];
        [low, high] = [high - low * ratio, low];
    }
    return mod(lm);
}

function add(p1: Point, p2: Point): Point {
    if (!p1) return p2;
    if (!p2) return p1;
    if (p1.x === p2.x && mod(p1.y + p2.y) === 0n) return null;
    const slope =
        p1.x === p2.x && p1.y === p2.y
            ? mod((3n * p1.x * p1.x + A) * inverse(2n * p1.y))
            : mod((p2.y - p1.y) * inverse(p2.x - p1.x));
    const x = mod(slope * slope - p1.x - p2.x);
    return { x, y: mod(slope * (p1.x - x) - p1.y) };
}

function multiply(scalar: bigint, point: Point): Point {
    let k = mod(scalar, N);
    let result: Point = null;
    let addend = point;
    while (k > 0n) {
        if (k & 1n) result = add(result, addend);
        addend = add(addend, addend);
        k >>= 1n;
    }
    return result;
}

function negate(point: Point): Point {
    return point ? { x: point.x, y: mod(-point.y) } : null;
}

function toBigInt(bytes: Buffer): bigint {
    return bytes.length === 0 ? 0n : BigInt(`0x${bytes.toString("hex")}`);
}

function toBytes(value: bigint, length = 32): Buffer {
    return Buffer.from(value.toString(16).padStart(length * 2, "0"), "hex");
}

/** A SEC1 point, uncompressed (0x04) or compressed (0x02/0x03). Throws on
 *  anything that is not a point of the curve. */
export function decodePoint(bytes: Buffer): Point {
    let point: Point;
    if (bytes[0] === 0x04 && bytes.length === 65) {
        point = { x: toBigInt(bytes.subarray(1, 33)), y: toBigInt(bytes.subarray(33, 65)) };
    } else if ((bytes[0] === 0x02 || bytes[0] === 0x03) && bytes.length === 33) {
        const x = toBigInt(bytes.subarray(1, 33));
        let y = power(power(x, 3n) + A * x + B, (P + 1n) / 4n);
        if ((y & 1n) !== BigInt(bytes[0] & 1)) y = P - y;
        point = { x, y };
    } else {
        throw new Error("not a curve point");
    }
    if (mod(point.y * point.y) !== mod(power(point.x, 3n) + A * point.x + B))
        throw new Error("not a curve point");
    return point;
}

export function encodePoint(point: Point): Buffer {
    if (!point) throw new Error("point at infinity");
    return Buffer.concat([Buffer.from([0x04]), toBytes(point.x), toBytes(point.y)]);
}

const M = decodePoint(
    Buffer.from("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f", "hex")
);
const NP = decodePoint(
    Buffer.from("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49", "hex")
);

function hkdf(ikm: Buffer, salt: Buffer, info: string, length: number): Buffer {
    return Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), length));
}

const NO_SALT = Buffer.alloc(32);

function lengthPrefixed(chunks: readonly Buffer[]): Buffer {
    return Buffer.concat(
        chunks.flatMap((chunk) => {
            const size = Buffer.alloc(8);
            size.writeBigUInt64LE(BigInt(chunk.length));
            return [size, chunk];
        })
    );
}

export function md5Hex(text: string): string {
    return createHash("md5").update(text, "utf8").digest("hex");
}

export function sha256HexUpper(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex").toUpperCase();
}

const CRYPT_B64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CRYPT_ORDER = [
    [0, 10, 20],
    [21, 1, 11],
    [12, 22, 2],
    [3, 13, 23],
    [24, 4, 14],
    [15, 25, 5],
    [6, 16, 26],
    [27, 7, 17],
    [18, 28, 8],
    [9, 19, 29]
] as const;

function to64(value: number, count: number): string {
    let out = "";
    let left = value;
    for (let i = 0; i < count; i++) {
        out += CRYPT_B64[left & 0x3f];
        left >>= 6;
    }
    return out;
}

function repeat(digest: Buffer, length: number): Buffer {
    return Buffer.concat(
        Array.from({ length: Math.floor(length / 32) + 1 }, () => digest)
    ).subarray(0, length);
}

function sha256(...parts: Buffer[]): Buffer {
    const hash = createHash("sha256");
    for (const part of parts) hash.update(part);
    return hash.digest();
}

/**
 * SHA-256-crypt ("$5$", Drepper's specification), the way the Tapo app shadows
 * a password when the camera asks for `passwd_id` 5: salt and optional rounds
 * from the camera's prefix, the salt cut to 16 characters, and the whole
 * `$5$[rounds=N$]salt$hash` string as the answer.
 */
export function sha256Crypt(key: string, prefix: string): string {
    let rest = prefix.startsWith("$5$") ? prefix.slice(3) : prefix;
    let rounds = 5000;
    let explicit = false;
    if (rest.startsWith("rounds=")) {
        const cut = rest.indexOf("$");
        if (cut >= 0 && cut < rest.length - 1) {
            const asked = Number.parseInt(rest.slice(7, cut), 10);
            if (!Number.isFinite(asked) || asked > MAX_CRYPT_ROUNDS) throw new Error("bad rounds");
            rounds = Math.max(1000, asked);
            rest = rest.slice(cut + 1);
            explicit = true;
        }
    }
    const end = rest.indexOf("$");
    const salt = rest.slice(0, Math.min(end > 0 ? end : rest.length, 16));
    const k = Buffer.from(key, "utf8");
    const s = Buffer.from(salt, "utf8");

    const b = sha256(k, s, k);
    const a = createHash("sha256").update(k).update(s).update(repeat(b, k.length));
    for (let n = k.length; n > 0; n >>= 1) a.update(n & 1 ? b : k);
    const digestA = a.digest();
    const p = repeat(sha256(Buffer.concat(Array.from({ length: k.length }, () => k))), k.length);
    const sb = repeat(
        sha256(Buffer.concat(Array.from({ length: 16 + digestA[0]! }, () => s))),
        s.length
    );

    let c = digestA;
    for (let i = 0; i < rounds; i++) {
        const h = createHash("sha256").update(i & 1 ? p : c);
        if (i % 3) h.update(sb);
        if (i % 7) h.update(p);
        h.update(i & 1 ? c : p);
        c = h.digest();
    }
    let encoded = CRYPT_ORDER.map(([x, y, z]) =>
        to64((c[x]! << 16) | (c[y]! << 8) | c[z]!, 4)
    ).join("");
    encoded += to64((c[31]! << 8) | c[30]!, 3);
    return `$5$${explicit ? `rounds=${rounds}$` : ""}${salt}$${encoded}`;
}

/** The camera's `extra_crypt` from `pake_register`, when it asks for one. */
export interface ExtraCrypt {
    readonly type?: unknown;
    readonly params?: { readonly passwd_id?: unknown; readonly passwd_prefix?: unknown };
}

/** Turn a passcode into the credential the camera asked for. Null when it
 *  asks for a transform nobody has documented. */
export function applyExtraCrypt(
    passcode: string,
    extra: ExtraCrypt | null | undefined
): string | null {
    if (!extra || !extra.type) return passcode;
    if (String(extra.type).toLowerCase() !== "password_shadow") return null;
    const id = Number(extra.params?.passwd_id ?? 0);
    if (id === 5) return sha256Crypt(passcode, String(extra.params?.passwd_prefix ?? ""));
    if (id === 2) return createHash("sha1").update(passcode, "utf8").digest("hex");
    return null;
}

/** What the camera sends back to `pake_register`. */
export interface PakeRegister {
    readonly dev_salt: string;
    readonly dev_share: string;
    readonly dev_random: string;
    readonly iterations: number;
}

/** The client side of one `pake_register` -> `pake_share` exchange. */
export interface PakeClient {
    readonly userShare: Buffer;
    readonly userConfirm: Buffer;
    /** Whether the camera's `dev_confirm` proves it derived the same key -
     *  which it can only do knowing the password. */
    readonly deviceConfirms: (devConfirm: Buffer) => boolean;
    readonly key: Buffer;
    readonly nonce: Buffer;
}

export async function pakeClient(
    register: PakeRegister,
    userRandom: Buffer,
    credential: string,
    randomScalar: Buffer
): Promise<PakeClient> {
    if (
        !Number.isInteger(register.iterations) ||
        register.iterations < 1 ||
        register.iterations > MAX_PAKE_ITERATIONS
    )
        throw new Error("bad iterations");
    const dk = await pbkdf2Async(
        Buffer.from(credential, "utf8"),
        Buffer.from(register.dev_salt, "base64"),
        register.iterations,
        80,
        "sha256"
    );
    const w0 = mod(toBigInt(dk.subarray(0, 40)), N);
    const w1 = mod(toBigInt(dk.subarray(40)), N);
    const Y = decodePoint(Buffer.from(register.dev_share, "base64"));
    const x = mod(toBigInt(randomScalar), N - 1n) + 1n;
    const X = add(multiply(x, G), multiply(w0, M));
    const H = add(Y, negate(multiply(w0, NP)));
    const Xb = encodePoint(X);
    const Yb = encodePoint(Y);
    const context = sha256(
        Buffer.from("PAKE V1", "utf8"),
        userRandom,
        Buffer.from(register.dev_random, "base64")
    );
    const transcript = lengthPrefixed([
        context,
        Buffer.alloc(0),
        Buffer.alloc(0),
        encodePoint(M),
        encodePoint(NP),
        Xb,
        Yb,
        encodePoint(multiply(x, H)),
        encodePoint(multiply(w1, H)),
        toBytes(w0)
    ]);
    const ke = sha256(transcript);
    const confirmation = hkdf(ke, NO_SALT, "ConfirmationKeys", 64);
    const kcb = confirmation.subarray(32);
    const shared = hkdf(ke, NO_SALT, "SharedKey", 32);
    return {
        userShare: Xb,
        userConfirm: createHmac("sha256", confirmation.subarray(0, 32)).update(Yb).digest(),
        deviceConfirms: (devConfirm) => {
            const expected = createHmac("sha256", kcb).update(Xb).digest();
            return devConfirm.length === expected.length && timingSafeEqual(devConfirm, expected);
        },
        key: hkdf(
            shared,
            Buffer.from("tp-kdf-salt-aes128-key"),
            "tp-kdf-info-aes128-key",
            32
        ).subarray(0, 16),
        nonce: hkdf(
            shared,
            Buffer.from("tp-kdf-salt-aes128-iv"),
            "tp-kdf-info-aes128-iv",
            32
        ).subarray(0, 12)
    };
}

/** The signed-in channel: the key, the base nonce, and where the sequence is. */
export interface TpapChannel {
    readonly key: Buffer;
    readonly nonce: Buffer;
}

function nonceFor(channel: TpapChannel, seq: number): Buffer {
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(seq >>> 0);
    return Buffer.concat([channel.nonce.subarray(0, 8), tail]);
}

/** A request body for `/ds`: the sequence number, then the AES-128-CCM
 *  ciphertext and its 16-byte tag. */
export function sealRequest(channel: TpapChannel, seq: number, payload: string): Buffer {
    const cipher = createCipheriv("aes-128-ccm", channel.key, nonceFor(channel, seq), {
        authTagLength: 16
    });
    const plain = Buffer.from(payload, "utf8");
    const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(seq >>> 0);
    return Buffer.concat([head, sealed, cipher.getAuthTag()]);
}

/** The camera's sealed answer back to text, under the sequence number it
 *  carries. Throws when it does not authenticate. */
export function openReply(channel: TpapChannel, raw: Buffer): string {
    if (raw.length < 20) throw new Error("short reply");
    const seq = raw.readUInt32BE(0);
    const body = raw.subarray(4, raw.length - 16);
    const decipher = createDecipheriv("aes-128-ccm", channel.key, nonceFor(channel, seq), {
        authTagLength: 16
    });
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
