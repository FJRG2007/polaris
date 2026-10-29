import { beforeEach, describe, expect, it, vi } from "vitest";

const limit = vi.fn(async () => ({ ok: true, retryAfterMs: 0 }));

vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: limit }));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "203.0.113.7" }));

const { GET, OPTIONS } = await import("@/app/api/polaris/identity/route");

describe("GET /api/polaris/identity", () => {
    beforeEach(() => limit.mockClear());

    it("answers the product marker and protocol, and nothing else", async () => {
        const response = await GET();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ product: "polaris", protocol: 1 });
    });

    it("is readable from any origin without credentials, and cacheable", async () => {
        const response = await GET();
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        expect(response.headers.get("access-control-allow-credentials")).toBeNull();
        expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    });

    it("counts each request against the caller's address", async () => {
        await GET();
        expect(limit).toHaveBeenCalledWith("identity:203.0.113.7", 60, 60_000);
    });

    it("refuses once the caller is over the limit, uncached and with a retry time", async () => {
        limit.mockResolvedValueOnce({ ok: false, retryAfterMs: 12_500 });
        const response = await GET();
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("13");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("answers the preflight with no body", async () => {
        const response = OPTIONS();
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    });
});
