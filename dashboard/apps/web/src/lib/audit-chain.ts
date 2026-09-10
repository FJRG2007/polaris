/**
 * The audit trail's tamper evidence: sealing entries into a chain, and checking
 * that the chain still holds.
 *
 * **Why a chain.** The trail is the record of who did what, and a record anybody
 * with database access can quietly edit is a record nobody can rely on in the one
 * situation it exists for. Each sealed entry carries a keyed hash over its own
 * columns and the previous entry's hash, so changing an entry, deleting one out of
 * the middle, or slipping a new one in breaks a link - and the key is the
 * instance's master key, which a database dump does not contain, so the broken
 * links cannot be recomputed to hide it.
 *
 * **Why a separate pass seals them.** `recordAudit` runs inside every request
 * that changes anything, in parallel, and two of them reading "the last hash" at
 * the same moment would both link to it: a fork, which verification can only
 * report as a break. So a request writes the entry plain, and one leased pass
 * seals whatever is unsealed, oldest first. That is also what backfills an
 * instance that had years of entries before this existed - they are sealed in
 * the same batches, in order, until there are none left.
 *
 * **What it does not do.** An entry deleted in the minute before it was sealed
 * leaves no trace, and deleting the newest sealed entries - the tail - is only
 * caught against a copy of the head somebody kept elsewhere. That is why the
 * export carries the head's position and hash: it is the anchor to keep.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { secretFingerprint } from "@polaris/storage";
import { getSetting, setSetting } from "@/lib/setting-store";

/** How many entries one sealing statement takes. Large enough that a backlog of a
 *  million clears in well under an hour of passes, small enough that the
 *  transaction is over quickly. */
const SEAL_BATCH = 1000;

/** How long one pass keeps sealing before it lets the next pass carry on. */
const SEAL_BUDGET_MS = 20_000;

/** How many entries verification reads at a time. */
const VERIFY_BATCH = 5000;

/** Where the last verification's answer is kept, so the screen can show it
 *  without verifying on every visit. */
const LAST_VERIFY_KEY = "audit.chain.lastVerify";

/** The namespace the keyed hash is taken in, so the same master key used for
 *  anything else never produces a value that could stand in for a link. */
const CHAIN_SCOPE = "audit-chain-v1";

type ChainRow = {
    id: string;
    at: Date;
    actorId: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: string | null;
    ipHash: string | null;
    sessionId: string | null;
    orgId: string | null;
};

const CHAIN_COLUMNS = {
    id: true,
    at: true,
    actorId: true,
    action: true,
    targetType: true,
    targetId: true,
    metadata: true,
    ipHash: true,
    sessionId: true,
    orgId: true
} as const;

/** One link: the keyed hash of an entry at its place in the chain. */
export function chainLink(row: ChainRow, seq: bigint, prevHash: string): string {
    return secretFingerprint(
        core.auditChainPayload({ ...row, seq, prevHash }),
        CHAIN_SCOPE,
        loadEnv().POLARIS_MASTER_KEY
    );
}

/** The newest sealed entry's place and hash, falling back to where retention
 *  last cut the chain, falling back to the start. What the next seal links to. */
async function chainHead(): Promise<{ seq: bigint; hash: string }> {
    const [head, cut] = await Promise.all([
        prisma.auditLog.findFirst({
            where: { seq: { not: null } },
            orderBy: { seq: "desc" },
            select: { seq: true, hash: true }
        }),
        prisma.auditCheckpoint.findFirst({
            orderBy: { seq: "desc" },
            select: { seq: true, hash: true }
        })
    ]);
    if (head?.seq != null && head.hash) {
        // A checkpoint past the newest surviving entry means retention removed
        // everything that was sealed; the chain continues from the cut.
        if (cut && cut.seq > head.seq) return { seq: cut.seq, hash: cut.hash };
        return { seq: head.seq, hash: head.hash };
    }
    if (cut) return { seq: cut.seq, hash: cut.hash };
    return { seq: 0n, hash: core.AUDIT_CHAIN_GENESIS };
}

