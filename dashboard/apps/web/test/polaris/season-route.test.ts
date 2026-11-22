import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const limit = vi.fn(async () => ({ ok: true, retryAfterMs: 0 }));
const allowed = vi.fn(async () => true);

vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: limit }));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "203.0.113.7" }));
vi.mock("@/lib/seasonal-service", () => ({
    seasonsAllowed: allowed,
    seasonCalendar: async () => core.DEFAULT_SEASON_CALENDAR
}));

const { GET, OPTIONS } = await import("@/app/api/polaris/season/route");

describe("GET /api/polaris/season", () => {
    beforeEach(() => {
        limit.mockClear();
        allowed.mockResolvedValue(true);
    });

    it("answers the deployment's calendar", async () => {
        const response = await GET();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ calendar: core.DEFAULT_SEASON_CALENDAR });
    });

    it("answers null when the operator turned seasons off", async () => {
        allowed.mockResolvedValue(false);
        expect(await (await GET()).json()).toEqual({ calendar: null });
    });

    it("is readable from any origin without credentials, and cacheable", async () => {
        const response = await GET();
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        expect(response.headers.get("access-control-allow-credentials")).toBeNull();
        expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    });

    it("refuses once the caller is over the limit, uncached", async () => {
        limit.mockResolvedValueOnce({ ok: false, retryAfterMs: 12_500 });
        const response = await GET();
        expect(limit).toHaveBeenCalledWith("season:203.0.113.7", 60, 60_000);
        expect(response.status).toBe(429);
        expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("answers the preflight with no body", async () => {
        const response = OPTIONS();
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });
});
