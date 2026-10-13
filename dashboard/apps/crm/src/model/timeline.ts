/**
 * A record's activity: what happened to it, by whom and when - made, fields
 * changed, moved to the trash or back - as the record's page lists it.
 *
 * Pure and client-safe: the server builds the changes here before it stores
 * them, and reads them back through `readChanges`, which keeps only what has
 * the shape of a change.
 */

import { z } from "zod";
import type { CrmRecord, FieldValue, Ref } from "./objects";

export const EVENT_KINDS = ["created", "updated", "trashed", "restored"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The most events one page of a timeline holds. */
export const TIMELINE_PAGE = 20;

/** The most field changes one event keeps. */
export const MAX_CHANGES = 64;

export interface FieldChange {
    readonly key: string;
    readonly before: FieldValue;
    readonly after: FieldValue;
}

export interface TimelineEvent {
    readonly id: string;
    readonly kind: EventKind;
    /** Who did it; null when their account is gone or nobody is known. */
    readonly actor: Ref | null;
    /** ISO time. */
    readonly at: string;
    readonly changes: readonly FieldChange[];
}

export interface TimelinePage {
    readonly events: TimelineEvent[];
    /** The id to read the next, older page after; null at the first event. */
    readonly next: string | null;
}

/** Two values as the screens draw them, compared by content. */
export function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) {
        return (a ?? null) === (b ?? null);
    }
    if (typeof a !== "object" || typeof b !== "object") return false;
    const left = a as unknown as Record<string, unknown>;
    const right = b as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    // A reference is the same record whatever it is named by now.
    if ("id" in left && "id" in right) return left.id === right.id;
    return [...keys].every((key) => left[key] === right[key]);
}

/** The fields among `keys` whose value differs between two versions of a
 *  record, in the order of `keys`. */
export function changesBetween(
    before: CrmRecord,
    after: CrmRecord,
    keys: readonly string[]
): FieldChange[] {
    const changes: FieldChange[] = [];
    for (const key of new Set(keys)) {
        const was = before.values[key] ?? null;
        const now = after.values[key] ?? null;
        if (!sameValue(was, now)) changes.push({ key, before: was, after: now });
        if (changes.length === MAX_CHANGES) break;
    }
    return changes;
}

/** The fields a new record was made with: everything set, shown as changes
 *  from nothing. */
export function initialValues(record: CrmRecord, keys: readonly string[]): FieldChange[] {
    const empty: CrmRecord = { ...record, values: {} };
    return changesBetween(empty, record, keys).filter(
        (change) => change.after !== "" && change.after !== false
    );
}

const refShape = z.object({ id: z.string().max(64), name: z.string().max(512) });
const valueShape: z.ZodType<FieldValue> = z.union([
    z.string().max(10_000),
    z.number(),
    z.boolean(),
    z.null(),
    refShape,
    z.object({ amount: z.number().nullable(), currency: z.string().max(8) }),
    z.object({ first: z.string().max(512), last: z.string().max(512) })
]) as z.ZodType<FieldValue>;
const changeShape = z.object({
    key: z.string().min(1).max(64),
    before: valueShape,
    after: valueShape
});

/** A stored event's changes, keeping only the entries shaped like one. */
export function readChanges(raw: string): FieldChange[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_CHANGES).flatMap((entry) => {
        const one = changeShape.safeParse(entry);
        return one.success ? [one.data as FieldChange] : [];
    });
}

export function isEventKind(kind: string): kind is EventKind {
    return (EVENT_KINDS as readonly string[]).includes(kind);
}
