/**
 * What can be measured, and how a site is addressed in a URL.
 *
 * Neutral on purpose - no "use client" - because both the server page and the client
 * picker need it, and a value exported from a client module cannot be called on the
 * server.
 */

export const ANALYTICS_SCOPES = [
    { value: "application", label: "Service" },
    { value: "polaris", label: "Polaris" }
] as const;

export type AnalyticsScope = (typeof ANALYTICS_SCOPES)[number]["value"];

export interface SiteOption {
    id: string;
    label: string;
}

/** Whether a scope names something, or is the one instance-wide thing there is. */
export function scopeNeedsTarget(scope: AnalyticsScope): boolean {
    return scope === "application";
}

export function isAnalyticsScope(value: string | undefined): value is AnalyticsScope {
    return value === "application" || value === "polaris";
}
