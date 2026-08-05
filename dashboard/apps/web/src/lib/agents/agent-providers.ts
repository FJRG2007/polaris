/**
 * The model credentials a run is given.
 *
 * These are the operator's own provider keys, held as Integration rows like every
 * other credential on the instance, and handed to a run over its authenticated
 * run-context call. They are never written into the repository as an Actions
 * secret: one place to rotate a key, no copy left behind on a repository somebody
 * later turns off, and one less permission on the GitHub App.
 *
 * The environment variable names are the providers' own, because that is what the
 * agent CLIs read. A gateway (an OpenAI-compatible endpoint in front of several
 * providers) is expressed the same way, as a base URL plus a key, which is how a
 * run reuses an existing agent subscription instead of a raw provider key.
 */

import { readGatewayConfig } from "@/lib/integrations/registry";
import { getIntegrationSecret, listIntegrationStates } from "@/lib/integration-service";

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

/**
 * Which providers can currently serve a run. Read for the setup wizard and for
 * the model picker, which offers only what can run.
 *
 * The gateway joins the list on different terms: it holds no provider key, so
 * what makes it usable is an endpoint and a model to ask it for. A token is
 * optional there - plenty of them accept unauthenticated calls from inside the
 * network - so requiring one would hide a gateway that works.
 */
export async function connectedProviders(): Promise<string[]> {
    const states = await listIntegrationStates();
    const connected = MODEL_PROVIDERS.filter((provider) => states.get(provider.slug)?.hasSecret).map(
        (provider) => provider.slug
    );

    const gateway = states.get(GATEWAY_SLUG);
    if (gateway?.enabled) {
        const config = readGatewayConfig(gateway.config);
        if (config.baseUrl && config.model) connected.push(GATEWAY_SLUG);
    }
    return connected;
}

/**
 * The environment a run is handed, as variable names to values.
 *
 * Every connected provider is included rather than only the one the configured
 * model needs. A run can fall back to another model when its first choice has no
 * key, and the agent CLIs decide that themselves from what is present; handing
 * over only one key would turn a recoverable substitution into a failed run.
 *
 * Returns null - distinct from an empty object - when the credentials could not
 * be read at all, so the runtime can tell "this operator has stored none" from
 * "the store was briefly unreadable" and not report the second as the first.
 */
export async function runSecrets(): Promise<Record<string, string> | null> {
    const secrets: Record<string, string> = {};
    try {
        const states = await listIntegrationStates();
        for (const provider of MODEL_PROVIDERS) {
            if (!states.get(provider.slug)?.hasSecret) continue;
            const key = await getIntegrationSecret(provider.slug);
            if (key) secrets[provider.envVar] = key;
        }

        // The gateway speaks the OpenAI protocol, so a run uses it by pointing the
        // OpenAI-compatible client at its base URL. The key is whatever the
        // gateway asks for, which on a loopback install is frequently nothing.
        // The model and its two limits ride along because an endpoint publishes
        // no catalog: without them a run answers in 32000-token slices and never
        // compacts.
        const gateway = states.get(GATEWAY_SLUG);
        if (gateway?.enabled) {
            const config = readGatewayConfig(gateway.config);
            if (config.baseUrl) {
                secrets.OPENAI_COMPATIBLE_BASE_URL = config.baseUrl.replace(/\/+$/, "");
                const key = gateway.hasSecret ? await getIntegrationSecret(GATEWAY_SLUG) : null;
                secrets.OPENAI_COMPATIBLE_API_KEY = key ?? "unused";
                if (config.model) secrets.OPENAI_COMPATIBLE_MODEL = config.model;
                if (config.context > 0) secrets.OPENAI_COMPATIBLE_CONTEXT = String(config.context);
                if (config.maxOutput > 0) secrets.OPENAI_COMPATIBLE_MAX_OUTPUT = String(config.maxOutput);
            }
        }
    } catch {
        return null;
    }
    return secrets;
}
