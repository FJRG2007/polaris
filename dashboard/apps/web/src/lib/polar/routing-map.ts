/**
 * What the coding-tools table shows: for each kind of model a tool can ask
 * for, the model Polar answers with and the effort it runs at, worked out the
 * way `routeFor` (`compat/route-model.ts`) routes a real call - a tier's own
 * override, else the default model, else Automatic. Pure, so the table and the
 * router cannot drift apart unnoticed.
 */

import type { ClaudeTier, PolarRouting, RouteReasoning, RouteTarget } from "@/lib/polar/routing";

/** The tiers in the order a person reads them (free-claude-code's manifest). */
export const TIER_ORDER: readonly ClaudeTier[] = ["fable", "opus", "sonnet", "haiku"];

export type ToolAsk = "default" | ClaudeTier;

export interface ToolMapping {
    asked: ToolAsk;
    /** What this row sets itself; null follows the default model. */
    own: RouteTarget | null;
    /** The model a call lands on; null is Automatic. */
    target: RouteTarget | null;
    /** Where `target` comes from. */
    via: "own" | "default" | "automatic";
    /** The effort the call runs at once Inherit is resolved. */
    effort: Exclude<RouteReasoning, "inherit">;
}

export function effectiveEffort(
    reasoning: RouteReasoning | undefined,
    routing: Pick<PolarRouting, "defaultReasoning">
): Exclude<RouteReasoning, "inherit"> {
    return !reasoning || reasoning === "inherit" ? routing.defaultReasoning : reasoning;
}

/** The default model's row first, then one per tier. */
export function toolMappings(routing: PolarRouting): ToolMapping[] {
    const fallback = routing.defaultModel;
    const viaDefault = fallback ? ("default" as const) : ("automatic" as const);
    const first: ToolMapping = {
        asked: "default",
        own: fallback,
        target: fallback,
        via: fallback ? "own" : "automatic",
        effort: effectiveEffort(fallback?.reasoning, routing)
    };
    return [
        first,
        ...TIER_ORDER.map((tier): ToolMapping => {
            const own = routing.tiers[tier];
            const target = own ?? fallback;
            return {
                asked: tier,
                own,
                target,
                via: own ? "own" : viaDefault,
                effort: effectiveEffort(target?.reasoning, routing)
            };
        })
    ];
}
