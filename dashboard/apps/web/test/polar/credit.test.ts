import { describe, expect, it, vi } from "vitest";
import {
    POLAR_OUTPUT_DEFAULT,
    PaidModelError,
    creditMiddleware,
    creditRetry,
    freeVariantOf,
    polarOutputTokens
} from "@/lib/polar/credit";
import { classifyProviderFailure } from "@/lib/polar/provider-failure";

/** OpenRouter's 402 as the SDK surfaces it. */
function refusal(afford: number | null) {
    return Object.assign(new Error("Payment Required"), {
        statusCode: 402,
        responseBody: JSON.stringify({
            error: {
                code: 402,
                message:
                    afford === null
                        ? "Insufficient credits."
                        : `This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford ${afford}.`
            }
        })
    });
}

describe("polarOutputTokens", () => {
    it("caps an OpenRouter model at the default, or at its own smaller limit", () => {
        expect(polarOutputTokens({ provider: "openrouter", outputTokens: 65536 })).toBe(
            POLAR_OUTPUT_DEFAULT
        );
        expect(polarOutputTokens({ provider: "openrouter", outputTokens: 4096 })).toBe(4096);
        expect(polarOutputTokens({ provider: "openrouter" })).toBe(POLAR_OUTPUT_DEFAULT);
    });

    it("leaves other providers to their SDK default", () => {
        expect(polarOutputTokens({ provider: "anthropic", outputTokens: 64000 })).toBeUndefined();
    });
});

describe("freeVariantOf", () => {
    const models = [{ model: "deepseek/deepseek-r1" }, { model: "deepseek/deepseek-r1:free" }];
    it("finds the listed :free variant only", () => {
        expect(freeVariantOf("deepseek/deepseek-r1", models)).toBe("deepseek/deepseek-r1:free");
        expect(freeVariantOf("openai/gpt-4o", models)).toBeNull();
        expect(freeVariantOf("deepseek/deepseek-r1:free", models)).toBeNull();
    });
});

describe("creditRetry", () => {
    it("asks again at the affordable size when it is usable", () => {
        expect(creditRetry(refusal(22800), 65536, false)).toEqual({
            kind: "afford",
            tokens: 22800
        });
    });

    it("moves to the free variant, or says the model needs credit, when too little is left", () => {
        expect(creditRetry(refusal(12), 16384, true)).toEqual({ kind: "free" });
        expect(creditRetry(refusal(null), 16384, false)).toEqual({ kind: "paid" });
    });

    it("leaves anything that is not a 402 alone", () => {
        expect(
            creditRetry(Object.assign(new Error("x"), { statusCode: 429 }), 100, true)
        ).toBeNull();
        expect(creditRetry(new Error("network"), 100, true)).toBeNull();
    });
});

describe("creditMiddleware", () => {
    const params = { prompt: [], maxOutputTokens: 16384 } as never;

    it("retries once at the affordable size", async () => {
        const model = { doStream: vi.fn().mockResolvedValue("ok") };
        const result = await creditMiddleware(null).wrapStream!({
            doStream: () => Promise.reject(refusal(9000)),
            doGenerate: vi.fn(),
            params,
            model: model as never
        });
        expect(result).toBe("ok");
        expect(model.doStream).toHaveBeenCalledWith(
            expect.objectContaining({ maxOutputTokens: 9000 })
        );
    });

    it("answers with the free variant when the account has nothing to spend", async () => {
        const free = { doGenerate: vi.fn().mockResolvedValue("free") };
        const result = await creditMiddleware(() => free as never).wrapGenerate!({
            doGenerate: () => Promise.reject(refusal(0)),
            doStream: vi.fn(),
            params,
            model: {} as never
        });
        expect(result).toBe("free");
    });

    it("fails as a paid model when there is no free variant", async () => {
        const failure = await creditMiddleware(null).wrapGenerate!({
            doGenerate: () => Promise.reject(refusal(0)),
            doStream: vi.fn(),
            params,
            model: {} as never
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(PaidModelError);
        expect(classifyProviderFailure(failure).kind).toBe("paid");
        expect(classifyProviderFailure({ lastError: failure }).kind).toBe("paid");
    });
});
