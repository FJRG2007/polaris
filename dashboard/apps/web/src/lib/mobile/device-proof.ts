/**
 * Proof that a request comes from this person's own phone.
 *
 * The Polaris phone app makes a P-256 key in the phone's keystore, where the
 * private half never leaves, and registers the public half for the account it
 * is signed in to. Anything that must happen only from that phone - opening a
 * view-once photo, opening a door from a home-screen widget - asks for a
 * challenge first and is answered only against that challenge signed with a
 * registered key. A challenge names what it is for, what it is about and who
 * asked, and lasts a minute, so one signature cannot be replayed for anything
 * else.
 *
 * The session cookie is still required alongside: this is a second factor
 * bound to the device, not a replacement for being signed in.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

/** How long a challenge stays good: a phone asks for one and signs it at once. */
export const CHALLENGE_TTL_MS = 60_000;
/** Keys kept per account; older phones beyond this are forgotten. */
export const MOST_DEVICE_KEYS = 10;

/** What a challenge can be for. Part of what is signed, so each is its own. */
export type DevicePurpose = "view-once" | "door-open" | "sign-in-approval";

/** Why a device proof failed. */
export type DeviceProofRefusal = "device" | "challenge" | "signature";

export class DeviceProofRefused extends Error {
    constructor(readonly reason: DeviceProofRefusal) {
        super(`device proof refused: ${reason}`);
        this.name = "DeviceProofRefused";
    }
}

/** A proof as the phone sends it. */
export const deviceProofSchema = z.object({
    challenge: z.string().trim().min(10).max(200),
    publicKey: z.string().trim().min(40).max(400),
    signature: z.string().trim().min(16).max(200)
});

export type DeviceProof = z.infer<typeof deviceProofSchema>;

export const deviceKeySchema = z.object({
    publicKey: z.string().trim().min(40).max(400),
    platform: z.enum(["android", "ios"])
});

/** Whether the request came from the phone app. */
export function fromPhoneApp(userAgent: string | null): boolean {
    return /\bPolarisMobile\/\d/.test(userAgent ?? "");
}

function challengeMac(
    purpose: DevicePurpose,
    target: string,
    userId: string,
    expires: string,
    secret: string
): string {
    return createHmac("sha256", secret).update(`${purpose}:${target}:${userId}:${expires}`).digest("base64url");
}

/** A challenge for one purpose, one target and one person, good for a minute. */
export function deviceChallenge(
    purpose: DevicePurpose,
    target: string,
    userId: string,
    now = Date.now(),
    secret = loadEnv().POLARIS_AUTH_SECRET
): string {
    const expires = String(now + CHALLENGE_TTL_MS);
    return `${expires}.${challengeMac(purpose, target, userId, expires, secret)}`;
}

/** Whether a challenge was made for exactly this purpose, target and person, and is still good. */
export function challengeValid(
    challenge: string,
    purpose: DevicePurpose,
    target: string,
    userId: string,
    now = Date.now(),
    secret = loadEnv().POLARIS_AUTH_SECRET
): boolean {
    const [expires, mac, extra] = challenge.split(".");
    if (!expires || !mac || extra !== undefined || !/^\d{10,16}$/.test(expires)) return false;
    if (Number(expires) < now) return false;
    const expected = Buffer.from(challengeMac(purpose, target, userId, expires, secret));
    const given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The text a phone signs. */
export function signedText(purpose: DevicePurpose, target: string, challenge: string): string {
    return `${purpose}:${target}:${challenge}`;
}

/** A P-256 public key in SPKI base64, or null when it is anything else. */
export function readDeviceKey(publicKey: string) {
    if (!/^[A-Za-z0-9+/=]{40,400}$/.test(publicKey)) return null;
    try {
        const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
        if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
        return key;
    } catch {
        return null;
    }
}

/** Whether this signature (DER ECDSA, base64) over this text is that key's. */
export function signatureValid(publicKey: string, text: string, signature: string): boolean {
    const key = readDeviceKey(publicKey);
    if (!key || !/^[A-Za-z0-9+/=]{16,200}$/.test(signature)) return false;
    try {
        return verify("sha256", Buffer.from(text, "utf8"), key, Buffer.from(signature, "base64"));
    } catch {
        return false;
    }
}

/**
 * Keep a phone's key for this account.
 *
 * The same phone signed in as somebody else moves its key to them: a key is a
 * phone, and the phone now opens that account. Past `MOST_DEVICE_KEYS` the
 * longest-unused keys are forgotten.
 */
export async function registerDeviceKey(
    userId: string,
    publicKey: string,
    platform: "android" | "ios"
): Promise<boolean> {
    if (!readDeviceKey(publicKey)) return false;
    await prisma.mobileDeviceKey.upsert({
        where: { publicKey },
        create: { userId, publicKey, platform },
        update: { userId, platform, lastUsedAt: new Date() }
    });
    const kept = await prisma.mobileDeviceKey.findMany({
        where: { userId },
        orderBy: { lastUsedAt: "desc" },
        skip: MOST_DEVICE_KEYS,
        select: { id: true }
    });
    if (kept.length > 0) {
        await prisma.mobileDeviceKey.deleteMany({ where: { id: { in: kept.map((row) => row.id) } } });
    }
    return true;
}

/**
 * Check a proof: a key registered to this person, a challenge made for this,
 * and a signature over it by that key. Throws `DeviceProofRefused`; returns the
 * key's row id, for the caller to mark used once it has done what was asked.
 */
export async function proveDevice(
    userId: string,
    purpose: DevicePurpose,
    target: string,
    proof: DeviceProof
): Promise<string> {
    const device = await prisma.mobileDeviceKey.findUnique({
        where: { publicKey: proof.publicKey },
        select: { id: true, userId: true }
    });
    if (!device || device.userId !== userId) throw new DeviceProofRefused("device");
    if (!challengeValid(proof.challenge, purpose, target, userId)) throw new DeviceProofRefused("challenge");
    if (!signatureValid(proof.publicKey, signedText(purpose, target, proof.challenge), proof.signature)) {
        throw new DeviceProofRefused("signature");
    }
    return device.id;
}

/** The key was used just now. */
export async function deviceUsed(keyId: string): Promise<void> {
    await prisma.mobileDeviceKey.update({ where: { id: keyId }, data: { lastUsedAt: new Date() } });
}
