/**
 * The model providers beyond the handful with a card written by hand.
 *
 * The nine in the registry itself are the ones most deployments reach for, and
 * each carries its own paragraph. Everything else is a long tail that grows and
 * changes every month, and a hundred hand-written paragraphs is a hundred things
 * to go stale. So the tail is a table: one row per provider, carrying only what
 * is actually specific to it, and the prose around each row is assembled from
 * what kind of thing it is.
 *
 * One table, read three times. It is what the marketplace lists, what the run
 * environment hands a key to, and where a pasted key is checked - three lists
 * that used to be written out separately and could disagree without anything
 * failing until a run asked for a key that was never sent.
 *
 * Every field here is sourced rather than remembered. The environment variable,
 * the model prefix and the documentation link come from the same public index
 * the agent runtimes resolve model ids against (`models.dev`), because the
 * variable an agent CLI reads is not a thing to guess at. A key-creation link is
 * only written down when the page answers, and a check endpoint only when asking
 * it without a key is actually refused - a provider whose model list is public
 * would "verify" every string ever pasted.
 */

import type { IntegrationCatalogEntry } from "@/lib/integrations/registry";

/**
 * Whether a provider can be tried without paying, as the screens badge it.
 *
 * Two kinds, because they mean different things to somebody deciding where to
 * point a run: an allowance comes back (a daily or monthly quota that resets),
 * a trial is a one-off grant that runs out and does not return.
 *
 * The note is deliberately short and carries no numbers that move. Quotas are
 * changed by the providers without notice and Polaris has no way to learn that
 * they have; a figure written here is one that will be wrong within months and
 * read as fact anyway. What the badge promises is the shape of the offer, and
 * the provider's own page is where the current numbers live.
 */
export interface FreeTier {
    kind: "free" | "trial";
    /** One line, in the terms the provider itself uses. */
    note: string;
}

/** What a provider is, which is what its description is built out of. */
type ProviderKind = "lab" | "host" | "gateway";

/** One provider, as the three lists that read this need it. */
export interface ModelProviderSeed {
    /** Its id in the public model index, which is both the integration slug and
     *  the prefix of every model slug the credential can serve. */
    slug: string;
    name: string;
    kind: ProviderKind;
    /** The variable the agent CLIs read the key from. */
    envVar: string;
    /** One line saying what is worth coming here for. */
    summary: string;
    docsUrl: string;
    /** Where the key is actually made. Absent where the page could not be
     *  reached to confirm it, and the documentation link is then the way in. */
    keyUrl?: string;
    /** An endpoint that refuses an unknown key, so one can be checked before it
     *  is stored. Absent where the provider's model list is public, since asking
     *  a public list about a key accepts anything. */
    probe?: string;
    /** What a repository runs on when this is the provider picked. */
    defaultModel: { label: string; slug: string };
    free?: FreeTier;
}

/**
 * The tail, grouped the way somebody scanning it thinks about it: the labs that
 * train their own models, the hosts that serve everybody's on their own
 * hardware, and the gateways that put one credential in front of several.
 */
