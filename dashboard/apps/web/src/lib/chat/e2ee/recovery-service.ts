/**
 * Quorum recovery of an account key, server side (docs/chat-e2ee-mls.md,
 * "Recovery"). Everything stored here is an envelope sealed in a browser; the
 * server never holds a share, let alone a key, it could open.
 *
 * - Custodians: the administrators (owner first) of the organisation the
 *   account joined first, or the instance's administrators (`users.manage`) for
 *   an account in no organisation; only accounts with a key; see
 *   `recovery-policy.ts` for how many.
 * - A request can only be raised by an account that recovered its password in
 *   the last 7 days: an administrator-approved account recovery
 *   (`account-recovery-service.ts`) that was used, or the Security page's
 *   forgotten-password reset (`recoverPasswordAction`: an authenticator code, or
 *   the recovery questions with a code sent to the email or phone). The quorum
 *   is for "forgot the password and lost every device", and the person has
 *   already proven who they are once.
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
    return candidatesFor(policy.firstOrg(membership, owned));
}

/** A scope's candidate custodians in order: the organisation's owner and admins, or the instance's. */
async function candidatesFor(orgId: string | null): Promise<{ scope: policy.RecoveryScope; orgName: string | null; candidates: string[] }> {
    const instance = async () => ({ scope: "instance" as const, orgName: null, candidates: await usersWithPermission("users.manage") });
    if (!orgId) return instance();
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
            name: true,
            ownerId: true,
            members: { where: { role: "admin" }, orderBy: { createdAt: "asc" }, select: { userId: true }, take: 20 }
        }
    });
    if (!org) return instance();
    return {
        scope: `org:${orgId}`,
        orgName: org.name,
        candidates: [org.ownerId, ...org.members.map((member) => member.userId)]
    };
}

/** The keyed custodians among `candidates` and the threshold, never `ownerId` itself. */
async function chosenAmong(ownerId: string, candidates: readonly string[]) {
    const ids = candidates.slice(0, 50);
    const keys = await prisma.chatAccountKey.findMany({
        where: { userId: { in: ids } },
        select: { userId: true, akVersion: true, hpkePublicKey: true }
    });
    const byId = new Map(keys.map((key) => [key.userId, key]));
    return policy.chooseCustodians<CustodianRow>(
        ownerId,
        ids.map((id) => byId.get(id))
    );
}

async function custodiansOf(userId: string) {
    const { scope, orgName, candidates } = await scopeOf(userId);
    return { scope, orgName, ...(await chosenAmong(userId, candidates)) };
}

/**
 * The scopes this account is one of the chosen custodians of: the
 * organisations it owns or administers (at most 20) and the instance when it
 * holds `users.manage`. Each with its custodians and threshold, as for an
 * account; the owner id is the scope itself, so nobody is left out of it.
 */
export async function custodianScopes(userId: string) {
    const [owned, administered, instanceAdmins] = await Promise.all([
        prisma.organization.findMany({ where: { ownerId: userId }, orderBy: { createdAt: "asc" }, select: { id: true }, take: 20 }),
        prisma.organizationMember.findMany({ where: { userId, role: "admin" }, orderBy: { createdAt: "asc" }, select: { orgId: true }, take: 20 }),
        usersWithPermission("users.manage")
    ]);
    const orgIds = [...new Set([...owned.map((org) => org.id), ...administered.map((member) => member.orgId)])].slice(0, 20);
    const scopes = await Promise.all([
        ...orgIds.map((orgId) => candidatesFor(orgId)),
        ...(instanceAdmins.includes(userId) ? [candidatesFor(null)] : [])
    ]);
    const chosen = await Promise.all(
        scopes.map(async ({ scope, orgName, candidates }) => ({ scope, orgName, ...(await chosenAmong(`ork:${scope}`, candidates)) }))
    );
    const seen = new Set<string>();
    return chosen.filter((entry) => {
        if (seen.has(entry.scope) || !entry.custodians.some((custodian) => custodian.userId === userId)) return false;
        seen.add(entry.scope);
        return true;
    });
}

/**
 * The accounts whose logged keys this one may ask the key log for under the
 * `recovery` scope: its custodians now, the custodians its stored shares were
 * sealed to, the accounts whose shares it holds, and its fellow custodians of
 * every scope's organisation recovery key. Nothing the recovery state does not
 * already show it.
 */
