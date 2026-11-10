"use server";

/**
 * Analytics server actions.
 *
 * Every one resolves the site against the person asking (`siteAccess`) and checks
 * the level it needs before doing anything - a scope id in a URL is a request,
 * not a right. Reading takes `view`, changing the site takes `edit`.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { listProjectScopes } from "@/lib/deploy-service";
import type { SiteOption } from "./site-catalog";
import { requirePermission, userHasManage } from "@/lib/session";
import { grantedSubjects } from "@/lib/access/grants";
import { requireAnalyticsReader } from "./reader";
import { allows, siteAccess, type SiteAccess, type SiteLevel } from "./site-access";
import * as core from "@polaris/core";
import {
    getAnalyticsSettings,
    readAnalytics,
    recentVisits,
    rotateTrackerKey,
    setAnalyticsSettings,
    setSiteRules,
    setTrackerEnabled,
    type AnalyticsSiteView
} from "@/lib/analytics-service";
import * as reports from "@/lib/analytics-reports";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";

/** A reply in the reader's language. */
async function say(key: NamespaceKey<"analytics">): Promise<string> {
    return (await getTranslations("analytics"))(key);
}

const ANALYTICS_PATH = "/analytics";

const scopeSchema = z.object({
    scopeType: z.enum(["application", "polaris"]),
    scopeId: z.string().max(64)
});

/** The caller's access to a scope, when it reaches `needed`; null otherwise. */
async function reach(
    input: unknown,
    needed: SiteLevel
): Promise<{ access: SiteAccess; userId: string; isOperator: boolean } | { error: string }> {
    const { user } = await requireAnalyticsReader();
    const scope = scopeSchema.safeParse(input);
    if (!scope.success) return { error: await say("errors.notMeasured") };
    const isOperator = await userHasManage(user, "system.manage");
    const access = await siteAccess(user.id, isOperator, scope.data.scopeType, scope.data.scopeId);
    if (!access) return { error: await say("errors.notYoursToSee") };
    if (!allows(access.level, needed)) return { error: await say("errors.notYoursToChange") };
    return { access, userId: user.id, isOperator };
}

export interface AnalyticsOverview {
    readonly site: AnalyticsSiteView;
    readonly range: core.VisitRange;
    readonly filters: readonly core.VisitFilter[];
    readonly view: Awaited<ReturnType<typeof readAnalytics>>;
    /** The same totals over the window before, or null where it cannot be told. */
    readonly previous: reports.PeriodTotals | null;
    readonly recent: Awaited<ReturnType<typeof recentVisits>>;
    readonly settings: Awaited<ReturnType<typeof getAnalyticsSettings>>;
    readonly reports: readonly reports.SavedReport[];
    readonly canOperate: boolean;
    /** What this reader may do with the site. */
    readonly level: SiteLevel;
    /** Whether this reader may share the site: they configure the service. */
    readonly canShare: boolean;
    /** The site was shared with this reader. */
    readonly shared: boolean;
}

/**
 * Everything this account can look at, for the picker in the header: the
 * services it reaches through their projects, and the ones handed to it.
 *
 * Asked for after the screen is drawn rather than resolved before it. It walks
 * every project, environment and service somebody can reach, which on a busy
 * instance is the slowest thing on the page.
 */
export async function listAnalyticsSitesAction(): Promise<{ sites: SiteOption[] }> {
    const { user, lent } = await requireAnalyticsReader();
    const held = lent ?? new Set((await grantedSubjects(user.id, "analytics.site")).keys());
    const sites: SiteOption[] = [];
    const seen = new Set<string>();
    if (!lent) {
        const projects = await listProjectScopes(user.id);
        for (const project of projects) {
            for (const environment of project.environments) {
                for (const application of environment.applications) {
                    seen.add(application.id);
                    sites.push({
                        id: application.id,
                        label: `${project.name} / ${environment.name} / ${application.name}`
                    });
                }
            }
        }
    }
    const extra = [...held].filter((id) => !seen.has(id)).slice(0, 500);
    if (extra.length) {
        const rows = await prisma.application.findMany({
            where: { id: { in: extra } },
            orderBy: { name: "asc" },
            select: { id: true, name: true }
        });
        for (const row of rows) sites.push({ id: row.id, label: row.name });
    }
    return { sites };
}

