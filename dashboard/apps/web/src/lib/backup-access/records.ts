/**
 * The DNS writes a flip makes, worked out without touching Cloudflare.
 *
 * Going to backup, every owned name's address records are remembered exactly -
 * type, content, proxy flag, TTL - and the name is pointed at the backup: a
 * proxied CNAME to the named tunnel, or an A record naming the relay. Coming back,
 * those remembered records are written again as they were. The first record of a
 * name is overwritten in place (one write, no moment with no record); any others
 * are deleted on the way out and created again on the way back.
 *
 * A proxied record takes effect at Cloudflare's edge without waiting on a TTL. A
 * DNS-only one is cached by resolvers for its TTL, so while backup is armed such
 * records are kept at `ARMED_TTL` and given their own TTL back when it is not.
 *
 * Every plan is idempotent: run against records that already hold the outcome,
 * it plans nothing, so a pass cut short by a restart is finished by the next one.
 */

import { z } from "zod";

export const ADDRESS_TYPES = ["A", "AAAA", "CNAME"] as const;

/** Seconds a DNS-only record is cached for while backup is armed. */
export const ARMED_TTL = 60;
/** Cloudflare's "automatic" TTL. */
export const AUTO_TTL = 1;

export const savedRecordSchema = z.object({
    name: z.string(),
    type: z.enum(ADDRESS_TYPES),
    content: z.string(),
    proxied: z.boolean(),
    ttl: z.number().int()
});
export type SavedRecord = z.infer<typeof savedRecordSchema>;

export interface LiveRecord extends SavedRecord {
    readonly id: string;
}

export type BackupTarget =
    | { readonly kind: "tunnel"; readonly tunnelId: string }
    | { readonly kind: "relay"; readonly address: string };

export type RecordOp =
    | { readonly op: "put"; readonly id: string; readonly record: SavedRecord }
    | { readonly op: "delete"; readonly id: string }
    | { readonly op: "create"; readonly record: SavedRecord }
    | { readonly op: "ttl"; readonly id: string; readonly ttl: number };

export interface FlipPlan {
    /** What the names held before, to write back on the way home. */
    readonly originals: SavedRecord[];
    readonly ops: RecordOp[];
}

export interface RestorePlan {
    readonly ops: RecordOp[];
    /** Names holding a record that is neither ours nor the backup's: left alone. */
    readonly conflicts: string[];
}

/** The record a name holds while on backup. */
export function backupRecord(target: BackupTarget, name: string, proxied: boolean): SavedRecord {
    if (target.kind === "tunnel")
        return {
            name,
            type: "CNAME",
            content: `${target.tunnelId}.cfargotunnel.com`,
            proxied: true,
            ttl: AUTO_TTL
        };
    return {
        name,
        type: target.address.includes(":") ? "AAAA" : "A",
        content: target.address,
        proxied,
        ttl: proxied ? AUTO_TTL : ARMED_TTL
    };
}

function same(a: SavedRecord, b: SavedRecord): boolean {
    return (
        a.name === b.name &&
        a.type === b.type &&
        a.content.toLowerCase() === b.content.toLowerCase() &&
        a.proxied === b.proxied &&
        a.ttl === b.ttl
    );
}

function plain(record: SavedRecord): SavedRecord {
    return {
        name: record.name,
        type: record.type,
        content: record.content,
        proxied: record.proxied,
        ttl: record.ttl
    };
}

function byName<T extends SavedRecord>(records: readonly T[]): Map<string, T[]> {
    const names = new Map<string, T[]>();
    for (const record of records) names.set(record.name, [...(names.get(record.name) ?? []), record]);
    return names;
}

/**
 * Point every name at the backup. A name with no address record is not ours to
 * create and is skipped; one already holding exactly the backup record is done.
 */
export function planFlip(live: readonly LiveRecord[], target: BackupTarget): FlipPlan {
    const originals: SavedRecord[] = [];
    const ops: RecordOp[] = [];
    for (const [name, records] of byName(live)) {
        const wanted = backupRecord(target, name, records.some((record) => record.proxied));
        const [first, ...rest] = records;
        if (!first || (rest.length === 0 && same(first, wanted))) continue;
        originals.push(...records.map(plain));
        ops.push({ op: "put", id: first.id, record: wanted });
        for (const extra of rest) ops.push({ op: "delete", id: extra.id });
    }
    return { originals, ops };
}

/**
 * Put back exactly what `planFlip` remembered. A name that already holds its
 * originals is done; one holding something else than the backup or its originals
 * was changed by somebody and is reported instead of overwritten.
 */
export function planRestore(
    live: readonly LiveRecord[],
    originals: readonly SavedRecord[],
    target: BackupTarget
): RestorePlan {
    const ops: RecordOp[] = [];
    const conflicts: string[] = [];
    const current = byName(live);
    for (const [name, wanted] of byName(originals)) {
        const held = current.get(name) ?? [];
        const isBackup = (record: SavedRecord) =>
            same(record, backupRecord(target, name, wanted.some((entry) => entry.proxied)));
        const missing = wanted.filter((record) => !held.some((entry) => same(entry, record)));
        if (missing.length === 0) continue;
        const backups = held.filter(isBackup);
        const foreign = held.filter(
            (record) => !isBackup(record) && !wanted.some((entry) => same(entry, record))
        );
        if (foreign.length > 0) {
            conflicts.push(name);
            continue;
        }
        const [overwrite, ...extra] = backups;
        const queue = [...missing];
        if (overwrite) ops.push({ op: "put", id: overwrite.id, record: queue.shift()! });
        for (const record of extra) ops.push({ op: "delete", id: record.id });
        for (const record of queue) ops.push({ op: "create", record });
    }
    return { ops, conflicts };
}

/**
 * Shorten the TTL of DNS-only records while armed, remembering what each had, or
 * give them back their own TTL when disarmed. Keyed by name and type: the follower
 * may move a record's content in the meantime, and the TTL still belongs to it.
 */
export function planTtl(
    live: readonly LiveRecord[],
    armed: boolean,
    remembered: Readonly<Record<string, number>>
): { ops: RecordOp[]; remembered: Record<string, number> } {
    const ops: RecordOp[] = [];
    const next: Record<string, number> = { ...remembered };
    for (const record of live) {
        if (record.proxied || record.type === "CNAME") continue;
        const key = `${record.name}|${record.type}`;
        if (armed) {
            if (record.ttl === ARMED_TTL) continue;
            next[key] = record.ttl;
            ops.push({ op: "ttl", id: record.id, ttl: ARMED_TTL });
        } else {
            const own = remembered[key];
            if (own === undefined) continue;
            if (record.ttl !== own) ops.push({ op: "ttl", id: record.id, ttl: own });
            delete next[key];
        }
    }
    return { ops, remembered: next };
}
