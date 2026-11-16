/**
 * The session API's own logic: how a session's stream is read in order and
 * resumed from a cursor, how a model asked for by name is checked against what
 * the person can start on, and what the route wrapper answers before a handler
 * ever runs. Starting and prompting a real agent needs a container and is not
 * exercised here.
 */

import { z } from "zod";
import * as sdk from "@polaris/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    events: vi.fn(),
    messages: vi.fn(),
    authenticate: vi.fn(),
    rateLimit: vi.fn(),
    polarModels: vi.fn(),
    credential: vi.fn(),
    defaults: vi.fn(),
    composer: vi.fn()
}));

vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@polaris/db", () => ({
    prisma: {
        agentSessionEvent: { findMany: mocks.events },
        agentSessionMessage: { findMany: mocks.messages }
    }
}));
vi.mock("@/lib/agents/session-service", () => {
    class SessionRefusal extends Error {}
    return { SessionRefusal, getSession: vi.fn(), readableFailure: () => "failed" };
});
vi.mock("@/lib/agents/session-runtime", () => ({}));
vi.mock("@/lib/agents/session-queue", () => ({}));
vi.mock("@/lib/polar/models", () => ({ polarModelOptions: mocks.polarModels }));
vi.mock("@/lib/polar/access", () => ({ polarCredentialFor: mocks.credential }));
vi.mock("@/lib/polar/agents/defaults", () => ({ agentDefaultsFor: mocks.defaults }));
vi.mock("@/lib/agents/agent-readiness", () => ({ agentOptionsFor: async () => [] }));
vi.mock("@/lib/polar/agents/composer-agents", () => ({ codeComposerFor: mocks.composer }));
vi.mock("@/lib/api-key-auth", () => ({ authenticateApiKey: mocks.authenticate }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/api-usage/recorder", () => ({ withKeyUsage: <T>(handler: T) => handler }));

const api = await import("@/lib/agents/session-api");
const http = await import("@/lib/agents/session-api-http");
const { SessionRefusal } = await import("@/lib/agents/session-service");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (ms: number) => new Date(ms);
const event = (n: number, ms: number) => ({
    id: id(n),
    kind: "tool",
    detail: "",
    subject: "",
    createdAt: at(ms)
});
const message = (n: number, ms: number) => ({
    id: id(n),
    role: "agent",
    kind: "text",
    subject: "",
    body: `m${n}`,
    createdAt: at(ms)
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimit.mockResolvedValue({ ok: true, retryAfterMs: 0 });
});

describe("streamAfter", () => {
    it("interleaves events and messages by time, then id, with a cursor that has both", async () => {
        mocks.events.mockResolvedValue([event(1, 1000), event(3, 3000)]);
        mocks.messages.mockResolvedValue([message(2, 2000), message(4, 3000)]);
        const page = await api.streamAfter("s", { event: null, message: null });
        expect(page.more).toBe(false);
        expect(page.items.map(({ item }) => item.data.id)).toEqual([id(1), id(2), id(3), id(4)]);
        expect(page.items.at(-1)!.cursor).toEqual({
            event: { at: 3000, id: id(3) },
            message: { at: 3000, id: id(4) }
        });
        // The cursor survives the round trip a reconnecting client makes.
        const wire = sdk.streamCursor(page.items[1]!.cursor);
        expect(sdk.readStreamCursor(wire)).toEqual(page.items[1]!.cursor);
    });

    it("reads after the cursor, including a row written in the same millisecond", async () => {
        mocks.events.mockResolvedValue([]);
        mocks.messages.mockResolvedValue([]);
        await api.streamAfter("s", { event: { at: 5000, id: id(9) }, message: null });
        const where = mocks.events.mock.calls[0]![0].where;
        expect(where.OR).toEqual([
            { createdAt: { gt: at(5000) } },
            { createdAt: at(5000), id: { gt: id(9) } }
        ]);
        expect(mocks.messages.mock.calls[0]![0].where.OR).toBeUndefined();
    });

    it("stops at the end of a full page, so the other kind is not sent past it", async () => {
        const full = Array.from({ length: api.STREAM_PAGE }, (_, n) => event(n + 1, 1000 + n));
        mocks.events.mockResolvedValue(full);
        mocks.messages.mockResolvedValue([message(500, 1050), message(501, 999_999)]);
        const page = await api.streamAfter("s", { event: null, message: null });
        expect(page.more).toBe(true);
        const ids = page.items.map(({ item }) => item.data.id);
        expect(ids).toContain(id(500));
        expect(ids).not.toContain(id(501));
        expect(page.items.at(-1)!.cursor.message).toEqual({ at: 1050, id: id(500) });
    });
});

describe("titleOf", () => {
    it("takes the title, else the prompt's first line, cut to a title's length", () => {
        expect(api.titleOf({ title: "Fix it", prompt: "x" })).toBe("Fix it");
        expect(api.titleOf({ title: "", prompt: "First line\nsecond" })).toBe("First line");
        expect(api.titleOf({ title: "", prompt: "a".repeat(100) })).toHaveLength(82);
        expect(api.titleOf({ title: "", prompt: "\n" })).toBe("Session");
    });
});

describe("startModel", () => {
    it("is the agent's default when none is asked for", async () => {
        expect(await api.startModel("u", "claude", "")).toBeNull();
    });

    it("refuses a name that is not provider/model", async () => {
        await expect(api.startModel("u", "opencode", "gpt")).rejects.toBeInstanceOf(SessionRefusal);
        expect(api.readModelSpec("openai/gpt-5")).toEqual({ provider: "openai", model: "gpt-5" });
        expect(api.readModelSpec("/gpt")).toBeNull();
        expect(api.readModelSpec("openai/bad model")).toBeNull();
    });

    it("runs OpenCode on a model Polar offers, pinned to the key Polar resolved", async () => {
        mocks.polarModels.mockResolvedValue([{ provider: "openai", models: [{ model: "gpt-5" }] }]);
        mocks.defaults.mockResolvedValue(new Map());
        mocks.credential.mockResolvedValue({ source: "own" });
        expect(await api.startModel("u", "opencode", "openai/gpt-5")).toEqual({
            provider: "openai",
            model: "gpt-5",
            payer: "own"
        });
        await expect(api.startModel("u", "opencode", "openai/other")).rejects.toThrow(/not a model/);
        mocks.credential.mockResolvedValue(null);
        await expect(api.startModel("u", "opencode", "openai/gpt-5")).rejects.toThrow(/not a model/);
    });

    it("keeps to Polar's own list where its settings require it", async () => {
        mocks.polarModels.mockResolvedValue([
            { provider: "openai", models: [{ model: "gpt-5" }, { model: "gpt-4o" }] }
        ]);
        mocks.defaults.mockResolvedValue(
            new Map([
                ["polar", { modelPolicy: "required", models: [{ provider: "openai", model: "gpt-5" }] }]
            ])
        );
        mocks.credential.mockResolvedValue({ source: "instance" });
        await expect(api.startModel("u", "opencode", "openai/gpt-4o")).rejects.toThrow(/not a model/);
        expect(await api.startModel("u", "opencode", "openai/gpt-5")).toMatchObject({ payer: "instance" });
    });

    it("gives a tool that takes a model by name only its own provider's, from its sources", async () => {
        mocks.composer.mockResolvedValue({
            sources: [
                { engines: ["claude"], models: [{ provider: "anthropic", model: "claude-opus-4-1" }] }
            ]
        });
        expect(await api.startModel("u", "claude", "anthropic/claude-opus-4-1")).toEqual({
            provider: "anthropic",
            model: "claude-opus-4-1",
            payer: null
        });
        await expect(api.startModel("u", "claude", "openai/gpt-5")).rejects.toThrow(/not a model/);
        await expect(api.startModel("u", "claude", "anthropic/unlisted")).rejects.toThrow(
            /not a model/
        );
    });
});

describe("sessionApiRoute", () => {
    const handler = vi.fn(async () => http.answer({ ok: true }));
    const route = http.sessionApiRoute("agents.manage", true, handler);
    const call = () =>
        route(new Request("https://polaris.test/api/v1/sessions"), { params: Promise.resolve({}) });
    const principal = { keyId: "k", userId: "u", scopes: ["agents.manage"] };

    it("answers 401 without a key and 403 without the scope, before the handler", async () => {
        mocks.authenticate.mockResolvedValue(null);
        expect((await call()).status).toBe(401);
        mocks.authenticate.mockResolvedValue({ ...principal, scopes: ["agents.read"] });
        const refused = await call();
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ requiredScope: "agents.manage" });
        expect(handler).not.toHaveBeenCalled();
    });

    it("answers 429 with Retry-After once the key's budget is spent", async () => {
        mocks.authenticate.mockResolvedValue(principal);
        mocks.rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 4200 });
        const throttled = await call();
        expect(throttled.status).toBe(429);
        expect(throttled.headers.get("retry-after")).toBe("5");
        expect(handler).not.toHaveBeenCalled();
    });

    it("names the field of a bad body, from the SDK's schemas too", async () => {
        mocks.authenticate.mockResolvedValue(principal);
        handler.mockImplementationOnce(async () => {
            sdk.createSessionBody.parse({ prompt: "" });
            return http.answer({});
        });
        const bad = await call();
        expect(bad.status).toBe(400);
        expect((await bad.json()).error).toMatch(/^prompt: /);
        handler.mockImplementationOnce(async () => {
            z.object({ text: z.string() }).parse({});
            return http.answer({});
        });
        expect((await call()).status).toBe(400);
    });

    it("passes a refusal's sentence through and hides anything else", async () => {
        mocks.authenticate.mockResolvedValue(principal);
        handler.mockRejectedValueOnce(new SessionRefusal("That session has ended."));
        const refused = await call();
        expect(refused.status).toBe(409);
        expect((await refused.json()).error).toBe("That session has ended.");
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        handler.mockRejectedValueOnce(new Error("/var/lib/secret path"));
        const failed = await call();
        expect(failed.status).toBe(500);
        expect((await failed.json()).error).not.toMatch(/secret/);
        spy.mockRestore();
    });
});
