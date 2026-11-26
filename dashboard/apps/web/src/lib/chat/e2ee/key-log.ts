/**
 * The server half of the account key log (design 4.6, `@polaris/chat-crypto/
 * key-log`): appending each published account key version as a leaf,
 * signing tree heads, and answering inclusion and consistency proofs.
 *
 * The log is append-only by construction: an entry is written once, under a
 * transaction-scoped advisory lock so two appends never take the same index,
 * together with the complete-subtree hashes it completes. Nothing here updates
 * or deletes a row.
 *
 * Existing installs: account keys published before the log existed are
 * appended the first time a proof of them is asked for (`ensureLogged`), so
 * the log needs no backfill job and no setting. The head's signing key is made
 * on first use and kept sealed in the settings table (`storedSigningKey`),
 * never in `.env` (repo CLAUDE.md). Every key it has ever signed with is
 * recorded in `ChatKeyLogHandover` (`currentLogKey`): a deliberate change is
 * signed by the old key (`rotateLogKey`), one forced by a master key that no
 * longer opens the old key is recorded unsigned, as a reset; a browser follows
 * the first on its own and the second only when its user says so.
 *
 * What a head proves, and what it cannot: the server signs whatever it holds,
 * so a signature is evidence, not honesty. Its value is that two heads of the
 * same size with different roots, both signed, prove a fork; and that every
 * browser checks each new head extends the one it saw before.
 */

import { sign } from "node:crypto";
import { prisma } from "@polaris/db";
import * as log from "@polaris/chat-crypto/key-log";
import { storedSigningKey, type EdgeSigningKey } from "@/lib/edge-signing-key";

const SIGNING_SETTING = "chat.e2ee.keyLog.ed25519";
/** A head is re-signed at least this often even when the log has not grown. */
const HEAD_TTL_MS = 10 * 60 * 1000;
/** An account's entries `ownEntries` answers at most, newest first: a key version per rotation. */
export const OWN_ENTRIES = 64;

const logSigningKey = storedSigningKey(SIGNING_SETTING);

export interface LoggedEntry extends log.KeyLogEntry {
    readonly index: number;
}

export interface ProvenEntry extends LoggedEntry {
    readonly proof: Uint8Array[];
}

export interface LogAnswer {
    /** The log's Ed25519 public key, raw 32 bytes. */
    readonly logKey: Uint8Array;
    readonly head: log.TreeHead;
    /** From the size the caller last saw to `head.treeSize`; null when it named none. */
    readonly consistency: Uint8Array[] | null;
    readonly entries: ProvenEntry[];
    /** From the log key the caller pinned to `logKey`, oldest first; empty when they are the same or it named none. */
    readonly handovers: ProvenHandover[];
}

/** A change of the log's key, with the proof that the head at the change is a prefix of the answer's head. */
export interface ProvenHandover extends log.KeyHandover {
    readonly consistency: Uint8Array[];
}

/** What the browser last saw: the tree size and the log key it pinned (raw 32 bytes). */
export interface Seen {
    readonly since?: number;
    readonly logKey?: Uint8Array;
}

/** Reads the complete subtrees `run` needs, all in one query, then runs it on them. */
async function withNodes<T>(run: (read: log.NodeReader) => Promise<T>, db: Pick<typeof prisma, "$queryRaw"> = prisma): Promise<T> {
    const needed = await log.nodesNeeded(run);
    const found = new Map<string, Uint8Array>();
    if (needed.length) {
        const levels = needed.map((n) => n.level);
        const indexes = needed.map((n) => n.index);
        const rows = await db.$queryRaw<{ level: number; index: number; hash: Uint8Array }[]>`
            SELECT n."level", n."index", n."hash" FROM "ChatKeyLogNode" n
            JOIN unnest(${levels}::int[], ${indexes}::int[]) AS want("level", "index")
              ON n."level" = want."level" AND n."index" = want."index"`;
        for (const row of rows) found.set(`${row.level}:${row.index}`, new Uint8Array(row.hash));
    }
    return run((level, index) => {
        const hash = found.get(`${level}:${index}`);
        if (!hash) throw new Error(`The key log is missing node ${level}:${index}`);
        return hash;
    });
}

