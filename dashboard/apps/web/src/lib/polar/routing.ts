/**
 * How Polar routes a call when the model asked for cannot answer, and which
 * model a coding tool's request lands on. One schema, read by the settings
 * screen before it saves and by the server before it believes a stored value.
 *
 * The shape follows free-claude-code's model routing
 * (github.com/Alishahryar1/free-claude-code, `config/model_refs.py`,
 * `application/routing.py`): an ordered fallback list whose entries each name a
 * model, a reasoning effort and a key, plus a default model and one override
 * per Claude tier for requests that arrive through the compatible API. Polaris
 * names a key by its id rather than by a position, because a person reorders
 * their keys and a position would silently point at another one.
 *
 * Client-safe: nothing here reaches the database or a provider.
 */

import { z } from "zod";

/**
 * How hard a routed model thinks. `inherit` keeps what the call already asked
 * for (the composer's intelligence, or the tier's effort); `client` is what the
 * calling tool sent; `off` asks for no reasoning; the rest force a level.
 */
export const ROUTE_REASONING = [
    "inherit",
    "client",
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
] as const;
export type RouteReasoning = (typeof ROUTE_REASONING)[number];

/** The Claude tiers a coding tool names in its model id, matched in this
 *  order (free-claude-code `routing.py`: fable, opus, haiku, sonnet). */
export const CLAUDE_TIERS = ["fable", "opus", "haiku", "sonnet"] as const;
export type ClaudeTier = (typeof CLAUDE_TIERS)[number];

/** Most entries one fallback list holds: each is a call a failing turn may make. */
export const FALLBACKS_MOST = 12;

const provider = z.string().trim().min(1).max(64);
const model = z.string().trim().min(1).max(200);

/** One model a route may land on. `keyId` pins one stored key; null lets the
 *  router walk every key held for the provider, in their order. */
export const routeTargetSchema = z
    .object({
        provider,
        model,
        reasoning: z.enum(ROUTE_REASONING).default("inherit"),
        keyId: z.string().uuid().nullable().default(null)
    })
    .strict();
export type RouteTarget = z.infer<typeof routeTargetSchema>;

/** The tier overrides. A missing tier uses the default model. */
const tiersSchema = z
    .object({
        fable: routeTargetSchema.nullable().default(null),
        opus: routeTargetSchema.nullable().default(null),
        haiku: routeTargetSchema.nullable().default(null),
        sonnet: routeTargetSchema.nullable().default(null)
    })
    .strict();

export const polarRoutingSchema = z
    .object({
        /** Tried in order after the chosen model and its other keys fail. */
        fallbacks: z
            .array(routeTargetSchema)
            .max(FALLBACKS_MOST)
            .default([])
            .superRefine((list, context) => {
                const seen = new Set<string>();
                list.forEach((entry, index) => {
                    const key = targetKey(entry);
                    if (seen.has(key)) {
                        context.addIssue({
                            code: "custom",
                            path: [index],
                            message: "duplicate"
                        });
                    }
                    seen.add(key);
                });
            }),
        /** Whether a model the person picked by hand falls back too. Off keeps
         *  a pinned model's refusal on screen, as before. */
        pinnedFallsBack: z.boolean().default(true),
        /** What a compatible-API request lands on when its model names no
         *  tier this sets, and no `provider/model`. Null is Automatic. */
        defaultModel: routeTargetSchema.nullable().default(null),
        tiers: tiersSchema.default({ fable: null, opus: null, haiku: null, sonnet: null }),
        /** The effort a compatible-API request runs at when its tier says
         *  `inherit`. */
        defaultReasoning: z.enum(ROUTE_REASONING).exclude(["inherit"]).default("client")
    })
    .strict();
export type PolarRouting = z.infer<typeof polarRoutingSchema>;

export const POLAR_ROUTING_DEFAULTS: PolarRouting = polarRoutingSchema.parse({});

/** Same model on the same key is one entry; the same model on another key is
 *  a different one (free-claude-code allows both). Pure. */
export function targetKey(target: Pick<RouteTarget, "provider" | "model" | "keyId">): string {
    return `${target.provider}/${target.model}#${target.keyId ?? "*"}`;
}

/** A stored value read whole: anything unreadable is the defaults. Pure. */
export function routingOf(value: unknown): PolarRouting {
    const parsed = polarRoutingSchema.safeParse(value ?? {});
    return parsed.success ? parsed.data : POLAR_ROUTING_DEFAULTS;
}

/** Whether a stored routing says anything a person set. Pure. */
export function routingIsSet(routing: PolarRouting): boolean {
    return (
        routing.fallbacks.length > 0 ||
        routing.defaultModel !== null ||
        CLAUDE_TIERS.some((tier) => routing.tiers[tier] !== null)
    );
}

/** The tier a model id names, by substring, in `CLAUDE_TIERS` order. Pure. */
export function tierOf(modelId: string): ClaudeTier | null {
    const lower = modelId.toLowerCase();
    return CLAUDE_TIERS.find((tier) => lower.includes(tier)) ?? null;
}

/** The AI SDK reasoning values a forced level maps to. */
export type SdkReasoning = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The reasoning a call runs at on a target: `inherit` keeps `current`,
 * `client` keeps what the caller sent (`fromClient`), `off` is none, a level
 * is that level. Pure.
 */
export function reasoningForRoute(
    preference: RouteReasoning,
    current: SdkReasoning | undefined,
    fromClient: SdkReasoning | undefined = current
): SdkReasoning | undefined {
    switch (preference) {
        case "inherit":
            return current;
        case "client":
            return fromClient;
        case "off":
            return "none";
        default:
            return preference;
    }
}
