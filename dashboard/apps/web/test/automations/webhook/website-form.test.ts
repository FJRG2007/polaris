/**
 * The website form variant of the webhook trigger: the three encodings a form
 * posts with, the site allowlist, the honeypot keeping a post as spam, the
 * per-address ceiling it always has, the thank-you address, CORS and the CSV.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const counters = new Map<string, number>();
vi.mock("@polaris/db", () => ({ prisma: {}, Prisma: { DbNull: null } }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k".repeat(64) }) }));
vi.mock("@/lib/analytics-geoip", () => ({ countryForIp: () => null }));
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => true }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string, limit: number, windowMs: number) => {
        const used = (counters.get(key) ?? 0) + 1;
        counters.set(key, used);
        return used > limit ? { ok: false, retryAfterMs: windowMs } : { ok: true, retryAfterMs: 0 };
    }
}));

const guard = await import("@/lib/automations/webhook-guard");
const form = await import("@/lib/automations/website-form");

const URL_ = "https://polaris.example.test/api/automations/hooks/fixture";

function formConfig(over: Record<string, unknown> = {}): core.WebhookConfig {
    const base = core.newWebsiteFormConfig();
    return core.webhookConfigSchema.parse({
        ...base,
        form: { ...(base.form as object), allowedOrigins: ["example.com"], ...over }
    });
}

function post(body: BodyInit, headers: Record<string, string> = {}): Request {
    return new Request(URL_, {
        method: "POST",
        headers: { origin: "https://www.example.com", "x-forwarded-for": "203.0.113.9", ...headers },
        body
    });
}

const inspect = (request: Request, cfg = formConfig()) =>
    guard.inspectHook({ request, config: cfg, secret: "unused", hash: "h" });

beforeEach(() => counters.clear());

describe("website form schema", () => {
    it("starts with no credential, POST only, and a per-address limit", () => {
        const cfg = formConfig();
        expect(core.webhookIsForm(cfg)).toBe(true);
        expect(core.webhookAuth(cfg)).toEqual({ mode: "none" });
        expect(core.webhookMethods({ ...cfg, methods: ["GET", "POST"] })).toEqual(["POST"]);
        expect(core.webhookIsLegacyOpen({ form: cfg.form })).toBe(false);
        expect(cfg.rateLimit.perIp).toEqual(core.WEBSITE_FORM_PER_IP);
    });

    it("takes only an http or https thank-you address", () => {
        const parse = (redirectUrl: string) => core.webhookFormSchema.safeParse({ redirectUrl }).success;
        expect(parse("https://example.com/thanks")).toBe(true);
        expect(parse("http://example.com/thanks")).toBe(true);
        expect(parse("")).toBe(true);
        expect(parse("javascript:alert(1)")).toBe(false);
        expect(parse("ftp://example.com")).toBe(false);
    });

    it("reads a typed site as its host and matches subdomains only", () => {
        expect(core.formSiteHost("https://www.Example.com/contact")).toBe("www.example.com");
        expect(core.formSiteHost("example.com")).toBe("example.com");
        expect(core.formSiteHost("not a site")).toBe("");
        expect(core.formOriginAllowed(["example.com"], "https://shop.example.com")).toBe(true);
        expect(core.formOriginAllowed(["example.com"], "https://badexample.com")).toBe(false);
        expect(core.formOriginAllowed(["example.com"], "")).toBe(false);
        expect(core.formOriginAllowed([], "")).toBe(true);
    });

    it("escapes the address and honeypot in the snippet", () => {
        const html = core.websiteFormSnippet('https://x.test/"><script>', { honeypotField: "_gotcha" });
        expect(html).toContain('action="https://x.test/&quot;&gt;&lt;script&gt;"');
        expect(html).toContain('name="_gotcha"');
        expect(html).toContain('method="POST"');
    });
});

describe("website form intake", () => {
    it("takes a urlencoded post and drops control fields", async () => {
        const answer = await inspect(
            post("name=Ada&email=ada%40example.test&_next=https%3A%2F%2Fevil.test&topic=a&topic=b", {
                "content-type": "application/x-www-form-urlencoded"
            })
        );
        expect(answer.ok).toBe(true);
        if (!answer.ok) return;
        expect(answer.spam).toBe(false);
        expect(answer.fields).toEqual({ name: "Ada", email: "ada@example.test", topic: "a, b" });
        expect(answer.payload.body).toEqual(answer.fields);
    });

    it("takes multipart and JSON posts", async () => {
        const data = new FormData();
        data.set("name", "Ada");
        data.set("file", new Blob(["x"]), "x.txt");
        const multipart = await inspect(post(data));
        expect(multipart.ok && multipart.fields).toEqual({ name: "Ada" });
        const json = await inspect(post(JSON.stringify({ name: "Ada", tags: ["a", "b"] }), { "content-type": "application/json" }));
        expect(json.ok && json.fields).toEqual({ name: "Ada", tags: "a, b" });
        const broken = await inspect(post("{", { "content-type": "application/json" }));
        expect(broken.ok).toBe(false);
    });

    it("keeps a post that fills the honeypot as spam", async () => {
        const answer = await inspect(
            post("name=Bot&_gotcha=http%3A%2F%2Fspam.test", { "content-type": "application/x-www-form-urlencoded" })
        );
        expect(answer.ok && answer.spam).toBe(true);
        expect(answer.ok && answer.fields).toEqual({ name: "Bot" });
    });

    it("refuses a site not on the list, and a caller with no origin", async () => {
        const other = await inspect(
            post("name=Ada", { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" })
        );
        expect(!other.ok && other.reason).toBe("origin");
        const bare = new Request(URL_, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "name=Ada"
        });
        const none = await inspect(bare);
        expect(!none.ok && none.status).toBe(403);
    });

    it("refuses other media types and limits each address", async () => {
        const text = await inspect(post("hi", { "content-type": "text/plain" }));
        expect(!text.ok && text.reason).toBe("contentType");
        counters.clear();
        const cfg = formConfig();
        const results = [];
        for (let index = 0; index < 6; index += 1)
            results.push(await inspect(post("a=1", { "content-type": "application/x-www-form-urlencoded" }), cfg));
        expect(results.slice(0, 5).every((entry) => entry.ok)).toBe(true);
        expect(!results[5]!.ok && results[5]!.reason).toBe("rateLimited");
    });
});

describe("website form answers", () => {
    it("redirects a plain form and answers JSON to fetch", () => {
        expect(form.formAnswerMode(new Headers({ accept: "text/html" }))).toBe("redirect");
        expect(form.formAnswerMode(new Headers({ accept: "application/json" }))).toBe("json");
        expect(form.formAnswerMode(new Headers({ "content-type": "application/json" }))).toBe("json");
    });

    it("echoes CORS only for a listed site", () => {
        const cfg = formConfig();
        if (!core.webhookIsForm(cfg)) throw new Error("not a form");
        expect(form.formCorsHeaders(cfg.form, "https://example.com")["access-control-allow-origin"]).toBe(
            "https://example.com"
        );
        expect(form.formCorsHeaders(cfg.form, "https://evil.test")["access-control-allow-origin"]).toBeUndefined();
    });

    it("writes every field as a column and defuses formulas", () => {
        const csv = form.submissionsCsv([
            { at: "2026-11-13T10:00:00.000Z", fields: { name: "Ada" } },
            { at: "2026-11-13T11:00:00.000Z", fields: { name: "=1+1", note: 'say "hi"' } }
        ]);
        expect(csv.split("\r\n")).toEqual([
            '"submitted","name","note"',
            '"2026-11-13T10:00:00.000Z","Ada",""',
            '"2026-11-13T11:00:00.000Z","\'=1+1","say ""hi"""',
            ""
        ]);
    });
});
