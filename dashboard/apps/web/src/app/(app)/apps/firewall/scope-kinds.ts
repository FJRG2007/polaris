/**
 * What a firewall rule can be attached to, shared by the page that resolves the
 * scope and the picker that changes it.
 *
 * Deliberately its own module with no "use client": the page is a server component
 * and needs `scopeNeedsTarget` to decide what to render, and a function exported from
 * a client module cannot be called on the server - only rendered as a component or
 * passed as a prop.
 */

import type { WafScopeType } from "@polaris/core";

/** One selectable target within a kind. */
export interface ScopeOption {
    readonly id: string;
    readonly label: string;
}

/** Everything the picker can offer, resolved on the server. */
export interface ScopeCatalog {
    readonly projects: readonly ScopeOption[];
    readonly environments: readonly ScopeOption[];
    readonly services: readonly ScopeOption[];
    readonly servers: readonly ScopeOption[];
    readonly serverGroups: readonly ScopeOption[];
}

/** The kinds, in the order they narrow: the whole instance, then a machine, then a
 *  project, then one service on it. */
export const SCOPE_KINDS: readonly { readonly value: WafScopeType; readonly label: string }[] = [
    { value: "polaris", label: "Polaris itself" },
    { value: "global", label: "All services" },
    { value: "server-group", label: "Server group" },
    { value: "server", label: "Server" },
    { value: "project", label: "Project" },
    { value: "environment", label: "Environment" },
    { value: "application", label: "Service" }
];

/** Scopes that name one thing; the other two are the instance and need no target. */
const NEEDS_TARGET = new Set<WafScopeType>(["server-group", "server", "project", "environment", "application"]);

/** Whether a kind names a target, so both sides agree on when an id is required. */
export function scopeNeedsTarget(kind: WafScopeType): boolean {
    return NEEDS_TARGET.has(kind);
}

/** The targets on offer for a kind. */
export function scopeOptions(kind: WafScopeType, catalog: ScopeCatalog): readonly ScopeOption[] {
    switch (kind) {
        case "project":
            return catalog.projects;
        case "environment":
            return catalog.environments;
        case "application":
            return catalog.services;
        case "server":
            return catalog.servers;
        case "server-group":
            return catalog.serverGroups;
        default:
            return [];
    }
}
