/**
 * The providers a run can be given a key for.
 *
 * The catalogue only: which providers exist, what the agent CLIs read each one's
 * key from, and which model slugs each one serves. Who holds a key for them, and
 * whose is spent when both an account and the deployment do, is `model-keys.ts`.
 *
 * The environment variable names are the providers' own, because that is what the
 * agent CLIs read. A gateway (an OpenAI-compatible endpoint in front of several
 * providers) is expressed the same way, as a base URL plus a key, which is how a
 * run reuses an existing agent subscription instead of a raw provider key.
 */

/** One provider Polaris can hand a run. */
export interface ModelProvider {
    /** Integration row this reads. */
    readonly slug: string;
    /** Shown wherever a run says which credential it used. */
    readonly name: string;
    /** The environment variable the agent CLIs read the key from. */
    readonly envVar: string;
    /** The `provider/` prefix of every model slug this credential can serve. */
    readonly modelPrefix: string;
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
    { slug: "anthropic", name: "Anthropic", envVar: "ANTHROPIC_API_KEY", modelPrefix: "anthropic" },
    { slug: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY", modelPrefix: "openai" },
    { slug: "google-ai", name: "Google AI", envVar: "GEMINI_API_KEY", modelPrefix: "google" },
    { slug: "xai", name: "xAI", envVar: "XAI_API_KEY", modelPrefix: "xai" },
    { slug: "deepseek", name: "DeepSeek", envVar: "DEEPSEEK_API_KEY", modelPrefix: "deepseek" },
    { slug: "moonshot", name: "Moonshot AI", envVar: "MOONSHOT_API_KEY", modelPrefix: "moonshotai" },
    { slug: "groq", name: "Groq", envVar: "GROQ_API_KEY", modelPrefix: "groq" },
    { slug: "cerebras", name: "Cerebras", envVar: "CEREBRAS_API_KEY", modelPrefix: "cerebras" },
    { slug: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY", modelPrefix: "openrouter" }
];

/**
 * The gateway integration.
 *
 * Kept apart from the list above because it is not a provider: it is an
 * OpenAI-compatible endpoint that fronts whatever the operator already pays for.
 * A run pointed at it sends its requests there instead of to a provider, which is
 * why it contributes a base URL as well as a key.
 */
export const GATEWAY_SLUG = "enigma";

/** Which provider a model slug needs a key for, or null when nothing here serves
 *  it (a raw specifier, or a provider Polaris does not carry a credential for). */
export function providerForModel(model: string): ModelProvider | null {
    const prefix = model.split("/")[0]?.toLowerCase() ?? "";
    return MODEL_PROVIDERS.find((provider) => provider.modelPrefix === prefix) ?? null;
}
