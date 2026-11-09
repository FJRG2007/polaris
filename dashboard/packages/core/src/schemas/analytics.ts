/**
 * What the tracker is allowed to send.
 *
 * This is the one endpoint in Polaris that anonymous traffic writes to, from a
 * script running on somebody else's page, so the schema is the whole defence. Every
 * field is bounded: a length cap on each string, an enum where there is one, and
 * nothing open-ended. Without that, one line of JavaScript on a page Polaris does
 * not control can fill the database with whatever it likes.
 *
 * Anything unrecognised is rejected rather than passed through. A payload that only
 * mostly matches is a payload someone is experimenting with.
 */

import { z } from "zod";

/** Long enough for a real URL with a query, short enough to bound a row. */
const URL_MAX = 2048;
const NAME_MAX = 120;

export const VISIT_BEATS = ["view", "event", "leave", "identify"] as const;
export type VisitBeat = (typeof VISIT_BEATS)[number];

/**
 * Custom event properties.
 *
 * Flat, and only scalars: a nested object is a document store, and this is a
 * breakdown. Twenty keys is far past what a useful breakdown has and well short of
 * what would make a row expensive.
 */
export const visitPropsSchema = z
    .record(z.string().min(1).max(60), z.union([z.string().max(240), z.number().finite(), z.boolean()]))
    .refine((props) => Object.keys(props).length <= 20, { message: "Too many properties on one event" });

export const visitBeatSchema = z.object({
    /** The site's public key, from the script tag. */
    key: z.string().min(8).max(64),
    type: z.enum(VISIT_BEATS),
    /** The page the beat is about. Path and query only - the origin is not the
     *  client's to assert, and the site's own hostnames are what identify it. */
    url: z.string().max(URL_MAX),
    referrer: z.string().max(URL_MAX).optional(),
    title: z.string().max(NAME_MAX).optional(),
    /** Custom event name. Required for an event beat, meaningless on the others. */
    name: z.string().min(1).max(NAME_MAX).optional(),
    props: visitPropsSchema.optional(),
    /** The site's own name for this visitor, sent by `polaris.identify()`. Only
     *  ever what the page chose to send; it is what lets a returning visitor be
     *  recognised past the daily salt, and only on sites that ask for it. */
    distinctId: z.string().trim().min(1).max(100).optional(),
    /** What `polaris.identify()` says about the visitor, kept on the visit. */
    data: visitPropsSchema.optional(),
    /** "1920x1080". Read off the client because the server cannot see it. */
    screen: z
        .string()
        .max(24)
        .regex(/^\d{2,5}x\d{2,5}$/, "Not a screen size")
        .optional(),
    language: z.string().max(35).optional(),
    /** IANA zone, which is how the visit gets a country without a geo-IP database. */
    timezone: z.string().max(64).optional(),
    /** Milliseconds on the page, sent with the beat that ends a view. Capped at a
     *  day: a tab left open over a weekend is not a two-day visit, and letting it
     *  count as one would wreck every average on the screen. */
    durationMs: z.number().int().min(0).max(86_400_000).optional()
});

export type VisitBeatInput = z.infer<typeof visitBeatSchema>;

/** How far back a query may look, and how the range is named in a URL. */
export const VISIT_RANGES = ["24h", "7d", "30d", "90d", "12m"] as const;
export type VisitRange = (typeof VISIT_RANGES)[number];

export const visitRangeSchema = z.enum(VISIT_RANGES);

/** Milliseconds a range spans, and the bucket count that reads well over it. */
export const VISIT_RANGE_SPEC: Readonly<Record<VisitRange, { ms: number; buckets: number; label: string }>> = {
    "24h": { ms: 24 * 3600_000, buckets: 24, label: "Last 24 hours" },
    "7d": { ms: 7 * 86_400_000, buckets: 7, label: "Last 7 days" },
    "30d": { ms: 30 * 86_400_000, buckets: 30, label: "Last 30 days" },
    "90d": { ms: 90 * 86_400_000, buckets: 90, label: "Last 90 days" },
    "12m": { ms: 365 * 86_400_000, buckets: 12, label: "Last 12 months" }
};

/** How long raw visits are kept before only the daily totals remain. */
export const analyticsSettingsSchema = z.object({
    /** Whether the edge's access log is folded into visits at all. */
    ingestEdgeLog: z.boolean(),
    /** Whether requests from recognised bots are recorded. Off by default: a
     *  dashboard where a crawler outranks every real page is one nobody reads. */
    countBots: z.boolean(),
    /** Days of per-visit detail. The daily totals outlive it. */
    retentionDays: z.number().int().min(1).max(3650)
});

export type AnalyticsSettings = z.infer<typeof analyticsSettingsSchema>;

export const ANALYTICS_DEFAULTS: AnalyticsSettings = {
    ingestEdgeLog: true,
    countBots: false,
    retentionDays: 180
};
// --- reading: filters, reports and per-site settings --------------------------

/**
 * The dimensions a report can be narrowed by. A session dimension narrows the
 * visits; `path` and `event` narrow them to the visits that saw that page or did
 * that thing, which is what "people who looked at /pricing" means.
 */
