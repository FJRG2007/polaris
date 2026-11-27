/**
 * The server's side of shared search segments (docs/chat-e2ee-mls.md,
 * "Shared search segments"): it keeps them, hands out who builds one, and
 * serves them to the accounts that may read them. It never reads a segment;
 * it checks only who may write one and that the signature is the writing
 * device's.
 *
 * Who may: an account that holds the epoch's history key (`ChatHistoryKey`
 * sealed to it - the same rule as history visibility), so a member removed
 * at `e` is never handed the segments of `e + 1`. The route checks the
 * account reaches the conversation (`channelAccess`) before any of this.
 *
 * A stretch lists only messages every member may see: sealed, not deleted,
 * with no audience (a whisper) and no expiry (a disappearing message), since
 * a segment outlives neither's rules on its own.
 */

import { prisma } from "@polaris/db";
import * as segment from "./search-segment";
import { SEGMENT_MAX_BYTES, SEGMENT_MESSAGES, SEGMENT_MIN_BYTES, verifySegmentSignature } from "./search-segment";

/** How long a build lease holds. */
export const LEASE_MS = 10 * 60 * 1000;
/** Segments per `index-segments` page. */
export const SEGMENT_PAGE = 50;
/** Segment rows looked at per page, for the ones whose epoch the account holds a key for. */
const SCAN = 200;
/** AES-GCM's tag beside the padded body. */
const TAG_BYTES = 16;

export class SearchSegmentRefusal extends Error {
    constructor(readonly reason: "noHistoryKey" | "notLeased" | "badSignature" | "badSize" | "stale" | "gap" | "unknownDevice") {
        super(`search segment refused: ${reason}`);
        this.name = "SearchSegmentRefusal";
    }
}

const address = (userId: string, device: string) => `${userId}/${device}`;

/** Whether the account holds the epoch's history key. */
export async function holdsHistoryKey(userId: string, channelId: string, epoch: bigint): Promise<boolean> {
    return Boolean(await prisma.chatHistoryKey.findFirst({ where: { channelId, epoch, recipient: userId }, select: { epoch: true } }));
}

async function mustHold(userId: string, channelId: string, epoch: bigint): Promise<void> {
    if (!(await holdsHistoryKey(userId, channelId, epoch))) throw new SearchSegmentRefusal("noHistoryKey");
}

/**
 * Hand the build of one stretch to this device for `LEASE_MS`, unless another
 * device holds it (compare-and-set: one of two racing devices wins).
 */
export async function claimIndexBuild(userId: string, device: string, channelId: string, epoch: bigint, seq: number, now = new Date()): Promise<{ granted: boolean; until: Date }> {
    await mustHold(userId, channelId, epoch);
    const holder = address(userId, device);
    const until = new Date(now.getTime() + LEASE_MS);
    const taken = await prisma.chatSearchLease.updateMany({
        where: { channelId, epoch, seq, OR: [{ holder }, { until: { lt: now } }] },
        data: { holder, until }
    });
    if (taken.count) return { granted: true, until };
    try {
        await prisma.chatSearchLease.create({ data: { channelId, epoch, seq, holder, until } });
        return { granted: true, until };
    } catch {
        const held = await prisma.chatSearchLease.findFirst({ where: { channelId, epoch, seq }, select: { until: true } });
        return { granted: false, until: held?.until ?? until };
    }
}

/**
 * The sealed messages of one epoch after `afterId` that a segment may name,
 * oldest first, at most `SEGMENT_MESSAGES`, with each one's last edit, and
 * whether there are more.
 */
export async function indexStretch(userId: string, channelId: string, epoch: bigint, afterId: string | null) {
    await mustHold(userId, channelId, epoch);
    const rows = await prisma.chatMessage.findMany({
        where: {
            channelId,
            e2eeEpoch: epoch,
            deletedAt: null,
            expiresAt: null,
            audience: { isEmpty: true },
            ...(afterId ? { id: { gt: afterId } } : {})
        },
        orderBy: { id: "asc" },
        take: SEGMENT_MESSAGES + 1,
        select: { id: true, editedAt: true }
    });
    const more = rows.length > SEGMENT_MESSAGES;
    return {
        messages: rows.slice(0, SEGMENT_MESSAGES).map((row) => ({ id: row.id, ...(row.editedAt ? { editedAt: row.editedAt.toISOString() } : {}) })),
        more
    };
}

export interface SegmentUpload {
    readonly channelId: string;
    readonly device: string;
    readonly epoch: bigint;
    readonly seq: number;
    readonly generation: number;
    readonly base: boolean;
    readonly messages: number;
    readonly lastId: string | null;
    readonly nonce: Uint8Array;
    readonly ciphertext: Uint8Array;
    readonly signature: Uint8Array;
}

/** Whether a ciphertext is a padded body (a power of two from 4 KiB to 512 KiB) and its tag. */
export function wellSized(length: number): boolean {
    const body = length - TAG_BYTES;
    return body >= SEGMENT_MIN_BYTES && body <= SEGMENT_MAX_BYTES && (body & (body - 1)) === 0;
}