export async function recoveryPeers(userId: string): Promise<Set<string>> {
    const [wanted, sealedTo, heldFor, scopes] = await Promise.all([
        custodiansOf(userId),
        prisma.chatRecoveryShare.findMany({ where: { ownerId: userId }, select: { custodianId: true }, take: 16 }),
        prisma.chatRecoveryShare.findMany({ where: { custodianId: userId }, select: { ownerId: true }, take: 500 }),
        custodianScopes(userId)
    ]);
    return new Set([
        ...wanted.custodians.map((custodian) => custodian.userId),
        ...sealedTo.map((share) => share.custodianId),
        ...heldFor.map((share) => share.ownerId),
        ...scopes.flatMap((scope) => scope.custodians.map((custodian) => custodian.userId))
    ]);
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

/**
 * What lets this account ask, if anything, within the window: an
 * administrator-approved recovery that was used (its id), or a forgotten
 * password reset from the Security page with an authenticator code or the
 * recovery questions plus a code sent to the account's email or phone
 * (`self`). Either way the custodians still compare the code with the person.
 */
async function eligibleRecovery(userId: string, now: Date): Promise<{ accountRecoveryId: string | null; via: "admin" | "self" } | null> {
    const since = new Date(now.getTime() - policy.RECOVERY_WINDOW_MS);
    const [approved, reset] = await Promise.all([
        prisma.accountRecovery.findFirst({
            where: { userId, status: "used", decidedAt: { gte: since } },
            orderBy: { decidedAt: "desc" },
            select: { id: true }
        }),
        prisma.auditLog.findFirst({
            where: { actorId: userId, action: policy.PASSWORD_RECOVERED, at: { gte: since } },
            orderBy: { at: "desc" },
            select: { id: true }
        })
    ]);
    if (approved) return { accountRecoveryId: approved.id, via: "admin" };
    return reset ? { accountRecoveryId: null, via: "self" } : null;
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
    const eligible = await eligibleRecovery(userId, now);
    if (!eligible) throw new RecoveryRefusal("notEligible");
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
                accountRecoveryId: eligible.accountRecoveryId,
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
        metadata: { requestId: created.id, threshold, custodians: shares.length, via: eligible.via }
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
    const approvals = await prisma.chatRecoveryApproval.count({ where: { requestId, envelope: { not: null } } });
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

/**
 * A custodian refuses to release their share - they could not confirm it was
 * the person, or the code did not match. Once so many have declined that the
 * rest cannot reach the threshold, the request is closed as `declined` and the
 * account is told; a new request needs a new administrator approval window.
 */
export async function declineRequest(custodianId: string, requestId: string, now = new Date()): Promise<{ declined: boolean }> {
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
        await prisma.chatRecoveryApproval.create({ data: { requestId, custodianId, envelope: null } });
    } catch (caught) {
        // Already answered, either way: an approval is never turned into a decline.
        if (!(caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002")) throw caught;
    }
    const [holders, declines] = await Promise.all([
        prisma.chatRecoveryShare.count({ where: { ownerId: request.userId, splitId: request.splitId } }),
        prisma.chatRecoveryApproval.count({ where: { requestId, envelope: null } })
    ]);
    const declined =
        holders - declines < request.threshold &&
        (await prisma.chatRecoveryRequest.updateMany({ where: { id: requestId, status: "pending" }, data: { status: "declined" } }))
            .count === 1;
    await recordAudit({
        actorId: custodianId,
        action: "chat.recovery.declined",
        targetType: "user",
        targetId: request.userId,
        metadata: { requestId, declines, holders, threshold: request.threshold, closed: declined }
    });
    if (declined) await tell(request.userId, "chat_recovery_declined", "chat_recovery_declined_body");
    return { declined };
}

/**
 * The organisation recovery key (`ORK`) of each scope this account is a
 * custodian of: the custodians and threshold a new one would be split to, and
 * the live key if there is one (`current` when its shares still match those
 * custodians). A custodian's browser creates the key where there is none.
 */
export async function recoveryKeyState(userId: string) {
    const scopes = await custodianScopes(userId);
    if (scopes.length === 0) return [];
    const keys = await prisma.chatRecoveryKey.findMany({
        where: { scope: { in: scopes.map((scope) => scope.scope) }, retiredAt: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, scope: true, threshold: true, shares: { select: { custodianId: true, custodianAkVersion: true }, take: 16 } },
        take: 100
    });
    return scopes.map((entry) => {
        const live = keys.find((key) => key.scope === entry.scope) ?? null;
        const current =
            live !== null &&
            live.threshold === entry.threshold &&
            live.shares.length === entry.custodians.length &&
            entry.custodians.every((custodian) =>
                live.shares.some((share) => share.custodianId === custodian.userId && share.custodianAkVersion === custodian.akVersion)
            );
        return {
            scope: entry.scope,
            orgName: entry.orgName,
            threshold: entry.threshold,
            custodians: entry.custodians,
            key: live ? { id: live.id, current } : null
        };
    });
}

/**
 * Store a scope's first `ORK`: its public key and its seed's shares, one per
 * custodian, only from one of those custodians and only if the split matches
 * the policy now. Two custodians creating at once both succeed here; the older
 * key stays live and the newer is retired at once, so a scope has one.
 */
export async function putRecoveryKey(
    userId: string,
    input: {
        id: string;
        scope: string;
        hpkePublicKey: Uint8Array;
        threshold: number;
        shares: ReadonlyArray<{ custodianId: string; custodianAkVersion: number; envelope: Uint8Array }>;
    },
    now = new Date()
): Promise<{ kept: boolean }> {
    const wanted = (await custodianScopes(userId)).find((entry) => entry.scope === input.scope);
    if (!wanted) throw new RecoveryRefusal("notFound");
    const matches =
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
    const existing = await prisma.chatRecoveryKey.findFirst({ where: { scope: input.scope, retiredAt: null }, select: { id: true } });
    if (existing) throw new RecoveryRefusal("stale");
    await prisma.$transaction([
        prisma.chatRecoveryKey.create({
            data: {
                id: input.id,
                scope: input.scope,
                hpkePublicKey: Buffer.from(input.hpkePublicKey),
                threshold: input.threshold,
                createdById: userId
            }
        }),
        prisma.chatRecoveryKeyShare.createMany({
            data: input.shares.map((share) => ({
                keyId: input.id,
                custodianId: share.custodianId,
                custodianAkVersion: share.custodianAkVersion,
                envelope: Buffer.from(share.envelope)
            }))
        })
    ]);
    const live = await prisma.chatRecoveryKey.findMany({
        where: { scope: input.scope, retiredAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
        take: 2
    });
    const kept = live[0]?.id === input.id;
    if (!kept) await prisma.chatRecoveryKey.updateMany({ where: { id: input.id }, data: { retiredAt: now } });
    await recordAudit({
        actorId: userId,
        action: "chat.recovery.key-created",
        metadata: { keyId: input.id, scope: input.scope, threshold: input.threshold, custodians: input.shares.length, kept }
    });
    return { kept };
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
