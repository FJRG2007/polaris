/**
 * Which Polar model a compatible-API request lands on, and how hard it
 * thinks. Follows free-claude-code's `application/routing.py`:
 *
 * 1. A model id that names a `provider/model` this person can use is that
 *    model. free-claude-code's gateway ids (`anthropic/<provider>/<model>`,
 *    and `claude-3-freecc-no-thinking/<provider>/<model>`, which Claude Code
 *    reads as a model that does not think) are accepted too.
 * 2. Otherwise the Claude tier the id names (`tierOf`: fable, opus, haiku,
 *    sonnet, by substring) lands on that tier's override, then on the default
 *    model, then on Automatic.
 *
 * The reasoning preference is the route's own (`inherit` meaning the
 * routing's `defaultReasoning`), and `client` is what the request asked for.
 * A direct `provider/model` runs at `defaultReasoning`, as free-claude-code's
 * direct ids run at its global policy.
 *
 * Pure: the routing and the options are read by the caller.
 */

import type { ModelChoice, Intelligence } from "@/lib/polar/shared";
import { automaticChoice } from "@/lib/polar/shared";
import {
    reasoningForRoute,
    tierOf,
    type PolarRouting,
    type RouteReasoning,
    type RouteTarget,
    type SdkReasoning
} from "@/lib/polar/routing";

/** The gateway-id prefixes free-claude-code advertises (`core/gateway_model_ids.py`). */
export const GATEWAY_PREFIX = "anthropic/";
export const NO_THINKING_PREFIX = "claude-3-freecc-no-thinking/";

/** The tier ids free-claude-code lists first in `/v1/models`
 *  (`api/model_catalog.py`, `SUPPORTED_CLAUDE_MODELS`). */
export const TIER_MODEL_IDS = [
    { id: "claude-fable-5-2", name: "Claude Fable 5.2" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" }
] as const;

/** What the routing needs to know of the options: which models exist. */
export interface RoutableProvider {
    provider: string;
    models: readonly { model: string }[];
}

export interface CompatRoute {
    choice: ModelChoice;
    /** The preference the route resolves the effort with. Never `inherit`. */
    preference: Exclude<RouteReasoning, "inherit">;
    /** The one stored key a tier or the default model pinned; null walks
     *  every key held for the provider. */
    keyId: string | null;
    /** The id asked for a model that does not think. */
    forceOff: boolean;
    /** How the route was found, for the logs and the tests. */
    via: "direct" | "tier" | "default" | "automatic";
}

function serves(options: readonly RoutableProvider[], provider: string, model: string): boolean {
    return options.some(
        (entry) => entry.provider === provider && entry.models.some((option) => option.model === model)
    );
}

/** The `provider/model` an id names, when this person can use it. */
function direct(
    id: string,
    options: readonly RoutableProvider[]
): { provider: string; model: string } | null {
    const slash = id.indexOf("/");
    if (slash <= 0 || slash === id.length - 1) return null;
    const provider = id.slice(0, slash);
    const model = id.slice(slash + 1);
    return serves(options, provider, model) ? { provider, model } : null;
}

const choiceOf = (target: { provider: string; model: string }): ModelChoice => ({
    kind: "language",
    provider: target.provider,
    model: target.model,
    intelligence: "balanced",
    payer: null
});

/** The route an id lands on, or "unknown_model" for a `provider/model` id
 *  that names nothing this person can use and no tier. */
export function routeFor(
    requested: string,
    routing: PolarRouting,
    options: readonly RoutableProvider[]
): CompatRoute | "unknown_model" {
    const id = requested.trim();
    const forceOff = id.startsWith(NO_THINKING_PREFIX);
    const bare = forceOff ? id.slice(NO_THINKING_PREFIX.length) : id;
    const named =
        direct(bare, options) ??
        (bare.startsWith(GATEWAY_PREFIX) ? direct(bare.slice(GATEWAY_PREFIX.length), options) : null);
    if (named) {
        return {
            choice: choiceOf(named),
            preference: routing.defaultReasoning,
            keyId: null,
            forceOff,
            via: "direct"
        };
    }
    const tier = tierOf(bare);
    const preferenceOf = (target: RouteTarget) =>
        target.reasoning === "inherit" ? routing.defaultReasoning : target.reasoning;
    const override = tier ? routing.tiers[tier] : null;
    if (override) {
        return {
            choice: choiceOf(override),
            preference: preferenceOf(override),
            keyId: override.keyId,
            forceOff,
            via: "tier"
        };
    }
    // An id that spells out a provider and a model nobody serves is a mistake
    // the caller should hear about, not a reason to answer with another model.
    if (!tier && bare.includes("/")) return "unknown_model";
    if (routing.defaultModel) {
        return {
            choice: choiceOf(routing.defaultModel),
            preference: preferenceOf(routing.defaultModel),
            keyId: routing.defaultModel.keyId,
            forceOff,
            via: "default"
        };
    }
    return {
        choice: automaticChoice(),
        preference: routing.defaultReasoning,
        keyId: null,
        forceOff,
        via: "automatic"
    };
}

/** The effort a call runs at: the route's preference over what the client
 *  asked, or none for a no-thinking id. */
export function routeReasoning(route: CompatRoute, client: SdkReasoning | undefined): SdkReasoning | undefined {
    if (route.forceOff) return "none";
    return reasoningForRoute(route.preference, client, client);
}

/** The intelligence Automatic picks a model for, from the effort. */
export function intelligenceFor(reasoning: SdkReasoning | undefined): Intelligence {
    switch (reasoning) {
        case "none":
        case "low":
            return "fast";
        case "high":
            return "deep";
        case "xhigh":
        case "max":
            return "max";
        default:
            return "balanced";
    }
}

/** The choice to resolve, with the intelligence the effort implies. */
export function choiceFor(route: CompatRoute, reasoning: SdkReasoning | undefined): ModelChoice {
    return { ...route.choice, intelligence: intelligenceFor(reasoning) };
}