/**
 * Seal whatever is unsealed, oldest first, until there is none or the pass has
 * used its time. Answers how many it sealed, so the job's own log says whether a
 * backlog is still being worked through.
 *
 * Run from a leased job only: this is the chain's single writer, and two running
 * at once would hand out the same places twice. The unique index on `seq` makes
 * that a failed statement rather than a fork, but the lease is what keeps it from
 * happening at all.
 */
export async function sealAuditChain(now: () => number = Date.now): Promise<number> {
    const started = now();
    let sealed = 0;
    let { seq, hash } = await chainHead();

    while (now() - started < SEAL_BUDGET_MS) {
        const rows = await prisma.auditLog.findMany({
            where: { seq: null },
            orderBy: [{ at: "asc" }, { id: "asc" }],
            take: SEAL_BATCH,
            select: CHAIN_COLUMNS
        });
        if (rows.length === 0) break;

        const writes = rows.map((row) => {
            seq += 1n;
            const prevHash = hash;
            hash = chainLink(row, seq, prevHash);
            return prisma.auditLog.update({
                where: { id: row.id },
                data: { seq, prevHash, hash }
            });
        });
        await prisma.$transaction(writes);
        sealed += rows.length;
        if (rows.length < SEAL_BATCH) break;
    }
    return sealed;
}

/** What one verification found. */
export interface ChainVerification {
    /** ISO 8601. */
    readonly at: string;
    readonly ok: boolean;
    /** How many sealed entries were checked. */
    readonly checked: number;
    /** The first break, when there was one. */
    readonly broken: {
        readonly seq: string;
        readonly entryId: string | null;
        readonly entryAt: string | null;
        readonly reason: core.AuditChainBreak;
    } | null;
}

/**
 * Walk the sealed chain from where it starts and report the first link that does
 * not hold.
 *
 * The start is the newest retention checkpoint when there is one - the entries
 * before it were deleted on purpose, and the first surviving entry has to link to
 * the hash the cut recorded - and the genesis value otherwise. From there every
 * entry must be the next place in the sequence, point back at the entry before
 * it, and still produce its own hash from its columns.
 *
 * The answer is kept, so the screen can say when the chain was last checked
 * without walking it on every visit.
 */
export async function verifyAuditChain(): Promise<ChainVerification> {
    const cut = await prisma.auditCheckpoint.findFirst({
        orderBy: { seq: "desc" },
        select: { seq: true, hash: true }
    });
    let expectedSeq = (cut?.seq ?? 0n) + 1n;
    let expectedPrev = cut?.hash ?? core.AUDIT_CHAIN_GENESIS;
    let checked = 0;
    let broken: ChainVerification["broken"] = null;

    // Entries at or before the cut that retention has not reached yet are still
    // verifiable, but nothing links to them any more: the walk starts after the
    // cut, which is where the chain as it now stands begins.
    for (;;) {
        const rows = await prisma.auditLog.findMany({
            where: { seq: { gte: expectedSeq } },
            orderBy: { seq: "asc" },
            take: VERIFY_BATCH,
            select: { ...CHAIN_COLUMNS, seq: true, prevHash: true, hash: true }
        });
        if (rows.length === 0) break;
        for (const row of rows) {
            const seq = row.seq ?? 0n;
            const where = { seq: seq.toString(), entryId: row.id, entryAt: row.at.toISOString() };
            if (seq !== expectedSeq) {
                broken = {
                    seq: expectedSeq.toString(),
                    entryId: null,
                    entryAt: null,
                    reason: "missing"
                };
                break;
            }
            if (row.prevHash !== expectedPrev) {
                broken = { ...where, reason: "relinked" };
                break;
            }
            if (row.hash !== chainLink(row, seq, expectedPrev)) {
                broken = { ...where, reason: "altered" };
                break;
            }
            checked += 1;
            expectedPrev = row.hash;
            expectedSeq += 1n;
        }
        if (broken || rows.length < VERIFY_BATCH) break;
    }

    const result: ChainVerification = {
        at: new Date().toISOString(),
        ok: broken === null,
        checked,
        broken
    };
    await setSetting(LAST_VERIFY_KEY, JSON.stringify(result));
    return result;
}

