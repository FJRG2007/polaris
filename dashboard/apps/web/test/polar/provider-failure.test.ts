/**
 * A provider's refusal, put in words somebody can act on.
 *
 * The cases are the answers providers actually give: Cerebras's 402 that
 * started this, OpenAI's quota 429, Anthropic's low-balance 400, a revoked key,
 * a retired model and an outage. The body is read to tell them apart and must
 * never come back out.
 */

import { describe, expect, it } from "vitest";
import { standIn } from "@/components/polar/polar-failure";
import {
    classifyProviderFailure,
    decodePolarFailure,
    encodePolarFailure,
    failureLogLine,
    type PolarFailure
} from "@/lib/polar/provider-failure";

/** The shape the AI SDK's APICallError carries. */
function callError(statusCode: number, responseBody = ""): Error {
    return Object.assign(new Error(`status ${statusCode}`), { statusCode, responseBody });
}

describe("classifyProviderFailure", () => {
    it("reads Cerebras's 402 as out of credit", () => {
        const body = JSON.stringify({
            type: "payment_required_error",
            message: "Visit your billing tab"
        });
        expect(classifyProviderFailure(callError(402, body))).toEqual({
            kind: "credit",
            status: 402
        });
    });

    it("reads a quota 429 as out of credit, not as a rate limit", () => {
        const body = JSON.stringify({ error: { code: "insufficient_quota" } });
        expect(classifyProviderFailure(callError(429, body)).kind).toBe("credit");
    });

    it("reads a low balance said with a 400 as out of credit", () => {
        expect(classifyProviderFailure(callError(400, "Your credit balance is too low")).kind).toBe(
            "credit"
        );
    });

    it("reads 401 and 403 as a key problem", () => {
        expect(classifyProviderFailure(callError(401)).kind).toBe("key");
        expect(classifyProviderFailure(callError(403)).kind).toBe("key");
    });

    it("reads a plain 429 as a rate limit", () => {
        expect(classifyProviderFailure(callError(429, "rate limit exceeded")).kind).toBe("rate");
    });

    it("reads 5xx as the provider being down", () => {
        expect(classifyProviderFailure(callError(503)).kind).toBe("down");
    });

    it("reads a retired model as model not found", () => {
        expect(classifyProviderFailure(callError(404)).kind).toBe("model");
        expect(classifyProviderFailure(callError(400, '{"code":"model_not_found"}')).kind).toBe(
            "model"
        );
    });

    it("finds the status inside a retry that gave up", () => {
        const retry = Object.assign(new Error("Failed after 3 attempts"), {
            lastError: callError(402)
        });
        expect(classifyProviderFailure(retry).kind).toBe("credit");
    });

    it("calls anything that is not a provider's answer other", () => {
        expect(classifyProviderFailure(new Error("socket hang up"))).toEqual({
            kind: "other",
            status: null
        });
        expect(classifyProviderFailure("nope")).toEqual({ kind: "other", status: null });
    });
});

const failure: PolarFailure = {
    code: "provider",
    kind: "credit",
    provider: "Cerebras",
    slug: "cerebras",
    payer: "instance"
};

describe("the failure the stream carries", () => {
    it("round-trips, and carries nothing of the provider's body", () => {
        const text = encodePolarFailure(failure);
        expect(decodePolarFailure(text)).toEqual(failure);
        expect(text).not.toMatch(/billing tab/);
    });

    it("is null for an older build's bare code or garbage", () => {
        expect(decodePolarFailure("polar_failed")).toBeNull();
        expect(decodePolarFailure('{"code":"provider","kind":"exploded"}')).toBeNull();
        expect(decodePolarFailure(undefined)).toBeNull();
    });

    it("logs one line with no body", () => {
        const line = failureLogLine("a turn", "Cerebras", { kind: "credit", status: 402 });
        expect(line).toBe("polar: a turn failed at Cerebras (402, credit)");
        expect(line).not.toContain("\n");
    });
});

const providers = [
    {
        provider: "cerebras",
        name: "Cerebras",
        payers: [],
        models: [
            { provider: "cerebras", model: "llama-a", name: "Llama A", reasoning: false },
            { provider: "cerebras", model: "llama-b", name: "Llama B", reasoning: false }
        ]
    },
    {
        provider: "anthropic",
        name: "Anthropic",
        payers: [],
        models: [{ provider: "anthropic", model: "claude-x", name: "Claude X", reasoning: true }]
    }
] as never;

describe("standIn", () => {
    it("offers another provider when the key's account is out of credit", () => {
        expect(standIn(failure, "llama-a", providers)?.model).toBe("claude-x");
    });

    it("offers another model of the same provider when only the model is gone", () => {
        expect(standIn({ ...failure, kind: "model" }, "llama-a", providers)?.model).toBe("llama-b");
    });

    it("offers nothing when no other provider can serve", () => {
        expect(standIn(failure, "llama-a", [(providers as unknown[])[0]] as never)).toBeNull();
    });
});
