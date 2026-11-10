/**
 * Where Polar sends a chat for each provider in the catalogue's tail
 * (`model-providers.ts`), and which wire format it speaks there.
 *
 * Copied from https://models.dev/api.json on 2026-11-10: each provider's `api`
 * field, kept where its `npm` field is `@ai-sdk/openai-compatible` (the OpenAI
 * chat API) or `@ai-sdk/anthropic` (the Anthropic messages API). Two providers
 * whose index entry names their own SDK instead are added by hand from the
 * endpoint Polaris already checks their keys against (`probe` in
 * `model-providers.ts`, less its `/models`): Together, whose API is
 * OpenAI-compatible, and Mistral, served by its own AI SDK provider.
 *
 * A provider absent from here, and from the nine Polar has always called, is
 * one Polar cannot reach yet; its keys still serve agent runs.
 */

export interface ProviderEndpoint {
    api: "openai" | "anthropic" | "mistral";
    baseUrl: string;
}

// i18n-ignore: endpoints, never shown.
export const PROVIDER_ENDPOINTS: Readonly<Record<string, ProviderEndpoint>> = {
    zai: { api: "openai", baseUrl: "https://api.z.ai/api/paas/v4" },
    minimax: { api: "anthropic", baseUrl: "https://api.minimax.io/anthropic/v1" },
    alibaba: { api: "openai", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
    upstage: { api: "openai", baseUrl: "https://api.upstage.ai/v1/solar" },
    inception: { api: "openai", baseUrl: "https://api.inceptionlabs.ai/v1" },
    arcee: { api: "openai", baseUrl: "https://api.arcee.ai/api/v1" },
    longcat: { api: "openai", baseUrl: "https://api.longcat.chat/openai" },
    sarvam: { api: "openai", baseUrl: "https://api.sarvam.ai/v1" },
    "stepfun-ai": { api: "openai", baseUrl: "https://api.stepfun.ai/v1" },
    xiaomi: { api: "openai", baseUrl: "https://api.xiaomimimo.com/v1" },
    volcengine: { api: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
    modelscope: { api: "openai", baseUrl: "https://api-inference.modelscope.cn/v1" },
    "fireworks-ai": { api: "openai", baseUrl: "https://api.fireworks.ai/inference/v1" },
    nebius: { api: "openai", baseUrl: "https://api.tokenfactory.nebius.com/v1" },
    huggingface: { api: "openai", baseUrl: "https://router.huggingface.co/v1" },
    nvidia: { api: "openai", baseUrl: "https://integrate.api.nvidia.com/v1" },
    baseten: { api: "openai", baseUrl: "https://inference.baseten.co/v1" },
    "ollama-cloud": { api: "openai", baseUrl: "https://ollama.com/v1" },
    siliconflow: { api: "openai", baseUrl: "https://api.siliconflow.com/v1" },
    "novita-ai": { api: "openai", baseUrl: "https://api.novita.ai/openai" },
    chutes: { api: "openai", baseUrl: "https://llm.chutes.ai/v1" },
    scaleway: { api: "openai", baseUrl: "https://api.scaleway.ai/v1" },
    ovhcloud: { api: "openai", baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1" },
    wandb: { api: "openai", baseUrl: "https://api.inference.wandb.ai/v1" },
    friendli: { api: "openai", baseUrl: "https://api.friendli.ai/serverless/v1" },
    hetzner: { api: "openai", baseUrl: "https://inference.hetzner.com/api/v1" },
    tinfoil: { api: "openai", baseUrl: "https://inference.tinfoil.sh/v1" },
    vultr: { api: "openai", baseUrl: "https://api.vultrinference.com/v1" },
    crusoe: { api: "openai", baseUrl: "https://api.inference.crusoecloud.com/v1" },
    gmicloud: { api: "openai", baseUrl: "https://api.gmi-serving.com/v1" },
    "io-net": { api: "openai", baseUrl: "https://api.intelligence.io.solutions/api/v1" },
    berget: { api: "openai", baseUrl: "https://api.berget.ai/v1" },
    requesty: { api: "openai", baseUrl: "https://router.requesty.ai/v1" },
    zenmux: { api: "openai", baseUrl: "https://zenmux.ai/api/v1" },
    "nano-gpt": { api: "openai", baseUrl: "https://nano-gpt.com/api/v1" },
    kilo: { api: "openai", baseUrl: "https://api.kilo.ai/api/gateway" },
    llmgateway: { api: "openai", baseUrl: "https://api.llmgateway.io/v1" },
    poe: { api: "openai", baseUrl: "https://api.poe.com/v1" },
    helicone: { api: "openai", baseUrl: "https://ai-gateway.helicone.ai/v1" },
    fastrouter: { api: "openai", baseUrl: "https://go.fastrouter.ai/api/v1" },
    anyapi: { api: "openai", baseUrl: "https://api.anyapi.ai/v1" },
    unorouter: { api: "openai", baseUrl: "https://api.unorouter.com/v1" },
    orcarouter: { api: "openai", baseUrl: "https://api.orcarouter.ai/v1" },
    synthetic: { api: "openai", baseUrl: "https://api.synthetic.new/openai/v1" },
    opencode: { api: "openai", baseUrl: "https://opencode.ai/inference/openai/v1" },
    cortecs: { api: "openai", baseUrl: "https://api.cortecs.ai/v1" },
    edenai: { api: "openai", baseUrl: "https://api.edenai.run/v3" },
    "cline-pass": { api: "openai", baseUrl: "https://api.cline.bot/api/v1" },
    togetherai: { api: "openai", baseUrl: "https://api.together.xyz/v1" },
    mistral: { api: "mistral", baseUrl: "https://api.mistral.ai/v1" }
};
