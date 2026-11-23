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
 *
 * Number matching (as GitHub Mobile and Microsoft Authenticator do it): the
 * browser shows a two-digit number and the phone lists it among three, so a
 * prompt the person did not cause - somebody else holding their password and
 * pressing the button over and over - cannot be approved by a reflexive tap.
 * A wrong pick denies the request, and three in an hour switch phone approval
 * off for the account until the hour has passed.
 *
 * The same request also signs in with no password at all (`purpose: "sign-in"`,
 * see `app/oauth/login/phone-sign-in-actions.ts`). There the identifier is a
 * random secret held in an http-only cookie of the browser that asked, so only
 * that browser can collect the approval, and what it collects is the account to
 * issue a session for rather than a code. Each kind is collected only by its
 * own collector, so an approval for one can never be spent as the other.
 */

import { prisma } from "@polaris/db";
import { noteSecondFactor } from "@polaris/auth";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/** How long the phone has to answer. */
export const APPROVAL_TTL_MS = 2 * 60_000;
/** How long the handed-over code is good for: it is spent straight away. */
const CODE_TTL_MS = 60_000;
/** Wrong picks tolerated in `MISMATCH_WINDOW_MS` before phone approval rests. */
export const MISMATCH_LIMIT = 3;
const MISMATCH_WINDOW_MS = 60 * 60_000;

export type ApprovalDecision = "approve" | "deny";

/** What a request finishes: a second-factor challenge, or a whole sign-in. */
export type ApprovalPurpose = "second-factor" | "sign-in";

/** How a phone's answer landed. */
export type DecisionOutcome = "approved" | "denied" | "mismatch" | "outdated" | "gone";

/** What the waiting browser learns when it asks. */
export type ApprovalState =
    | { state: "pending" }
    | { state: "denied"; reason: "not-me" | "mismatch" }
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
          place: string | null;
          choices: number[] | null;
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

/**
 * The three numbers the phone offers: the right one and two others, in an order
 * that does not give it away. Worked out from the request's id, so a phone that
 * connects later - or reconnects - is offered the same three.
 */
export function matchChoices(id: string, matchNumber: number): number[] {
    const seed = createHash("sha256").update(`choices:${id}`).digest();
    const others: number[] = [];
    for (let index = 0; others.length < 2; index += 1) {
        const candidate = 10 + ((seed[index % seed.length]! + index * 37) % 90);
        if (candidate !== matchNumber && !others.includes(candidate)) others.push(candidate);
    }
    others.splice(seed[31]! % 3, 0, matchNumber);
    return others;
}

/** Whether the account has the phone app on a phone that could answer, and is not resting it. */
export async function phoneCanApprove(userId: string): Promise<boolean> {
    const key = await prisma.mobileDeviceKey
        .findFirst({ where: { userId, platform: "android" }, select: { id: true } })
        .catch(() => null);
    if (!key) return false;
    const wrong = await prisma.signInApproval
        .count({
            where: { userId, reason: "mismatch", decidedAt: { gt: new Date(Date.now() - MISMATCH_WINDOW_MS) } }
        })
        .catch(() => 0);
    return wrong < MISMATCH_LIMIT;
}

