/**
 * Opening an organisation recovery key (`ORK`) with a quorum of its custodians
 * (docs/chat-e2ee-mls.md, "Recovery"), server side.
 *
 * The legacy migration seals a conversation's history key to the `ORK` of
 * every scope a member with no account key yet belongs to. When such a member
 * comes back with a key and nobody who holds that history is around to pass it
 * on, one custodian raises an opening: a one-off public key, like an account's
 * recovery request. The other custodians compare its code with the opener and
 * release their seed shares to it; with the key's threshold of them the
 * opener's browser rebuilds the seed, checks it against the key's public half,
 * seals each history key to the members missing it (`openingWork`,
 * `putOpenedKeys`), and splits the seed again to today's custodians when they
 * changed (`resplitKey`). The server only ever stores envelopes.
 */

import * as policy from "./recovery-policy";
import { prisma, Prisma } from "@polaris/db";
import { audienceOf } from "./legacy-migration";
import { recordAudit } from "@/lib/audit-service";
import { recoveryRecipient } from "./recovery-keys";
import { legacyKeyGaps, putHistoryKeys } from "./mls-delivery";
import { RecoveryRefusal, custodianScopes, keyHolders, recoveryKeyState, tell } from "./recovery-service";

const MAX_SHARE_BYTES = 4096;
/** Conversations (one history key each) a work page answers. */
const WORK_PAGE = 10;
/** History keys of one conversation sealed to the key a page reads at most: the migration's and its sweeps'. */
const EPOCHS_PER_CHANNEL = 16;
/** Members missing a history key a work page answers per conversation. */
const WORK_GAPS = 100;
/** Waiting members counted per key: enough to say "some", bounded however large the scope. */
const WAITING_CAP = 1000;

/**
 * How many members of a key's conversations now have an account key and no
 * copy of a history key sealed to it: who an opening would let back in. The
 * conversations' own members only, and capped; the work itself reads each
 * conversation's whole audience.
 */
async function waitingMembers(keyId: string): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ waiting: bigint | number }>>(Prisma.sql`
        SELECT COUNT(*) AS "waiting" FROM (
            SELECT 1 FROM "ChatHistoryKey" o
            JOIN "ChatChannelMember" m ON m."channelId" = o."channelId"
            JOIN "ChatAccountKey" a ON a."userId" = m."userId"
            WHERE o."recipient" = ${recoveryRecipient(keyId)}
              AND NOT EXISTS (
                  SELECT 1 FROM "ChatHistoryKey" h
                  WHERE h."channelId" = o."channelId" AND h."epoch" = o."epoch" AND h."recipient" = m."userId"::text
              )
            LIMIT ${WAITING_CAP}
        ) AS gaps`);
    return Number(rows[0]?.waiting ?? 0);
}

/**
 * The organisation recovery key of each scope this account is a custodian of,
 * as `recoveryKeyState` answers it, plus what an opening needs: how many
 * members wait on it, and its open openings - the caller's own (with the
 * released shares once the quorum is met) and the ones waiting on the caller.
 */
