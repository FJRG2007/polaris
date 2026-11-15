/**
 * GET /api/v1/analytics/stats - one site's figures for a range, read with a
 * Polaris API key.
 *
 * The same numbers the Analytics screen shows: it reads through
 * `readAnalytics` and `previousPeriod`, so the API and the screen cannot count
 * apart. Ranges past 31 days come from the daily totals and list the dimensions
 * those do not keep in `unavailable`, exactly as the screen does. The key needs
 * `deploy.manage`, and its owner must be able to see the site right now - a
 * shared site is readable, someone else's is a 404, never a hint that it exists.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { requireApiKey } from "@/lib/api-key-auth";
import * as reports from "@/lib/analytics-reports";
import { readerWords } from "@/lib/i18n/reader-words";
import { readAnalytics } from "@/lib/analytics-service";
import { withKeyUsage } from "@/lib/api-usage/recorder";
import { siteAccess } from "@/app/(app)/analytics/site-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
    scopeType: z.enum(["application", "polaris", "external"]),
    scopeId: z.string().trim().max(64).default(""),
    range: core.visitRangeSchema,
    /** The screen's filter list, as JSON: `[{"dimension":"country","value":"ES"}]`. */
    filters: z.string().max(4000).optional(),
    compare: z.enum(core.VISIT_COMPARES).default("previous"),
    /** Breakdowns to include; every one when omitted. Comma-separated. */
    breakdown: z
        .string()
        .max(400)
        .optional()
        .transform((value, context) => {
            if (!value) return [...core.VISIT_DIMENSIONS];
            const asked = value.split(",").map((entry) => entry.trim()).filter(Boolean);
            const unknown = asked.filter((entry) => !(core.VISIT_DIMENSIONS as readonly string[]).includes(entry));
            if (unknown.length) {
                context.addIssue({ code: "custom", message: `Unknown breakdown: ${unknown.join(", ")}` });
                return z.NEVER;
            }
            return asked as core.VisitDimension[];
        })
});

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const principal = await requireApiKey(request, "deploy.manage");
    if (principal instanceof Response) return principal;
    const words = await readerWords("api");

    const url = new URL(request.url);
    const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
        return Response.json(
            { error: words("errors.invalidRequest"), issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })) },
            { status: 400 }
        );
    }
    const query = parsed.data;
    const access = await siteAccess(
        principal.userId,
        principal.scopes.includes("system.manage"),
        query.scopeType,
        query.scopeId
    );
    if (!access) return Response.json({ error: words("errors.notFound") }, { status: 404 });

    const filters = core.parseVisitFilters(query.filters);
    const view = await readAnalytics(access.site, query.range, Date.now(), filters);
    const previous = await reports.previousPeriod(
        { siteId: access.site.id, from: view.from, to: view.to, filters },
        view.source,
        query.compare
    );
    const breakdowns = Object.fromEntries(query.breakdown.map((dimension) => [dimension, view.breakdowns[dimension]]));

    return Response.json({
        site: { id: access.site.id, name: access.site.name },
        range: query.range,
        from: new Date(view.from).toISOString(),
        to: new Date(view.to).toISOString(),
        source: view.source,
        unavailable: view.unavailable,
        filtersIgnored: view.filtersIgnored,
        online: view.online,
        overview: view.overview,
        compare: query.compare,
        previous,
        series: view.series.map((point) => ({ t: new Date(point.t).toISOString(), visitors: point.visitors, views: point.views })),
        breakdowns
    });
});
