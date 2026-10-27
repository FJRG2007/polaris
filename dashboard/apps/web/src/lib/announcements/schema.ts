/**
 * The shapes an announcement is made of, shared by the compose screen and the
 * actions behind it, so the form refuses exactly what the server would.
 *
 * Client-safe: no database, no catalogs.
 */

import { z } from "zod";

export const SEVERITIES = ["info", "success", "warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const KINDS = ["announcement", "maintenance"] as const;
export type AnnouncementKind = (typeof KINDS)[number];

/** Ready-made texts, translated in the `announcements` catalog. */
export const TEMPLATES = [
    "generic",
    "maintenanceScheduled",
    "maintenanceInProgress",
    "maintenanceFinished",
    "updateAvailable",
    "updateApplied",
    "newFeature",
    "incident",
    "policyChange"
] as const;
export type TemplateId = (typeof TEMPLATES)[number];

/** The placeholders a text may carry, filled in per reader. */
export const PLACEHOLDERS = ["start", "end", "duration", "affected"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export const TITLE_MAX = 120;
export const BODY_MAX = 2000;
export const LINK_LABEL_MAX = 40;
/** A day ahead unless the administrator says otherwise. */
export const DEFAULT_LEAD_MINUTES = 24 * 60;
export const LEAD_MAX_MINUTES = 14 * 24 * 60;
/** How many history rows the admin screen reads at a time. */
export const HISTORY_PAGE = 50;

const uuid = z.string().uuid();
const ids = z.array(uuid).max(500);

export const audienceSchema = z
    .object({
        everyone: z.boolean().default(false),
        roleIds: ids.default([]),
        groupIds: ids.default([]),
        orgIds: ids.default([]),
        userIds: ids.default([])
    })
    .strict();
export type AudienceSpec = z.infer<typeof audienceSchema>;

export const NOBODY: AudienceSpec = { everyone: false, roleIds: [], groupIds: [], orgIds: [], userIds: [] };

/** Nobody picked at all - not the same as a pick that happens to match nobody. */
export function audienceIsEmpty(audience: AudienceSpec): boolean {
    return (
        !audience.everyone &&
        audience.roleIds.length === 0 &&
        audience.groupIds.length === 0 &&
        audience.orgIds.length === 0 &&
        audience.userIds.length === 0
    );
}

/** A link is a path inside Polaris or an https address. Nothing else is rendered. */
export function safeLink(value: string): boolean {
    if (value.startsWith("/")) return !value.startsWith("//") && !value.includes("\\");
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

const isoDate = z.string().datetime({ offset: true });

export const composeSchema = z
    .object({
        kind: z.enum(KINDS),
        template: z.enum(TEMPLATES),
        /** True while the text is still the template's own words. */
        localized: z.boolean(),
        severity: z.enum(SEVERITIES),
        title: z.string().min(1).max(TITLE_MAX),
        body: z.string().max(BODY_MAX),
        linkUrl: z.string().max(2000).refine(safeLink, "link").nullable(),
        linkLabel: z.string().max(LINK_LABEL_MAX).nullable(),
        audience: audienceSchema,
        sendNotice: z.boolean(),
        showBanner: z.boolean(),
        /** Announcement: when it starts showing (null is now) and stops (null is never). */
        startsAt: isoDate.nullable(),
        endsAt: isoDate.nullable(),
        /** Maintenance: the window, how far ahead to announce it, what it touches. */
        windowStart: isoDate.nullable(),
        windowEnd: isoDate.nullable(),
        leadMinutes: z.number().int().min(0).max(LEAD_MAX_MINUTES).nullable(),
        affected: z.array(z.string().min(1).max(60)).max(30),
        notifySteps: z.boolean()
    })
    .strict()
    .superRefine((value, ctx) => {
        if (!value.sendNotice && !value.showBanner) {
            ctx.addIssue({ code: "custom", path: ["showBanner"], message: "delivery" });
        }
        if (audienceIsEmpty(value.audience)) {
            ctx.addIssue({ code: "custom", path: ["audience"], message: "audience" });
        }
        if (value.kind === "maintenance") {
            if (!value.windowStart || !value.windowEnd) {
                ctx.addIssue({ code: "custom", path: ["windowStart"], message: "window" });
            } else if (Date.parse(value.windowEnd) <= Date.parse(value.windowStart)) {
                ctx.addIssue({ code: "custom", path: ["windowEnd"], message: "order" });
            }
        } else if (
            value.startsAt &&
            value.endsAt &&
            Date.parse(value.endsAt) <= Date.parse(value.startsAt)
        ) {
            ctx.addIssue({ code: "custom", path: ["endsAt"], message: "order" });
        }
        if (value.linkLabel && !value.linkUrl) {
            ctx.addIssue({ code: "custom", path: ["linkUrl"], message: "link" });
        }
    });
export type ComposeInput = z.infer<typeof composeSchema>;

export const announcementIdSchema = uuid;

/**
 * One normalizer for the form and the server: trimmed text, an empty optional
 * field as null, the affected list without blanks or repeats.
 */
export function normalizeCompose(input: ComposeInput): ComposeInput {
    const optional = (value: string | null) => {
        const trimmed = value?.trim() ?? "";
        return trimmed.length > 0 ? trimmed : null;
    };
    return {
        ...input,
        title: input.title.trim(),
        body: input.body.trim(),
        linkUrl: optional(input.linkUrl),
        linkLabel: optional(input.linkLabel),
        affected: [...new Set(input.affected.map((one) => one.trim()).filter(Boolean))]
    };
}