/**
 * Keep a segment. A base needs this device's live lease and removes every
 * generation below it; a correction needs only to be newer than what is
 * kept. Either is refused unless the device's signature checks.
 */
export async function putIndexSegment(userId: string, input: SegmentUpload, now = new Date()): Promise<void> {
    const { channelId, epoch, seq, generation } = input;
    await mustHold(userId, channelId, epoch);
    if (!wellSized(input.ciphertext.length) || input.messages < 1 || input.messages > SEGMENT_MESSAGES) throw new SearchSegmentRefusal("badSize");
    const device = await prisma.mlsDevice.findFirst({ where: { userId, device: input.device }, select: { signatureKey: true } });
    if (!device) throw new SearchSegmentRefusal("unknownDevice");
    const binding = { channelId, epoch, seq, generation };
    if (!(await verifySegmentSignature(new Uint8Array(device.signatureKey), binding, input.nonce, input.ciphertext, input.signature)))
        throw new SearchSegmentRefusal("badSignature");
    const builder = address(userId, input.device);
    await prisma.$transaction(async (tx) => {
        const kept = await tx.chatSearchSegment.findMany({ where: { channelId, epoch }, select: { seq: true, generation: true } });
        const highestSeq = kept.reduce((top, row) => Math.max(top, row.seq), -1);
        if (seq > highestSeq + 1) throw new SearchSegmentRefusal("gap");
        if (kept.some((row) => row.seq === seq && row.generation >= generation)) throw new SearchSegmentRefusal("stale");
        if (input.base) {
            const lease = await tx.chatSearchLease.findFirst({ where: { channelId, epoch, seq }, select: { holder: true, until: true } });
            if (!lease || lease.holder !== builder || lease.until.getTime() <= now.getTime()) throw new SearchSegmentRefusal("notLeased");
        }
        await tx.chatSearchSegment.create({
            data: {
                channelId,
                epoch,
                seq,
                generation,
                base: input.base,
                messages: input.messages,
                lastId: input.base ? input.lastId : null,
                nonce: Buffer.from(input.nonce),
                ciphertext: Buffer.from(input.ciphertext),
                builder,
                signature: Buffer.from(input.signature)
            }
        });
        if (input.base) {
            await tx.chatSearchSegment.deleteMany({ where: { channelId, epoch, seq, generation: { lt: generation } } });
            await tx.chatSearchLease.deleteMany({ where: { channelId, epoch, seq } });
        }
    });
}

export interface SegmentListing {
    readonly channelId: string;
    readonly epoch: bigint;
    readonly seq: number;
    readonly generation: number;
    readonly base: boolean;
    readonly messages: number;
    readonly lastId: string | null;
    readonly bytes: number;
    readonly createdAt: Date;
}

/**
 * The segments an account may read, newest first, `SEGMENT_PAGE` at a time
 * (`before`: the last page's `next`); in one conversation, or one epoch of
 * it, when named. `reaches` is the route's `channelAccess`.
 */
