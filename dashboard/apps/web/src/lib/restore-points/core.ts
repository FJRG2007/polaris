/**
 * The pure half of restore points: how a snapshot is written down, compared,
 * deduplicated and pruned. No database here, so every rule is asserted in a test.
 *
 * A snapshot body is always `{ items: { [stableKey]: object } }`: one entry per
 * thing in the object (a variable by name, a job by id, a route by hostname, a
 * DNS record by type and name), so a diff reads as "this one was added, that one
 * changed" rather than as a wall of JSON.
 */

import { createHash } from "node:crypto";

export const RESTORE_POINT_KINDS = ["routes", "firewall", "cron", "dns", "env"] as const;
export type RestorePointKind = (typeof RESTORE_POINT_KINDS)[number];

/** How many points one object keeps, newest first. */
export const KEEP_PER_OBJECT = 50;
/** Points older than this go regardless of how few an object has. */
export const MAX_AGE_DAYS = 180;

export interface SnapshotBody {
    readonly items: Record<string, Record<string, unknown>>;
}

/** Field of an item that holds a secret value; shown masked and never in clear. */
export const SECRET_FIELD = "envelope";

/** JSON with every object's keys sorted, so equal content is equal text. */
export function canonical(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const field = (value as Record<string, unknown>)[key];
            if (field !== undefined) out[key] = sortKeys(field);
        }
        return out;
    }
    return value;
}

export function hashOf(body: SnapshotBody): string {
    return createHash("sha256").update(canonical(body)).digest("hex");
}

/** A body is written only when it differs from the newest one already kept. */
export function isDuplicate(newestHash: string | null | undefined, body: SnapshotBody): boolean {
    return newestHash === hashOf(body);
}

export type ChangeKind = "added" | "removed" | "changed";

export interface FieldChange {
    readonly field: string;
    /** Display text; a secret is never in clear here. */
    readonly before: string | null;
    readonly after: string | null;
}

export interface ItemChange {
    readonly item: string;
    readonly kind: ChangeKind;
    readonly fields: FieldChange[];
}

const MASK = "••••••";

function display(field: string, value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (field === SECRET_FIELD) return MASK;
    return typeof value === "string" ? value : canonical(value);
}

/**
 * What would change if `to` replaced `from`, item by item. A secret field is
 * compared by its stored envelope and shown as a mask on both sides.
 */
export function diffBodies(from: SnapshotBody, to: SnapshotBody): ItemChange[] {
    const changes: ItemChange[] = [];
    const keys = [...new Set([...Object.keys(from.items), ...Object.keys(to.items)])].sort();
    for (const item of keys) {
        const before = from.items[item];
        const after = to.items[item];
        const fields: FieldChange[] = [];
        const names = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
        for (const field of names) {
            const was = before?.[field];
            const now = after?.[field];
            if (canonical(was) === canonical(now)) continue;
            fields.push({ field, before: display(field, was), after: display(field, now) });
        }
        if (!before) changes.push({ item, kind: "added", fields });
        else if (!after) changes.push({ item, kind: "removed", fields });
        else if (fields.length > 0) changes.push({ item, kind: "changed", fields });
    }
    return changes;
}

/**
 * The ids to delete from one object's points (newest first is not assumed):
 * everything past the newest `keep`, and anything older than `maxAgeDays`.
 */
export function prunable(
    points: readonly { id: string; createdAt: Date }[],
    now: Date,
    keep = KEEP_PER_OBJECT,
    maxAgeDays = MAX_AGE_DAYS
): string[] {
    const cutoff = now.getTime() - maxAgeDays * 86_400_000;
    const newestFirst = [...points].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return newestFirst.filter((point, index) => index >= keep || point.createdAt.getTime() < cutoff).map((point) => point.id);
}

/** Parses a stored body, refusing anything that is not the expected shape. */
export function parseBody(text: string): SnapshotBody {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || typeof (parsed as SnapshotBody).items !== "object") {
        throw new Error("Restore point body is not readable");
    }
    return parsed as SnapshotBody;
}
