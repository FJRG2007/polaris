/** Search words for the AI providers, kept apart so the catalogue store can
 *  index them without importing the screens' modules. */

/**
 * What somebody types when they are looking for a provider by the thing it
 * serves rather than by the company that serves it. "gemini" is how most people
 * would look for Google AI, and "claude" for Anthropic.
 */
export const PROVIDER_ALIASES: Record<string, string[]> = {
    anthropic: ["claude"],
    openai: ["gpt", "chatgpt", "codex"],
    "google-ai": ["gemini", "ai studio"],
    xai: ["grok"],
    deepseek: [],
    moonshot: ["kimi"],
    groq: ["gpt oss", "llama"],
    cerebras: ["glm"],
    openrouter: ["router"],
    enigma: ["gateway", "openai compatible", "endpoint"],
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
    "opencode-go": ["go"],
    upstage: ["solar"],
    inception: ["mercury"],
    "nano-gpt": ["nanogpt"]
};
