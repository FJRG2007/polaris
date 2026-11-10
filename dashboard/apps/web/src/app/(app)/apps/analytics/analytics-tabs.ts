/**
 * The Analytics screen's sections, by the name the address carries.
 *
 * Its own module, not the reports component's: the page reads `?tab=` on the
 * server, and a function exported from a client file cannot be called there -
 * Next answers with an error page instead of the screen.
 *
 * Pure and safe on both sides.
 */

export const ANALYTICS_TABS = [
    "overview",
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

/** Whether an address's `tab` names one of the sections. */
export function isAnalyticsTab(value: string | null | undefined): value is AnalyticsTab {
    return (ANALYTICS_TABS as readonly string[]).includes(value ?? "");
}
