/**
 * Quorum recovery of an account key, server side (docs/chat-e2ee-mls.md,
 * "Recovery"). Everything stored here is an envelope sealed in a browser; the
 * server never holds a share, let alone a key, it could open.
 *
 * - Custodians: the administrators (owner first) of the organisation the
 *   account joined first, or the instance's administrators (`users.manage`) for
 *   an account in no organisation; only accounts with a key; see
 *   `recovery-policy.ts` for how many.
 * - A request can only be raised by an account whose administrator-approved
 *   account recovery (`account-recovery-service.ts`) was used in the last 7
 *   days: the quorum is for "forgot the password and lost every device", and an
 *   administrator has already judged that this is the person.
 * - Every request, approval and completion is in the audit log and told to the
 *   account; custodians are told a request waits for them.
 */

import * as policy from "./recovery-policy";
import { prisma, Prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { usersWithPermission } from "@polaris/auth";
import { notify } from "@/lib/notifications/dispatch";
import { wordsFor } from "@/lib/notifications/notice-words";

const SECURITY = "/account/security";
const MAX_SHARE_BYTES = 4096;

export class RecoveryRefusal extends Error {
    constructor(readonly code: "noKey" | "stale" | "notEligible" | "noShares" | "notFound") {
        super(code);
        this.name = "RecoveryRefusal";
    }
}

interface CustodianRow {
    userId: string;
    akVersion: number;
    hpkePublicKey: Uint8Array;
}

/** The scope an account's shares belong to and its candidate custodians, in order. */
async function scopeOf(userId: string): Promise<{ scope: policy.RecoveryScope; orgName: string | null; candidates: string[] }> {
    const [membership, owned] = await Promise.all([
        prisma.organizationMember.findFirst({
            where: { userId },
            orderBy: { createdAt: "asc" },
            select: { orgId: true, createdAt: true }
        }),
        prisma.organization.findFirst({
            where: { ownerId: userId },
            orderBy: { createdAt: "asc" },
            select: { id: true, createdAt: true }
        })
    ]);
    const orgId =
        membership && owned
            ? membership.createdAt <= owned.createdAt
                ? membership.orgId
                : owned.id
            : (membership?.orgId ?? owned?.id ?? null);
    if (!orgId) return { scope: "instance", orgName: null, candidates: await usersWithPermission("users.manage") };
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            name: true,
            ownerId: true,
            members: { where: { role: "admin" }, orderBy: { createdAt: "asc" }, select: { userId: true }, take: 20 }
        }
    });
    if (!org) return { scope: "instance", orgName: null, candidates: await usersWithPermission("users.manage") };
    return {
        scope: `org:${orgId}`,
        orgName: org.name,
        candidates: [org.ownerId, ...org.members.map((member) => member.userId)]
    };
}

async function custodiansOf(userId: string) {
    const { scope, orgName, candidates } = await scopeOf(userId);
    const ids = candidates.slice(0, 50);
    const keys = await prisma.chatAccountKey.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, akVersion: true, hpkePublicKey: true }
    });
    const byId = new Map(keys.map((key) => [key.userId, key]));
    const chosen = policy.chooseCustodians<CustodianRow>(
        userId,
        ids.map((id) => byId.get(id))
    );
    return { scope, orgName, ...chosen };
}

const SHARE_SELECT = {
    custodianId: true,
    custodianAkVersion: true,
    akVersion: true,
    splitId: true,
    threshold: true,
    scope: true
} as const;

/** What the account's browser needs to keep its shares current. */
export async function recoveryState(userId: string) {
    const [wanted, shares, soleFor] = await Promise.all([
        custodiansOf(userId),
        prisma.chatRecoveryShare.findMany({ where: { ownerId: userId }, select: SHARE_SELECT, take: 16 }),
        // Accounts only this one can recover: the single administrator's warning.
        prisma.chatRecoveryShare.count({ where: { custodianId: userId, threshold: 1 } })
    ]);
    return {
        scope: wanted.scope,
        orgName: wanted.orgName,
        threshold: wanted.threshold,
        custodians: wanted.custodians,
        shares,
        soleCustodianOf: soleFor
    };
}

