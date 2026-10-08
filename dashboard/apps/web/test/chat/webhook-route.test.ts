/**
 * The public address a webhook is posted to.
 *
 * Discord's answers, so a tool written against Discord reads these the same
 * way: 204 on success, the message back with `?wait=true`, 404 "Unknown Webhook"
 * for any wrong address, 400 for an empty message, 429 with `Retry-After` once
 * the webhook has posted its share for the minute.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    known: true,
    posted: [] as Array<{ content: string; username?: string }>,
    limited: new Set<string>(),
    refuse: false
}));

const HOOK = { id: "0190a000-0000-7000-8000-0000000000h1", channelId: "c1", name: "CI" };

vi.mock("@/lib/chat/webhooks", () => ({
    webhookFor: async () => (state.known ? HOOK : null),
    postThroughWebhook: async (_hook: unknown, input: { content: string; username?: string }) => {
        if (state.refuse) {
            const { ChatAccessError } = await import("@/lib/chat/access");
            throw new ChatAccessError({ key: "errors.conversationArchived" });
        }
        state.posted.push(input);
        return "m1";
    }
}));

vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string) =>
        [...state.limited].some((prefix) => key.startsWith(prefix))
            ? { ok: false, retryAfterMs: 12_000 }
            : { ok: true, retryAfterMs: 0 }
}));

vi.mock("@/lib/request-context", () => ({ clientIp: async () => "203.0.113.9" }));

vi.mock("@polaris/db", () => ({ prisma: {} }));

const route = await import("@/app/api/chat/webhooks/[id]/[token]/route");

function call(body: unknown, query = "") {
    return route.POST(
        new Request(`https://polaris.test/api/chat/webhooks/${HOOK.id}/tok${query}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body)
        }),
        { params: Promise.resolve({ id: HOOK.id, token: "tok" }) }
    );
}

beforeEach(() => {
    state.known = true;
    state.posted = [];
    state.limited = new Set();
    state.refuse = false;
});

describe("posting", () => {
    it("answers 204 and posts the message", async () => {
        const response = await call({ content: "Build passed", username: "CI bot", embeds: [] });
        expect(response.status).toBe(204);
        expect(state.posted).toEqual([
            expect.objectContaining({ content: "Build passed", username: "CI bot" })
        ]);
    });

    it("hands the message back when asked to wait", async () => {
        const response = await call({ content: "hi" }, "?wait=true");
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ id: "m1", channel_id: "c1", content: "hi" });
    });

    it("refuses an empty message and a body that is not JSON", async () => {
        expect((await call({ content: "  " })).status).toBe(400);
        expect((await call("not json")).status).toBe(400);
        expect(state.posted).toEqual([]);
    });

    it("refuses a body past the cap without posting", async () => {
        const response = await call({ content: "x".repeat(70 * 1024) });
        expect(response.status).toBe(413);
    });

    it("says a refused channel is refused", async () => {
        state.refuse = true;
        expect((await call({ content: "hi" })).status).toBe(403);
    });
});

describe("the wrong address", () => {
    it("is one 404, whichever half was wrong", async () => {
        state.known = false;
        const response = await call({ content: "hi" });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ message: "Unknown Webhook" });
        expect(state.posted).toEqual([]);
    });

    it("is held back once a caller has guessed too often", async () => {
        state.known = false;
        state.limited.add("chat-webhook-miss:");
        expect((await call({ content: "hi" })).status).toBe(429);
    });
});

describe("the rate", () => {
    it("holds a webhook to its share, and says when to come back", async () => {
        state.limited.add("chat-webhook:");
        const response = await call({ content: "hi" });
        expect(response.status).toBe(429);
        expect(response.headers.get("Retry-After")).toBe("12");
        expect(state.posted).toEqual([]);
    });
});

describe("describing it", () => {
    it("answers GET with Discord's shape", async () => {
        const response = await route.GET(new Request("https://polaris.test/x"), {
            params: Promise.resolve({ id: HOOK.id, token: "tok" })
        });
        expect(await response.json()).toEqual({ id: HOOK.id, type: 1, name: "CI", channel_id: "c1" });
    });
});
