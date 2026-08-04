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

/** Which providers currently hold a usable credential. Read for the setup wizard
 *  and for the model picker, which greys out what cannot run. */
export async function connectedProviders(): Promise<string[]> {
    const states = await listIntegrationStates();
    return MODEL_PROVIDERS.filter((provider) => states.get(provider.slug)?.hasSecret).map((provider) => provider.slug);
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
        const gateway = states.get(GATEWAY_SLUG);
        if (gateway?.enabled) {
            const baseUrl = typeof gateway.config.baseUrl === "string" ? gateway.config.baseUrl : "";
            if (baseUrl) {
                secrets.OPENAI_COMPATIBLE_BASE_URL = baseUrl.replace(/\/+$/, "");
                const key = gateway.hasSecret ? await getIntegrationSecret(GATEWAY_SLUG) : null;
                secrets.OPENAI_COMPATIBLE_API_KEY = key ?? "unused";
            }
        }
    } catch {
        return null;
    }
    return secrets;
}