export const MODEL_PROVIDER_SEEDS: readonly ModelProviderSeed[] = [
    // -----------------------------------------------------------------------
    // Labs, which serve the models they train
    // -----------------------------------------------------------------------
    {
        slug: "mistral",
        name: "Mistral",
        kind: "lab",
        envVar: "MISTRAL_API_KEY",
        summary: "European models, with a coding model of their own.",
        docsUrl: "https://docs.mistral.ai/getting-started/models/",
        keyUrl: "https://console.mistral.ai/api-keys",
        probe: "https://api.mistral.ai/v1/models",
        defaultModel: { label: "Mistral Medium", slug: "mistral/mistral-medium-2508" },
        free: { kind: "free", note: "An experiment tier that needs no card, rate limited rather than metered." }
    },
    {
        slug: "zai",
        name: "Z.AI",
        kind: "lab",
        envVar: "ZHIPU_API_KEY",
        summary: "The GLM models, and a coding plan priced for agents.",
        docsUrl: "https://docs.z.ai/guides/overview/pricing",
        keyUrl: "https://z.ai/manage-apikey/apikey-list",
        probe: "https://api.z.ai/api/paas/v4/models",
        defaultModel: { label: "GLM 5.3 (Z.AI)", slug: "zai/glm-5.3" }
    },
    {
        slug: "minimax",
        name: "MiniMax",
        kind: "lab",
        envVar: "MINIMAX_API_KEY",
        summary: "The M-series models, direct rather than through a router.",
        docsUrl: "https://platform.minimax.io/docs/guides/quickstart",
        keyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
        probe: "https://api.minimax.io/anthropic/v1/models",
        defaultModel: { label: "MiniMax M3", slug: "minimax/MiniMax-M3" }
    },
    {
        slug: "cohere",
        name: "Cohere",
        kind: "lab",
        envVar: "COHERE_API_KEY",
        summary: "The Command models, built around retrieval and tool use.",
        docsUrl: "https://docs.cohere.com/docs/models",
        keyUrl: "https://dashboard.cohere.com/api-keys",
        probe: "https://api.cohere.com/v1/models",
        defaultModel: { label: "Command A (Cohere)", slug: "cohere/command-a-03-2025" },
        free: { kind: "trial", note: "A trial key with a monthly call allowance, for evaluating rather than running on." }
    },
    {
        slug: "llama",
        name: "Meta Llama",
        kind: "lab",
        envVar: "LLAMA_API_KEY",
        summary: "Llama from Meta itself, rather than from somebody hosting it.",
        docsUrl: "https://llama.developer.meta.com/docs/models",
        keyUrl: "https://llama.developer.meta.com/api-keys",
        probe: "https://api.llama.com/compat/v1/models",
        defaultModel: { label: "Llama 4 Scout", slug: "llama/llama-4-scout-17b-16e-instruct-fp8" }
    },
    {
        slug: "alibaba",
        name: "Alibaba Model Studio",
        kind: "lab",
        envVar: "DASHSCOPE_API_KEY",
        summary: "The Qwen models, including the coder ones agents do well on.",
        docsUrl: "https://www.alibabacloud.com/help/en/model-studio/models",
        keyUrl: "https://bailian.console.alibabacloud.com/?tab=model#/api-key",
        probe: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
        defaultModel: { label: "Qwen3 Coder Plus", slug: "alibaba/qwen3-coder-plus" }
    },
    {
        slug: "venice",
        name: "Venice AI",
        kind: "lab",
        envVar: "VENICE_API_KEY",
        summary: "Serves other labs' models without keeping what is sent through it.",
        docsUrl: "https://docs.venice.ai",
        keyUrl: "https://venice.ai/settings/api",
        defaultModel: { label: "GLM 5.3 Flash (Venice)", slug: "venice/z-ai-glm-5-3-flash" }
    },
    {
        slug: "upstage",
        name: "Upstage",
        kind: "lab",
        envVar: "UPSTAGE_API_KEY",
        summary: "The Solar models, small enough to answer quickly.",
        docsUrl: "https://developers.upstage.ai/docs/apis/chat",
        keyUrl: "https://console.upstage.ai/api-keys",
        probe: "https://api.upstage.ai/v1/solar/models",
        defaultModel: { label: "Solar Pro 4", slug: "upstage/solar-pro4" }
    },
    {
        slug: "inception",
        name: "Inception",
        kind: "lab",
        envVar: "INCEPTION_API_KEY",
        summary: "A diffusion model that writes far faster than it reads.",
        docsUrl: "https://platform.inceptionlabs.ai/docs",
        defaultModel: { label: "Mercury 2 (Inception)", slug: "inception/mercury-2" },
        free: { kind: "trial", note: "A block of tokens on signup, with no card." }
    },
    {
        slug: "arcee",
        name: "Arcee AI",
        kind: "lab",
        envVar: "ARCEE_API_KEY",
        summary: "Its own models beside the open ones, on one key.",
        docsUrl: "https://docs.arcee.ai",
        probe: "https://api.arcee.ai/api/v1/models",
        defaultModel: { label: "DeepSeek V4 Flash (Arcee)", slug: "arcee/deepseek/deepseek-v4-flash-latest" },
        free: { kind: "free", note: "A model kept free to use, with no card." }
    },
    {
        slug: "longcat",
        name: "LongCat",
        kind: "lab",
        envVar: "LONGCAT_API_KEY",
        summary: "One large model, offered without a bill attached.",
        docsUrl: "https://longcat.chat/platform/docs/",
        keyUrl: "https://longcat.chat/platform/api_keys",
        probe: "https://api.longcat.chat/openai/models",
        defaultModel: { label: "LongCat 2.0", slug: "longcat/LongCat-2.0" },
        free: { kind: "free", note: "Free to call, within a rate limit." }
    },
    {
        slug: "sarvam",
        name: "Sarvam AI",
        kind: "lab",
        envVar: "SARVAM_API_KEY",
        summary: "Models trained for Indian languages.",
        docsUrl: "https://docs.sarvam.ai/api-reference-docs/getting-started/models",
        defaultModel: { label: "Sarvam 105B", slug: "sarvam/sarvam-105b" },
        free: { kind: "trial", note: "Signup credits that do not expire." }
    },
    {
        slug: "stepfun-ai",
        name: "StepFun",
        kind: "lab",
        envVar: "STEPFUN_API_KEY",
        summary: "The Step models, on the endpoint served outside China.",
        docsUrl: "https://platform.stepfun.ai/docs/en/overview/concept",
        keyUrl: "https://platform.stepfun.ai/interface-key",
        probe: "https://api.stepfun.ai/v1/models",
        defaultModel: { label: "Step 3.7 Flash", slug: "stepfun-ai/step-3.7-flash" }
    },
    {
        slug: "xiaomi",
        name: "Xiaomi MiMo",
        kind: "lab",
        envVar: "XIAOMI_API_KEY",
        summary: "The MiMo models, with a very large window.",
        docsUrl: "https://platform.xiaomimimo.com/#/docs",
        keyUrl: "https://platform.xiaomimimo.com/#/apikey",
        probe: "https://api.xiaomimimo.com/v1/models",
        defaultModel: { label: "MiMo v2.5", slug: "xiaomi/mimo-v2.5" }
    },
    {
        slug: "volcengine",
        name: "Volcengine Ark",
        kind: "lab",
        envVar: "ARK_API_KEY",
        summary: "The Doubao models, and DeepSeek served beside them.",
        docsUrl: "https://www.volcengine.com/docs/82379/1330310",
        keyUrl: "https://console.volcengine.com/ark",
        probe: "https://ark.cn-beijing.volces.com/api/v3/models",
        defaultModel: {
            label: "Doubao Seed 2.0 Code",
            slug: "volcengine/doubao-seed-2-0-code-preview-260215"
        }
    },
    {
        slug: "modelscope",
        name: "ModelScope",
        kind: "lab",
        envVar: "MODELSCOPE_API_KEY",
        summary: "Alibaba's model hub, serving the Qwen family from it.",
        docsUrl: "https://modelscope.cn/docs/model-service/API-Inference/intro",
        keyUrl: "https://modelscope.cn/my/myaccesstoken",
        defaultModel: {
            label: "Qwen3 Coder 30B (ModelScope)",
            slug: "modelscope/Qwen/Qwen3-Coder-30B-A3B-Instruct"
        },
        free: { kind: "free", note: "A daily allowance on a hub account." }
    },

    // -----------------------------------------------------------------------
    // Hosts, which serve other people's models on their own hardware
    // -----------------------------------------------------------------------
    {
        slug: "togetherai",
        name: "Together AI",
        kind: "host",
        envVar: "TOGETHER_API_KEY",
        summary: "Most of the open models, on one key.",
        docsUrl: "https://docs.together.ai/docs/serverless-models",
        keyUrl: "https://api.together.ai/settings/api-keys",
        probe: "https://api.together.xyz/v1/models",
        defaultModel: { label: "Kimi K3 (Together)", slug: "togetherai/moonshotai/Kimi-K3" }
    },
    {
        slug: "fireworks-ai",
        name: "Fireworks AI",
        kind: "host",
        envVar: "FIREWORKS_API_KEY",
        summary: "Open models tuned for throughput rather than price.",
        docsUrl: "https://fireworks.ai/docs/",
        keyUrl: "https://app.fireworks.ai/settings/users/api-keys",
        probe: "https://api.fireworks.ai/inference/v1/models",
        defaultModel: {
            label: "Kimi K3 (Fireworks)",
            slug: "fireworks-ai/accounts/fireworks/models/kimi-k3"
        },
        free: { kind: "trial", note: "A starter credit on signup." }
    },
    {
        slug: "deepinfra",
        name: "DeepInfra",
        kind: "host",
        envVar: "DEEPINFRA_API_KEY",
        summary: "Open models at some of the lowest per-token prices.",
        docsUrl: "https://deepinfra.com/models",
        keyUrl: "https://deepinfra.com/dash/api_keys",
        defaultModel: { label: "Kimi K3 (DeepInfra)", slug: "deepinfra/moonshotai/Kimi-K3" },
        free: { kind: "trial", note: "Signup credit, enough to try a run." }
    },
    {
        slug: "nebius",
        name: "Nebius Token Factory",
        kind: "host",
        envVar: "NEBIUS_API_KEY",
        summary: "European hardware, serving the open models.",
        docsUrl: "https://docs.tokenfactory.nebius.com/",
        keyUrl: "https://tokenfactory.nebius.com/",
        probe: "https://api.tokenfactory.nebius.com/v1/models",
        defaultModel: { label: "Kimi K3 (Nebius)", slug: "nebius/moonshotai/Kimi-K3" },
        free: { kind: "trial", note: "Signup credit for evaluating." }
    },
    {
        slug: "huggingface",
        name: "Hugging Face",
        kind: "host",
        envVar: "HF_TOKEN",
        summary: "One token in front of every host the hub routes to.",
        docsUrl: "https://huggingface.co/docs/inference-providers",
        keyUrl: "https://huggingface.co/settings/tokens",
        defaultModel: {
            label: "DeepSeek V4 Flash (Hugging Face)",
            slug: "huggingface/deepseek-ai/DeepSeek-V4-Flash"
        },
        free: { kind: "free", note: "An allowance on a free account, with paid routing beyond it." }
    },
    {
        slug: "nvidia",
        name: "NVIDIA NIM",
        kind: "host",
        envVar: "NVIDIA_API_KEY",
        summary: "A wide catalogue on NVIDIA's own endpoints.",
        docsUrl: "https://docs.api.nvidia.com/nim/",
        keyUrl: "https://build.nvidia.com/settings/api-keys",
        defaultModel: { label: "Kimi K3 (NVIDIA)", slug: "nvidia/moonshotai/kimi-k3" },
        free: { kind: "free", note: "A developer allowance, rate limited rather than billed." }
    },
    {
        slug: "baseten",
        name: "Baseten",
        kind: "host",
        envVar: "BASETEN_API_KEY",
        summary: "Dedicated deployments as well as the shared endpoints.",
        docsUrl: "https://docs.baseten.co/inference/model-apis/overview",
        keyUrl: "https://app.baseten.co/settings/api_keys",
        probe: "https://inference.baseten.co/v1/models",
        defaultModel: { label: "Kimi K3 (Baseten)", slug: "baseten/moonshotai/Kimi-K3" },
        free: { kind: "trial", note: "Trial credits on signup." }
    },
    {
        slug: "ollama-cloud",
        name: "Ollama Cloud",
        kind: "host",
        envVar: "OLLAMA_API_KEY",
        summary: "The models you would run locally, run somewhere with the memory.",
        docsUrl: "https://docs.ollama.com/cloud",
        keyUrl: "https://ollama.com/settings/keys",
        defaultModel: { label: "Kimi K3 (Ollama Cloud)", slug: "ollama-cloud/kimi-k3" },
        free: { kind: "free", note: "An hourly and daily allowance on a free account." }
    },
    {
        slug: "siliconflow",
        name: "SiliconFlow",
        kind: "host",
        envVar: "SILICONFLOW_API_KEY",
        summary: "A broad Chinese-model catalogue on one key.",
        docsUrl: "https://cloud.siliconflow.com/models",
        keyUrl: "https://cloud.siliconflow.com/account/ak",
        probe: "https://api.siliconflow.com/v1/models",
        defaultModel: { label: "GLM 5.2 (SiliconFlow)", slug: "siliconflow/zai-org/GLM-5.2" },
        free: { kind: "free", note: "Some models served at no cost, the rest metered." }
    },
    {
        slug: "novita-ai",
        name: "Novita AI",
        kind: "host",
        envVar: "NOVITA_API_KEY",
        summary: "Open models with GPU rental beside them.",
        docsUrl: "https://novita.ai/docs/guides/introduction",
        keyUrl: "https://novita.ai/settings/key-management",
        defaultModel: { label: "Kimi K3 (Novita)", slug: "novita-ai/moonshotai/kimi-k3" },
        free: { kind: "trial", note: "A small credit on signup." }
    },
    {
        slug: "chutes",
        name: "Chutes",
        kind: "host",
        envVar: "CHUTES_API_KEY",
        summary: "Open models served inside attested hardware.",
        docsUrl: "https://llm.chutes.ai/v1/models",
        keyUrl: "https://chutes.ai/app/api",
        defaultModel: { label: "Kimi K3 (Chutes)", slug: "chutes/moonshotai/Kimi-K3-TEE" }
    },
    {
        slug: "scaleway",
        name: "Scaleway",
        kind: "host",
        envVar: "SCALEWAY_API_KEY",
        summary: "Open models on French hardware, under EU rules.",
        docsUrl: "https://www.scaleway.com/en/docs/generative-apis/",
        keyUrl: "https://console.scaleway.com/iam/api-keys",
        probe: "https://api.scaleway.ai/v1/models",
        defaultModel: { label: "Qwen3 235B (Scaleway)", slug: "scaleway/qwen3-235b-a22b-instruct-2507" },
        free: { kind: "trial", note: "A block of tokens for new accounts." }
    },
    {
        slug: "ovhcloud",
        name: "OVHcloud AI Endpoints",
        kind: "host",
        envVar: "OVHCLOUD_API_KEY",
        summary: "Open models on European hardware.",
        docsUrl: "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/",
        keyUrl: "https://endpoints.ai.cloud.ovh.net/",
        defaultModel: {
            label: "Qwen3 Coder 30B (OVHcloud)",
            slug: "ovhcloud/qwen3-coder-30b-a3b-instruct"
        }
    },
    {
        slug: "wandb",
        name: "Weights & Biases",
        kind: "host",
        envVar: "WANDB_API_KEY",
        summary: "Inference beside the run tracking, on the same key.",
        docsUrl: "https://docs.wandb.ai/guides/integrations/inference/",
        keyUrl: "https://wandb.ai/authorize",
        probe: "https://api.inference.wandb.ai/v1/models",
        defaultModel: { label: "GLM 5.2 (W&B)", slug: "wandb/zai-org/GLM-5.2" }
    },
    {
        slug: "friendli",
        name: "FriendliAI",
        kind: "host",
        envVar: "FRIENDLI_TOKEN",
        summary: "Serverless endpoints for the open models.",
        docsUrl: "https://friendli.ai/docs/guides/serverless_endpoints/introduction",
        keyUrl: "https://suite.friendli.ai/",
        defaultModel: { label: "GLM 5.3 (Friendli)", slug: "friendli/zai-org/GLM-5.3" },
        free: { kind: "free", note: "A free tier on the serverless endpoints, with no card." }
    },
    {
        slug: "hetzner",
        name: "Hetzner",
        kind: "host",
        envVar: "HETZNER_API_KEY",
        summary: "Open models on German hardware, from the hosting company.",
        docsUrl: "https://experiments.hetzner.com/docs/inference",
        keyUrl: "https://console.hetzner.com/",
        probe: "https://inference.hetzner.com/api/v1/models",
        defaultModel: { label: "Qwen3.8 27B (Hetzner)", slug: "hetzner/Qwen3.8-27B" },
        free: { kind: "free", note: "Served at no per-token cost while it is an experiment." }
    },
    {
        slug: "tinfoil",
        name: "Tinfoil",
        kind: "host",
        envVar: "TINFOIL_API_KEY",
        summary: "Runs inside enclaves, so the host cannot read the prompt.",
        docsUrl: "https://docs.tinfoil.sh",
        keyUrl: "https://tinfoil.sh/dashboard",
        defaultModel: { label: "DeepSeek V4 Flash (Tinfoil)", slug: "tinfoil/deepseek-v4-flash" }
    },
    {
        slug: "vultr",
        name: "Vultr",
        kind: "host",
        envVar: "VULTR_API_KEY",
        summary: "Serverless inference beside the rest of the cloud account.",
        docsUrl: "https://api.vultrinference.com/",
        defaultModel: { label: "MiMo v2.5 Pro (Vultr)", slug: "vultr/XiaomiMiMo/MiMo-V2.5-Pro" }
    },
    {
        slug: "crusoe",
        name: "Crusoe",
        kind: "host",
        envVar: "CRUSOE_API_KEY",
        summary: "Open models on hardware run off stranded energy.",
        docsUrl: "https://docs.crusoecloud.com/managed-inference/overview",
        keyUrl: "https://console.crusoecloud.com/",
        probe: "https://api.inference.crusoecloud.com/v1/models",
        defaultModel: { label: "GLM 5.2 (Crusoe)", slug: "crusoe/zai/GLM-5.2" }
    },
    {
        slug: "gmicloud",
        name: "GMI Cloud",
        kind: "host",
        envVar: "GMICLOUD_API_KEY",
        summary: "Open models with dedicated capacity behind them.",
        docsUrl: "https://docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference",
        probe: "https://api.gmi-serving.com/v1/models",
        defaultModel: { label: "DeepSeek V4 Pro (GMI)", slug: "gmicloud/deepseek-ai/DeepSeek-V4-Pro" }
    },
    {
        slug: "io-net",
        name: "IO.NET",
        kind: "host",
        envVar: "IOINTELLIGENCE_API_KEY",
        summary: "Open models on a distributed GPU network.",
        docsUrl: "https://io.net/docs/guides/intelligence/io-intelligence",
        keyUrl: "https://ai.io.net/ai/api-keys",
        defaultModel: {
            label: "Qwen3 235B (IO.NET)",
            slug: "io-net/Qwen/Qwen3-235B-A22B-Thinking-2507"
        },
        free: { kind: "free", note: "A daily allowance on a free account." }
    },
    {
        slug: "berget",
        name: "Berget.AI",
        kind: "host",
        envVar: "BERGET_API_KEY",
        summary: "Open models on Swedish hardware, under EU rules.",
        docsUrl: "https://api.berget.ai",
        keyUrl: "https://console.berget.ai/",
        defaultModel: { label: "GLM 5.2 (Berget)", slug: "berget/zai-org/GLM-5.2" }
    },

    // -----------------------------------------------------------------------
    // Gateways, which put one credential in front of several providers
    // -----------------------------------------------------------------------
    {
        slug: "vercel",
        name: "Vercel AI Gateway",
        kind: "gateway",
        envVar: "AI_GATEWAY_API_KEY",
        summary: "One key for the frontier models, billed through Vercel.",
        docsUrl: "https://vercel.com/docs/ai-gateway",
        keyUrl: "https://vercel.com/docs/ai-gateway",
        defaultModel: { label: "Grok 4.20 (Vercel)", slug: "vercel/spacexai/grok-4.20-reasoning" },
        free: { kind: "trial", note: "A starting credit on a Vercel account." }
    },
    {
        slug: "requesty",
        name: "Requesty",
        kind: "gateway",
        envVar: "REQUESTY_API_KEY",
        summary: "Routing across several hundred models, with spend caps.",
        docsUrl: "https://requesty.ai/solution/llm-routing/models",
        defaultModel: { label: "GPT 5.5 Pro (Requesty)", slug: "requesty/gpt-5.5-pro" },
        free: { kind: "free", note: "A daily request allowance before anything is billed." }
    },
    {
        slug: "zenmux",
        name: "ZenMux",
        kind: "gateway",
        envVar: "ZENMUX_API_KEY",
        summary: "One key across the frontier labs.",
        docsUrl: "https://docs.zenmux.ai",
        keyUrl: "https://zenmux.ai/settings/keys",
        defaultModel: { label: "Grok 4.2 Fast (ZenMux)", slug: "zenmux/x-ai/grok-4.2-fast" }
    },
    {
        slug: "nano-gpt",
        name: "NanoGPT",
        kind: "gateway",
        envVar: "NANO_GPT_API_KEY",
        summary: "The widest catalogue of the routers, paid per request.",
        docsUrl: "https://docs.nano-gpt.com",
        keyUrl: "https://nano-gpt.com/api",
        defaultModel: { label: "GPT 5.6 Sol (NanoGPT)", slug: "nano-gpt/openai/gpt-5.6-sol" }
    },
    {
        slug: "kilo",
        name: "Kilo Gateway",
        kind: "gateway",
        envVar: "KILO_API_KEY",
        summary: "The router behind the Kilo coding tools.",
        docsUrl: "https://kilo.ai",
        keyUrl: "https://app.kilocode.ai/",
        defaultModel: { label: "Grok 4.20 (Kilo)", slug: "kilo/x-ai/grok-4.20" }
    },
    {
        slug: "llmgateway",
        name: "LLM Gateway",
        kind: "gateway",
        envVar: "LLMGATEWAY_API_KEY",
        summary: "An open-source router you can also host yourself.",
        docsUrl: "https://llmgateway.io/docs",
        keyUrl: "https://llmgateway.io/dashboard",
        defaultModel: { label: "Grok 4.1 Fast (LLM Gateway)", slug: "llmgateway/grok-4-1-fast-reasoning" },
        free: { kind: "free", note: "A free tier on the hosted router." }
    },
    {
        slug: "poe",
        name: "Poe",
        kind: "gateway",
        envVar: "POE_API_KEY",
        summary: "Spends the points a Poe subscription already includes.",
        docsUrl: "https://creator.poe.com/docs/external-applications/openai-compatible-api",
        defaultModel: { label: "Grok 4 Fast (Poe)", slug: "poe/xai/grok-4-fast-reasoning" }
    },
    {
        slug: "helicone",
        name: "Helicone",
        kind: "gateway",
        envVar: "HELICONE_API_KEY",
        summary: "Routes and records the calls, for looking at afterwards.",
        docsUrl: "https://helicone.ai/models",
        keyUrl: "https://us.helicone.ai/developer",
        defaultModel: { label: "Grok 4 Fast (Helicone)", slug: "helicone/grok-4-fast-reasoning" }
    },
    {
        slug: "fastrouter",
        name: "FastRouter",
        kind: "gateway",
        envVar: "FASTROUTER_API_KEY",
        summary: "Picks the cheapest host serving the model asked for.",
        docsUrl: "https://fastrouter.ai/models",
        defaultModel: { label: "GPT 5.5 Pro (FastRouter)", slug: "fastrouter/openai/gpt-5.5-pro" },
        free: { kind: "free", note: "A free tier before anything is billed." }
    },
    {
        slug: "anyapi",
        name: "AnyAPI",
        kind: "gateway",
        envVar: "ANYAPI_API_KEY",
        summary: "One key across the frontier models, paid as you go.",
        docsUrl: "https://docs.anyapi.ai",
        probe: "https://api.anyapi.ai/v1/models",
        defaultModel: { label: "GPT 5.4 (AnyAPI)", slug: "anyapi/openai/gpt-5.4" },
        free: { kind: "free", note: "A free tier for trying it." }
    },
    {
        slug: "unorouter",
        name: "UnoRouter",
        kind: "gateway",
        envVar: "UNOROUTER_API_KEY",
        summary: "Serves some of its catalogue at no cost.",
        docsUrl: "https://unorouter.com/models",
        keyUrl: "https://unorouter.com/dashboard",
        defaultModel: { label: "GPT 5.5 (UnoRouter)", slug: "unorouter/gpt-5.5" },
        free: { kind: "free", note: "Models marked free are served at no per-token cost." }
    },
    {
        slug: "orcarouter",
        name: "OrcaRouter",
        kind: "gateway",
        envVar: "ORCAROUTER_API_KEY",
        summary: "One key across the frontier labs.",
        docsUrl: "https://docs.orcarouter.ai",
        keyUrl: "https://www.orcarouter.ai/",
        defaultModel: { label: "GPT 5.5 Pro (OrcaRouter)", slug: "orcarouter/openai/gpt-5.5-pro" }
    },
    {
        slug: "synthetic",
        name: "Synthetic",
        kind: "gateway",
        envVar: "SYNTHETIC_API_KEY",
        summary: "A flat monthly price rather than a per-token one.",
        docsUrl: "https://synthetic.new/pricing",
        defaultModel: { label: "Kimi K3 (Synthetic)", slug: "synthetic/hf:moonshotai/Kimi-K3" }
    },
    {
        slug: "opencode",
        name: "OpenCode Zen",
        kind: "gateway",
        envVar: "OPENCODE_API_KEY",
        summary: "The models the agent runtime itself is built around.",
        docsUrl: "https://opencode.ai/docs/zen",
        keyUrl: "https://opencode.ai/auth",
        defaultModel: { label: "GPT 5.5 Pro (Zen)", slug: "opencode/gpt-5.5-pro" }
    },
    {
        slug: "cortecs",
        name: "Cortecs",
        kind: "gateway",
        envVar: "CORTECS_API_KEY",
        summary: "Routing with EU hosting where the model allows it.",
        docsUrl: "https://api.cortecs.ai/v1/models",
        keyUrl: "https://cortecs.ai/",
        defaultModel: { label: "GPT 5.6 Sol (Cortecs)", slug: "cortecs/gpt-5.6-sol" }
    },
    {
        slug: "edenai",
        name: "Eden AI",
        kind: "gateway",
        envVar: "EDENAI_API_KEY",
        summary: "One key across the labs and the clouds serving them.",
        docsUrl: "https://docs.edenai.co",
        keyUrl: "https://app.edenai.run/admin/account/settings",
        defaultModel: { label: "GPT 5.5 Pro (Eden AI)", slug: "edenai/openai/gpt-5.5-pro" }
    },
    {
        slug: "cline-pass",
        name: "ClinePass",
        kind: "gateway",
        envVar: "CLINE_API_KEY",
        summary: "Spends a ClinePass subscription instead of a provider bill.",
        docsUrl: "https://docs.cline.bot/getting-started/clinepass",
        keyUrl: "https://app.cline.bot/",
        defaultModel: { label: "Kimi K3 (ClinePass)", slug: "cline-pass/cline-pass/kimi-k3" }
    }
];

