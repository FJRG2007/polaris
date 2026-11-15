/**
 * OpenCode on any provider Polaris holds a key for.
 *
 * OpenCode reads its providers from the public model index (models.dev), the
 * same index Polaris's own catalogue comes from, so a provider's slug maps to
 * OpenCode's provider id through the same `modelPrefix` a run uses, and the
 * model id is the index's own. The configuration goes in through
 * `OPENCODE_CONFIG_CONTENT`, which OpenCode loads above the repository's own
 * `opencode.json` (https://opencode.ai/docs/config, "Precedence order"), so a
 * checkout cannot swap the model the person picked.
 *
 * The key itself is never in that configuration: it names `{env:...}`, which
 * OpenCode substitutes from the environment, and the key travels the way every
 * session credential does.
 *
 * Pure, so the mapping is asserted in a test.
 */

import { GATEWAY_SLUG, modelProviders } from "@/lib/agents/agent-providers";
import { catalogProvider } from "@/lib/integrations/provider-catalog-snapshot";

/** The variable the configuration reads the key from. Polaris's own name. */
export const OPENCODE_KEY_ENV = "POLARIS_OPENCODE_KEY";

/** OpenCode's id for the person's own OpenAI-compatible endpoint. */
export const OPENCODE_GATEWAY_ID = "polaris-gateway";

/** The OpenAI-compatible package OpenCode documents for a custom endpoint. */
const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

export interface OpencodeModelInput {
    /** Polaris's provider slug, as the chat picker names it. */
    readonly provider: string;
    /** The model id, as the catalogue lists it. */
    readonly model: string;
    readonly secret: string;
    /** The endpoint, for the gateway only. */
    readonly baseUrl: string | null;
    /** The one model the gateway serves, when it says. */
    readonly gatewayModel: string | null;
}

/** OpenCode's provider id for one of Polaris's slugs. */
export function opencodeProviderId(slug: string): string {
    if (slug === GATEWAY_SLUG) return OPENCODE_GATEWAY_ID;
    return modelProviders().find((entry) => entry.slug === slug)?.modelPrefix ?? slug;
}

/** The configuration OpenCode is started with, as an object. */
export function opencodeModelConfig(input: OpencodeModelInput): Record<string, unknown> {
    const apiKey = `{env:${OPENCODE_KEY_ENV}}`;
    if (input.provider === GATEWAY_SLUG) {
        const model = input.gatewayModel || input.model;
        return {
            $schema: "https://opencode.ai/config.json",
            model: `${OPENCODE_GATEWAY_ID}/${model}`,
            provider: {
                [OPENCODE_GATEWAY_ID]: {
                    npm: OPENAI_COMPATIBLE_NPM,
                    name: "Gateway",
                    options: { baseURL: (input.baseUrl ?? "").replace(/\/+$/, ""), apiKey },
                    models: { [model]: { name: model } }
                }
            }
        };
    }
    // A provider outside the public index (Coarena, an operator's own) is one
    // OpenCode cannot resolve by name, so it is declared the way the gateway is:
    // the OpenAI-compatible package, its endpoint, and the model it runs.
    const outside = catalogProvider(input.provider);
    if (outside?.outsideIndex && outside.baseUrl) {
        return {
            $schema: "https://opencode.ai/config.json",
            model: `${outside.slug}/${input.model}`,
            provider: {
                [outside.slug]: {
                    npm: OPENAI_COMPATIBLE_NPM,
                    name: outside.name,
                    options: { baseURL: outside.baseUrl.replace(/\/+$/, ""), apiKey },
                    models: { [input.model]: { name: input.model } }
                }
            }
        };
    }
    const id = opencodeProviderId(input.provider);
    return {
        $schema: "https://opencode.ai/config.json",
        model: `${id}/${input.model}`,
        provider: { [id]: { options: { apiKey } } }
    };
}

/**
 * The variables that point OpenCode at the chosen provider and model: one line
 * of JSON, so it carries no control character, and the key beside it.
 */
export function opencodeModelEnv(input: OpencodeModelInput): Record<string, string> {
    return {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeModelConfig(input)),
        // A gateway frequently takes no key at all; the variable still has to
        // say something, or OpenCode sends an empty bearer.
        [OPENCODE_KEY_ENV]: input.secret || "unused"
    };
}