export async function getAnalyticsOverviewAction(input: {
    scopeType: string;
    scopeId: string;
    range: string;
    filters?: string;
}): Promise<AnalyticsOverview | { error: string }> {
    const reached = await reach(input, "view");
    if ("error" in reached) return reached;
    const range = core.visitRangeSchema.safeParse(input.range);
    if (!range.success) return { error: await say("errors.range") };
    const filters = core.parseVisitFilters(input.filters);
    const { access, isOperator: canOperate } = reached;

    const now = Date.now();
    const [view, recent, settings, saved] = await Promise.all([
        readAnalytics(access.site, range.data, now, filters),
        recentVisits(access.site.id, 25, { filters }),
        getAnalyticsSettings(),
        reports.listReports(access.site.id)
    ]);
    const previous = await reports.previousPeriod(
        { siteId: access.site.id, from: view.from, to: view.to, filters },
        view.source
    );
    return {
        site: access.site,
        range: range.data,
        filters,
        view,
        previous,
        recent,
        settings,
        reports: saved,
        canOperate,
        level: access.level,
        canShare: access.level === "own" && access.site.scopeType === "application",
        shared: access.shared
    };
}

// --- reports -------------------------------------------------------------------

const reportRequestSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("events") }),
    z.object({ kind: z.literal("properties"), name: z.string().trim().min(1).max(120) }),
    z.object({ kind: z.literal("revenue") }),
    z.object({ kind: z.literal("funnel"), definition: core.funnelDefinitionSchema }),
    z.object({ kind: z.literal("journey"), definition: core.journeyDefinitionSchema }),
    z.object({ kind: z.literal("goals") }),
    z.object({ kind: z.literal("retention") }),
    z.object({ kind: z.literal("sessions"), before: z.string().datetime().optional() }),
    z.object({ kind: z.literal("session"), id: z.string().trim().min(8).max(128) })
]);
export type AnalyticsReportRequest = z.infer<typeof reportRequestSchema>;

export type AnalyticsReportAnswer =
    | { kind: "events"; rows: reports.EventNameRow[] }
    | { kind: "properties"; name: string; rows: reports.EventPropertyRow[] }
    | { kind: "revenue"; report: reports.RevenueReport }
    | { kind: "funnel"; steps: reports.FunnelStep[] }
    | { kind: "journey"; rows: reports.JourneyRow[] }
    | { kind: "goals"; total: number; results: (reports.GoalResult & { name: string; goal: core.GoalDefinition })[] }
    | { kind: "retention"; cells: reports.RetentionCell[] }
    | { kind: "sessions"; rows: Awaited<ReturnType<typeof recentVisits>>; more: boolean }
    | { kind: "session"; session: NonNullable<Awaited<ReturnType<typeof reports.sessionJourney>>> | null };

const SESSIONS_PAGE = 50;

/** Anything past the overview, asked for when its tab is opened. */
export async function runAnalyticsReportAction(input: {
    scopeType: string;
    scopeId: string;
    range: string;
    filters?: string;
    request: string;
}): Promise<AnalyticsReportAnswer | { error: string }> {
    const reached = await reach(input, "view");
    if ("error" in reached) return reached;
    const range = core.visitRangeSchema.safeParse(input.range);
    if (!range.success) return { error: await say("errors.range") };
    let raw: unknown;
    try {
        raw = JSON.parse(input.request);
    } catch {
        return { error: await say("errors.report") };
    }
    const request = reportRequestSchema.safeParse(raw);
    if (!request.success) return { error: await say("errors.report") };

    const siteId = reached.access.site.id;
    const to = Date.now();
    const window: reports.ReportWindow = {
        siteId,
        from: to - core.VISIT_RANGE_SPEC[range.data].ms,
        to,
        filters: core.parseVisitFilters(input.filters)
    };
    const ask = request.data;
    switch (ask.kind) {
        case "events":
            return { kind: "events", rows: await reports.eventNames(window) };
        case "properties":
            return { kind: "properties", name: ask.name, rows: await reports.eventProperties(window, ask.name) };
        case "revenue":
            return { kind: "revenue", report: await reports.revenue(window) };
        case "funnel":
            return { kind: "funnel", steps: await reports.funnel(window, ask.definition) };
        case "journey":
            return { kind: "journey", rows: await reports.journeys(window, ask.definition) };
        case "goals": {
            const saved = (await reports.listReports(siteId)).filter((report) => report.kind === "goal");
            const list = saved.map((report) => ({ id: report.id, goal: report.definition as core.GoalDefinition }));
            const answer = await reports.goals(window, list);
            return {
                kind: "goals",
                total: answer.total,
                results: answer.results.map((result, index) => ({
                    ...result,
                    name: saved[index]!.name,
                    goal: list[index]!.goal
                }))
            };
        }
        case "retention":
            return { kind: "retention", cells: await reports.retention(window) };
        case "sessions": {
            const rows = await recentVisits(siteId, SESSIONS_PAGE + 1, {
                filters: window.filters,
                before: ask.before ? new Date(ask.before) : null
            });
            return { kind: "sessions", rows: rows.slice(0, SESSIONS_PAGE), more: rows.length > SESSIONS_PAGE };
        }
        case "session":
            return { kind: "session", session: await reports.sessionJourney(siteId, ask.id) };
    }
}

