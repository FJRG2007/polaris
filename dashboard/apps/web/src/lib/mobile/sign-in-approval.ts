/**
 * "Is this you?" on the phone: a second factor answered from the Polaris app.
 *
 * Somebody at the second-factor challenge asks for it; the account's phone app,
 * which keeps `/api/mobile/notices` open, shows Approve and Deny; the answer comes
 * back signed by the phone's own key (`device-proof`), so a browser tab holding a
 * session cannot answer it. The waiting browser then collects the approval and is
 * handed a one-time code for the challenge it holds, which it spends through the
 * same verify-otp endpoint every sent code goes through - so the session is still
 * created by better-auth, with its attempt counter, trust-device handling and the
 * sign-in record, and nothing here mints a session of its own.
 *
 * Each request is bound to one challenge by a hash of its identifier, lives two
 * minutes, is answered once and collected once. The raw identifier is never
 * stored: it is what finishes the challenge.
 */

import { prisma } from "@polaris/db";
import { noteSecondFactor } from "@polaris/auth";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/** How long the phone has to answer. */
export const APPROVAL_TTL_MS = 2 * 60_000;
/** How long the handed-over code is good for: it is spent straight away. */
const CODE_TTL_MS = 60_000;

export type ApprovalDecision = "approve" | "deny";

/** What the waiting browser learns when it asks. */
export type ApprovalState =
    | { state: "pending" }
    | { state: "denied" }
    | { state: "expired" }
    | { state: "approved"; code: string };

/** What the phone is told about a request, and when it is settled. */
export type ApprovalChange =
    | {
          kind: "requested";
          userId: string;
          id: string;
          device: string | null;
          ip: string | null;
          expiresAt: Date;
      }
    | { kind: "settled"; userId: string; id: string };

type Listener = (change: ApprovalChange) => void;
const REGISTRY = Symbol.for("polaris.signInApprovals");

function listeners(): Set<Listener> {
    const holder = globalThis as { [REGISTRY]?: Set<Listener> };
    if (!holder[REGISTRY]) holder[REGISTRY] = new Set();
    return holder[REGISTRY];
}

function publish(change: ApprovalChange): void {
    for (const listener of listeners()) {
        try {
            listener(change);
        } catch (caught) {
            console.error(caught);
        }
    }
}

/** Listen until the returned function is called. */
export function subscribeSignInApprovals(listener: Listener): () => void {
    listeners().add(listener);
    return () => listeners().delete(listener);
}

function hashChallenge(identifier: string): string {
    return createHash("sha256").update(identifier).digest("hex");
}

function sameHash(left: string, right: string): boolean {
    const a = Buffer.from(left, "hex");
    const b = Buffer.from(right, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether the account has the phone app on a phone that could answer. */
export async function phoneCanApprove(userId: string): Promise<boolean> {
    const key = await prisma.mobileDeviceKey
        .findFirst({ where: { userId, platform: "android" }, select: { id: true } })
        .catch(() => null);
    return Boolean(key);
}

/** Ask the phone. Any earlier request for the same challenge stops counting. */
export async function requestApproval(input: {
    userId: string;
    identifier: string;
    device: string | null;
    ip: string | null;
}): Promise<string> {
    const challengeHash = hashChallenge(input.identifier);
    const now = new Date();
    const earlier = await prisma.signInApproval.findMany({
        where: { userId: input.userId, challengeHash, status: "pending", expiresAt: { gt: now } },
        select: { id: true }
    });
    if (earlier.length > 0) {
        await prisma.signInApproval.updateMany({
            where: { id: { in: earlier.map((row) => row.id) } },
            data: { expiresAt: now }
        });
        for (const row of earlier) publish({ kind: "settled", userId: input.userId, id: row.id });
    }
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);
    const created = await prisma.signInApproval.create({
        data: {
            userId: input.userId,
            challengeHash,
            device: input.device?.slice(0, 200) ?? null,
            ip: input.ip?.slice(0, 64) ?? null,
            expiresAt
        },
        select: { id: true }
    });
    publish({
        kind: "requested",
        userId: input.userId,
        id: created.id,
        device: input.device,
        ip: input.ip,
        expiresAt
    });
    return created.id;
}

/** Requests still waiting on an answer, for a phone that connects after they were made. */
export async function pendingApprovals(userId: string) {
    return prisma.signInApproval.findMany({
        where: { userId, status: "pending", expiresAt: { gt: new Date() } },
        select: { id: true, device: true, ip: true, expiresAt: true },
        orderBy: { createdAt: "desc" },
        take: 5
    });
}

/** The phone's answer. False when there is nothing left to answer. */
export async function decideApproval(userId: string, id: string, decision: ApprovalDecision): Promise<boolean> {
    const { count } = await prisma.signInApproval.updateMany({
        where: { id, userId, status: "pending", expiresAt: { gt: new Date() } },
        data: { status: decision === "approve" ? "approved" : "denied", decidedAt: new Date() }
    });
    publish({ kind: "settled", userId, id });
    return count === 1;
}

/**
 * The waiting browser asking how its request stands. `identifier` is the
 * challenge its own signed cookie names, so a request id alone - for a challenge
 * somebody else holds - answers nothing but "expired".
 */
export async function collectApproval(identifier: string, id: string): Promise<ApprovalState> {
    const row = await prisma.signInApproval.findUnique({
        where: { id },
        select: { userId: true, challengeHash: true, status: true, expiresAt: true }
    });
    if (!row || !sameHash(row.challengeHash, hashChallenge(identifier))) return { state: "expired" };
    if (row.status === "denied") return { state: "denied" };
    if (row.status === "pending") return row.expiresAt > new Date() ? { state: "pending" } : { state: "expired" };
    if (row.status !== "approved") return { state: "expired" };

    // Spent here, once: a second collector finds it already used.
    const { count } = await prisma.signInApproval.updateMany({
        where: { id, status: "approved" },
        data: { status: "used" }
    });
    if (count !== 1) return { state: "expired" };

    // The same row better-auth's send-otp writes for this challenge (`2fa-otp-`
    // plus the identifier, a SHA-256 base64url hash and the attempt count), so
    // verify-otp checks and consumes it exactly as it would a sent code.
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const hashed = createHash("sha256").update(code).digest("base64url");
    const otpIdentifier = `2fa-otp-${identifier}`;
    await prisma.$transaction([
        prisma.verification.deleteMany({ where: { identifier: otpIdentifier } }),
        prisma.verification.create({
            data: {
                identifier: otpIdentifier,
                value: `${hashed}:0`,
                expiresAt: new Date(Date.now() + CODE_TTL_MS)
            }
        })
    ]);
    await noteSecondFactor(row.userId, "phone-approval");
    return { state: "approved", code };
}