async function treeSize(db: Pick<typeof prisma, "chatKeyLogEntry"> = prisma): Promise<number> {
    const last = await db.chatKeyLogEntry.findFirst({ orderBy: { index: "desc" }, select: { index: true } });
    return last ? last.index + 1 : 0;
}

/** Another append holds the log's lock: retried, never waited on inside the transaction. */
class LogBusy extends Error {}

/**
 * Appends under a lock taken with `pg_try_advisory_xact_lock`, never a blocking
 * wait: a wait would count against the transaction's timeout and, under heavy
 * contention, end as Prisma's opaque "transaction already closed" after 5 s
 * with the lock still queued. Here a busy lock ends the transaction at once
 * and is retried after a short, jittered backoff - at most `LOCK_ATTEMPTS`
 * times, about 1.5 s in all - and the transaction itself is bounded
 * explicitly (`TRANSACTION`), so contention costs a bounded delay and, past
 * it, a 503 the browser retries, never a connection held on a queue.
 */
const LOCK_ATTEMPTS = 6;
const TRANSACTION = { maxWait: 2_000, timeout: 5_000 } as const;
const backoff = (attempt: number) => new Promise((settle) => setTimeout(settle, 25 * 2 ** attempt * (0.5 + Math.random())));

/** Appends `entry` unless its (account, version) is already logged. True when it was appended. */
export async function appendEntry(entry: log.KeyLogEntry): Promise<boolean> {
    const leaf = await log.entryLeafHash(entry);
    for (let attempt = 1; ; attempt++) {
        try {
            return await appendOnce(entry, leaf);
        } catch (error) {
            if (!(error instanceof LogBusy) || attempt >= LOCK_ATTEMPTS) throw error;
            await backoff(attempt);
        }
    }
}