export async function listIndexSegments(
    userId: string,
    scope: { channelId?: string; epoch?: bigint; before?: Date },
    reaches: (channelId: string) => Promise<boolean>
): Promise<{ segments: SegmentListing[]; next: Date | null }> {
    const rows = await prisma.chatSearchSegment.findMany({
        where: {
            ...(scope.channelId ? { channelId: scope.channelId } : {}),
            ...(scope.epoch !== undefined ? { epoch: scope.epoch } : {}),
            ...(scope.before ? { createdAt: { lt: scope.before } } : {})
        },
        orderBy: { createdAt: "desc" },
        take: SCAN,
        select: { channelId: true, epoch: true, seq: true, generation: true, base: true, messages: true, lastId: true, ciphertext: true, createdAt: true }
    });
    const pairs = [...new Map(rows.map((row) => [`${row.channelId}/${row.epoch}`, { channelId: row.channelId, epoch: row.epoch }])).values()];
    const held = pairs.length
        ? await prisma.chatHistoryKey.findMany({ where: { recipient: userId, OR: pairs }, select: { channelId: true, epoch: true } })
        : [];
    const heldKeys = new Set(held.map((row) => `${row.channelId}/${row.epoch}`));
    const channels = [...new Set(rows.map((row) => row.channelId))];
    const reached = new Set((await Promise.all(channels.map(async (id) => ((await reaches(id)) ? id : null)))).filter(Boolean));
    const segments: SegmentListing[] = [];
    let last: Date | null = null;
    for (const row of [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
        last = row.createdAt;
        if (!heldKeys.has(`${row.channelId}/${row.epoch}`) || !reached.has(row.channelId)) continue;
        const { channelId, epoch, seq, generation, base, messages, lastId, createdAt } = row;
        segments.push({ channelId, epoch, seq, generation, base, messages, lastId, bytes: row.ciphertext.length, createdAt });
        if (segments.length >= SEGMENT_PAGE) break;
    }
    return { segments, next: rows.length === SCAN || segments.length >= SEGMENT_PAGE ? last : null };
}

/** One segment, sealed as kept, to an account holding its epoch's key. */
export async function readIndexSegment(userId: string, channelId: string, epoch: bigint, seq: number, generation: number) {
    await mustHold(userId, channelId, epoch);
    const row = await prisma.chatSearchSegment.findFirst({
        where: { channelId, epoch, seq, generation },
        select: { nonce: true, ciphertext: true, builder: true, signature: true, base: true, messages: true, lastId: true }
    });
    if (!row) return null;
    const { builder, base, messages, lastId } = row;
    const signatureKey = await builderKey(channelId, builder);
    return {
        builder,
        base,
        messages,
        lastId,
        nonce: new Uint8Array(row.nonce),
        ciphertext: new Uint8Array(row.ciphertext),
        signature: new Uint8Array(row.signature),
        ...(signatureKey ? { signatureKey } : {})
    };
}

/**
 * The key the server holds for a segment's builder: the device's registered
 * one, or the migration run's. A reader checks a device's signature against
 * the key its own copy of the group holds for that member, and takes this one
 * only where it holds no copy (`search-segments-client.ts`).
 */
async function builderKey(channelId: string, builder: string): Promise<Uint8Array | null> {
    if (builder === segment.MIGRATION_BUILDER) {
        const run = await prisma.chatMigration.findUnique({ where: { channelId }, select: { signKey: true } });
        return run?.signKey ? new Uint8Array(run.signKey) : null;
    }
    const slash = builder.indexOf("/");
    if (slash < 0) return null;
    const device = await prisma.mlsDevice.findFirst({ where: { userId: builder.slice(0, slash), device: builder.slice(slash + 1) }, select: { signatureKey: true } });
    return device ? new Uint8Array(device.signatureKey) : null;
}

/** What the migrator signs segments with: its run's own Ed25519 key (`ChatMigration.signKey`). */
export interface MigrationSigner {
    readonly privateKey: CryptoKey;
}

/** What the binding's `signContent` puts in front of the payload (polaris_core::mls::CONTENT_SIGNATURE_LABEL). */
const CONTENT_SIGNATURE_LABEL = new TextEncoder().encode("polaris/chat-e2ee/content-signature/v1\u0000");

/**
 * Index a conversation's migrated history (`legacy-migration.ts`), which the
 * migrator alone holds the words of once it is cut: the plain copies kept for
 * rollback. Segments of the legacy epoch, under `IK(c, legacy)`, signed by
 * the run's key and named as built by `migration`. Answers how many it wrote.
 */
export async function indexMigrated(channelId: string, epoch: bigint, historyKey: Uint8Array, signer: MigrationSigner): Promise<number> {
    const key = await segment.indexKey(historyKey, channelId, epoch);
    await prisma.chatSearchSegment.deleteMany({ where: { channelId, epoch } });
    let after: string | null = null;
    let seq = 0;
    for (;;) {
        const rows: { id: string; editedAt: Date | null }[] = await prisma.chatMessage.findMany({
            where: { channelId, e2eeEpoch: epoch, deletedAt: null, expiresAt: null, audience: { isEmpty: true }, ...(after ? { id: { gt: after } } : {}) },
            orderBy: { id: "asc" },
            take: SEGMENT_MESSAGES,
            select: { id: true, editedAt: true }
        });
        if (!rows.length) return seq;
        const copies = await prisma.chatMigrationRollback.findMany({
            where: { channelId, kind: "message", messageId: { in: rows.map((row) => row.id) } },
            select: { messageId: true, body: true }
        });
        const words = new Map<string, string>(copies.map((copy: { messageId: string; body: string }) => [copy.messageId, copy.body]));
        let entries: segment.SegmentEntry[] = rows.flatMap((row) => {
            const body = words.get(row.id);
            return body ? [{ id: row.id, ...(row.editedAt ? { editedAt: row.editedAt.toISOString() } : {}), body }] : [];
        });
        let lastId: string = rows[rows.length - 1]!.id;
        for (;;) {
            if (!entries.length) break;
            const index = segment.buildIndex(entries);
            const binding = { channelId, epoch, seq, generation: 0 };
            try {
                const { nonce, ciphertext } = await segment.sealSegment(key, binding, index);
                const payload = await segment.segmentSignaturePayload(binding, nonce, ciphertext);
                const signed = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signer.privateKey, Buffer.concat([CONTENT_SIGNATURE_LABEL, payload])));
                await prisma.chatSearchSegment.create({
                    data: {
                        channelId,
                        epoch,
                        seq,
                        generation: 0,
                        base: true,
                        messages: entries.length,
                        lastId,
                        nonce: Buffer.from(nonce),
                        ciphertext: Buffer.from(ciphertext),
                        builder: MIGRATION_BUILDER,
                        signature: Buffer.from(signed)
                    }
                });
                seq += 1;
                break;
            } catch (caught) {
                if (!(caught instanceof segment.SegmentTooLarge) || entries.length <= 1) throw caught;
                entries = entries.slice(0, Math.ceil(entries.length / 2));
                lastId = entries[entries.length - 1]!.id;
            }
        }
        after = lastId;
    }
}

/** The builder a migrated segment names. */
export const MIGRATION_BUILDER = segment.MIGRATION_BUILDER;
