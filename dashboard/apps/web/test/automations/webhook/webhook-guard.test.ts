/**
 * The checks a webhook call passes: every credential mode, signatures and
 * their age, the caller rules, the rate limit, methods, size and media type,
 * payload shapes - and a trigger saved before any of this still answering.
 */

import * as core from "@polaris/core";
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const counters = new Map<string, number>();
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));
vi.mock("@/lib/automations/service", () => ({ AutomationAccessError: class extends Error {}, load: vi.fn() }));
vi.mock("@/lib/automations/history", () => ({ startTestRun: vi.fn() }));
vi.mock("@/lib/automations/triggers", () => ({ hookPath: () => "/api/automations/hooks/fixture" }));
vi.mock("@/lib/analytics-geoip", () => ({ countryForIp: () => null }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.test" }));
vi.mock("@/lib/geo-service", () => ({
    geoAllowedForIp: async (ip: string | undefined, countries: string[]) =>
        countries.length === 0 || countries.includes(ip?.startsWith("81.") ? "ES" : "US")
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string, limit: number, windowMs: number) => {
        const used = (counters.get(key) ?? 0) + 1;
        counters.set(key, used);
        return used > limit ? { ok: false, retryAfterMs: windowMs } : { ok: true, retryAfterMs: 0 };
    }
}));

const guard = await import("@/lib/automations/webhook-guard");
const { sampleHookRequest } = await import("@/lib/automations/webhook-service");

const SECRET = guard.hookSecret("a1", "n1", 0);
const HOOK_URL = "https://polaris.example.test/api/automations/hooks/fixture";

function config(over: Record<string, unknown> = {}): core.WebhookConfig {
    return core.webhookConfigSchema.parse({ methods: ["POST"], ...over });
}

function call(
    init: { method?: string; headers?: Record<string, string>; body?: string; query?: string } = {}
): Request {
    const method = init.method ?? "POST";
    return new Request(`${HOOK_URL}${init.query ?? ""}`, {
        method,
        headers: {
            "x-forwarded-for": "203.0.113.5",
            "content-type": "application/json",
            ...init.headers
        },
        ...(method === "GET" || method === "HEAD" ? {} : { body: init.body ?? '{"a":1}' })
    });
}

const inspect = (request: Request, cfg: core.WebhookConfig, test = false) =>
    guard.inspectHook({ request, config: cfg, secret: SECRET, hash: "h", test });

const hex = (algorithm: string, text: string) =>
    createHmac(algorithm, SECRET).update(text).digest("hex");

beforeEach(() => counters.clear());

describe("legacy triggers", () => {
    it("a trigger saved before checks reads as open, POST only, 60 a minute, 202", async () => {
        const legacy = core.webhookConfigSchema.parse({ method: "POST", rotation: 0 });
        expect(core.webhookIsLegacyOpen(legacy)).toBe(true);
        expect(core.webhookMethods(legacy)).toEqual(["POST"]);
        expect(legacy.rateLimit.total).toEqual({ count: 60, windowSeconds: 60 });
        expect(legacy.response.status).toBe(202);
        expect(legacy.bodyShape).toEqual({ kind: "any" });
        expect((await inspect(call(), legacy)).ok).toBe(true);
        expect((await inspect(call({ method: "GET" }), legacy)).ok).toBe(false);
        expect(core.webhookMethods(core.webhookConfigSchema.parse({ method: "any" }))).toHaveLength(7);
    });
    it("a new trigger starts on a header token", () => {
        const fresh = core.webhookConfigSchema.parse(core.newWebhookConfig());
        expect(core.webhookAuth(fresh).mode).toBe("header");
        expect(core.webhookIsLegacyOpen(fresh)).toBe(false);
    });
});

describe("methods", () => {
    it("answers any of the chosen methods and 405s the rest", async () => {
        const cfg = config({ methods: ["GET", "PUT"] });
        expect((await inspect(call({ method: "GET" }), cfg)).ok).toBe(true);
        const put = await inspect(call({ method: "PUT" }), cfg);
        expect(put.ok && put.payload.method).toBe("PUT");
        expect(await inspect(call({ method: "DELETE" }), cfg)).toMatchObject({
            ok: false,
            status: 405,
            reason: "method"
        });
        const response = guard.refusalResponse({ ok: false, status: 405, reason: "method" }, cfg);
        expect(response.headers.get("allow")).toBe("GET, PUT");
    });
});

describe("credentials", () => {
    it("header token: Bearer on authorization, raw on a custom header", async () => {
        const bearer = config({ auth: { mode: "header" } });
        expect(
            (await inspect(call({ headers: { authorization: `Bearer ${SECRET}` } }), bearer)).ok
        ).toBe(true);
        expect(
            await inspect(call({ headers: { authorization: "Bearer nope" } }), bearer)
        ).toMatchObject({ status: 401, reason: "auth" });
        expect(await inspect(call(), bearer)).toMatchObject({ status: 401 });
        const custom = config({ auth: { mode: "header", header: "X-Token" } });
        expect((await inspect(call({ headers: { "x-token": SECRET } }), custom)).ok).toBe(true);
        expect((await inspect(call({ headers: { "x-token": `${SECRET}x` } }), custom)).ok).toBe(
            false
        );
    });
    it("basic", async () => {
        const cfg = config({ auth: { mode: "basic", username: "ci" } });
        const good = Buffer.from(`ci:${SECRET}`).toString("base64");
        const bad = Buffer.from(`other:${SECRET}`).toString("base64");
        expect((await inspect(call({ headers: { authorization: `Basic ${good}` } }), cfg)).ok).toBe(
            true
        );
        expect((await inspect(call({ headers: { authorization: `Basic ${bad}` } }), cfg)).ok).toBe(
            false
        );
        const response = guard.refusalResponse({ ok: false, status: 401, reason: "auth" }, cfg);
        expect(response.headers.get("www-authenticate")).toContain("Basic");
        expect(await response.json()).toEqual({ error: "unauthorized" });
    });
    it("GitHub-style HMAC of the raw body", async () => {
        const cfg = config({
            auth: { mode: "hmac", preset: "github", ...core.WEBHOOK_HMAC_PRESET_VALUES.github }
        });
        const body = '{"a":1}';
        const good = { "x-hub-signature-256": `sha256=${hex("sha256", body)}` };
        expect((await inspect(call({ body, headers: good }), cfg)).ok).toBe(true);
        expect((await inspect(call({ body: '{"a":2}', headers: good }), cfg)).ok).toBe(false);
    });
    it("custom HMAC with sha1 and a timestamp inside the tolerance only", async () => {
        const cfg = config({
            auth: {
                mode: "hmac",
                algorithm: "sha1",
                header: "x-sig",
                timestampHeader: "x-ts",
                toleranceSeconds: 60
            }
        });
        const body = '{"a":1}';
        const now = Math.floor(Date.now() / 1000);
        const signed = (ts: number) => ({
            "x-sig": hex("sha1", `${ts}.${body}`),
            "x-ts": String(ts)
        });
        expect((await inspect(call({ body, headers: signed(now) }), cfg)).ok).toBe(true);
        expect(await inspect(call({ body, headers: signed(now - 600) }), cfg)).toMatchObject({
            reason: "signatureExpired"
        });
        expect((await inspect(call({ body, headers: { "x-sig": hex("sha1", body) } }), cfg)).ok).toBe(
            false
        );
    });
    it("Stripe-style t=,v1= with tolerance", async () => {
        const cfg = config({
            auth: { mode: "hmac", preset: "stripe", ...core.WEBHOOK_HMAC_PRESET_VALUES.stripe }
        });
        const body = '{"a":1}';
        const now = Math.floor(Date.now() / 1000);
        const header = (ts: number) => ({
            "stripe-signature": `t=${ts},v1=${hex("sha256", `${ts}.${body}`)}`
        });
        expect((await inspect(call({ body, headers: header(now) }), cfg)).ok).toBe(true);
        expect(await inspect(call({ body, headers: header(now - 3600) }), cfg)).toMatchObject({
            reason: "signatureExpired"
        });
    });
    it("none is open", async () => {
        expect((await inspect(call(), config({ auth: { mode: "none" } }))).ok).toBe(true);
    });
    it("Send test signs its sample so it passes every mode", async () => {
        for (const auth of [
            { mode: "header" },
            { mode: "basic", username: "u" },
            { mode: "hmac", preset: "stripe", ...core.WEBHOOK_HMAC_PRESET_VALUES.stripe },
            { mode: "hmac", timestampHeader: "x-ts" }
        ]) {
            const cfg = config({ auth });
            const answer = await inspect(sampleHookRequest(HOOK_URL, cfg, SECRET), cfg, true);
            expect(answer.ok, JSON.stringify(auth)).toBe(true);
        }
    });
});

describe("caller rules and limits", () => {
    const at = (ip: string, ua = "curl/8") =>
        call({ headers: { "x-forwarded-for": ip, "user-agent": ua } });
    it("allow and deny lists, countries and clients", async () => {
        const allow = config({ allowedCidrs: ["203.0.113.0/24"] });
        expect(await inspect(at("10.0.0.1"), allow)).toMatchObject({ status: 403, reason: "address" });
        expect((await inspect(at("203.0.113.9"), allow)).ok).toBe(true);
        expect(
            await inspect(at("203.0.113.9"), config({ deniedCidrs: ["203.0.113.9"] }))
        ).toMatchObject({ reason: "address" });
        const spain = config({ allowedCountries: ["ES"] });
        expect(await inspect(at("203.0.113.9"), spain)).toMatchObject({ reason: "country" });
        expect((await inspect(at("81.0.0.1"), spain)).ok).toBe(true);
        expect(
            await inspect(at("81.0.0.1", "Mozilla/5.0"), config({ allowedUserAgents: ["curl"] }))
        ).toMatchObject({ reason: "client" });
    });
    it("rate limits in total and per address, with Retry-After", async () => {
        const cfg = config({
            rateLimit: {
                total: { count: 3, windowSeconds: 60 },
                perIp: { count: 1, windowSeconds: 30 }
            }
        });
        expect((await inspect(call(), cfg)).ok).toBe(true);
        const second = await inspect(call(), cfg);
        expect(second).toMatchObject({ status: 429, reason: "rateLimited", retryAfterSeconds: 30 });
        if (second.ok) throw new Error("expected a refusal");
        expect(guard.refusalResponse(second, cfg).headers.get("retry-after")).toBe("30");
    });
    it("size, media type and JSON", async () => {
        expect(await inspect(call({ body: "x".repeat(3000) }), config({ maxBodyKb: 1 }))).toMatchObject({
            status: 413
        });
        expect(
            await inspect(
                call({ headers: { "content-type": "text/plain" } }),
                config({ contentTypes: ["application/json"] })
            )
        ).toMatchObject({ status: 415 });
        expect(
            (await inspect(call({ headers: { "content-type": "text/csv" } }), config({ contentTypes: ["text/*"] })))
                .ok
        ).toBe(true);
        expect(await inspect(call({ body: "{nope" }), config())).toMatchObject({
            status: 400,
            reason: "invalidJson"
        });
    });
});

describe("payload shapes", () => {
    const shape = core.inferShape({ id: 1, name: "x" });
    it("refuses a body that does not match, naming the field for the owner only", async () => {
        const cfg = config({ bodyShape: shape });
        expect((await inspect(call({ body: '{"id":1,"name":"y"}' }), cfg)).ok).toBe(true);
        const refused = await inspect(call({ body: '{"id":"1","name":"y"}' }), cfg);
        expect(refused).toMatchObject({ status: 422, reason: "shape", detail: "body.id" });
        expect(await inspect(call({ body: '{"id":1,"name":"y","x":1}' }), cfg)).toMatchObject({
            status: 422
        });
        if (refused.ok) throw new Error("expected a refusal");
        expect(await guard.refusalResponse(refused, cfg).json()).toEqual({
            error: "payload does not match"
        });
    });
    it("checks the query and required headers", async () => {
        const cfg = config({
            queryShape: {
                kind: "structured",
                root: {
                    name: "",
                    type: "object",
                    required: true,
                    nullable: false,
                    strict: false,
                    fields: [
                        { name: "id", type: "string", required: true, nullable: false, pattern: "^[0-9]+$" }
                    ]
                }
            },
            requiredHeaders: ["x-event"]
        });
        expect(await inspect(call({ query: "?id=1" }), cfg)).toMatchObject({
            status: 400,
            reason: "headers",
            detail: "x-event"
        });
        expect(
            await inspect(call({ query: "?id=a", headers: { "x-event": "e" } }), cfg)
        ).toMatchObject({ status: 422, detail: "query.id" });
        const answer = await inspect(call({ query: "?id=7", headers: { "x-event": "e" } }), cfg);
        expect(answer.ok && answer.payload.headers["x-event"]).toBe("e");
    });
    it("the test sample fits a structured body shape", async () => {
        const cfg = config({ bodyShape: shape });
        expect((await inspect(sampleHookRequest(HOOK_URL, cfg, SECRET), cfg, true)).ok).toBe(true);
    });
});

describe("curl snippet", () => {
    it("names the method and credential with a placeholder secret", () => {
        const bearer = core.webhookCurl(HOOK_URL, config({ methods: ["PUT"], auth: { mode: "header" } }));
        expect(bearer).toContain("curl -X PUT");
        expect(bearer).toContain("Authorization: Bearer $POLARIS_HOOK_SECRET");
        expect(bearer).not.toContain(SECRET);
        const stripe = core.webhookCurl(
            HOOK_URL,
            config({ auth: { mode: "hmac", preset: "stripe", ...core.WEBHOOK_HMAC_PRESET_VALUES.stripe } })
        );
        expect(stripe).toContain("t=$TS,v1=$SIG");
    });
});
