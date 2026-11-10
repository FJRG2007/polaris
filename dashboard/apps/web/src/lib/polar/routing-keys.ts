/**
 * The keys a routing screen offers for a fallback, and the check that a saved
 * routing names only those. A key is named by its id; the screen shows its
 * name, and the deployment's keys as the deployment's.
 *
 * Client-safe.
 */

import {
    CLAUDE_TIERS,
    polarRoutingSchema,
    type PolarRouting,
    type RouteTarget
} from "@/lib/polar/routing";

/** One key a route may pin. */
export interface RouteKeyOption {
    id: string;
    provider: string;
    name: string;
    /** The person's own key, or one the deployment shares with them. */
    source: "own" | "instance";
}

/** Every target a routing names, fallbacks first. Pure. */
export function routeTargets(routing: PolarRouting): RouteTarget[] {
    const tiers = CLAUDE_TIERS.map((tier) => routing.tiers[tier]).filter(
        (target): target is RouteTarget => target !== null
    );
    return [...routing.fallbacks, ...(routing.defaultModel ? [routing.defaultModel] : []), ...tiers];
}

/**
 * Whether a routing pins a key it may not: one this owner cannot spend, or one
 * issued by another provider than the model's. A key the saved routing already
 * pinned and that is gone since is let through as it was - the router steps
 * over it, and the screen says "(unavailable)" - so `kept` lists the ids the
 * saved routing held. Pure.
 */
export function pinsForeignKey(
    routing: PolarRouting,
    keys: readonly RouteKeyOption[],
    kept: ReadonlySet<string> = new Set()
): boolean {
    const byId = new Map(keys.map((key) => [key.id, key]));
    return routeTargets(routing).some((target) => {
        if (target.keyId === null) return false;
        const key = byId.get(target.keyId);
        if (!key) return !kept.has(target.keyId);
        return key.provider !== target.provider;
    });
}

/** The key ids a routing pins. Pure. */
export function pinnedKeyIds(routing: PolarRouting | null): Set<string> {
    if (!routing) return new Set();
    return new Set(
        routeTargets(routing)
            .map((target) => target.keyId)
            .filter((id): id is string => id !== null)
    );
}

/** Why a routing was not saved, as the screen words it. */
export type RoutingRefusal = "duplicate" | "tooMany" | "key" | "invalid";

/**
 * A routing as a screen sent it, read whole and held to the keys this owner may
 * pin. The one check both routing screens run before they save. Pure.
 */
export function checkRouting(
    input: unknown,
    keys: readonly RouteKeyOption[],
    kept: ReadonlySet<string>
): { ok: true; routing: PolarRouting } | { ok: false; refusal: RoutingRefusal } {
    const parsed = polarRoutingSchema.safeParse(input);
    if (!parsed.success) {
        const issues = parsed.error.issues;
        if (issues.some((issue) => issue.path[0] === "fallbacks" && issue.code === "too_big")) {
            return { ok: false, refusal: "tooMany" };
        }
        if (issues.some((issue) => issue.message === "duplicate")) {
            return { ok: false, refusal: "duplicate" };
        }
        return { ok: false, refusal: "invalid" };
    }
    if (pinsForeignKey(parsed.data, keys, kept)) return { ok: false, refusal: "key" };
    return { ok: true, routing: parsed.data };
}
