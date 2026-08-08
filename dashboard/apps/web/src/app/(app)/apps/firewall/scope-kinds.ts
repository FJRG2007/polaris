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
    /** The subset of `services` that an installed marketplace app is running, named
     *  as the app rather than as the container underneath it. */
    readonly marketplace: readonly ScopeOption[];
    readonly servers: readonly ScopeOption[];
    readonly serverGroups: readonly ScopeOption[];
}

/**
 * The kinds, in the order they narrow: the whole instance, then a machine, then a
 * project, then one service on it.
 *
 * "Marketplace app" is not a scope of its own - a rule on one is a rule on the
 * service it runs, and it resolves to `application` like any other. It is a way in:
 * somebody who installed Minecraft from the marketplace knows it as Minecraft, not
 * as `Marketplace / Production / minecraft-2`, and making them work that path out
 * to find its rules is the difference between a screen they can use and one they
 * give up on.
 */
export const SCOPE_KINDS: readonly { readonly value: ScopeKind; readonly label: string }[] = [
    { value: "polaris", label: "Polaris itself" },
    { value: "global", label: "All services" },
    { value: "server-group", label: "Server group" },
    { value: "server", label: "Server" },
    { value: "project", label: "Project" },
    { value: "environment", label: "Environment" },
    { value: "marketplace", label: "Marketplace app" },
    { value: "application", label: "Service" }
];

/** What the picker offers, which is the rule scopes plus the marketplace shortcut
 *  into one of them. */
export type ScopeKind = WafScopeType | "marketplace";

/** The scope a kind actually writes rules against. */
export function ruleScopeFor(kind: ScopeKind): WafScopeType {
    return kind === "marketplace" ? "application" : kind;
}

/** Scopes that name one thing; the other two are the instance and need no target. */
const NEEDS_TARGET = new Set<ScopeKind>([
    "server-group",
    "server",
    "project",
    "environment",
    "marketplace",
    "application"
]);

/** Whether a kind names a target, so both sides agree on when an id is required. */
export function scopeNeedsTarget(kind: ScopeKind): boolean {
    return NEEDS_TARGET.has(kind);
}

/** The targets on offer for a kind. */
export function scopeOptions(kind: ScopeKind, catalog: ScopeCatalog): readonly ScopeOption[] {
    switch (kind) {
        case "project":
            return catalog.projects;
        case "environment":
            return catalog.environments;
        case "marketplace":
            return catalog.marketplace;
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
