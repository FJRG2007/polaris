/**
 * The Analytics screen's sections, by the name the address carries.
 *
 * Its own module, not the reports component's: the pages read the section on the
 * server, and a function exported from a client file cannot be called there -
 * Next answers with an error page instead of the screen.
 *
 * Each section is a route of its own under /analytics, so the rail (APP_SECTIONS in
 * `lib/apps.ts`) can link at it. The saved reports share one route and pick their
 * kind with `?tab=`, which is also what the address used to carry for every
 * section - an old `/analytics?tab=sessions` link is redirected to its route.
 *
 * Pure and safe on both sides.
 */

export const ANALYTICS_TABS = [
    "overview",
    "realtime",
    "pages",
    "sources",
    "geography",
    "sessions",
    "events",
    "funnels",
    "journeys",
    "goals",
    "retention",
    "revenue",
    "site"
] as const;

export type AnalyticsTab = (typeof ANALYTICS_TABS)[number];

/** The saved-report kinds, which live together on /analytics/reports. */
export const REPORT_TABS = ["funnels", "journeys", "goals", "retention", "revenue"] as const satisfies readonly AnalyticsTab[];

export type ReportTab = (typeof REPORT_TABS)[number];

/** Whether an address's `tab` names one of the sections. */
export function isAnalyticsTab(value: string | null | undefined): value is AnalyticsTab {
    return (ANALYTICS_TABS as readonly string[]).includes(value ?? "");
}

export function isReportTab(value: string | null | undefined): value is ReportTab {
    return (REPORT_TABS as readonly string[]).includes(value ?? "");
}

const SECTION_PATH: Readonly<Record<Exclude<AnalyticsTab, ReportTab>, string>> = {
    overview: "/analytics",
    realtime: "/analytics/realtime",
    pages: "/analytics/pages",
    sources: "/analytics/sources",
    geography: "/analytics/geography",
    sessions: "/analytics/sessions",
    events: "/analytics/events",
    site: "/analytics/settings"
};

/** The route a section is drawn on, without its query. */
export function analyticsTabPath(tab: AnalyticsTab): string {
    return isReportTab(tab) ? "/analytics/reports" : SECTION_PATH[tab];
}

/**
 * The cookie that remembers which site was last open, `scope:id`.
 *
 * The rail links at bare routes, so moving from Pages to Sessions carries no
 * query - without this every click in the rail would land on the first site
 * again. A preference, not a credential: the site is still resolved against the
 * reader on every read.
 */
export const ANALYTICS_SITE_COOKIE = "polaris-analytics-site";

/** `scope:id` back into its parts; null for anything malformed. */
export function parseSiteCookie(raw: string | null | undefined): { scope: string; id: string } | null {
    const match = /^(application|polaris|external):([A-Za-z0-9:_-]{0,80})$/.exec(raw ?? "");
    return match ? { scope: match[1]!, id: match[2]! } : null;
}
