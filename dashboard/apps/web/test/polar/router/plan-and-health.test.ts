/**
 * What the router remembers about a refusal and for how long, a key's own
 * allowance, the routing a person saves, and the plan a call walks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    today: [] as Array<{ keyId: string; _count: { _all: number }; _sum: Record<string, number> }>,
    month: [] as Array<{ keyId: string; _sum: Record<string, number> }>
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        userModelKey: { updateMany: vi.fn(async () => ({ count: 1 })) },
        polarUsage: {
            groupBy: vi.fn(async (args: { _count?: unknown }) => (args._count ? db.today : db.month))
        }
    }
}));

const health = await import("@/lib/polar/router/health");
const limits = await import("@/lib/polar/router/limits");
const routing = await import("@/lib/polar/routing");
const { keyLimitsOf, keyLimitsSchema, NO_KEY_LIMITS } = await import("@/lib/agents/key-limits");
const { planSteps } = await import("@/lib/polar/router/plan");

beforeEach(() => {
    health.resetRouteHealth();
    limits.resetKeyAdmission();
    db.today = [];
    db.month = [];
});

const withHeaders = (headers: Record<string, string>) =>
    Object.assign(new Error("x"), { statusCode: 429, responseHeaders: headers });

describe("Retry-After", () => {
    it("reads seconds, milliseconds and an HTTP date, and caps it at an hour", () => {
        const now = Date.parse("2026-11-10T10:00:00Z");
        expect(health.retryAfterMs(withHeaders({ "Retry-After": "12" }), now)).toBe(12_000);
        expect(health.retryAfterMs(withHeaders({ "retry-after-ms": "250" }), now)).toBe(250);
        expect(
            health.retryAfterMs(withHeaders({ "retry-after": "Tue, 10 Nov 2026 10:00:30 GMT" }), now)
        ).toBe(30_000);
        expect(health.retryAfterMs(withHeaders({ "retry-after": "86400" }), now)).toBe(3_600_000);
        expect(health.retryAfterMs(withHeaders({ "retry-after": "soon" }), now)).toBeNull();
        expect(health.retryAfterMs(new Error("no headers"), now)).toBeNull();
    });

    it("lets a provider's own wait decide a rate limit, never a refused key", () => {
        expect(health.coolingMs("rate", 5_000)).toBe(5_000);
        expect(health.coolingMs("rate", null)).toBe(health.COOLING_MS.rate);
        expect(health.coolingMs("key", 5_000)).toBe(health.COOLING_MS.key);
        expect(health.coolingMs("other", null)).toBeNull();
    });
});

describe("what a refusal cools, and for whom", () => {
    const now = Date.parse("2026-11-10T10:00:00Z");
    const subject = { provider: "groq", model: "llama", keyId: "k1" };

    it("cools a rate limit for that key and model only", async () => {
        await health.noteRefusal(subject, "rate", new Error("x"), now);
        expect(health.coolingOf(subject, false, now + 1)?.kind).toBe("rate");
        expect(health.coolingOf({ ...subject, model: "other" }, false, now + 1)).toBeNull();
        expect(health.coolingOf({ ...subject, keyId: "k2" }, false, now + 1)).toBeNull();
        expect(health.coolingOf(subject, false, now + health.COOLING_MS.rate + 1)).toBeNull();
    });

    it("cools a busy model for every key, an outage for the whole provider", async () => {
        await health.noteRefusal(subject, "busy", new Error("x"), now);
        expect(health.coolingOf({ ...subject, keyId: "k2" }, false, now + 1)?.scope).toBe("model");
        await health.noteRefusal({ provider: "groq", model: "x", keyId: "k3" }, "down", new Error("x"), now);
        expect(
            health.coolingOf({ provider: "groq", model: "y", keyId: "k9" }, false, now + 1)?.scope
        ).toBe("provider");
    });

    it("still offers a key with no credit for a free model", async () => {
        await health.noteRefusal(subject, "credit", new Error("x"), now);
        expect(health.coolingOf({ ...subject, model: "paid" }, false, now + 1)?.kind).toBe("credit");
        expect(health.coolingOf({ ...subject, model: "free" }, true, now + 1)).toBeNull();
    });

    it("reads a cool-down written on the row by another process", () => {
        const row = { ...subject, coolingUntil: new Date(now + 60_000), coolingReason: "key" };
        expect(health.coolingOf(row, true, now)?.kind).toBe("key");
        expect(health.coolingOf(row, false, now + 61_000)).toBeNull();
    });
});

describe("a key's own allowance", () => {
    const perMinute = { ...NO_KEY_LIMITS, requestsPerMinute: 2 };

    it("admits calls up to the minute's limit and says when the next slot opens", () => {
        const now = 1_000_000;
        expect(limits.admit("k", perMinute, now).ok).toBe(true);
        expect(limits.admit("k", perMinute, now + 10).ok).toBe(true);
        const third = limits.admit("k", perMinute, now + 20);
        expect(third.ok).toBe(false);
        if (!third.ok) expect(third.retryInMs).toBe(59_980);
        expect(limits.admit("k", perMinute, now + 60_001).ok).toBe(true);
    });

    it("holds calls at once to the concurrency limit until one is released", () => {
        const one = { ...NO_KEY_LIMITS, concurrency: 1 };
        const first = limits.admit("c", one);
        expect(first.ok).toBe(true);
        expect(limits.admit("c", one).ok).toBe(false);
        if (first.ok) first.release();
        expect(limits.admit("c", one).ok).toBe(true);
    });

    it("lets a key with no limit through without counting", () => {
        expect(limits.admit("free", NO_KEY_LIMITS).ok).toBe(true);
        expect(limits.keyPressure("free").lastMinute).toBe(0);
    });

    it("says which of the day and month limits a key has spent", () => {
        const set = { ...NO_KEY_LIMITS, requestsPerDay: 10, tokensPerMonth: 1_000 };
        expect(limits.allowanceState(set, { requestsToday: 9, tokensToday: 0, tokensThisMonth: 0 })).toBe("ready");
        expect(limits.allowanceState(set, { requestsToday: 10, tokensToday: 0, tokensThisMonth: 0 })).toBe("limit_day");
        expect(limits.allowanceState(set, { requestsToday: 0, tokensToday: 0, tokensThisMonth: 1_000 })).toBe(
            "limit_month"
        );
    });

    it("reads a stored allowance whole, and anything unreadable as no limit", () => {
        expect(keyLimitsOf('{"requestsPerDay":50}').requestsPerDay).toBe(50);
        expect(keyLimitsOf("not json")).toEqual(NO_KEY_LIMITS);
        expect(keyLimitsOf({ requestsPerDay: -3 })).toEqual(NO_KEY_LIMITS);
        expect(keyLimitsSchema.safeParse({ tokensPerDay: 1.5 }).success).toBe(false);
    });
});

describe("the routing a person saves", () => {
    const target = (model: string, keyId: string | null = null) => ({
        provider: "groq",
        model,
        reasoning: "inherit" as const,
        keyId
    });
    const KEY = "0190a6f2-0000-7000-8000-000000000001";

    it("refuses the same model on the same key twice, allows it on another key", () => {
        expect(routing.polarRoutingSchema.safeParse({ fallbacks: [target("a"), target("a")] }).success).toBe(false);
        expect(routing.polarRoutingSchema.safeParse({ fallbacks: [target("a"), target("a", KEY)] }).success).toBe(true);
    });

    it("caps the list", () => {
        const many = Array.from({ length: routing.FALLBACKS_MOST + 1 }, (_, index) => target(`m${index}`));
        expect(routing.polarRoutingSchema.safeParse({ fallbacks: many }).success).toBe(false);
    });

    it("reads anything unreadable as the defaults", () => {
        expect(routing.routingOf({ fallbacks: "nope" })).toEqual(routing.POLAR_ROUTING_DEFAULTS);
        expect(routing.routingIsSet(routing.POLAR_ROUTING_DEFAULTS)).toBe(false);
    });

    it("matches a coding tool's model id to a Claude tier in free-claude-code's order", () => {
        expect(routing.tierOf("claude-opus-4-1-20250805")).toBe("opus");
        expect(routing.tierOf("claude-3-5-haiku-latest")).toBe("haiku");
        expect(routing.tierOf("claude-sonnet-4-5")).toBe("sonnet");
        expect(routing.tierOf("claude-fable-5-1")).toBe("fable");
        expect(routing.tierOf("gpt-5")).toBeNull();
    });

    it("works out each step's effort", () => {
        expect(routing.reasoningForRoute("inherit", "medium")).toBe("medium");
        expect(routing.reasoningForRoute("off", "medium")).toBe("none");
        expect(routing.reasoningForRoute("max", "low")).toBe("max");
        expect(routing.reasoningForRoute("client", "low", "high")).toBe("high");
    });
});

describe("the plan a call walks", () => {
    const option = (model: string) => ({
        provider: "groq",
        providerName: "Groq",
        model,
        name: model,
        reasoning: false,
        attachment: false,
        contextTokens: 0,
        providerContextTokens: null,
        costInput: 0,
        costOutput: 0,
        inputs: [],
        releaseDate: null
    });
    const key = (keyId: string, source: "own" | "instance" = "own", extra = {}) => ({
        provider: "groq",
        source,
        secret: "s",
        baseUrl: null,
        gatewayModel: null,
        keyId,
        limits: NO_KEY_LIMITS,
        ...extra
    });
    const entry = (model: string, credentials: ReturnType<typeof key>[]) => ({
        option: option(model),
        credentials,
        build: () => ({}) as never
    });

    it("lines up the chosen model on every key, then the fallbacks, once each", async () => {
        const steps = await planSteps(
            [entry("a", [key("k1"), key("k2")]), entry("b", [key("k1")]), entry("a", [key("k1")])],
            async () => true
        );
        expect(steps.map((step) => `${step.modelId}@${step.keyId}`)).toEqual(["a@k1", "a@k2", "b@k1"]);
    });

    it("leaves out a key that spent its day, and the deployment's key when its ceiling is reached", async () => {
        db.today = [{ keyId: "k1", _count: { _all: 5 }, _sum: { inputTokens: 0, outputTokens: 0 } }];
        const spentKey = key("k1", "own", { limits: { ...NO_KEY_LIMITS, requestsPerDay: 5 } });
        const steps = await planSteps(
            [entry("a", [spentKey, key("k2")]), entry("b", [key("k9", "instance")])],
            async () => false
        );
        expect(steps.map((step) => step.keyId)).toEqual(["k2"]);
    });

    it("keeps a spent first key as a step that refuses, when it is all there is", async () => {
        db.today = [{ keyId: "k1", _count: { _all: 5 }, _sum: { inputTokens: 0, outputTokens: 0 } }];
        const spentKey = key("k1", "own", { limits: { ...NO_KEY_LIMITS, requestsPerDay: 5 } });
        const steps = await planSteps([entry("a", [spentKey])], async () => true);
        expect(steps).toHaveLength(1);
        expect(steps[0]?.spent).toBe(true);
    });
});