/** Ask the phone. Any earlier request for the same challenge stops counting. */
export async function requestApproval(input: {
    userId: string;
    identifier: string;
    device: string | null;
    ip: string | null;
    place: string | null;
    purpose?: ApprovalPurpose;
}): Promise<{ id: string; matchNumber: number }> {
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
    const matchNumber = randomInt(10, 100);
    const place = input.place?.slice(0, 120) ?? null;
    const created = await prisma.signInApproval.create({
        data: {
            userId: input.userId,
            challengeHash,
            device: input.device?.slice(0, 200) ?? null,
            ip: input.ip?.slice(0, 64) ?? null,
            place,
            matchNumber,
            purpose: input.purpose ?? "second-factor",
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
        place,
        choices: matchChoices(created.id, matchNumber),
        expiresAt
    });
    return { id: created.id, matchNumber };
}

/** Requests still waiting on an answer, for a phone that connects after they were made. */
export async function pendingApprovals(userId: string) {
    const rows = await prisma.signInApproval.findMany({
        where: { userId, status: "pending", expiresAt: { gt: new Date() } },
        select: { id: true, device: true, ip: true, place: true, matchNumber: true, expiresAt: true },
        orderBy: { createdAt: "desc" },
        take: 5
    });
    return rows.map(({ matchNumber, ...row }) => ({
        ...row,
        choices: matchNumber === null ? null : matchChoices(row.id, matchNumber)
    }));
}

/**
 * The phone's answer. `picked` is the number chosen on the phone; a request that
 * carries a number is approved only with the right one. An approval without a
 * pick, from a phone app that predates number matching, changes nothing and is
 * answered "outdated" so the phone can say to update - denying still works.
 */
export async function decideApproval(
    userId: string,
    id: string,
    decision: ApprovalDecision,
    picked: number | null = null
): Promise<DecisionOutcome> {
    const live = { id, userId, status: "pending", expiresAt: { gt: new Date() } };
    const row = await prisma.signInApproval.findFirst({ where: live, select: { matchNumber: true } });
    if (!row) return "gone";
    let outcome: DecisionOutcome;
    if (decision === "deny") outcome = "denied";
    else if (row.matchNumber === null) outcome = "approved";
    else if (picked === null) return "outdated";
    else outcome = picked === row.matchNumber ? "approved" : "mismatch";
    const { count } = await prisma.signInApproval.updateMany({
        where: live,
        data: {
            status: outcome === "approved" ? "approved" : "denied",
            reason: outcome === "denied" ? "not-me" : outcome === "mismatch" ? "mismatch" : null,
            decidedAt: new Date()
        }
    });
    publish({ kind: "settled", userId, id });
    return count === 1 ? outcome : "gone";
}

/**
 * The waiting browser asking how its request stands. `identifier` is the
 * challenge its own signed cookie names, so a request id alone - for a challenge
 * somebody else holds - answers nothing but "expired".
 */
export async function collectApproval(identifier: string, id: string): Promise<ApprovalState> {
    const row = await prisma.signInApproval.findUnique({
        where: { id },
        select: { userId: true, challengeHash: true, status: true, reason: true, expiresAt: true, purpose: true }
    });
    const settled = await settle(row, identifier, "second-factor", id);
    if (settled.state !== "approved") return settled;
    if (!row) return { state: "expired" };

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

type Settled = Exclude<ApprovalState, { state: "approved" }> | { state: "approved" };

/**
 * Where a request stands for the browser asking, spending an approval on the
 * way: a request of another purpose, or for another browser's identifier,
 * answers "expired" like one that does not exist.
 */
async function settle(
    row: {
        challengeHash: string;
        status: string;
        reason: string | null;
        expiresAt: Date;
        purpose: string;
    } | null,
    identifier: string,
    purpose: ApprovalPurpose,
    id: string
): Promise<Settled> {
    if (!row || row.purpose !== purpose || !sameHash(row.challengeHash, hashChallenge(identifier)))
        return { state: "expired" };
    if (row.status === "denied") return { state: "denied", reason: row.reason === "mismatch" ? "mismatch" : "not-me" };
    if (row.status === "pending") return row.expiresAt > new Date() ? { state: "pending" } : { state: "expired" };
    if (row.status !== "approved") return { state: "expired" };
    // Spent here, once: a second collector finds it already used.
    const { count } = await prisma.signInApproval.updateMany({
        where: { id, status: "approved" },
        data: { status: "used" }
    });
    return count === 1 ? { state: "approved" } : { state: "expired" };
}

/** How a passwordless request stands; an approved one names the account to sign in. */
export type SignInApprovalState = Exclude<ApprovalState, { state: "approved" }> | { state: "approved"; userId: string };

/**
 * The browser that asked to sign in with its phone, collecting the answer.
 * `secret` is the value of its own http-only cookie; an approval is handed over
 * once, and only to the browser holding it.
 */
export async function collectSignIn(secret: string, id: string): Promise<SignInApprovalState> {
    const row = await prisma.signInApproval.findUnique({
        where: { id },
        select: { userId: true, challengeHash: true, status: true, reason: true, expiresAt: true, purpose: true }
    });
    const settled = await settle(row, secret, "sign-in", id);
    return settled.state === "approved" && row ? { state: "approved", userId: row.userId } : (settled as SignInApprovalState);
}

/** What a request was for, so a refusal can be described in the right words. */
export async function approvalPurpose(id: string): Promise<ApprovalPurpose> {
    const row = await prisma.signInApproval.findUnique({ where: { id }, select: { purpose: true } }).catch(() => null);
    return row?.purpose === "sign-in" ? "sign-in" : "second-factor";
}
