/**
 * Every provider Polar can reach says "no credit", "too many requests", "busy
 * for everyone", "no such model" and "bad key" in its own way. Each row is a
 * refusal as the provider's error reference documents it (status, and the
 * body's structured fields where the reference gives them), and the kind
 * Polar reads it as. A row whose body text is not quoted by the reference is
 * marked so: its status and structured field are documented, its wording is
 * representative.
 */

import { describe, expect, it } from "vitest";
import { classifyProviderFailure, type FailureKind } from "@/lib/polar/provider-failure";

type Row = [provider: string, status: number, body: unknown, kind: FailureKind];

function refusal(status: number, body: unknown) {
    return Object.assign(new Error("refused"), {
        statusCode: status,
        responseBody: typeof body === "string" ? body : JSON.stringify(body)
    });
}

const ROWS: Row[] = [
    // OpenAI: developers.openai.com/api/docs/guides/error-codes
    [
        "openai quota",
        429,
        {
            error: {
                message:
                    "You exceeded your current quota, please check your plan and billing details.",
                type: "insufficient_quota",
                code: "insufficient_quota"
            }
        },
        "credit"
    ],
    [
        "openai credit exhausted",
        429,
        {
            error: {
                message: "Credit balance exhausted",
                type: "insufficient_quota",
                code: "credit_balance_exhausted"
            }
        },
        "credit"
    ],
    [
        "openai project spend limit",
        429,
        {
            error: {
                message: "Project spend limit reached",
                type: "insufficient_quota",
                code: "project_spend_limit_exceeded"
            }
        },
        "credit"
    ],
    [
        "openai rate limit",
        429,
        {
            error: {
                message:
                    "Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Used 30000, Requested 900.",
                type: "tokens",
                code: "rate_limit_exceeded"
            }
        },
        "rate"
    ],
    [
        "openai slow down",
        429,
        { error: { message: "Slow down", type: "rate_limit_error", code: "slow_down" } },
        "rate"
    ],
    [
        "openai overloaded",
        503,
        {
            error: {
                message: "The model is overloaded.",
                type: "service_unavailable_error",
                code: "server_is_overloaded"
            }
        },
        "busy"
    ],
    [
        "openai bad key",
        401,
        {
            error: {
                message: "Incorrect API key provided: sk-xxx.",
                type: "invalid_request_error",
                code: "invalid_api_key"
            }
        },
        "key"
    ],
    [
        "openai model",
        404,
        {
            error: {
                message: "The model `gpt-9` does not exist or you do not have access to it.",
                type: "invalid_request_error",
                code: "model_not_found"
            }
        },
        "model"
    ],

    // Anthropic: platform.claude.com/docs/en/api/errors
    [
        "anthropic credit balance",
        400,
        {
            type: "error",
            error: {
                type: "invalid_request_error",
                message:
                    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."
            }
        },
        "credit"
    ],
    [
        "anthropic billing",
        402,
        {
            type: "error",
            error: { type: "billing_error", message: "There's an issue with your billing." }
        },
        "credit"
    ],
    [
        "anthropic rate",
        429,
        {
            type: "error",
            error: {
                type: "rate_limit_error",
                message: "Number of request tokens has exceeded your per-minute rate limit."
            }
        },
        "rate"
    ],
    [
        "anthropic overloaded",
        529,
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        "busy"
    ],
    [
        "anthropic not found",
        404,
        { type: "error", error: { type: "not_found_error", message: "model: claude-x" } },
        "model"
    ],
    [
        "anthropic key",
        401,
        { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
        "key"
    ],
    [
        "anthropic api error",
        500,
        { type: "error", error: { type: "api_error", message: "Internal server error" } },
        "down"
    ],

    // Gemini: aistudio.google.com/docs/api-errors
    [
        "gemini quota (mentions billing, still a rate limit)",
        429,
        {
            error: {
                code: 429,
                message:
                    "You exceeded your current quota, please check your plan and billing details.",
                status: "RESOURCE_EXHAUSTED",
                details: [
                    {
                        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                        violations: [
                            { quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }
                        ]
                    }
                ]
            }
        },
        "rate"
    ],
    [
        "gemini overloaded",
        503,
        {
            error: {
                code: 503,
                message: "The model is overloaded. Please try again later.",
                status: "UNAVAILABLE"
            }
        },
        "busy"
    ],
    [
        "gemini prepay depleted",
        402,
        {
            error: {
                code: 402,
                message: "Prepay credit balance is depleted.",
                status: "PAYMENT_REQUIRED"
            }
        },
        "credit"
    ],
    [
        "gemini billing precondition",
        400,
        {
            error: {
                code: 400,
                message:
                    "Gemini API free tier is not available in your country. Please enable billing on your project.",
                status: "FAILED_PRECONDITION"
            }
        },
        "credit"
    ],
    [
        "gemini model",
        404,
        {
            error: {
                code: 404,
                message: "models/gemini-9 is not found for API version v1beta.",
                status: "NOT_FOUND"
            }
        },
        "model"
    ],
    [
        "gemini key",
        400,
        {
            error: {
                code: 400,
                message: "API key not valid.",
                status: "INVALID_ARGUMENT",
                details: [{ reason: "API_KEY_INVALID" }]
            }
        },
        "key"
    ],
    [
        "gemini verification",
        403,
        {
            error: {
                code: 403,
                message: "Free tier verification required.",
                status: "PERMISSION_DENIED"
            }
        },
        "key"
    ],
    // Gemini's streaming errors arrive as an array.
    [
        "gemini streamed quota",
        429,
        [
            {
                error: {
                    code: 429,
                    message: "Resource has been exhausted.",
                    status: "RESOURCE_EXHAUSTED"
                }
            }
        ],
        "rate"
    ],

    // Groq: console.groq.com/docs/errors (its 429 points at billing for an upgrade)
    [
        "groq rate",
        429,
        {
            error: {
                message:
                    "Rate limit reached for model `llama-3.3-70b-versatile` on tokens per minute (TPM): Limit 6000. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing",
                type: "tokens",
                code: "rate_limit_exceeded"
            }
        },
        "rate"
    ],
    [
        "groq flex at capacity",
        498,
        { error: { message: "Flex tier capacity exceeded.", type: "invalid_request_error" } },
        "busy"
    ],
    [
        "groq unavailable",
        503,
        { error: { message: "Service Unavailable", type: "internal_server_error" } },
        "down"
    ],
    [
        "groq decommissioned",
        400,
        {
            error: {
                message:
                    "The model `mixtral-8x7b-32768` has been decommissioned and is no longer supported.",
                type: "invalid_request_error",
                code: "model_decommissioned"
            }
        },
        "model"
    ],

    // DeepSeek: api-docs.deepseek.com/quick_start/error_codes
    [
        "deepseek balance",
        402,
        {
            error: {
                message: "Insufficient Balance",
                type: "unknown_error",
                param: null,
                code: "invalid_request_error"
            }
        },
        "credit"
    ],
    [
        "deepseek rate",
        429,
        { error: { message: "Rate Limit Reached", type: "rate_limit_error" } },
        "rate"
    ],
    [
        "deepseek overloaded",
        503,
        {
            error: {
                message: "The server is overloaded due to high traffic.",
                type: "server_error"
            }
        },
        "busy"
    ],
    [
        "deepseek key",
        401,
        { error: { message: "Authentication Fails", type: "authentication_error" } },
        "key"
    ],

    // Cerebras: inference-docs.cerebras.ai/support/error (statuses; body wording representative)
    [
        "cerebras payment",
        402,
        {
            message: "Payment required. Visit your billing tab.",
            type: "payment_required_error",
            code: "payment_required"
        },
        "credit"
    ],
    [
        "cerebras token quota",
        429,
        {
            message: "Tokens per minute limit exceeded.",
            type: "too_many_requests_error",
            code: "token_quota_exceeded"
        },
        "rate"
    ],
    [
        "cerebras queue",
        503,
        {
            message: "We're experiencing high traffic right now.",
            type: "service_unavailable",
            code: "queue_exceeded"
        },
        "busy"
    ],

    // xAI: docs.x.ai/docs/key-information/debugging (statuses; body wording representative)
    [
        "xai no credits",
        403,
        {
            code: "The caller does not have permission",
            error: "Your team doesn't have any credits yet."
        },
        "credit"
    ],
    [
        "xai spending limit",
        429,
        {
            code: "Too many requests",
            error: "Your team has used all available credits or reached its monthly spending limit."
        },
        "credit"
    ],
    ["xai rate", 429, { code: "Too many requests", error: "Rate limit exceeded." }, "rate"],
    ["xai key", 401, { code: "Unauthorized", error: "Incorrect API key provided." }, "key"],

    // Mistral (status codes; capacity type as its API returns it)
    ["mistral rate", 429, { message: "Requests rate limit exceeded" }, "rate"],
    [
        "mistral capacity",
        429,
        {
            object: "error",
            message: "Service tier capacity exceeded for this model.",
            type: "service_tier_capacity_exceeded",
            code: "3505"
        },
        "busy"
    ],

    // Together: docs.together.ai/docs/error-codes (statuses)
    [
        "together credit",
        402,
        { error: { message: "Credit limit exceeded.", type: "credit_limit" } },
        "credit"
    ],
    ["together overloaded", 529, { error: { message: "Model at max replicas." } }, "busy"],
    ["together unavailable", 503, "Service Unavailable", "busy"],

    // Fireworks (statuses)
    [
        "fireworks payment",
        402,
        { error: { message: "Payment required.", type: "invalid_request_error" } },
        "credit"
    ],
    ["fireworks rate", 429, { error: { message: "Too many requests." } }, "rate"],

    // Azure OpenAI: learn.microsoft.com/azure/ai-foundry/openai/quotas-limits
    [
        "azure rate",
        429,
        {
            error: {
                code: "429",
                message:
                    "Requests to the ChatCompletions_Create Operation have exceeded token rate limit of your current OpenAI S0 pricing tier. Please retry after 6 seconds."
            }
        },
        "rate"
    ],
    [
        "azure deployment",
        404,
        {
            error: {
                code: "DeploymentNotFound",
                message: "The API deployment for this resource does not exist."
            }
        },
        "model"
    ],
    [
        "azure key",
        401,
        {
            error: {
                code: "401",
                message: "Access denied due to invalid subscription key or wrong API endpoint."
            }
        },
        "key"
    ],

    // OpenRouter: openrouter.ai/docs/api-reference/errors
    [
        "openrouter credits",
        402,
        { error: { code: 402, message: "Insufficient credits" } },
        "credit"
    ],
    [
        "openrouter budget spent",
        403,
        {
            error: {
                code: 403,
                message: "Budget spent",
                metadata: { limit_source: "openrouter_guardrail_budget" }
            }
        },
        "credit"
    ],
    [
        "openrouter moderation",
        403,
        {
            error: {
                code: 403,
                message: "Input was flagged",
                metadata: { reasons: ["violence"], flagged_input: "..." }
            }
        },
        "other"
    ],
    [
        "openrouter forwarded provider limit",
        429,
        {
            error: {
                code: 429,
                message: "Rate limit exceeded",
                metadata: { error_type: "rate_limit_exceeded", provider_code: "rate_limited" }
            }
        },
        "busy"
    ],
    [
        "openrouter free daily limit",
        429,
        {
            error: {
                code: 429,
                message:
                    "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"
            }
        },
        "rate"
    ],
    [
        "openrouter upstream free model",
        429,
        {
            error: {
                code: 429,
                message: "Provider returned error",
                metadata: {
                    raw: "meta-llama/llama:free is temporarily rate-limited upstream. Please retry shortly."
                }
            }
        },
        "busy"
    ],
    [
        "openrouter provider down",
        502,
        {
            error: {
                code: 502,
                message: "Provider returned error",
                metadata: { error_type: "provider_unavailable" }
            }
        },
        "down"
    ],
    [
        "openrouter provider overloaded",
        503,
        {
            error: {
                code: 503,
                message: "No available provider",
                metadata: { error_type: "provider_overloaded" }
            }
        },
        "busy"
    ],

    // Vercel AI Gateway: error types from @ai-sdk/gateway
    [
        "gateway model",
        404,
        { error: { message: "Model not found", type: "model_not_found" } },
        "model"
    ],
    [
        "gateway rate",
        429,
        { error: { message: "Rate limit exceeded", type: "rate_limit_exceeded" } },
        "rate"
    ],
    [
        "gateway key",
        401,
        { error: { message: "Invalid API key", type: "authentication_error" } },
        "key"
    ],
    [
        "gateway funds",
        402,
        { error: { message: "Insufficient funds", type: "insufficient_funds" } },
        "credit"
    ],

    // LiteLLM proxy: docs.litellm.ai/docs/exception_mapping
    [
        "litellm budget",
        400,
        {
            error: {
                message: "Budget has been exceeded! Current cost: 10.2, Max budget: 10.0",
                type: "budget_exceeded",
                param: null,
                code: "400"
            }
        },
        "credit"
    ],
    [
        "litellm rate",
        429,
        {
            error: {
                message:
                    "litellm.RateLimitError: RateLimitError: OpenAIException - Rate limit reached",
                type: null,
                param: null,
                code: "429"
            }
        },
        "rate"
    ],

    // Ollama (local): a model that was never pulled
    [
        "ollama not pulled",
        404,
        {
            error: {
                message: 'model "llama3" not found, try pulling it first',
                type: "api_error",
                param: null,
                code: null
            }
        },
        "model"
    ],

    // Moonshot (Kimi)
    [
        "moonshot quota",
        429,
        {
            error: {
                message: "Your account is suspended, please check your plan and billing details",
                type: "exceeded_current_quota_error"
            }
        },
        "credit"
    ],
    [
        "moonshot overloaded",
        429,
        {
            error: {
                message: "The engine is currently overloaded, please try again later",
                type: "engine_overloaded_error"
            }
        },
        "busy"
    ],
    [
        "moonshot rate",
        429,
        {
            error: { message: "Your account reached max request", type: "rate_limit_reached_error" }
        },
        "rate"
    ]
];

describe("every provider's refusal reads as the kind it means", () => {
    it.each(ROWS)("%s (%i)", (_name, status, body, kind) => {
        expect(classifyProviderFailure(refusal(status, body)).kind).toBe(kind);
    });

    it("reads a failure wrapped by a retry", () => {
        const inner = refusal(529, {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" }
        });
        expect(classifyProviderFailure({ lastError: inner }).kind).toBe("busy");
    });

    it("reads a stream that failed after it started by its error object", () => {
        expect(
            classifyProviderFailure({ type: "overloaded_error", message: "Overloaded" }).kind
        ).toBe("busy");
        expect(
            classifyProviderFailure({ error: { type: "rate_limit_error", message: "slow" } }).kind
        ).toBe("rate");
        expect(classifyProviderFailure(new Error("socket hang up")).kind).toBe("other");
    });

    it("does not read a huge body past its cap", () => {
        const body = `${"x".repeat(40_000)} insufficient_quota`;
        expect(classifyProviderFailure(refusal(400, body)).kind).toBe("other");
    });
});