/** The sentence that says what kind of thing a provider is. */
const KIND_SENTENCE: Record<ProviderKind, (name: string) => string> = {
    lab: (name) => `Connects your ${name} account so agents can run on the models it trains and serves itself.`,
    host: (name) => `Connects ${name}, which serves open models on its own hardware rather than training them.`,
    gateway: (name) =>
        `Routes agent runs through ${name}, which serves models from several providers behind one credential.`
};

/** The line every one of them ends on, since it is true of every one of them. */
const HANDLING =
    "The key is held here and handed to a run over an authenticated call, never copied into your repositories.";

/** One provider's description, assembled rather than written out. */
function describe(seed: ModelProviderSeed): string {
    const billing =
        seed.kind === "gateway"
            ? `Usage is billed by ${seed.name} directly.`
            : `Usage is billed by ${seed.name} directly, and Polaris adds nothing to that bill.`;
    return [KIND_SENTENCE[seed.kind](seed.name), HANDLING, billing, seed.free?.note].filter(Boolean).join(" ");
}

/** The tail as marketplace entries, for the registry to append to the nine it
 *  writes out by hand. */
export const SEEDED_MODEL_INTEGRATIONS: readonly IntegrationCatalogEntry[] = MODEL_PROVIDER_SEEDS.map((seed) => ({
    slug: seed.slug,
    name: seed.name,
    category: "Models" as const,
    summary: seed.summary,
    description: describe(seed),
    docsUrl: seed.docsUrl,
    setupLinks: seed.keyUrl ? [{ label: "Create an API key", url: seed.keyUrl }] : undefined,
    requiresApiKey: true,
    apiKeyLabel: "API key",
    defaultModel: seed.defaultModel,
    freeTier: seed.free
}));