/** Replace every share of the account with one new split, only if it matches the policy now. */
export async function putShares(
    userId: string,
    input: {
        akVersion: number;
        splitId: string;
        threshold: number;
        scope: string;
        shares: ReadonlyArray<{ custodianId: string; custodianAkVersion: number; envelope: Uint8Array }>;
    }
): Promise<void> {
    const [key, wanted] = await Promise.all([
        prisma.chatAccountKey.findUnique({ where: { userId }, select: { akVersion: true } }),
        custodiansOf(userId)
    ]);
    if (!key) throw new RecoveryRefusal("noKey");
    const matches =
        key.akVersion === input.akVersion &&
        wanted.scope === input.scope &&
        wanted.threshold === input.threshold &&
        input.shares.length === wanted.custodians.length &&
        wanted.custodians.every((custodian) =>
            input.shares.some(
                (share) =>
                    share.custodianId === custodian.userId &&
                    share.custodianAkVersion === custodian.akVersion &&
                    share.envelope.length <= MAX_SHARE_BYTES
            )
        );
    if (!matches) throw new RecoveryRefusal("stale");
    await prisma.$transaction([
        prisma.chatRecoveryShare.deleteMany({ where: { ownerId: userId } }),
        prisma.chatRecoveryShare.createMany({
            data: input.shares.map((share) => ({
                ownerId: userId,
                custodianId: share.custodianId,
                akVersion: input.akVersion,
                splitId: input.splitId,
                threshold: input.threshold,
                custodianAkVersion: share.custodianAkVersion,
                scope: input.scope,
                envelope: Buffer.from(share.envelope)
            }))
        })
    ]);
}

/** The administrator-approved recovery that lets this account ask, if any. */
async function eligibleRecovery(userId: string, now: Date): Promise<string | null> {
    const row = await prisma.accountRecovery.findFirst({
        where: {
            userId,
            status: "used",
            decidedAt: { gte: new Date(now.getTime() - policy.RECOVERY_WINDOW_MS) }
        },
        orderBy: { decidedAt: "desc" },
        select: { id: true }
    });
    return row?.id ?? null;
}

async function tell(userId: string, title: string, body: string): Promise<void> {
    const t = await wordsFor(userId, "notices");
    await notify({
        userId,
        event: "account.security",
        title: t(`security.${title}` as Parameters<typeof t>[0]),
        body: t(`security.${body}` as Parameters<typeof t>[0]),
        href: SECURITY
    }).catch((caught: unknown) => console.error("polaris: a recovery notice could not be sent:", caught));
}

/** The account's open request, if any, and whether it may raise one. */
export async function ownRequest(userId: string, now = new Date()) {
    const [request, eligible] = await Promise.all([
        prisma.chatRecoveryRequest.findFirst({
            where: { userId, status: { in: ["pending", "released"] }, expiresAt: { gt: now } },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                status: true,
                akVersion: true,
                threshold: true,
                requesterKey: true,
                expiresAt: true,
                approvals: { select: { custodianId: true, envelope: true }, take: policy.MAX_CUSTODIANS }
            }
        }),
        eligibleRecovery(userId, now)
    ]);
    return { request, eligible: eligible !== null };
}

/** Raise a request with the requester browser's one-off public key. Replaces a pending one. */
export async function openRequest(userId: string, requesterKey: Uint8Array, now = new Date()): Promise<string> {
    const recoveryId = await eligibleRecovery(userId, now);
    if (!recoveryId) throw new RecoveryRefusal("notEligible");
    const key = await prisma.chatAccountKey.findUnique({ where: { userId }, select: { akVersion: true } });
    if (!key) throw new RecoveryRefusal("noKey");
    const shares = await prisma.chatRecoveryShare.findMany({
        where: { ownerId: userId, akVersion: key.akVersion },
        select: { custodianId: true, splitId: true, threshold: true },
        take: 16
    });
    const splitId = shares[0]?.splitId;
    const threshold = shares[0]?.threshold ?? 0;
    if (!splitId || threshold < 1 || shares.length < threshold || shares.some((share) => share.splitId !== splitId))
        throw new RecoveryRefusal("noShares");

    const created = await prisma.$transaction(async (tx) => {
        await tx.chatRecoveryRequest.updateMany({
            where: { userId, status: "pending" },
            data: { status: "cancelled" }
        });
        return tx.chatRecoveryRequest.create({
            data: {
                userId,
                accountRecoveryId: recoveryId,
                akVersion: key.akVersion,
                splitId,
                threshold,
                requesterKey: Buffer.from(requesterKey),
                expiresAt: new Date(now.getTime() + policy.REQUEST_MS)
            },
            select: { id: true }
        });
    });
    await recordAudit({
        actorId: userId,
        action: "chat.recovery.requested",
        targetType: "user",
        targetId: userId,
        metadata: { requestId: created.id, threshold, custodians: shares.length }
    });
    await Promise.all([
        tell(userId, "chat_recovery_requested", "chat_recovery_requested_body"),
        ...shares.map((share) => tell(share.custodianId, "chat_recovery_waiting", "chat_recovery_waiting_body"))
    ]);
    return created.id;
}