export async function keyState(userId: string, now = new Date()) {
    const scopes = await recoveryKeyState(userId);
    const keyIds = scopes.flatMap((entry) => (entry.key ? [entry.key.id] : []));
    const [openings, waiting] = await Promise.all([
        keyIds.length
            ? prisma.chatRecoveryKeyOpening.findMany({
                  where: { keyId: { in: keyIds }, status: { in: ["pending", "released"] }, expiresAt: { gt: now } },
                  orderBy: { createdAt: "asc" },
                  take: 50,
                  select: {
                      id: true,
                      keyId: true,
                      openerId: true,
                      status: true,
                      splitId: true,
                      threshold: true,
                      requesterKey: true,
                      expiresAt: true,
                      releases: { select: { custodianId: true, envelope: true }, take: policy.MAX_CUSTODIANS + 1 }
                  }
              })
            : [],
        Promise.all(keyIds.map(async (id) => [id, await waitingMembers(id)] as const))
    ]);
    const openers = await prisma.user.findMany({
        where: { id: { in: [...new Set(openings.map((opening) => opening.openerId))] } },
        select: { id: true, name: true, email: true }
    });
    const waitingBy = new Map(waiting);
    return scopes.map((entry) => ({
        ...entry,
        waiting: entry.key ? (waitingBy.get(entry.key.id) ?? 0) : 0,
        openings: openings
            .filter((opening) => opening.keyId === entry.key?.id)
            // Another custodian's opening the caller already answered is not theirs to see again.
            .filter((opening) => opening.openerId === userId || !opening.releases.some((release) => release.custodianId === userId))
            .map((opening) => {
                const opener = openers.find((user) => user.id === opening.openerId);
                const mine = opening.openerId === userId;
                return {
                    id: opening.id,
                    keyId: opening.keyId,
                    mine,
                    openerName: opener?.name ?? null,
                    openerEmail: opener?.email ?? null,
                    status: opening.status,
                    splitId: opening.splitId,
                    threshold: opening.threshold,
                    requesterKey: new Uint8Array(opening.requesterKey),
                    expiresAt: opening.expiresAt,
                    released: opening.releases.filter((release) => release.envelope).length,
                    declined: opening.releases.filter((release) => !release.envelope).length,
                    ownReleased: opening.releases.some((release) => release.custodianId === userId && release.envelope),
                    // The shares only for the opener and only once the quorum is met; they open for that browser alone.
                    shares:
                        mine && opening.status === "released"
                            ? opening.releases.flatMap((release) =>
                                  release.envelope ? [{ custodianId: release.custodianId, envelope: new Uint8Array(release.envelope) }] : []
                              )
                            : []
                };
            })
    }));
}

/** The live key `keyId` of a scope the account is a holder of, with that scope's custodians. */
async function heldKey(userId: string, keyId: string) {
    const scopes = await custodianScopes(userId);
    const key = await prisma.chatRecoveryKey.findFirst({
        where: { id: keyId, retiredAt: null, scope: { in: scopes.map((entry) => entry.scope) } },
        select: {
            id: true,
            scope: true,
            threshold: true,
            splitId: true,
            shares: { select: { custodianId: true, custodianAkVersion: true }, take: 16 }
        }
    });
    const entry = key && scopes.find((scope) => scope.scope === key.scope);
    if (!key || !entry) throw new RecoveryRefusal("notFound");
    const holders = keyHolders(key.shares, entry.custodians);
    if (!holders.includes(userId)) throw new RecoveryRefusal("notFound");
    return { key, entry, holders, splitId: key.splitId ?? key.id };
}

/** Raise an opening of `keyId` with the opener browser's one-off public key. Replaces the caller's pending one. */
export async function startOpening(userId: string, keyId: string, requesterKey: Uint8Array, now = new Date()): Promise<string> {
    const { key, holders, splitId } = await heldKey(userId, keyId);
    if (holders.length < key.threshold) throw new RecoveryRefusal("noShares");
    const created = await prisma.$transaction(async (tx) => {
        await tx.chatRecoveryKeyOpening.updateMany({ where: { keyId, openerId: userId, status: "pending" }, data: { status: "cancelled" } });
        return tx.chatRecoveryKeyOpening.create({
            data: {
                keyId,
                openerId: userId,
                splitId,
                threshold: key.threshold,
                requesterKey: Buffer.from(requesterKey),
                expiresAt: new Date(now.getTime() + policy.REQUEST_MS)
            },
            select: { id: true }
        });
    });
    await recordAudit({
        actorId: userId,
        action: "chat.recovery.key-opening-requested",
        metadata: { openingId: created.id, keyId, scope: key.scope, threshold: key.threshold, holders: holders.length }
    });
    await Promise.all(
        holders.filter((id) => id !== userId).map((id) => tell(id, "chat_recovery_key_waiting", "chat_recovery_key_waiting_body"))
    );
    return created.id;
}

/** A pending opening of a live key the account holds a share of, for the split the opening names. */
async function openingFor(userId: string, openingId: string, now: Date) {
    const opening = await prisma.chatRecoveryKeyOpening.findFirst({
        where: { id: openingId, status: "pending", expiresAt: { gt: now } },
        select: { keyId: true, openerId: true, splitId: true, threshold: true }
    });
    if (!opening) throw new RecoveryRefusal("notFound");
    const held = await heldKey(userId, opening.keyId);
    if (held.splitId !== opening.splitId) throw new RecoveryRefusal("notFound");
    return { opening, held };
}

