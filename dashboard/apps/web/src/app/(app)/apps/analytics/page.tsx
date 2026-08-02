/**
 * Analytics (/apps/analytics).
 *
 * Structured like the firewall and like Deploy, because it answers the same shape of
 * question about the same things: pick what you are looking at in the header, then
 * read down. The choice lives in the URL (`?scope=application&id=...`), so a
 * service's own panel can link straight at its numbers.
 *
 * The shell renders immediately and the numbers arrive into it. Everything on this
 * page is a database read over a window the visitor chose, and holding the whole
 * screen back for it would mean a blank page every time somebody changes the range.
 */

import { notFound } from "next/navigation";
import { AnalyticsView } from "./analytics-view";
import { listProjectScopes } from "@/lib/deploy-service";
import { requirePermission, userHasManage } from "@/lib/session";
import { visitRangeSchema, type VisitRange } from "@polaris/core";
import { isAnalyticsScope, scopeNeedsTarget, type AnalyticsScope, type SiteOption } from "./site-catalog";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({
    searchParams
}: {
    searchParams: Promise<{ scope?: string; id?: string; range?: string }>;
}) {
    const { scope, id, range } = await searchParams;
    const user = await requirePermission("deploy.manage");
    const canOperate = await userHasManage(user, "system.manage");

    const projects = await listProjectScopes(user.id);
    const services: SiteOption[] = [];
    for (const project of projects) {
        for (const environment of project.environments) {
            for (const application of environment.applications) {
                services.push({
                    id: application.id,
                    label: `${project.name} / ${environment.name} / ${application.name}`
                });
            }
        }
    }

    // An unknown scope in the URL is a stale link, not a 404. Polaris's own traffic is
    // the natural landing place for an operator and is not offered to anyone else.
    const requested = isAnalyticsScope(scope) ? scope : null;
    let kind: AnalyticsScope = requested ?? (canOperate ? "polaris" : "application");
    if (!canOperate && kind === "polaris") kind = "application";

    const siteId = scopeNeedsTarget(kind) ? (services.find((option) => option.id === id)?.id ?? services[0]?.id ?? "") : "";
    if (scopeNeedsTarget(kind) && id && !services.some((option) => option.id === id)) {
        // An id that is not this caller's must not quietly resolve to their first
        // service - that turns a link to someone else's numbers into a link to their
        // own, which reads as data appearing where it should not.
        notFound();
    }

    const parsedRange = visitRangeSchema.safeParse(range);
    const activeRange: VisitRange = parsedRange.success ? parsedRange.data : "24h";

    return (
        <AnalyticsView
            key={`${kind}:${siteId}`}
            scope={kind}
            siteId={siteId}
            range={activeRange}
            services={services}
            canOperate={canOperate}
        />
    );
}