/** The open requests waiting on this custodian, with the share they hold for each. */
export async function custodianInbox(custodianId: string, now = new Date()) {
    const shares = await prisma.chatRecoveryShare.findMany({
        where: { custodianId },
        select: {
            ownerId: true,
            splitId: true,
            akVersion: true,
            custodianAkVersion: true,
            envelope: true,
            owner: { select: { name: true, email: true } }
        },
        take: 500
    });
    if (shares.length === 0) return [];
    const requests = await prisma.chatRecoveryRequest.findMany({
        where: {
            userId: { in: shares.map((share) => share.ownerId) },
            status: "pending",
            expiresAt: { gt: now },
            approvals: { none: { custodianId } }
        },
        orderBy: { createdAt: "asc" },
        take: 50,
        select: { id: true, userId: true, splitId: true, akVersion: true, threshold: true, requesterKey: true, createdAt: true, expiresAt: true }
    });
    return requests.flatMap((request) => {
        const share = shares.find((s) => s.ownerId === request.userId && s.splitId === request.splitId);
        return share ? [{ ...request, share }] : [];
    });
}

/** A custodian's share, opened in their browser and sealed to the request's key. */
export async function approveRequest(
    custodianId: string,
    requestId: string,
    envelope: Uint8Array,
    now = new Date()
): Promise<{ released: boolean }> {
    if (envelope.length > MAX_SHARE_BYTES) throw new RecoveryRefusal("notFound");
    const request = await prisma.chatRecoveryRequest.findFirst({
        where: { id: requestId, status: "pending", expiresAt: { gt: now } },
        select: { userId: true, splitId: true, threshold: true }
    });
    if (!request) throw new RecoveryRefusal("notFound");
    const share = await prisma.chatRecoveryShare.findUnique({
        where: { ownerId_custodianId: { ownerId: request.userId, custodianId } },
        select: { splitId: true }
    });
    if (!share || share.splitId !== request.splitId) throw new RecoveryRefusal("notFound");
    try {
        await prisma.chatRecoveryApproval.create({ data: { requestId, custodianId, envelope: Buffer.from(envelope) } });
    } catch (caught) {
        if (!(caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002")) throw caught;
    }
    const approvals = await prisma.chatRecoveryApproval.count({ where: { requestId } });
    const released =
        approvals >= request.threshold &&
        (await prisma.chatRecoveryRequest.updateMany({ where: { id: requestId, status: "pending" }, data: { status: "released" } }))
            .count === 1;
    await recordAudit({
        actorId: custodianId,
        action: "chat.recovery.approved",
        targetType: "user",
        targetId: request.userId,
        metadata: { requestId, approvals, threshold: request.threshold }
    });
    await tell(request.userId, "chat_recovery_approved", "chat_recovery_approved_body");
    return { released };
}

/** The requester's browser holds its key again: close the request, drop the released shares. */
export async function completeRequest(userId: string, requestId: string): Promise<void> {
    const done = await prisma.chatRecoveryRequest.updateMany({
        where: { id: requestId, userId, status: "released" },
        data: { status: "completed", completedAt: new Date() }
    });
    if (done.count !== 1) throw new RecoveryRefusal("notFound");
    await prisma.chatRecoveryApproval.deleteMany({ where: { requestId } });
    await recordAudit({
        actorId: userId,
        action: "chat.recovery.completed",
        targetType: "user",
        targetId: userId,
        metadata: { requestId }
    });
    await tell(userId, "chat_recovery_completed", "chat_recovery_completed_body");
}
