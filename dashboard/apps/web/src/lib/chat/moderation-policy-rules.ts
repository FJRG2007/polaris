/**
 * The pure half of `moderation-policy.ts`: the schema, the defaults and the
 * total reader, safe to import from a client component.
 */

import { z } from "zod";

export const AUTO_DOWNLOAD_CHOICES = ["all", "contacts", "none"] as const;
export type AutoDownload = (typeof AUTO_DOWNLOAD_CHOICES)[number];

export const restrictionSchema = z
    .object({
        enabled: z.boolean(),
        /** How many different people blocking or reporting it, in the window. */
        threshold: z.number().int().min(2).max(1000),
        /** How far back those count, in days. */
        windowDays: z.number().int().min(1).max(90),
        /** How long the restriction lasts from the latest of them, in hours. */
        hours: z.number().int().min(1).max(24 * 30)
    })
    .strict();
export type RestrictionPolicy = z.infer<typeof restrictionSchema>;

export const moderationPolicySchema = z
    .object({
        keep: z.enum(["allowed", "forbidden"]),
        restriction: restrictionSchema,
        autoDownload: z.enum(AUTO_DOWNLOAD_CHOICES)
    })
    .strict();
export type ModerationPolicy = z.infer<typeof moderationPolicySchema>;

export const DEFAULT_MODERATION_POLICY: ModerationPolicy = {
    keep: "allowed",
    restriction: { enabled: true, threshold: 5, windowDays: 7, hours: 24 },
    autoDownload: "all"
};

/** Read one stored value field by field, so one bad field costs only itself. */
export function readModerationPolicy(raw: string | null): ModerationPolicy {
    let stored: Record<string, unknown> = {};
    try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            stored = parsed as Record<string, unknown>;
        }
    } catch {
        stored = {};
    }
    const keep = moderationPolicySchema.shape.keep.safeParse(stored.keep);
    const restriction = restrictionSchema.safeParse(stored.restriction);
    const autoDownload = moderationPolicySchema.shape.autoDownload.safeParse(stored.autoDownload);
    return {
        keep: keep.success ? keep.data : DEFAULT_MODERATION_POLICY.keep,
        restriction: restriction.success ? restriction.data : DEFAULT_MODERATION_POLICY.restriction,
        autoDownload: autoDownload.success ? autoDownload.data : DEFAULT_MODERATION_POLICY.autoDownload
    };
}