/** A custodian's seed share, opened in their browser and sealed to the opening's key (the opener's own too). */
export async function releaseOpening(userId: string, openingId: string, envelope: Uint8Array, now = new Date()): Promise<{ released: boolean }> {
    if (envelope.length > MAX_SHARE_BYTES) throw new RecoveryRefusal("notFound");
    const { opening, held } = await openingFor(userId, openingId, now);
    try {
        await prisma.chatRecoveryKeyRelease.create({ data: { openingId, custodianId: userId, envelope: Buffer.from(envelope) } });
    } catch (caught) {
        if (!(caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002")) throw caught;
    }
    const releases = await prisma.chatRecoveryKeyRelease.count({ where: { openingId, envelope: { not: null } } });
    const released =
        releases >= opening.threshold &&
        (await prisma.chatRecoveryKeyOpening.updateMany({ where: { id: openingId, status: "pending" }, data: { status: "released" } })).count === 1;
    await recordAudit({
        actorId: userId,
        action: "chat.recovery.key-opening-approved",
        metadata: { openingId, keyId: opening.keyId, scope: held.key.scope, releases, threshold: opening.threshold }
    });
    if (released && opening.openerId !== userId) await tell(opening.openerId, "chat_recovery_key_released", "chat_recovery_key_released_body");
    return { released };
}

/** A custodian refuses; once the rest cannot reach the threshold the opening closes as `declined`. */
export async function declineOpening(userId: string, openingId: string, now = new Date()): Promise<{ declined: boolean }> {
    const { opening, held } = await openingFor(userId, openingId, now);
    try {
        await prisma.chatRecoveryKeyRelease.create({ data: { openingId, custodianId: userId, envelope: null } });
    } catch (caught) {
        // Already answered, either way: a release is never turned into a decline.
        if (!(caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === "P2002")) throw caught;
    }
    const declines = await prisma.chatRecoveryKeyRelease.count({ where: { openingId, envelope: null } });
    const declined =
        held.holders.length - declines < opening.threshold &&
        (await prisma.chatRecoveryKeyOpening.updateMany({ where: { id: openingId, status: "pending" }, data: { status: "declined" } })).count === 1;
    await recordAudit({
        actorId: userId,
        action: "chat.recovery.key-opening-declined",
        metadata: { openingId, keyId: opening.keyId, scope: held.key.scope, declines, holders: held.holders.length, closed: declined }
    });
    if (declined && opening.openerId !== userId) await tell(opening.openerId, "chat_recovery_key_declined", "chat_recovery_key_declined_body");
    return { declined };
}

/** The caller's released opening, still within its window. */
async function releasedOpening(userId: string, openingId: string, now: Date) {
    const opening = await prisma.chatRecoveryKeyOpening.findFirst({
        where: { id: openingId, openerId: userId, status: "released", expiresAt: { gt: now } },
        select: { keyId: true, key: { select: { scope: true, retiredAt: true } } }
    });
    if (!opening || opening.key.retiredAt) throw new RecoveryRefusal("notFound");
    return opening;
}

/**
 * A page of the history keys sealed to the opened key, each with the members
 * of its conversation who have an account key and no copy of it, after the
 * conversation `after` (ids ascending). `next` is null on the last page.
 */
export async function openingWork(userId: string, openingId: string, after: string | null, now = new Date()) {
    const opening = await releasedOpening(userId, openingId, now);
    const recipient = recoveryRecipient(opening.keyId);
    // A page is whole conversations, so a cursor on the conversation never skips one of its epochs.
    const channels = await prisma.chatHistoryKey.findMany({
        where: { recipient, ...(after ? { channelId: { gt: after } } : {}) },
        orderBy: { channelId: "asc" },
        distinct: ["channelId"],
        take: WORK_PAGE,
        select: { channelId: true }
    });
    const rows = channels.length
        ? await prisma.chatHistoryKey.findMany({
              where: { recipient, channelId: { in: channels.map((row) => row.channelId) } },
              orderBy: [{ channelId: "asc" }, { epoch: "asc" }],
              take: WORK_PAGE * EPOCHS_PER_CHANNEL,
              select: { channelId: true, epoch: true, envelope: true }
          })
        : [];
    const items = await Promise.all(
        rows.map(async (row) => {
            const audience = (await audienceOf(row.channelId)) ?? [];
            return {
                channelId: row.channelId,
                epoch: row.epoch,
                envelope: new Uint8Array(row.envelope),
                gaps: audience.length ? await legacyKeyGaps(row.channelId, row.epoch, audience, WORK_GAPS) : []
            };
        })
    );
    return { items, next: channels.length === WORK_PAGE ? channels[channels.length - 1]!.channelId : null };
}

/**
 * Store history-key envelopes the opener's browser sealed from the opened key:
 * only for a conversation and epoch the key holds a copy of, and only to a
 * member of that conversation who still has none. Anything else is dropped.
 * How many were stored.
 */
export async function putOpenedKeys(
    userId: string,
    openingId: string,
    envelopes: ReadonlyArray<{ channelId: string; epoch: bigint; recipient: string; envelope: Uint8Array }>,
    now = new Date()
): Promise<number> {
    const opening = await releasedOpening(userId, openingId, now);
    const recipient = recoveryRecipient(opening.keyId);
    const groups = new Map<string, typeof envelopes[number][]>();
    for (const item of envelopes) {
        const at = `${item.channelId}:${item.epoch}`;
        groups.set(at, [...(groups.get(at) ?? []), item]);
    }
    let stored = 0;
    for (const items of groups.values()) {
        const { channelId, epoch } = items[0]!;
        const held = await prisma.chatHistoryKey.findUnique({
            where: { channelId_epoch_recipient: { channelId, epoch, recipient } },
            select: { recipient: true }
        });
        if (!held) continue;
        const audience = (await audienceOf(channelId)) ?? [];
        const wanted = audience.filter((id) => items.some((item) => item.recipient === id));
        const gaps = new Set((await legacyKeyGaps(channelId, epoch, wanted, WORK_GAPS)).map((gap) => gap.userId));
        const kept = items.filter((item) => gaps.has(item.recipient));
        if (kept.length) await putHistoryKeys(channelId, epoch, kept);
        stored += kept.length;
    }
    if (stored)
        await recordAudit({ actorId: userId, action: "chat.recovery.key-opening-sealed", metadata: { openingId, keyId: opening.keyId, stored } });
    return stored;
}

/**
 * Replace the opened key's shares with a new split of the same seed to today's
 * custodians, only from the opener and only if it matches the policy now. The
 * public key, and every history key sealed to it, stay as they are; the old
 * shares are deleted, and shares of two different splits never combine.
 */
export async function resplitKey(
    userId: string,
    openingId: string,
    input: {
        splitId: string;
        threshold: number;
        shares: ReadonlyArray<{ custodianId: string; custodianAkVersion: number; envelope: Uint8Array }>;
    },
    now = new Date()
): Promise<void> {
    const opening = await releasedOpening(userId, openingId, now);
    const wanted = (await custodianScopes(userId)).find((entry) => entry.scope === opening.key.scope);
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
    await prisma.$transaction([
        prisma.chatRecoveryKeyShare.deleteMany({ where: { keyId: opening.keyId } }),
        prisma.chatRecoveryKeyShare.createMany({
            data: input.shares.map((share) => ({
                keyId: opening.keyId,
                custodianId: share.custodianId,
                custodianAkVersion: share.custodianAkVersion,
                envelope: Buffer.from(share.envelope)
            }))
        }),
        prisma.chatRecoveryKey.update({ where: { id: opening.keyId }, data: { splitId: input.splitId, threshold: input.threshold } }),
        // Openings of the old split can no longer be answered.
        prisma.chatRecoveryKeyOpening.updateMany({ where: { keyId: opening.keyId, status: "pending" }, data: { status: "cancelled" } })
    ]);
    await recordAudit({
        actorId: userId,
        action: "chat.recovery.key-resplit",
        metadata: { openingId, keyId: opening.keyId, scope: opening.key.scope, threshold: input.threshold, custodians: input.shares.length }
    });
}

/** The opener's browser is done: close the opening and drop the released shares. */
export async function completeOpening(userId: string, openingId: string): Promise<void> {
    const done = await prisma.chatRecoveryKeyOpening.updateMany({
        where: { id: openingId, openerId: userId, status: "released" },
        data: { status: "completed", completedAt: new Date() }
    });
    if (done.count !== 1) throw new RecoveryRefusal("notFound");
    await prisma.chatRecoveryKeyRelease.deleteMany({ where: { openingId } });
    await recordAudit({ actorId: userId, action: "chat.recovery.key-opening-completed", metadata: { openingId } });
}
