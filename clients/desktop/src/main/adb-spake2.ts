/**
 * SPAKE2 over Ed25519 exactly as BoringSSL's `spake25519.cc` speaks it, which is
 * what adbd uses to check a Wireless debugging pairing code
 * (AOSP packages/modules/adb, pairing_auth/pairing_auth.cpp).
 *
 * Only the group arithmetic comes from a library (@noble/curves, audited); the
 * hashes are node:crypto. The steps, names and transcript order follow
 * BoringSSL line by line, including its "password scalar hack": the password
 * scalar is moved to a multiple of eight by adding multiples of the group order,
 * so the peer's small-order components cancel the same way they do there.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { createHash, randomBytes } from "node:crypto";

const Point = ed25519.Point;
type Point = InstanceType<typeof Point>;

/** The order of the prime-order subgroup (BoringSSL `kOrder`). */
const ORDER = Point.Fn.ORDER;

/** BoringSSL's fixed points, decoded from the first entry of `kSpakeMSmallPrecomp` / `kSpakeNSmallPrecomp`. */
const M = Point.fromBytes(Buffer.from("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e", "hex"));
const N = Point.fromBytes(Buffer.from("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778", "hex"));

/** adbd's names for the two sides; `sizeof` in C, so the trailing NUL is part of each. */
export const CLIENT_NAME = Buffer.from("adb pair client\0");
export const SERVER_NAME = Buffer.from("adb pair server\0");

export type Spake2Role = "alice" | "bob";

function littleEndian(bytes: Uint8Array): bigint {
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index] ?? 0);
    return value;
}

/** `scalar` times `point`, for a scalar that is a multiple of eight below 8 times the order, as BoringSSL multiplies. */
function timesMultipleOfEight(point: Point, scalar: bigint): Point {
    const eighth = scalar >> 3n;
    return eighth === 0n ? Point.ZERO : point.clearCofactor().multiply(eighth);
}

/** SHA-512 of the password, and the password scalar after BoringSSL's reduction and hack. */
export function passwordScalar(password: Uint8Array): { readonly hash: Buffer; readonly scalar: bigint; } {
    const hash = createHash("sha512").update(password).digest();
    let scalar = littleEndian(hash) % ORDER;
    if (scalar & 1n) scalar += ORDER;
    if (scalar & 2n) scalar += 2n * ORDER;
    if (scalar & 4n) scalar += 4n * ORDER;
    return { hash, scalar };
}

function withLength(hash: ReturnType<typeof createHash>, data: Uint8Array): void {
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(data.length));
    hash.update(length).update(data);
}

/** One side of one exchange. `random` stands in for RAND_bytes(64), for known-answer tests. */
export class Spake2 {
    /** Our 32-byte message for the peer. */
    readonly message: Buffer;
    private readonly secret: bigint;
    private readonly password: { readonly hash: Buffer; readonly scalar: bigint; };
    private done = false;

    constructor(
        private readonly role: Spake2Role,
        private readonly myName: Uint8Array,
        private readonly theirName: Uint8Array,
        password: Uint8Array,
        random: Uint8Array = randomBytes(64)
    ) {
        if (random.length !== 64) throw new Error("SPAKE2 needs 64 random bytes.");
        const reduced = littleEndian(random) % ORDER;
        if (reduced === 0n) throw new Error("SPAKE2 drew a zero scalar.");
        // BoringSSL keeps the private scalar multiplied by the cofactor.
        this.secret = reduced << 3n;
        this.password = passwordScalar(password);
        const mask = timesMultipleOfEight(role === "alice" ? M : N, this.password.scalar);
        this.message = Buffer.from(Point.BASE.multiply(reduced).clearCofactor().add(mask).toBytes());
    }

    /** The 64-byte shared key from the peer's message. Both sides get the same one only with the same password. */
    finish(theirMessage: Uint8Array): Buffer {
        if (this.done) throw new Error("This SPAKE2 exchange is already finished.");
        if (theirMessage.length !== 32) throw new Error("The SPAKE2 message is not 32 bytes.");
        let theirs: Point;
        try {
            theirs = Point.fromBytes(theirMessage, true);
        } catch {
            throw new Error("The SPAKE2 message is not a point on the curve.");
        }
        this.done = true;
        const unmasked = theirs.subtract(timesMultipleOfEight(this.role === "alice" ? N : M, this.password.scalar));
        const shared = timesMultipleOfEight(unmasked, this.secret).toBytes();
        const hash = createHash("sha512");
        const [first, second] = this.role === "alice" ? [this.myName, this.theirName] : [this.theirName, this.myName];
        const [firstMessage, secondMessage] = this.role === "alice" ? [this.message, theirMessage] : [theirMessage, this.message];
        for (const part of [first, second, firstMessage, secondMessage, shared, this.password.hash]) withLength(hash, part);
        return hash.digest();
    }
}
