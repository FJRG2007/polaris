/**
 * What one reader may do with one site, decided in one place for every action
 * and route in Analytics - kept out of the action module so it is not itself an
 * action a browser could call.
 *
 * Three levels, each including the one below:
 * - `view`: the numbers, the visits and the saved reports. Anybody who can see
 *   the service, or who was handed its site to view.
 * - `edit`: also the tracker, its key, the reports, what the site ignores and
 *   wiping its history. Whoever configures the service, or was handed the site
 *   to edit.
 * - `own`: also handing the site to somebody else. Whoever configures the
 *   service - a grant is never passed on by the person it was given to.
 *
 * Polaris's own traffic is an operator's alone: it includes who is reaching the
 * dashboard, which is not a project member's to read.
 *
 * A site somebody runs elsewhere (`external`) is owned by whoever added it, and
 * by an operator; anybody else reaches it only when it was shared with them.
 */

import { prisma } from "@polaris/db";
import { grantedSubjects } from "@/lib/access/grants";
import { visibleApplication } from "@/lib/deploy-service";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import {
    ensureAnalyticsSite,
    externalSiteOwner,
    findExternalSite,
    type AnalyticsScopeType,
    type AnalyticsSiteView
} from "@/lib/analytics-service";

export type SiteLevel = "view" | "edit" | "own";

export interface SiteAccess {
    readonly site: AnalyticsSiteView;
    readonly level: SiteLevel;
    /** The site was shared with this reader rather than reached through its project. */
    readonly shared: boolean;
}

const RANK: Readonly<Record<SiteLevel, number>> = { view: 0, edit: 1, own: 2 };

/** Whether a level allows what `needed` names. */
export function allows(level: SiteLevel, needed: SiteLevel): boolean {
    return RANK[level] >= RANK[needed];
}

export async function siteAccess(
    userId: string,
    isOperator: boolean,
    scopeType: AnalyticsScopeType,
    scopeId: string
): Promise<SiteAccess | null> {
    if (scopeType === "polaris") {
        if (!isOperator) return null;
        const { dashboardHosts } = await import("@/lib/domain-edge");
        const hosts = await dashboardHosts().catch(() => [] as string[]);
        const site = await ensureAnalyticsSite(
            "polaris",
            "",
            "Polaris",
            hosts.map((host) => host.toLowerCase())
        );
        return { site, level: "own", shared: false };
    }

    if (scopeType === "external") {
        const owner = externalSiteOwner(scopeId);
        if (!owner) return null;
        const mine = owner === userId.toLowerCase() || isOperator;
        const held = mine
            ? null
            : await grantedSubjects(userId, "analytics.site").then((map) => map.get(scopeId) ?? null);
        if (!mine && !held) return null;
        const site = await findExternalSite(scopeId);
        if (!site) return null;
        return { site, level: mine ? "own" : held === "edit" ? "edit" : "view", shared: !mine };
    }

    const [visible, held, configurable] = await Promise.all([
        visibleApplication(scopeId, userId),
        grantedSubjects(userId, "analytics.site").then((map) => map.get(scopeId) ?? null),
        requireApplicationAccess(scopeId, userId, "service.configure").then(
            () => true,
            () => false
        )
    ]);
    if (!visible && !held && !configurable) return null;

    const application =
        visible ??
        (await prisma.application.findUnique({ where: { id: scopeId }, select: { id: true, name: true } }));
    if (!application) return null;
    const domains = await prisma.domain.findMany({
        where: { applicationId: application.id, enabled: true },
        select: { hostname: true }
    });
    const site = await ensureAnalyticsSite(
        "application",
        application.id,
        application.name,
        domains.map((domain) => domain.hostname.toLowerCase())
    );
    const level: SiteLevel = configurable ? "own" : held === "edit" ? "edit" : "view";
    return { site, level, shared: !visible && !configurable };
}
