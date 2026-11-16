/**
 * An answer of `GET https://opencode.ai/zen/v1/models`, trimmed. The first two
 * entries were recorded on 2026-11-16 (`big-pickle`,
 * `deepseek-v4.1-flash-free`, fields cut to the ones read); the others are
 * fixtures shaped like them: a priced model, a model with no chat-completions
 * address, one pointing off OpenCode's host, and one that does not parse.
 */

export const ZEN_MODELS_ANSWER = {
    object: "list",
    data: [
        {
            id: "big-pickle",
            object: "model",
            name: "Big Pickle",
            type: "chat",
            release_date: "2025-10-17",
            modalities: { input: ["text"], output: ["text"] },
            capabilities: { tools: { supported: true }, reasoning: { supported: true } },
            limit: { context: 200000, input: 160000, output: 32000 },
            cost: {
                text: {
                    input: { price: 0, cache: { read: 0, write: 0 } },
                    output: { price: 0 }
                }
            },
            api: {
                "chat-completions": {
                    base_url: "https://opencode.ai/inference/openai/v1",
                    sdk: { aisdk: "@ai-sdk/openai-compatible" }
                }
            }
        },
        {
            id: "deepseek-v4.1-flash-free",
            object: "model",
            name: "DeepSeek V4.1 Flash Free",
            type: "chat",
            release_date: "2026-10-17",
            modalities: { input: ["text", "image/jpeg", "image/png"], output: ["text"] },
            capabilities: {
                tools: { supported: true },
                reasoning: { supported: true, toggle: true, effort: ["low", "high", "max"] }
            },
            limit: { context: 200000, output: 32000 },
            cost: { text: { input: { price: 0, cache: { read: 0 } }, output: { price: 0 } } },
            api: {
                "chat-completions": {
                    base_url: "https://opencode.ai/inference/openai/v1",
                    sdk: { aisdk: "@ai-sdk/openai-compatible" }
                }
            }
        },
        {
            id: "fixture-priced",
            name: "Fixture Priced",
            type: "chat",
            cost: { text: { input: { price: 1.25 }, output: { price: 10 } } },
            api: { "chat-completions": { base_url: "https://opencode.ai/inference/openai/v1" } }
        },
        {
            id: "fixture-messages-only",
            name: "Fixture Messages Only",
            type: "chat",
            cost: { text: { input: { price: 0 }, output: { price: 0 } } },
            api: { messages: { base_url: "https://opencode.ai/inference/anthropic/v1" } }
        },
        {
            id: "fixture-elsewhere",
            name: "Fixture Elsewhere",
            type: "chat",
            cost: { text: { input: { price: 0 }, output: { price: 0 } } },
            api: { "chat-completions": { base_url: "https://example.invalid/v1" } }
        },
        { id: 42, name: null }
    ]
};
