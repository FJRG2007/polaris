/**
 * What can be measured, and how a site is addressed in a URL.
 *
 * Neutral on purpose - no "use client" - because both the server page and the client
 * picker need it, and a value exported from a client module cannot be called on the
 * server.
 */

export const ANALYTICS_SCOPES = [
    // i18n-ignore drawn as analytics.scopes.<value> in the reader's words
    { value: "application", label: "Service" },
    // i18n-ignore drawn as analytics.scopes.<value> in the reader's words
    { value: "external", label: "Website" },
    { value: "polaris", label: "Polaris" } // i18n-ignore the product's name
] as const;

export type AnalyticsScope = (typeof ANALYTICS_SCOPES)[number]["value"];

export interface SiteOption {
    id: string;
    label: string;
    /** Which kind of site this is; a service unless said otherwise. */
    scope?: "application" | "external";
}

/** Whether a scope names something, or is the one instance-wide thing there is. */
export function scopeNeedsTarget(scope: AnalyticsScope): boolean {
    return scope !== "polaris";
}

export function isAnalyticsScope(value: string | undefined): value is AnalyticsScope {
    return value === "application" || value === "polaris" || value === "external";
}
