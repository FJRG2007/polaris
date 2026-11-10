/**
 * What every Analytics section does before it draws: who is asking, which site,
 * which window. Shared so the sections cannot drift on any of it.
 *
 * The shell renders immediately and everything else arrives into it - the numbers,
 * and the list of what can be measured. Both are database reads: one over a window
 * the visitor chose, the other over every project they can reach, and waiting for
 * either would mean a blank page every time somebody changes the range or opens
 * a section at all.
 *
 * The site lives in the URL (`?scope=application&id=...`), so a service's own panel
 * can link straight at its numbers. The rail links at bare routes, so a section
 * opened from it falls back to the site last open (a cookie, see
 * `ANALYTICS_SITE_COOKIE`).
 */

import { cookies } from "next/headers";
import { AnalyticsView } from "./analytics-view";
import { userHasManage } from "@/lib/session";
import { grantedSubjects } from "@/lib/access/grants";
import { requireAnalyticsReader } from "./reader";
import { requireInstalledApp } from "@/lib/apps/require-installed";
import { visitRangeSchema, type VisitRange } from "@polaris/core";
import { holdsPolarisSite } from "@/lib/analytics-service";
import { isAnalyticsScope, type AnalyticsScope } from "./site-catalog";
import { ANALYTICS_SITE_COOKIE, parseSiteCookie, type AnalyticsTab } from "./analytics-tabs";

export interface AnalyticsSearch {
    scope?: string;
    id?: string;
    range?: string;
    tab?: string;
}

export async function renderAnalyticsPage(searchParams: Promise<AnalyticsSearch>, tab: AnalyticsTab) {
    const { scope, id, range } = await searchParams;
    const { user, lent } = await requireAnalyticsReader();
    await requireInstalledApp("analytics", user);
    const canOperate = await userHasManage(user, "system.manage");
    // Polaris's own traffic: an operator's, or handed to this reader by one.
    const seesPolaris =
        canOperate ||
        (await holdsPolarisSite(lent ?? new Set((await grantedSubjects(user.id, "analytics.site")).keys())));

    // Nothing named in the address: the site last open, if there was one.
    const remembered = scope ? null : parseSiteCookie((await cookies()).get(ANALYTICS_SITE_COOKIE)?.value);
    const named = scope ?? remembered?.scope;

    // An unknown scope in the URL is a stale link, not a 404. Polaris's own traffic is
    // the natural landing place for an operator and is not offered to anyone else.
    const requested = isAnalyticsScope(named) ? named : null;
    let kind: AnalyticsScope = requested ?? (canOperate ? "polaris" : "application");
    if (!seesPolaris && kind === "polaris") kind = "application";

    // Taken as written. An id belonging to somebody else is refused by the read
    // itself - it resolves the site against the person asking - so nothing here
    // has to hold the page open to find out, and a link to someone else's numbers
    // still cannot become a link to your own.
    const siteId = (id ?? (requested === remembered?.scope ? remembered?.id : "") ?? "").trim().slice(0, 64);

    const parsedRange = visitRangeSchema.safeParse(range);
    const activeRange: VisitRange = parsedRange.success ? parsedRange.data : "24h";

    return (
        <AnalyticsView
            key={`${kind}:${siteId}`}
            scope={kind}
            siteId={siteId}
            range={activeRange}
            canOperate={canOperate}
            seesPolaris={seesPolaris}
            canAdd={lent === null}
            tab={tab}
        />
    );
}