async function appendOnce(entry: log.KeyLogEntry, leaf: Uint8Array): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('polaris.chat.key-log')) AS "locked"`;
        if (!lock?.locked) throw new LogBusy("The key log is busy");
        const existing = await tx.chatKeyLogEntry.findUnique({
            where: { userId_akVersion: { userId: entry.userId, akVersion: entry.akVersion } },
            select: { index: true }
        });
        if (existing) return false;
        const index = await treeSize(tx);
        const nodes = await withNodes((read) => log.appendedNodes(index, leaf, read), tx);
        await tx.chatKeyLogEntry.create({
            data: {
                index,
                userId: entry.userId,
                akVersion: entry.akVersion,
                signPublicKey: Buffer.from(entry.signPublicKey),
                hpkePublicKey: Buffer.from(entry.hpkePublicKey)
            }
        });
        await tx.chatKeyLogNode.createMany({ data: nodes.map((n) => ({ level: n.level, index: n.index, hash: Buffer.from(n.hash) })) });
        return true;
    }, TRANSACTION);
}

/** Appends the current published key of each account that has one and is not logged yet. */
export async function ensureLogged(userIds: ReadonlyArray<string>): Promise<void> {
    if (!userIds.length) return;
    const [keys, logged] = await Promise.all([
        prisma.chatAccountKey.findMany({
            where: { userId: { in: [...userIds] } },
            select: { userId: true, akVersion: true, signPublicKey: true, hpkePublicKey: true },
            orderBy: { createdAt: "asc" }
        }),
        prisma.chatKeyLogEntry.findMany({ where: { userId: { in: [...userIds] } }, select: { userId: true, akVersion: true } })
    ]);
    const known = new Set(logged.map((row) => `${row.userId}:${row.akVersion}`));
    for (const key of keys) {
        if (known.has(`${key.userId}:${key.akVersion}`)) continue;
        await appendEntry({
            userId: key.userId,
            akVersion: key.akVersion,
            signPublicKey: new Uint8Array(key.signPublicKey),
            hpkePublicKey: new Uint8Array(key.hpkePublicKey)
        });
    }
}

const raw = (publicKey: string) => new Uint8Array(Buffer.from(publicKey, "base64url"));
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** The log's size and root right now, unsigned. */
async function headNow(now = Date.now()): Promise<Pick<log.TreeHead, "treeSize" | "timestamp" | "rootHash">> {
    const size = await treeSize();
    return { treeSize: size, timestamp: now, rootHash: await withNodes((read) => log.rootOf(size, read)) };
}

/**
 * The key heads are signed with, recorded in `ChatKeyLogHandover` before it
 * signs anything. A key not recorded yet is the first one (no `fromKey`) or
 * one that replaced the last recorded key without its signature: the stored
 * key no longer read under the master key, so `storedSigningKey` made a new
 * one. That is written down as a reset - honestly unsigned, which browsers
 * that pinned the old key refuse to follow on their own (`followHandovers`).
 * A key this process holds that is older than the last recorded one was
 * rotated by another process: it is dropped and read again.
 */
async function currentLogKey(): Promise<EdgeSigningKey> {
    for (let reread = false; ; reread = true) {
        const key = await logSigningKey();
        const latest = await prisma.chatKeyLogHandover.findFirst({ orderBy: { id: "desc" }, select: { toKey: true } });
        if (latest && sameBytes(latest.toKey, raw(key.publicKey))) return key;
        const known = latest ? await prisma.chatKeyLogHandover.findUnique({ where: { toKey: Buffer.from(raw(key.publicKey)) }, select: { id: true } }) : null;
        if (known && !reread) {
            logSigningKey.forget();
            continue;
        }
        const head = await headNow();
        await prisma.chatKeyLogHandover.createMany({
            data: [{
                fromKey: latest ? Buffer.from(latest.toKey) : null,
                toKey: Buffer.from(raw(key.publicKey)),
                treeSize: head.treeSize,
                timestamp: BigInt(head.timestamp),
                rootHash: Buffer.from(head.rootHash),
                signature: null
            }],
            skipDuplicates: true
        });
        if (latest && !known) console.error("polaris: the chat key log's signing key could not be read and was replaced; browsers will report a reset");
        return key;
    }
}

/**
 * Replaces the log's signing key while the old one still reads: the old key
 * signs the new one with the head at the change, and that hand-over is stored
 * before the new key is, so no head under the new key is ever served without
 * it. A hand-over to a key that then failed to store is removed again (the
 * only row this module ever deletes, and one nothing was ever signed by).
 */
export async function rotateLogKey(): Promise<void> {
    await currentLogKey();
    await logSigningKey.rotate(async (previous, nextPublicKey) => {
        const head = await headNow();
        const unsigned = { fromKey: raw(previous.publicKey), toKey: raw(nextPublicKey), head };
        const signature = sign(null, log.handoverMessage(unsigned), previous.privateKey);
        const row = await prisma.chatKeyLogHandover.create({
            data: {
                fromKey: Buffer.from(unsigned.fromKey),
                toKey: Buffer.from(unsigned.toKey),
                treeSize: head.treeSize,
                timestamp: BigInt(head.timestamp),
                rootHash: Buffer.from(head.rootHash),
                signature
            },
            select: { id: true }
        });
        return async () => {
            await prisma.chatKeyLogHandover.deleteMany({ where: { id: row.id } });
        };
    });
    lastHead = null;
}

/** Hand-overs answered at most: one per change of the log's key. */
export const HANDOVERS = 32;

/** The changes of the log's key from `pinned` on, oldest first; empty when `pinned` is current or unknown. */
async function handoversFrom(pinned: Uint8Array | undefined, current: Uint8Array): Promise<log.KeyHandover[]> {
    if (!pinned || sameBytes(pinned, current)) return [];
    const rows = await prisma.chatKeyLogHandover.findMany({
        orderBy: { id: "desc" },
        take: HANDOVERS,
        select: { fromKey: true, toKey: true, treeSize: true, timestamp: true, rootHash: true, signature: true }
    });
    const chain = rows.reverse().flatMap((row) =>
        row.fromKey
            ? [{
                fromKey: new Uint8Array(row.fromKey),
                toKey: new Uint8Array(row.toKey),
                head: { treeSize: row.treeSize, timestamp: Number(row.timestamp), rootHash: new Uint8Array(row.rootHash) },
                signature: row.signature ? new Uint8Array(row.signature) : null
            }]
            : []
    );
    const start = chain.findIndex((link) => sameBytes(link.fromKey, pinned));
    return start < 0 ? [] : chain.slice(start);
}

let lastHead: { head: log.TreeHead; at: number; key: string } | null = null;

/** A signed head of the log as it is now: the cached one while the size is unchanged and it is fresh. */
export async function signedHead(now = Date.now()): Promise<{ logKey: Uint8Array; head: log.TreeHead }> {
    const key = await currentLogKey();
    const logKey = raw(key.publicKey);
    const size = await treeSize();
    if (lastHead && lastHead.key === key.publicKey && lastHead.head.treeSize === size && now - lastHead.at < HEAD_TTL_MS) return { logKey, head: lastHead.head };
    const rootHash = await withNodes((read) => log.rootOf(size, read));
    const unsigned = { treeSize: size, timestamp: now, rootHash };
    const signature = new Uint8Array(sign(null, log.headMessage(unsigned), key.privateKey));
    const head = { ...unsigned, signature };
    lastHead = { head, at: now, key: key.publicKey };
    return { logKey, head };
}

function entryOf(row: { index: number; userId: string; akVersion: number; signPublicKey: Uint8Array; hpkePublicKey: Uint8Array }): LoggedEntry {
    return {
        index: row.index,
        userId: row.userId,
        akVersion: row.akVersion,
        signPublicKey: new Uint8Array(row.signPublicKey),
        hpkePublicKey: new Uint8Array(row.hpkePublicKey)
    };
}

/**
 * A fresh signed head with proofs of `entries` under it, of it extending the
 * size `seen.since`, and of every hand-over from `seen.logKey` - all from one
 * node read.
 */
async function answerFor(entries: LoggedEntry[], seen: Seen): Promise<LogAnswer> {
    const { logKey, head } = await signedHead();
    const size = head.treeSize;
    const from = seen.since !== undefined && seen.since <= size ? seen.since : undefined;
    const links = (await handoversFrom(seen.logKey, logKey)).filter((link) => link.head.treeSize <= size);
    const proven = await withNodes(async (read) => ({
        consistency: from === undefined ? null : await log.consistencyProof(from, size, read),
        entries: await Promise.all(
            entries.filter((e) => e.index < size).map(async (e) => ({ ...e, proof: await log.inclusionProof(e.index, size, read) }))
        ),
        handovers: await Promise.all(links.map(async (link) => ({ ...link, consistency: await log.consistencyProof(link.head.treeSize, size, read) })))
    }));
    return { logKey, head, ...proven };
}

/**
 * The latest logged key of each account in `userIds`, each with its inclusion
 * proof, under a fresh signed head - plus the consistency proof from the size
 * the caller last saw and the hand-overs from the log key it pinned (`seen`).
 * The caller decides who may be named.
 */
export async function keyProofs(userIds: ReadonlyArray<string>, seen: Seen = {}): Promise<LogAnswer> {
    await ensureLogged(userIds);
    const rows = await prisma.chatKeyLogEntry.findMany({
        where: { userId: { in: [...userIds] } },
        orderBy: { akVersion: "desc" },
        distinct: ["userId"],
        select: { index: true, userId: true, akVersion: true, signPublicKey: true, hpkePublicKey: true }
    });
    return answerFor(rows.map(entryOf), seen);
}

/**
 * Every entry of one account, for that account's own browsers to check against
 * the key they hold (monitoring). Answered only to the account itself.
 */
export async function ownEntries(userId: string, seen: Seen = {}): Promise<LogAnswer> {
    await ensureLogged([userId]);
    const rows = await prisma.chatKeyLogEntry.findMany({
        where: { userId },
        // The newest first: past the cap it is old versions that go unchecked, never the current one.
        orderBy: { index: "desc" },
        take: OWN_ENTRIES,
        select: { index: true, userId: true, akVersion: true, signPublicKey: true, hpkePublicKey: true }
    });
    return answerFor(rows.map(entryOf), seen);
}
