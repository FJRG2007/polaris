/**
 * Analytics (/apps/analytics).
 *
 * Structured like the firewall and like Deploy, because it answers the same shape of
 * question about the same things: pick what you are looking at in the header, then
 * read down. The choice lives in the URL (`?scope=application&id=...`), so a
 * service's own panel can link straight at its numbers.
 *
 * The shell renders immediately and everything else arrives into it - the numbers,
 * and the list of what can be measured. Both are database reads: one over a window
 * the visitor chose, the other over every project they can reach, and waiting for
 * either would mean a blank page every time somebody changes the range or opens
 * this at all. Which is what it did, for the list.
 */

import { AnalyticsView } from "./analytics-view";
import { requirePermission, userHasManage } from "@/lib/session";
import { visitRangeSchema, type VisitRange } from "@polaris/core";
import { isAnalyticsScope, type AnalyticsScope } from "./site-catalog";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({
    searchParams
}: {
    searchParams: Promise<{ scope?: string; id?: string; range?: string }>;
}) {
    const { scope, id, range } = await searchParams;
    const user = await requirePermission("deploy.manage");
    const canOperate = await userHasManage(user, "system.manage");

    // An unknown scope in the URL is a stale link, not a 404. Polaris's own traffic is
    // the natural landing place for an operator and is not offered to anyone else.
    const requested = isAnalyticsScope(scope) ? scope : null;
    let kind: AnalyticsScope = requested ?? (canOperate ? "polaris" : "application");
    if (!canOperate && kind === "polaris") kind = "application";

    // Taken as written. An id belonging to somebody else is refused by the read
    // itself - it resolves the service against the person asking - so nothing here
    // has to hold the page open to find out, and a link to someone else's numbers
    // still cannot become a link to your own.
    const siteId = (id ?? "").trim().slice(0, 64);

    const parsedRange = visitRangeSchema.safeParse(range);
    const activeRange: VisitRange = parsedRange.success ? parsedRange.data : "24h";

    return (
        <AnalyticsView
            key={`${kind}:${siteId}`}
            scope={kind}
            siteId={siteId}
            range={activeRange}
            canOperate={canOperate}
        />
    );
}
