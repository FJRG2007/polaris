"use server";

/**
 * Analytics server actions.
 *
 * Reading a site's numbers needs the same permission as seeing the service itself,
 * so ownership is re-checked here rather than trusted from the page - a scope id in
 * a URL is a request, not a right.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { listProjectScopes, visibleApplication } from "@/lib/deploy-service";
import type { SiteOption } from "./site-catalog";
import { requirePermission, userHasManage } from "@/lib/session";
import { analyticsSettingsSchema, visitRangeSchema, type VisitRange } from "@polaris/core";
import {
    getAnalyticsSettings,
    readAnalytics,
    recentVisits,
    rotateTrackerKey,
    setAnalyticsSettings,
    setTrackerEnabled,
    ensureAnalyticsSite,
    type AnalyticsScopeType,
    type AnalyticsSiteView
} from "@/lib/analytics-service";

const ANALYTICS_PATH = "/apps/analytics";

const scopeSchema = z.object({
    scopeType: z.enum(["application", "polaris"]),
    scopeId: z.string().max(64)
});

/**
 * The site behind a scope, or null when the caller may not see it.
 *
 * Polaris's own traffic is an operator's business: it includes who is reaching the
 * dashboard, which is not a project member's to read.
 */
async function resolveSite(
    userId: string,
    isOperator: boolean,
    scopeType: AnalyticsScopeType,
    scopeId: string
): Promise<AnalyticsSiteView | null> {
    if (scopeType === "polaris") {
        if (!isOperator) return null;
        const { dashboardHosts } = await import("@/lib/domain-edge");
        const hosts = await dashboardHosts().catch(() => [] as string[]);
        return ensureAnalyticsSite("polaris", "", "Polaris", hosts.map((host) => host.toLowerCase()));
    }
    const application = await visibleApplication(scopeId, userId);
    if (!application) return null;
    const domains = await prisma.domain.findMany({
        where: { applicationId: application.id, enabled: true },
        select: { hostname: true }
    });
    return ensureAnalyticsSite(
        "application",
        application.id,
        application.name,
        domains.map((domain) => domain.hostname.toLowerCase())
    );
}

export interface AnalyticsOverview {
    readonly site: AnalyticsSiteView;
    readonly range: VisitRange;
    readonly view: Awaited<ReturnType<typeof readAnalytics>>;
    readonly recent: Awaited<ReturnType<typeof recentVisits>>;
    readonly settings: Awaited<ReturnType<typeof getAnalyticsSettings>>;
    readonly canOperate: boolean;
}

/** Everything one screen shows, in one round trip. */
/**
 * Everything this account can look at, for the picker in the header.
 *
 * Asked for after the screen is drawn rather than resolved before it. It walks
 * every project, environment and service somebody can reach, which on a busy
 * instance is the slowest thing on the page - and it was being awaited before the
 * first paint, so the whole of Analytics waited on a list that only fills one
 * dropdown.
 */
export async function listAnalyticsSitesAction(): Promise<{ sites: SiteOption[] }> {
    const user = await requirePermission("deploy.manage");
    const projects = await listProjectScopes(user.id);
    const sites: SiteOption[] = [];
    for (const project of projects) {
        for (const environment of project.environments) {
            for (const application of environment.applications) {
                sites.push({
                    id: application.id,
                    label: `${project.name} / ${environment.name} / ${application.name}`
                });
            }
        }
    }
    return { sites };
}

export async function getAnalyticsOverviewAction(input: {
    scopeType: string;
    scopeId: string;
    range: string;
}): Promise<AnalyticsOverview | { error: string }> {
    const user = await requirePermission("deploy.manage");
    const canOperate = await userHasManage(user, "system.manage");
    const scope = scopeSchema.safeParse({ scopeType: input.scopeType, scopeId: input.scopeId });
    if (!scope.success) return { error: "That is not something Polaris measures." };
    const range = visitRangeSchema.safeParse(input.range);
    if (!range.success) return { error: "Unknown time range." };

    const site = await resolveSite(user.id, canOperate, scope.data.scopeType, scope.data.scopeId);
    if (!site) return { error: "That is not yours to look at." };

    const [view, recent, settings] = await Promise.all([
        readAnalytics(site, range.data),
        recentVisits(site.id),
        getAnalyticsSettings()
    ]);
    return { site, range: range.data, view, recent, settings, canOperate };
}

export async function setTrackerEnabledAction(input: {
    scopeType: string;
    scopeId: string;
    enabled: boolean;
}): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    const canOperate = await userHasManage(user, "system.manage");
    const scope = scopeSchema.safeParse(input);
    if (!scope.success) return { error: "That is not something Polaris measures." };
    const site = await resolveSite(user.id, canOperate, scope.data.scopeType, scope.data.scopeId);
    if (!site) return { error: "That is not yours to change." };

    await setTrackerEnabled(site.id, input.enabled);
    await recordAudit({
        actorId: user.id,
        action: input.enabled ? "analytics.tracker.enable" : "analytics.tracker.disable",
        targetType: "analytics",
        targetId: site.id
    });
    revalidatePath(ANALYTICS_PATH);
    return {};
}

export async function rotateTrackerKeyAction(input: {
    scopeType: string;
    scopeId: string;
}): Promise<{ error?: string; publicKey?: string }> {
    const user = await requirePermission("deploy.manage");
    const canOperate = await userHasManage(user, "system.manage");
    const scope = scopeSchema.safeParse(input);
    if (!scope.success) return { error: "That is not something Polaris measures." };
    const site = await resolveSite(user.id, canOperate, scope.data.scopeType, scope.data.scopeId);
    if (!site) return { error: "That is not yours to change." };

    const publicKey = await rotateTrackerKey(site.id);
    await recordAudit({
        actorId: user.id,
        action: "analytics.tracker.rotate",
        targetType: "analytics",
        targetId: site.id
    });
    revalidatePath(ANALYTICS_PATH);
    return { publicKey };
}

/** Ingest and retention are instance-wide, so only an operator may change them. */
export async function setAnalyticsSettingsAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = analyticsSettingsSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Those settings are not valid." };
    await setAnalyticsSettings(parsed.data);
    await recordAudit({ actorId: user.id, action: "analytics.settings", targetType: "analytics", targetId: "global" });
    revalidatePath(ANALYTICS_PATH);
    return {};
}
