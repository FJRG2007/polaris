/**
 * AI provider keys (/account/ai-keys): the provider accounts this person's AI
 * work bills to, and the order they are tried in.
 *
 * An account setting rather than a feature of the Agents app, because it is the
 * same answer wherever Polaris asks a model something: a key you brought is used
 * first, and the deployment's is the fallback for a provider you have not brought
 * one for.
 */

import { requireUser } from "@/lib/session";
import { GATEWAY_SLUG } from "@/lib/agents/agent-providers";
import { AiKeysView, type ProviderRow } from "./ai-keys-view";
import { MODEL_INTEGRATIONS } from "@/lib/integrations/registry";
import { providerIsCheckable } from "@/lib/agents/provider-key-check";
import { instanceKeysAreShared, keySourcesFor, listUserModelKeys } from "@/lib/agents/user-model-keys";

export const dynamic = "force-dynamic";

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
    [GATEWAY_SLUG]: ["gateway", "openai compatible", "endpoint"]
};

export default async function AiKeysPage() {
    const user = await requireUser();
    const [keys, sources, shared] = await Promise.all([
        listUserModelKeys(user.id),
        keySourcesFor(user.id),
        instanceKeysAreShared()
    ]);

    // Read here rather than in the actions file: everything a "use server" module
    // exports has to be an action, and this is a constant.
    const providers: ProviderRow[] = MODEL_INTEGRATIONS.map((entry) => ({
        slug: entry.slug,
        name: entry.name,
        aliases: PROVIDER_ALIASES[entry.slug] ?? [],
        apiKeyLabel: entry.apiKeyLabel ?? "API key",
        apiKeyHelp: entry.apiKeyHelp ?? null,
        createUrl: entry.setupLinks?.[0]?.url ?? null,
        isGateway: entry.slug === GATEWAY_SLUG,
        checkable: providerIsCheckable(entry.slug)
    }));

    const named = new Map(providers.map((provider) => [provider.slug, provider.name]));
    const instanceProviders = [...sources.entries()]
        .filter(([, source]) => source === "instance")
        .map(([slug]) => named.get(slug) ?? slug);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[17px] font-semibold tracking-tight">AI provider keys</h1>
                <p className="text-muted-foreground text-sm">
                    The provider accounts your AI work bills to. A key you add here is used before anything the
                    deployment holds.
                </p>
            </div>
            <AiKeysView
                providers={providers}
                keys={keys}
                instanceProviders={instanceProviders}
                instanceShared={shared}
            />
        </div>
    );
}
