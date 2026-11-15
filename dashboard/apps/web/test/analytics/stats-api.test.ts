/**
 * GET /api/v1/analytics/stats: a site the key's owner cannot see is a 404 (never
 * a hint it exists), an unknown breakdown is a 400 that names it, and a range
 * past 31 days is answered from the daily totals with the dimensions those do
 * not keep listed as `unavailable` - the same rule the screen follows, since the
 * route reads through the same `readAnalytics`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const site = { id: "site-1", name: "Shop", publicKey: "key", trackerEnabled: true };
let access: { site: typeof site } | null = { site };
const siteAccess = vi.fn(async () => access);
const dayRows = vi.fn(async () => [
    { siteId: "site-1", day: new Date(Date.now() - 40 * 86_400_000), dimension: "total", value: "", views: 30, visitors: 12, bounces: 3, durationSec: 600, measured: 10 }
]);

vi.mock("@polaris/db", () => ({
    prisma: {
        analyticsSession: { count: async () => 2 },
        analyticsDay: {
            findMany: () => dayRows(),
            aggregate: async () => ({ _sum: { visitors: 5, views: 9, bounces: 1, durationSec: 100, measured: 4 } })
        },
        $queryRaw: vi.fn(async () => {
            throw new Error("the raw rows must not be read for a daily range");
        })
    }
}));
vi.mock("@/lib/api-key-auth", () => ({
    requireApiKey: async () => ({ userId: "user-1", scopes: ["deploy.manage"], keyId: "key-1" })
}));
vi.mock("@/lib/api-usage/recorder", () => ({ withKeyUsage: (handler: unknown) => handler }));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/app/(app)/analytics/site-access", () => ({ siteAccess: (...args: unknown[]) => siteAccess(...(args as [])) }));
vi.mock("@/lib/analytics-geoip", () => ({ countryForIp: () => null }));
vi.mock("@/lib/access/forget", () => ({ forgetSubject: async () => undefined }));
vi.mock("@/lib/setting-store", () => ({ getSetting: async () => null, setSetting: async () => undefined }));

const { GET } = await import("@/app/api/v1/analytics/stats/route");

const ask = (query: string) =>
    (GET as (request: Request) => Promise<Response>)(new Request(`http://polaris.test/api/v1/analytics/stats?${query}`));

beforeEach(() => {
    access = { site };
    siteAccess.mockClear();
});

describe("the Stats API", () => {
    it("answers 404 for a site the key's owner cannot see", async () => {
        access = null;
        const response = await ask("scopeType=external&scopeId=other&range=7d");
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "errors.notFound" });
    });

    it("answers 400 naming an unknown breakdown, before looking the site up", async () => {
        const response = await ask("scopeType=external&scopeId=mine&range=7d&breakdown=path,shoeSize");
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(JSON.stringify(body.issues)).toContain("shoeSize");
        expect(siteAccess).not.toHaveBeenCalled();
    });

    it("answers 400 for a range the screen does not offer", async () => {
        const response = await ask("scopeType=external&scopeId=mine&range=2y");
        expect(response.status).toBe(400);
    });

    it("reads a range past 31 days from the daily totals and says what they lack", async () => {
        const response = await ask("scopeType=external&scopeId=mine&range=90d&breakdown=path,screen");
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.source).toBe("daily");
        expect(body.unavailable).toContain("screen");
        expect(body.unavailable).not.toContain("path");
        expect(body.overview.views).toBe(30);
        expect(Object.keys(body.breakdowns).sort()).toEqual(["path", "screen"]);
        expect(body.previous).toMatchObject({ visitors: 5, views: 9 });
        expect(body.site).toEqual({ id: "site-1", name: "Shop" });
    });
});
