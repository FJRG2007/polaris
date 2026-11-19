/**
 * Photos and videos sent to be seen once.
 *
 * What makes it "once" is the server, not a screen: the bytes and the still are
 * refused to everything except the Polaris phone app, and to the app only
 * against a fresh challenge signed with a key that phone made in its own
 * keystore and registered for this account. The open is written before a byte
 * is sent, and the row's primary key refuses the second one. The phone draws it
 * in a window Android keeps out of screenshots and recordings.
 *
 * What it cannot stop, and does not claim to: a camera pointed at the screen,
 * or somebody who builds their own client that signs with a key of its own.
 * The name and the time drawn across the picture are for the first of those.
 *
 * Server-only.
 */

import { z } from "zod";
import { loadEnv } from "@polaris/config";
import { Prisma, prisma } from "@polaris/db";
import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

/** How long a challenge stays good: a phone asks for one and signs it at once. */
export const CHALLENGE_TTL_MS = 60_000;
/** Keys kept per account; older phones beyond this are forgotten. */
export const MOST_DEVICE_KEYS = 10;

export type ViewOnceRefusal =
    | "notFound"
    | "own"
    | "opened"
    | "device"
    | "challenge"
    | "signature";

export class ViewOnceRefused extends Error {
    constructor(readonly reason: ViewOnceRefusal) {
        super(`view once refused: ${reason}`);
        this.name = "ViewOnceRefused";
    }
}

/** Whether the request came from the phone app, the only sender whose "camera" is believed. */
export function fromPhoneApp(userAgent: string | null): boolean {
    return /\bPolarisMobile\/\d/.test(userAgent ?? "");
}

function challengeMac(attachmentId: string, userId: string, expires: string, secret: string): string {
    return createHmac("sha256", secret)
        .update(`view-once:${attachmentId}:${userId}:${expires}`)
        .digest("base64url");
}

/** A challenge for one reader and one file, good for a minute. */
export function viewOnceChallenge(
    attachmentId: string,
    userId: string,
    now = Date.now(),
    secret = loadEnv().POLARIS_AUTH_SECRET
): string {
    const expires = String(now + CHALLENGE_TTL_MS);
    return `${expires}.${challengeMac(attachmentId, userId, expires, secret)}`;
}

/** Whether a challenge was made for exactly this reader and file, and is still good. */
export function challengeValid(
    challenge: string,
    attachmentId: string,
    userId: string,
    now = Date.now(),
    secret = loadEnv().POLARIS_AUTH_SECRET
): boolean {
    const [expires, mac, extra] = challenge.split(".");
    if (!expires || !mac || extra !== undefined || !/^\d{10,16}$/.test(expires)) return false;
    if (Number(expires) < now) return false;
    const expected = Buffer.from(challengeMac(attachmentId, userId, expires, secret));
    const given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The text a phone signs for one file and one challenge. */
export function signedText(attachmentId: string, challenge: string): string {
    return `view-once:${attachmentId}:${challenge}`;
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

export const deviceKeySchema = z.object({
    publicKey: z.string().trim().min(40).max(400),
    platform: z.enum(["android", "ios"])
});

/**
 * Keep a phone's key for this account.
 *
 * The same phone signed in as somebody else moves its key to them: a key is a
 * phone, and the phone now opens that account. Past `MOST_DEVICE_KEYS` the
 * longest-unused keys are forgotten.
 */
export async function registerDeviceKey(userId: string, publicKey: string, platform: "android" | "ios"): Promise<boolean> {
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
    if (kept.length > 0) await prisma.mobileDeviceKey.deleteMany({ where: { id: { in: kept.map((row) => row.id) } } });
    return true;
}

/** A view-once file as the opening route needs it. Null for anything else. */
export async function viewOnceFile(attachmentId: string) {
    return prisma.chatAttachment.findFirst({
        where: { id: attachmentId, viewOnce: true },
        select: {
            id: true,
            name: true,
            contentType: true,
            connectionId: true,
            path: true,
            viewSeconds: true,
            message: { select: { id: true, channelId: true, authorId: true } }
        }
    });
}

export type ViewOnceFile = NonNullable<Awaited<ReturnType<typeof viewOnceFile>>>;

/**
 * Prove the open and record it, in that order and before any byte is read.
 *
 * Access to the conversation is the caller's to check first; this is the part
 * that makes it once and makes it a phone.
 */
export async function claimViewOnce(
    userId: string,
    file: ViewOnceFile,
    proof: { readonly challenge: string; readonly publicKey: string; readonly signature: string }
): Promise<void> {
    if (file.message.authorId === userId) throw new ViewOnceRefused("own");
    const device = await prisma.mobileDeviceKey.findUnique({
        where: { publicKey: proof.publicKey },
        select: { id: true, userId: true }
    });
    if (!device || device.userId !== userId) throw new ViewOnceRefused("device");
    if (!challengeValid(proof.challenge, file.id, userId)) throw new ViewOnceRefused("challenge");
    if (!signatureValid(proof.publicKey, signedText(file.id, proof.challenge), proof.signature)) {
        throw new ViewOnceRefused("signature");
    }
    try {
        await prisma.chatAttachmentOpen.create({ data: { attachmentId: file.id, userId } });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            throw new ViewOnceRefused("opened");
        }
        throw error;
    }
    await prisma.mobileDeviceKey.update({ where: { id: device.id }, data: { lastUsedAt: new Date() } });
}

/** Who is looking and when, for the phone to draw across the picture. */
export function watermarkText(name: string, at = new Date()): string {
    const stamp = at.toISOString().slice(0, 16).replace("T", " ");
    return `${name} - ${stamp} UTC`.slice(0, 120);
}
