/**
 * The tracker's switches set for a site in Polaris rather than on its tag, so a
 * tag carrying only its key is enough (one-tag setup).
 *
 * The client-side switches (outbound links, downloads, forms, hash routing,
 * vitals) are served to the script by `GET /api/analytics/collect?key=`; an
 * attribute on the tag still wins. The two privacy switches are enforced here on
 * the server instead, so they hold from the very first beat and whatever the tag
 * says: leaving out the query string, and not counting a browser that sends
 * Do Not Track or Global Privacy Control.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";

export const trackerOptionsSchema = z
    .object({
        outbound: z.boolean().default(false),
        downloads: z.boolean().default(false),
        forms: z.boolean().default(false),
        hash: z.boolean().default(false),
        vitals: z.boolean().default(false),
        excludeSearch: z.boolean().default(false),
        doNotTrack: z.boolean().default(false)
    })
    .strict();
export type TrackerOptions = z.infer<typeof trackerOptionsSchema>;
export const TRACKER_OPTIONS = ["outbound", "downloads", "forms", "hash", "vitals", "excludeSearch", "doNotTrack"] as const;

const NONE: TrackerOptions = trackerOptionsSchema.parse({});

/** A stored value read whole: anything unreadable is every switch off. */
export function parseTrackerOptions(raw: string | null | undefined): TrackerOptions {
    try {
        const parsed = trackerOptionsSchema.safeParse(JSON.parse(raw ?? "{}"));
        return parsed.success ? parsed.data : NONE;
    } catch {
        return NONE;
    }
}

/** What the script is told: only the switches that are on, as the tag's attribute names. */
export function scriptOptions(options: TrackerOptions): Record<string, true> {
    const out: Record<string, true> = {};
    if (options.outbound) out["data-outbound"] = true;
    if (options.downloads) out["data-downloads"] = true;
    if (options.forms) out["data-forms"] = true;
    if (options.hash) out["data-hash"] = true;
    if (options.vitals) out["data-vitals"] = true;
    return out;
}

/** Whether the request comes from a browser that asked not to be tracked. */
export function asksNotToTrack(headers: Headers): boolean {
    return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1";
}

/** A page address without its query string, keeping a hash route. */
export function withoutSearch(url: string): string {
    const hash = url.indexOf("#");
    const path = hash === -1 ? url : url.slice(0, hash);
    const query = path.indexOf("?");
    return query === -1 ? url : path.slice(0, query) + (hash === -1 ? "" : url.slice(hash));
}

/** Read on every beat, so held briefly per site. */
const cache = new Map<string, { at: number; options: TrackerOptions }>();
const TTL_MS = 30_000;

export async function readTrackerOptions(siteId: string): Promise<TrackerOptions> {
    const cached = cache.get(siteId);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.options;
    const site = await prisma.analyticsSite.findUnique({ where: { id: siteId }, select: { trackerOptions: true } });
    const options = parseTrackerOptions(site?.trackerOptions);
    if (cache.size > 5000) cache.clear();
    cache.set(siteId, { at: Date.now(), options });
    return options;
}

export async function writeTrackerOptions(siteId: string, options: TrackerOptions): Promise<void> {
    await prisma.analyticsSite.update({ where: { id: siteId }, data: { trackerOptions: JSON.stringify(options) } });
    cache.set(siteId, { at: Date.now(), options });
}
