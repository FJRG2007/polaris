/**
 * Reading the audit trail: the narrowing a screen or an export may ask for, the
 * cursor that pages through it, and the exact bytes each entry's link in the
 * tamper-evident chain is computed over.
 *
 * Pure, so the browser validates a filter against the same rules the server
 * enforces, and so the chain's canonical form is one function a test can pin -
 * two copies of "how an entry is serialized for hashing" would stop agreeing the
 * day either moved, and every entry sealed after that would read as altered.
 */

import { z } from "zod";

/** One page, at most. The feed scrolls, and an export streams, so nothing needs
 *  more than this at a time. */
export const AUDIT_PAGE_MAX = 200;

/** What a screen asks for when it does not say. About a screenful and a half. */
export const AUDIT_PAGE_DEFAULT = 50;

export const AUDIT_EXPORT_FORMATS = ["csv", "json"] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];

/**
 * A page's position, as `<milliseconds>_<entry id>`.
 *
 * Keyset rather than offset: the log is appended to while somebody scrolls it,
 * and an offset would show the same entry twice every time something new
 * arrived at the top. Plain digits and a uuid, so it needs no encoding to sit in
 * a URL and cannot smuggle anything into the query that reads it.
 */
const CURSOR = /^(\d{1,15})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function encodeAuditCursor(at: Date, id: string): string {
    return `${at.getTime()}_${id}`;
}

/** The position a cursor names, or null for anything that is not one. */
export function decodeAuditCursor(cursor: string): { at: Date; id: string } | null {
    const match = CURSOR.exec(cursor);
    if (!match) return null;
    const at = new Date(Number(match[1]));
    if (Number.isNaN(at.getTime())) return null;
    return { at, id: match[2] ?? "" };
}

/** A date from a query string or a form: an ISO timestamp, or empty for none. */
const dateField = z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((value, context) => {
        if (!value) return undefined;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
            context.addIssue({ code: "custom", message: "That is not a date" });
            return z.NEVER;
        }
        return parsed;
    });

/**
 * What an audit read may be narrowed by.
 *
 * `area` is the first segment of an action (`org`, `deploy`, `drive`), which is
 * the narrowing people actually want - "what happened to the roster" - without
 * having to know every action's exact name. `q` is a substring of the action or
 * its details, for the entry somebody half remembers. `resource` is the kind of
 * thing acted on. `from` and `to` bound the time.
 */
export const auditFilterSchema = z
    .object({
        actor: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
        area: z
            .string()
            .trim()
            .max(40)
            .regex(/^[a-z0-9-]*$/, "Not an area")
            .optional()
            .transform((value) => value || undefined),
        q: z
            .string()
            .trim()
            .max(200)
            .optional()
            .transform((value) => value || undefined),
        resource: z
            .string()
            .trim()
            .max(40)
            .regex(/^[A-Za-z0-9_-]*$/, "Not a kind of resource")
            .optional()
            .transform((value) => value || undefined),
        from: dateField,
        to: dateField,
        cursor: z
            .string()
            .trim()
            .max(80)
            .optional()
            .refine((value) => !value || decodeAuditCursor(value) !== null, "Not a page position")
            .transform((value) => value || undefined),
        limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_MAX).default(AUDIT_PAGE_DEFAULT)
    })
    // On the object rather than on either field, because neither is wrong on its
    // own: a range is wrong when its end comes before its start.
    .refine((filter) => !filter.from || !filter.to || filter.from <= filter.to, {
        message: "The end of the range is before its start",
        path: ["to"]
    });

export type AuditFilter = z.infer<typeof auditFilterSchema>;

/** The same narrowing, as an export is asked for it: a format and no page. */
export const auditExportSchema = auditFilterSchema.and(
    z.object({ format: z.enum(AUDIT_EXPORT_FORMATS).default("csv") })
);

/** The first segment of an action, which is what `area` narrows by. */
export function auditArea(action: string): string {
    return action.split(".")[0] ?? action;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/** What the first sealed entry points back at: nothing, said the same way every
 *  time. Sixty-four zeros, the width of every other link. */
export const AUDIT_CHAIN_GENESIS = "0".repeat(64);

/** An entry's columns, as the chain reads them. */
export interface AuditChainEntry {
    readonly seq: bigint;
    readonly prevHash: string;
    readonly id: string;
    readonly at: Date;
    readonly actorId: string | null;
    readonly action: string;
    readonly targetType: string | null;
    readonly targetId: string | null;
    readonly metadata: string | null;
    readonly ipHash: string | null;
    readonly sessionId: string | null;
    readonly orgId: string | null;
}

/**
 * The exact text an entry's link is computed over.
 *
 * A JSON array in a fixed order rather than an object, because the order of an
 * object's keys is not something JSON promises and this string has to come out
 * byte-for-byte the same on the day an entry is sealed and on every day it is
 * verified after. Every column is in it, the previous link included - which is
 * what turns a list of hashes into a chain, since changing any entry changes
 * every link after it.
 */
export function auditChainPayload(entry: AuditChainEntry): string {
    return JSON.stringify([
        entry.seq.toString(),
        entry.prevHash,
        entry.id,
        entry.at.toISOString(),
        entry.actorId,
        entry.action,
        entry.targetType,
        entry.targetId,
        entry.metadata,
        entry.ipHash,
        entry.sessionId,
        entry.orgId
    ]);
}

/** Where a chain was found to break, and how. */
export type AuditChainBreak =
    /** An entry is missing: the sequence skips, or the first entry after a cut
     *  does not follow the cut. */
    | "missing"
    /** An entry's own columns no longer produce its hash. */
    | "altered"
    /** An entry's back-link does not name the entry before it. */
    | "relinked";

export const AUDIT_CHAIN_BREAK_LABELS: Readonly<Record<AuditChainBreak, string>> = {
    missing: "An entry is missing from the chain",
    altered: "An entry was changed after it was sealed",
    relinked: "An entry no longer points at the one before it"
};