export async function saveAnalyticsReportAction(input: {
    scopeType: string;
    scopeId: string;
    id?: string;
    report: unknown;
}): Promise<{ error?: string; id?: string }> {
    const reached = await reach(input, "edit");
    if ("error" in reached) return reached;
    const report = core.analyticsReportSchema.safeParse(input.report);
    if (!report.success) return { error: await say("errors.report") };
    const id = input.id && /^[0-9a-f-]{36}$/i.test(input.id) ? input.id : undefined;
    const saved = await reports.saveReport(reached.access.site.id, reached.userId, report.data, id);
    if (!saved) return { error: await say(id ? "errors.report" : "errors.tooMany") };
    await recordAudit({
        actorId: reached.userId,
        action: id ? "analytics.report.update" : "analytics.report.create",
        targetType: "analytics",
        targetId: reached.access.site.id
    });
    return { id: saved };
}

export async function deleteAnalyticsReportAction(input: {
    scopeType: string;
    scopeId: string;
    id: string;
}): Promise<{ error?: string }> {
    const reached = await reach(input, "edit");
    if ("error" in reached) return reached;
    if (!/^[0-9a-f-]{36}$/i.test(input.id ?? "")) return { error: await say("errors.report") };
    await reports.deleteReport(reached.access.site.id, input.id);
    await recordAudit({
        actorId: reached.userId,
        action: "analytics.report.delete",
        targetType: "analytics",
        targetId: reached.access.site.id
    });
    return {};
}

// --- the site itself -------------------------------------------------------------

export async function setTrackerEnabledAction(input: {
    scopeType: string;
    scopeId: string;
    enabled: boolean;
}): Promise<{ error?: string }> {
    const reached = await reach(input, "edit");
    if ("error" in reached) return reached;
    const { access, userId } = reached;
    await setTrackerEnabled(access.site.id, input.enabled === true);
    await recordAudit({
        actorId: userId,
        action: input.enabled ? "analytics.tracker.enable" : "analytics.tracker.disable",
        targetType: "analytics",
        targetId: access.site.id
    });
    revalidatePath(ANALYTICS_PATH);
    return {};
}

export async function rotateTrackerKeyAction(input: {
    scopeType: string;
    scopeId: string;
}): Promise<{ error?: string; publicKey?: string }> {
    const reached = await reach(input, "edit");
    if ("error" in reached) return reached;
    const { access, userId } = reached;
    const publicKey = await rotateTrackerKey(access.site.id);
    await recordAudit({
        actorId: userId,
        action: "analytics.tracker.rotate",
        targetType: "analytics",
        targetId: access.site.id
    });
    revalidatePath(ANALYTICS_PATH);
    return { publicKey };
}

/** What a site never records: pages and addresses. */
export async function setSiteRulesAction(input: {
    scopeType: string;
    scopeId: string;
    rules: unknown;
}): Promise<{ error?: string }> {
    const reached = await reach(input, "edit");
    if ("error" in reached) return reached;
    const rules = core.analyticsSiteSettingsSchema.safeParse(input.rules);
    if (!rules.success) return { error: await say("errors.rules") };
    await setSiteRules(reached.access.site.id, rules.data);
    await recordAudit({
        actorId: reached.userId,
        action: "analytics.site.rules",
        targetType: "analytics",
        targetId: reached.access.site.id
    });
    return {};
}

/** Wipe a site's recorded history. Its key, settings and reports stay. */
export async function resetSiteDataAction(input: { scopeType: string; scopeId: string }): Promise<{ error?: string }> {
    const reached = await reach(input, "edit");
    if ("error" in reached) return reached;
    await reports.resetSiteData(reached.access.site.id);
    await recordAudit({
        actorId: reached.userId,
        action: "analytics.site.reset",
        targetType: "analytics",
        targetId: reached.access.site.id
    });
    revalidatePath(ANALYTICS_PATH);
    return {};
}

/** Ingest and retention are instance-wide, so only an operator may change them. */
export async function setAnalyticsSettingsAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("system.manage");
    const parsed = core.analyticsSettingsSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.settings") };
    await setAnalyticsSettings(parsed.data);
    await recordAudit({
        actorId: user.id,
        action: "analytics.settings",
        targetType: "analytics",
        targetId: "global"
    });
    revalidatePath(ANALYTICS_PATH);
    return {};
}
