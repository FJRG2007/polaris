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

export const VISIT_BEATS = ["view", "event", "leave"] as const;
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