/** Where the chain stands, for the integrity panel. */
export interface ChainStatus {
    readonly sealed: number;
    /** Entries written but not yet sealed - the backlog the pass is working on. */
    readonly pending: number;
    readonly head: { readonly seq: string; readonly hash: string } | null;
    readonly checkpoint: {
        readonly seq: string;
        readonly hash: string;
        readonly at: string;
        readonly pruned: number;
    } | null;
    readonly lastVerification: ChainVerification | null;
}

export async function auditChainStatus(): Promise<ChainStatus> {
    const [sealed, pending, head, cut, stored] = await Promise.all([
        prisma.auditLog.count({ where: { seq: { not: null } } }),
        prisma.auditLog.count({ where: { seq: null } }),
        prisma.auditLog.findFirst({
            where: { seq: { not: null } },
            orderBy: { seq: "desc" },
            select: { seq: true, hash: true }
        }),
        prisma.auditCheckpoint.findFirst({ orderBy: { seq: "desc" } }),
        getSetting(LAST_VERIFY_KEY)
    ]);
    return {
        sealed,
        pending,
        head: head?.seq != null && head.hash ? { seq: head.seq.toString(), hash: head.hash } : null,
        checkpoint: cut
            ? {
                  seq: cut.seq.toString(),
                  hash: cut.hash,
                  at: cut.at.toISOString(),
                  pruned: cut.pruned
              }
            : null,
        lastVerification: parseVerification(stored)
    };
}

/** A stored verification, or null for anything that does not read as one. */
function parseVerification(stored: string | null): ChainVerification | null {
    if (!stored) return null;
    try {
        const parsed = JSON.parse(stored) as Partial<ChainVerification>;
        if (typeof parsed.at !== "string" || typeof parsed.ok !== "boolean") return null;
        return {
            at: parsed.at,
            ok: parsed.ok,
            checked: typeof parsed.checked === "number" ? parsed.checked : 0,
            broken: parsed.broken ?? null
        };
    } catch {
        return null;
    }
}

/**
 * Delete the oldest sealed entries older than `cutoff`, keeping the chain
 * verifiable.
 *
 * Only a contiguous run from the start of the chain is ever removed - a gap in
 * the middle is exactly what verification reports as tampering - and the last
 * removed entry's place and hash are written as a checkpoint first, so the entry
 * after it still has something to link to. Entries not yet sealed are left for
 * the next pass: removing one would be removing it from a chain it never joined,
 * and the seal is minutes away.
 *
 * Answers how many it removed and whether the batch was full.
 */
export async function pruneSealedAudit(
    cutoff: Date,
    batch: number
): Promise<{ removed: number; more: boolean }> {
    const rows = await prisma.auditLog.findMany({
        where: { seq: { not: null } },
        orderBy: { seq: "asc" },
        take: batch,
        select: { id: true, seq: true, hash: true, at: true }
    });
    // The run stops at the first entry still inside the period: everything after
    // it stays, whatever its own timestamp says, so the removed part is a prefix.
    const due: typeof rows = [];
    for (const row of rows) {
        if (row.at >= cutoff) break;
        due.push(row);
    }
    const last = due.at(-1);
    if (!last || last.seq == null || !last.hash) return { removed: 0, more: false };

    await prisma.$transaction([
        prisma.auditCheckpoint.upsert({
            where: { seq: last.seq },
            create: { seq: last.seq, hash: last.hash, pruned: due.length },
            update: {}
        }),
        prisma.auditLog.deleteMany({ where: { id: { in: due.map((row) => row.id) } } })
    ]);
    return { removed: due.length, more: due.length === batch };
}