export const VISIT_FILTER_DIMENSIONS = [
    "path",
    "event",
    "referrer",
    "channel",
    "campaign",
    "medium",
    "browser",
    "os",
    "device",
    "country",
    "language",
    "screen",
    "ip",
    "distinctId"
] as const;
export type VisitFilterDimension = (typeof VISIT_FILTER_DIMENSIONS)[number];

export const visitFilterSchema = z.object({
    dimension: z.enum(VISIT_FILTER_DIMENSIONS),
    value: z.string().trim().min(1).max(240),
    /** Whether the filter keeps the matching visits or every other one. */
    negate: z.boolean().default(false)
});
export type VisitFilter = z.infer<typeof visitFilterSchema>;

/** At most this many at once: past it the URL is unreadable and the query is not
 *  a breakdown any more. */
export const visitFiltersSchema = z.array(visitFilterSchema).max(10);

/** Read the filters off a URL parameter. Anything malformed reads as none. */
export function parseVisitFilters(raw: string | null | undefined): VisitFilter[] {
    if (!raw) return [];
    try {
        const parsed = visitFiltersSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

/** A page or an event: one step of a funnel, a goal. A path ending in `*` matches
 *  every path that starts with what comes before it. */
export const visitMatchSchema = z
    .object({
        type: z.enum(["path", "event"]),
        value: z.string().trim().min(1).max(240)
    })
    .superRefine((match, context) => {
        if (match.type === "path" && !match.value.startsWith("/"))
            context.addIssue({ code: "custom", path: ["value"], message: "A path starts with /" });
    });
export type VisitMatch = z.infer<typeof visitMatchSchema>;

export const funnelDefinitionSchema = z.object({
    steps: z.array(visitMatchSchema).min(2).max(8),
    /** How long a visitor has, from the first step, to reach the last. */
    windowMinutes: z.number().int().min(1).max(10_080)
});
export type FunnelDefinition = z.infer<typeof funnelDefinitionSchema>;

export const goalDefinitionSchema = visitMatchSchema;
export type GoalDefinition = z.infer<typeof goalDefinitionSchema>;

export const journeyDefinitionSchema = z.object({
    /** Pages per journey shown. */
    steps: z.number().int().min(2).max(7),
    /** Only journeys that start here, when set. */
    start: z.string().trim().max(240).optional()
});
export type JourneyDefinition = z.infer<typeof journeyDefinitionSchema>;

export const segmentDefinitionSchema = z.object({ filters: visitFiltersSchema.min(1) });
export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;

export const ANALYTICS_REPORT_KINDS = ["funnel", "goal", "journey", "segment"] as const;
export type AnalyticsReportKind = (typeof ANALYTICS_REPORT_KINDS)[number];

const reportName = z.string().trim().min(1).max(80);

/** A report as it is saved: a name, and what it asks. */
export const analyticsReportSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("funnel"), name: reportName, definition: funnelDefinitionSchema }),
    z.object({ kind: z.literal("goal"), name: reportName, definition: goalDefinitionSchema }),
    z.object({ kind: z.literal("journey"), name: reportName, definition: journeyDefinitionSchema }),
    z.object({ kind: z.literal("segment"), name: reportName, definition: segmentDefinitionSchema })
]);
export type AnalyticsReportInput = z.infer<typeof analyticsReportSchema>;

/**
 * What one site ignores. Both apply to the edge log and the tracker alike, at
 * the moment a visit is recorded, so an excluded page never reaches a total.
 * A path pattern ending in `*` is a prefix.
 */
export const analyticsSiteSettingsSchema = z.object({
    excludedPaths: z
        .array(
            z
                .string()
                .trim()
                .min(1)
                .max(200)
                .regex(/^\/\S*$/, "A path starts with / and has no spaces")
        )
        .max(50),
    ignoredIps: z
        .array(
            z
                .string()
                .trim()
                .min(2)
                .max(64)
                .regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, "Not an address")
        )
        .max(50)
});
export type AnalyticsSiteSettings = z.infer<typeof analyticsSiteSettingsSchema>;

/** Whether a path matches a pattern: exact, or a prefix when it ends in `*`. */
export function visitPathMatches(pattern: string, path: string): boolean {
    return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

/** Whether an address is one a site ignores: exact, or inside an IPv4 CIDR. */
export function visitIpIgnored(patterns: readonly string[], ip: string): boolean {
    for (const pattern of patterns) {
        if (!pattern.includes("/")) {
            if (pattern.toLowerCase() === ip.toLowerCase()) return true;
            continue;
        }
        const [base, bitsText] = pattern.split("/");
        const bits = Number(bitsText);
        const a = ipv4ToInt(base ?? "");
        const b = ipv4ToInt(ip);
        if (a === null || b === null || !(bits >= 0 && bits <= 32)) continue;
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if ((a & mask) >>> 0 === (b & mask) >>> 0) return true;
    }
    return false;
}

function ipv4ToInt(value: string): number | null {
    const parts = value.split(".");
    if (parts.length !== 4) return null;
    let out = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const n = Number(part);
        if (n > 255) return null;
        out = out * 256 + n;
    }
    return out >>> 0;
}
