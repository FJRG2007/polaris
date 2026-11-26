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
 * never in `.env` (repo CLAUDE.md).
 *
 * What a head proves, and what it cannot: the server signs whatever it holds,
 * so a signature is evidence, not honesty. Its value is that two heads of the
 * same size with different roots, both signed, prove a fork; and that every
 * browser checks each new head extends the one it saw before.
 */

import { sign } from "node:crypto";
import { prisma } from "@polaris/db";
import * as log from "@polaris/chat-crypto/key-log";
import { storedSigningKey } from "@/lib/edge-signing-key";

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

/** Appends `entry` unless its (account, version) is already logged. True when it was appended. */
export async function appendEntry(entry: log.KeyLogEntry): Promise<boolean> {
    const leaf = await log.entryLeafHash(entry);
    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('polaris.chat.key-log'))`;
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
    });
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

let lastHead: { head: log.TreeHead; at: number; key: string } | null = null;

/** A signed head of the log as it is now: the cached one while the size is unchanged and it is fresh. */
export async function signedHead(now = Date.now()): Promise<{ logKey: Uint8Array; head: log.TreeHead }> {
    const key = await logSigningKey();
    const logKey = new Uint8Array(Buffer.from(key.publicKey, "base64url"));
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

/** Proofs of `entries` under `head`, and of `head` extending the size `since`, from one node read. */
async function prove(head: log.TreeHead, entries: LoggedEntry[], since: number | undefined): Promise<Pick<LogAnswer, "consistency" | "entries">> {
    const size = head.treeSize;
    const from = since !== undefined && since <= size ? since : undefined;
    return withNodes(async (read) => ({
        consistency: from === undefined ? null : await log.consistencyProof(from, size, read),
        entries: await Promise.all(
            entries.filter((e) => e.index < size).map(async (e) => ({ ...e, proof: await log.inclusionProof(e.index, size, read) }))
        )
    }));
}

/**
 * The latest logged key of each account in `userIds`, each with its inclusion
 * proof, under a fresh signed head - plus the consistency proof from `since`,
 * the size the caller last saw. The caller decides who may be named.
 */
export async function keyProofs(userIds: ReadonlyArray<string>, since?: number): Promise<LogAnswer> {
    await ensureLogged(userIds);
    const rows = await prisma.chatKeyLogEntry.findMany({
        where: { userId: { in: [...userIds] } },
        orderBy: { akVersion: "desc" },
        distinct: ["userId"],
        select: { index: true, userId: true, akVersion: true, signPublicKey: true, hpkePublicKey: true }
    });
    const { logKey, head } = await signedHead();
    return { logKey, head, ...(await prove(head, rows.map(entryOf), since)) };
}

/**
 * Every entry of one account, for that account's own browsers to check against
 * the key they hold (monitoring). Answered only to the account itself.
 */
export async function ownEntries(userId: string, since?: number): Promise<LogAnswer> {
    await ensureLogged([userId]);
    const rows = await prisma.chatKeyLogEntry.findMany({
        where: { userId },
        // The newest first: past the cap it is old versions that go unchecked, never the current one.
        orderBy: { index: "desc" },
        take: OWN_ENTRIES,
        select: { index: true, userId: true, akVersion: true, signPublicKey: true, hpkePublicKey: true }
    });
    const { logKey, head } = await signedHead();
    return { logKey, head, ...(await prove(head, rows.map(entryOf), since)) };
}
