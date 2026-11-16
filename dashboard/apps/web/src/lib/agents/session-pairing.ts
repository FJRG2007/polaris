/**
 * "Continue on phone": a one-time link that opens one session on another
 * device, signed in as the person who made it.
 *
 * The code is 16 random bytes (base64url), lives five minutes and is spent
 * once. Only its hash is stored, in the `verification` table, with the person
 * and the session it is bound to; a phone that holds it while signed in as
 * that person is sent straight to the session. A phone that is signed out
 * opens a QR sign-in code (`qr-sign-in-service.ts`) and attaches it here, and
 * the person approves it with their PIN from the dialog still open on the
 * computer - the same bar as any QR sign-in. The link alone never signs
 * anybody in.
 *
 * Server-only.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { appBaseUrl } from "@/lib/domain-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { createHash, randomBytes } from "node:crypto";
import { sessionOwner } from "@/lib/agents/session-service";

export const PAIRING_TTL_MS = 5 * 60 * 1000;
const OPEN_LIMIT = 10;
const OPEN_WINDOW_MS = 10 * 60 * 1000;
const PREFIX = "polar-continue:";
/** The shape of a code: 16 bytes as unpadded base64url. */
export const PAIRING_CODE = /^[A-Za-z0-9_-]{22}$/;

const recordSchema = z.object({
    userId: z.string().uuid(),
    sessionId: z.string().uuid(),
    /** The QR sign-in code a signed-out phone attached, once. */
    userCode: z.string().max(64).nullable()
});
export type PairingRecord = z.infer<typeof recordSchema>;

/** The stored identifier for a code: never the code itself. Pure. */
export function pairingIdentifier(code: string): string {
    return `${PREFIX}${createHash("sha256").update(code).digest("hex")}`;
}

/** A stored value, read back strictly. Pure. */
export function readPairingValue(raw: string): PairingRecord | null {
    try {
        const parsed = recordSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Open a link for a session this person owns. Null when they do not own it
 *  or opened too many. */
export async function openPairing(userId: string, sessionId: string): Promise<{ url: string; code: string; expiresAt: string } | "busy" | null> {
    if ((await sessionOwner(sessionId)) !== userId) return null;
    const throttle = await rateLimit(`session-pairing:${userId}`, OPEN_LIMIT, OPEN_WINDOW_MS);
    if (!throttle.ok) return "busy";
    await prisma.verification.deleteMany({ where: { identifier: { startsWith: PREFIX }, expiresAt: { lt: new Date() } } });
    const code = randomBytes(16).toString("base64url");
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    const value: PairingRecord = { userId, sessionId, userCode: null };
    await prisma.verification.create({ data: { identifier: pairingIdentifier(code), value: JSON.stringify(value), expiresAt } });
    const base = (await appBaseUrl()).replace(/\/+$/, "");
    return { url: `${base}/continue/${code}`, code, expiresAt: expiresAt.toISOString() };
}

async function findPairing(code: string): Promise<{ id: string; record: PairingRecord } | null> {
    if (!PAIRING_CODE.test(code)) return null;
    const row = await prisma.verification.findFirst({
        where: { identifier: pairingIdentifier(code), expiresAt: { gt: new Date() } },
        select: { id: true, value: true }
    });
    const record = row ? readPairingValue(row.value) : null;
    return row && record ? { id: row.id, record } : null;
}

/** The live link behind a code, or null. */
export async function readPairing(code: string): Promise<PairingRecord | null> {
    return (await findPairing(code))?.record ?? null;
}

/** Spend the link for the person it was made for: the session to open, once.
 *  Anyone else, or a second try, gets null. */
export async function spendPairing(code: string, userId: string): Promise<string | null> {
    const found = await findPairing(code);
    if (!found || found.record.userId !== userId) return null;
    const spent = await prisma.verification.deleteMany({ where: { id: found.id } });
    return spent.count === 1 ? found.record.sessionId : null;
}

/** Attach a signed-out phone's QR sign-in code to the link. Only the first
 *  phone is attached; a second is refused. */
export async function attachSignIn(code: string, userCode: string): Promise<boolean> {
    const found = await findPairing(code);
    if (!found || found.record.userCode) return false;
    const value: PairingRecord = { ...found.record, userCode };
    const updated = await prisma.verification.updateMany({
        where: { id: found.id, value: JSON.stringify(found.record) },
        data: { value: JSON.stringify(value) }
    });
    return updated.count === 1;
}

/** Where the link stands for the person who made it, from the computer:
 *  waiting for a phone, a signed-out phone waiting on their PIN, or gone
 *  (spent or expired). */
export async function pairingState(code: string, userId: string): Promise<{ state: "waiting" } | { state: "phone"; userCode: string } | { state: "gone" }> {
    const found = await findPairing(code);
    if (!found || found.record.userId !== userId) return { state: "gone" };
    return found.record.userCode ? { state: "phone", userCode: found.record.userCode } : { state: "waiting" };
}
