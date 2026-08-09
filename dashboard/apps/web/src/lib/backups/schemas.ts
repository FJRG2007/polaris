/**
 * Every shape that crosses into the backup engine from outside, and the selector
 * that gives a protected thing its identity.
 *
 * One module so the client form and the server action validate against the same
 * object rather than two that drift. Nothing here touches the database: these
 * are the checks a value passes before anything is done with it.
 */

import { z } from "zod";
import { RESOURCE_KINDS, type ResourceKind } from "./kinds";
import { BACKUP_INTERVALS, MAX_BACKUP_BYTES, MAX_KEEP_DAYS, MAX_KEEP_LAST } from "./policy";

/** Trim, and reject what is only whitespace. Names arrive from a form. */
const name = z.string().trim().min(1).max(120);

/**
 * A path inside a connection, normalized to one stored form.
 *
 * Leading and trailing slashes are removed and backslashes folded, so the same
 * folder typed three ways is one protected resource rather than three. `..` is
 * refused outright rather than resolved: this is the identity of a thing being
 * backed up, and a selector that can climb out of the connection it names is a
 * selector that can be pointed at somebody else's.
 */
export const subPathSchema = z
    .string()
    .trim()
    .max(1024)
    // Backslashes folded, repeated slashes collapsed, ends trimmed - so the same
    // folder typed five ways is one protected thing rather than five.
    .transform((value) =>
        value
            .replace(/\\/g, "/")
            .replace(/\/{2,}/g, "/")
            .replace(/^\/+|\/+$/g, "")
    )
    .refine((value) => !value.split("/").includes(".."), { message: "That path cannot contain '..'" })
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), { message: "That path contains control characters" });

/**
 * The normalized identity of a protected thing.
 *
 * Uniqueness is enforced on this, so the same database cannot be protected twice
 * under two display names. It is built here rather than at each call site
 * because the parts differ per kind and a selector assembled two ways is a
 * duplicate waiting to happen.
 */
export function buildSelector(kind: ResourceKind, parts: readonly string[] = []): string {
    return [kind, ...parts.filter((part) => part.length > 0)].join(":");
}

/** The kind a selector names, for reading one back. */
export function selectorKind(selector: string): ResourceKind | undefined {
    const head = selector.split(":", 1)[0];
    return (RESOURCE_KINDS as readonly string[]).includes(head ?? "") ? (head as ResourceKind) : undefined;
}

/**
 * What identifies each kind of thing, discriminated so a payload can only carry
 * the fields its own kind needs.
 *
 * The Polaris database has nothing to identify - there is one - which is why it
 * is the only member with no reference at all.
 */
export const protectTargetSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("polaris-database") }),
    z.object({ kind: z.literal("managed-database"), databaseId: z.string().uuid() }),
    z.object({ kind: z.literal("minecraft-world"), installedAppId: z.string().uuid() }),
    z.object({ kind: z.literal("deploy-volume"), volumeId: z.string().uuid() }),
    z.object({
        kind: z.literal("nas-path"),
        connectionId: z.string().uuid(),
        path: subPathSchema
    }),
]);

export type ProtectTarget = z.infer<typeof protectTargetSchema>;

/** The selector for a target, built from the one place that knows its shape. */
export function targetSelector(target: ProtectTarget): string {
    switch (target.kind) {
        case "polaris-database":
            return buildSelector("polaris-database");
        case "managed-database":
            return buildSelector("managed-database", [target.databaseId]);
        case "minecraft-world":
            return buildSelector("minecraft-world", [target.installedAppId]);
        case "deploy-volume":
            return buildSelector("deploy-volume", [target.volumeId]);
        case "nas-path":
            return buildSelector("nas-path", [target.connectionId, target.path]);
    }
}

export const protectSchema = z.object({
    target: protectTargetSchema,
    /** Shown in the table. Falls back to the source's own name when absent. */
    name: name.optional(),
    /** Null detaches; absent leaves it as it is. */
    planId: z.string().uuid().nullable().optional()
});

export type ProtectInput = z.infer<typeof protectSchema>;

export const planSchema = z.object({
    name,
    every: z.enum(BACKUP_INTERVALS),
    keepLast: z.number().int().min(0).max(MAX_KEEP_LAST),
    keepDays: z.number().int().min(0).max(MAX_KEEP_DAYS),
    maxBytes: z.number().int().min(0).max(MAX_BACKUP_BYTES),
    notifyOnFailure: z.boolean(),
    /**
     * Where copies go, in the order they are written.
     *
     * At least one, because a plan that writes nowhere is a schedule that
     * silently does nothing - the failure this whole rebuild exists to stop.
     */
    destinationIds: z.array(z.string().uuid()).min(1).max(10)
});

export type PlanInput = z.infer<typeof planSchema>;

export const destinationSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local"), name, basePath: subPathSchema.default("backups") }),
    z.object({ kind: z.literal("source-local"), name }),
    z.object({
        kind: z.literal("connection"),
        name,
        connectionId: z.string().uuid(),
        basePath: subPathSchema.default("polaris-backups")
    }),
    z.object({
        kind: z.literal("host"),
        name,
        hostId: z.string().uuid(),
        // An absolute path on the machine, which is what somebody means when they
        // say where on a server the copies should go.
        basePath: z.string().trim().min(1).max(1024).refine((value) => !value.includes(".."), {
            message: "That path cannot contain '..'"
        })
    })
]);

export type DestinationInput = z.infer<typeof destinationSchema>;

/** What the console asks for when it lists protected things. */
export const listResourcesSchema = z.object({
    query: z.string().trim().max(200).optional(),
    kind: z.enum(RESOURCE_KINDS).optional(),
    planId: z.string().uuid().optional(),
    status: z.enum(["active", "paused", "missing"]).optional(),
    /** Cursor is the id of the last row of the previous page. */
    cursor: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100).default(50),
    sort: z.enum(["name", "lastBackupAt", "sizeBytes", "nextDueAt"]).default("lastBackupAt"),
    direction: z.enum(["asc", "desc"]).default("desc")
});

export type ListResourcesInput = z.infer<typeof listResourcesSchema>;

export const restoreSchema = z.object({
    copyId: z.string().uuid(),
    /**
     * Restoring is destructive by definition, so the caller has to say it meant
     * to. A checkbox on a dialog, not a default.
     */
    confirm: z.literal(true)
});

export type RestoreInput = z.infer<typeof restoreSchema>;
