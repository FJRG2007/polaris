/**
 * The blocks the edge guard remembers, so a reference on a block page can be looked
 * up from the Firewall screen.
 *
 * The block page tells a visitor to quote its reference to the site owner. Until
 * this, the only place that reference was written down was the guard's own stdout,
 * which an operator who never opens a terminal cannot read. So the guard keeps the
 * most recent blocks in memory and answers for one of them, by reference, to a
 * caller that proves it is Polaris.
 *
 * Memory, not a file: the guard mounts nothing writable, and a log the edge appends
 * to on every refused request is a disk an attacker fills. Bounded by count, so a
 * flood costs a fixed amount and pushes out only the oldest entries. A guard that
 * restarted has forgotten what it held before, which the screen says.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Where the guard answers a lookup: this, then the reference. */
export const WAF_BLOCK_LOOKUP_PATH = "/v1/blocks/";

/** How many blocks the guard keeps. A few hundred bytes each. */
export const WAF_BLOCK_LOG_SIZE = 5000;

/** One refused request, as the guard recorded it. */
export interface WafBlockRecord {
    readonly reference: string;
    /** What decided, in the guard's words - the rule's name, the ban, the signature. */
    readonly reason: string;
    readonly ip: string | null;
    readonly host: string | null;
    readonly uri: string | null;
    readonly method: string | null;
    readonly userAgent: string | null;
    /** ISO time. */
    readonly at: string;
}

const REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether a value is shaped like a reference the guard hands out. */
export function isWafBlockReference(value: string): boolean {
    return REFERENCE.test(value);
}

/** The bearer a lookup carries, derived from the secret both containers already
 *  hold so nothing new has to reach either of them. */
export function wafBlockLookupToken(secret: string): string {
    return createHmac("sha256", secret).update("polaris.edge.blocks.v1").digest("base64url");
}

/** Whether `authorization` carries the lookup bearer for `secret`. Constant time,
 *  and false for an empty secret - a guard with none answers nobody. */
export function wafBlockLookupAllowed(authorization: string | undefined, secret: string): boolean {
    if (!secret || !authorization?.startsWith("Bearer ")) return false;
    const given = Buffer.from(authorization.slice(7));
    const wanted = Buffer.from(wafBlockLookupToken(secret));
    return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** A bounded, insertion-ordered memory of blocks. */
export interface WafBlockLog {
    add(record: WafBlockRecord): void;
    find(reference: string): WafBlockRecord | null;
    readonly size: number;
}

/** Remember at most `capacity` blocks, dropping the oldest first. */
export function createWafBlockLog(capacity = WAF_BLOCK_LOG_SIZE): WafBlockLog {
    const entries = new Map<string, WafBlockRecord>();
    return {
        add(record) {
            entries.set(record.reference, record);
            while (entries.size > capacity) {
                const oldest = entries.keys().next().value;
                if (oldest === undefined) break;
                entries.delete(oldest);
            }
        },
        find(reference) {
            return entries.get(reference) ?? null;
        },
        get size() {
            return entries.size;
        }
    };
}

function text(value: unknown, limit: number): string | null {
    return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : null;
}

/** Read a lookup's answer back, keeping only the known fields, capped. Null when it
 *  is not a record - a guard's answer is a network response, not a promise. */
export function parseWafBlockRecord(value: unknown): WafBlockRecord | null {
    if (typeof value !== "object" || value === null) return null;
    const raw = value as Record<string, unknown>;
    const reference = text(raw.reference, 64);
    const at = text(raw.at, 40);
    if (!reference || !isWafBlockReference(reference) || !at || Number.isNaN(Date.parse(at))) {
        return null;
    }
    return {
        reference,
        reason: text(raw.reason, 400) ?? "unknown",
        ip: text(raw.ip, 64),
        host: text(raw.host, 255),
        uri: text(raw.uri, 2048),
        method: text(raw.method, 16),
        userAgent: text(raw.userAgent, 512),
        at
    };
}
