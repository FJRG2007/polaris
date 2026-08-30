/**
 * The providers a key can be added for, as the screens that add one need them.
 *
 * Built here rather than in either screen because both ask the same question:
 * the account adding its own key and the administrator adding the deployment's
 * are picking from one list, and a provider that appears on one screen and not
 * the other would be a provider somebody cannot bring a key for depending on who
 * they are.
 */

import { GATEWAY_SLUG } from "@/lib/agents/agent-providers";
import { MODEL_INTEGRATIONS, type FreeTier } from "@/lib/integrations/registry";
import { providerIsCheckable } from "@/lib/agents/provider-key-check";

/**
 * What somebody types when they are looking for a provider by the thing it
 * serves rather than by the company that serves it. "gemini" is how most people
 * would look for Google AI, and "claude" for Anthropic.
 */
const PROVIDER_ALIASES: Record<string, string[]> = {
    anthropic: ["claude"],
    openai: ["gpt", "chatgpt", "codex"],
    "google-ai": ["gemini", "ai studio"],
    xai: ["grok"],
    deepseek: [],
    moonshot: ["kimi"],
    groq: ["gpt oss", "llama"],
    cerebras: ["glm"],
    openrouter: ["router"],
    [GATEWAY_SLUG]: ["gateway", "openai compatible", "endpoint"],
    // The tail, for the words people reach for that are not the company's name:
    // the model family, or what the thing is rather than who runs it.
    zai: ["glm", "zhipu"],
    alibaba: ["qwen", "dashscope", "bailian"],
    llama: ["meta"],
    "stepfun-ai": ["step"],
    xiaomi: ["mimo"],
    volcengine: ["doubao", "ark"],
    modelscope: ["qwen"],
    togetherai: ["together"],
    "fireworks-ai": ["fireworks"],
    "novita-ai": ["novita"],
    "ollama-cloud": ["ollama"],
    huggingface: ["hf", "hugging face"],
    nvidia: ["nim"],
    "io-net": ["io net"],
    "cline-pass": ["cline"],
    vercel: ["ai gateway"],
    opencode: ["zen"],
    upstage: ["solar"],
    inception: ["mercury"],
    "nano-gpt": ["nanogpt"]
};

/** One provider, as the dialog and the table need it. */
export interface ProviderRow {
    slug: string;
    name: string;
    /** Extra words somebody might type instead of the name. */
    aliases: string[];
    apiKeyLabel: string;
    apiKeyHelp: string | null;
    createUrl: string | null;
    /** The gateway is not a provider: it needs an endpoint and a model as well as
     *  a token, and the token is frequently not needed at all. */
    isGateway: boolean;
    /** Whether Polaris can ask this provider whether a key is good before storing
     *  it, so the dialog can say which of the two it is doing. */
    checkable: boolean;
    /** Whether a key can be had here without paying, and on what terms. Null for
     *  a provider that bills from the first token. */
    freeTier: FreeTier | null;
}

export function modelProviderRows(): ProviderRow[] {
    return MODEL_INTEGRATIONS.map((entry) => ({
        slug: entry.slug,
        name: entry.name,
        aliases: PROVIDER_ALIASES[entry.slug] ?? [],
        apiKeyLabel: entry.apiKeyLabel ?? "API key",
        apiKeyHelp: entry.apiKeyHelp ?? null,
        createUrl: entry.setupLinks?.[0]?.url ?? null,
        isGateway: entry.slug === GATEWAY_SLUG,
        checkable: providerIsCheckable(entry.slug),
        freeTier: entry.freeTier ?? null
    }));
}

/** What a provider is called, for a sentence about a key that belongs to it. */
export function modelProviderName(slug: string): string {
    return MODEL_INTEGRATIONS.find((entry) => entry.slug === slug)?.name ?? slug;
}
