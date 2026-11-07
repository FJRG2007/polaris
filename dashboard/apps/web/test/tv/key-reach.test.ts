/**
 * A TV's key opens Polaris TV's routes and nothing else: every other caller of
 * `authenticateApiKey` is told there is no key, MCP and `/api/v1/me` among them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let kind = "tv";

vi.mock("@polaris/auth", () => ({
    verifyApiKey: async () => ({
        id: "key-1",
        userId: "user-1",
        scopes: [],
        projectId: null,
        kind,
        rules: {},
        clients: {}
    }),
    touchApiKey: async () => undefined
}));
vi.mock("@polaris/core", () => ({ userAgentAllowed: () => true }));
vi.mock("@/lib/cli/sessions", () => ({ cliAddressAllows: async () => true }));
vi.mock("@/lib/network-rules", () => ({
    evaluateAccountAccess: async () => ({ allowed: true })
}));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.4",
    clientUserAgent: async () => "polaris-tv/3.3"
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/api-usage/recorder", () => ({
    noteKeyCall: () => undefined,
    withKeyUsage: (handler: unknown) => handler
}));
vi.mock("@/lib/i18n/translate", () => ({ translatorFor: () => (key: string) => key }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: true, retryAfterMs: 0 })
}));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: async () => "192.168.1.10" }));
vi.mock("@/lib/dns-blocker/service", () => ({
    readSettings: async () => ({}),
    engineRow: async () => ({ status: "running" }),
    encryptedDnsStatus: async () => ({
        enabled: true,
        hostname: "dns.plr.example.com",
        blocker: null,
        listening: true
    })
}));
vi.mock("@/lib/tv/release", async (original) => ({
    ...(await original<typeof import("@/lib/tv/release")>()),
    preparedTvApk: async () => null,
    preparedTvCatalogFile: async () => null,
    tvReleaseInfo: async () => null
}));
vi.mock("@/lib/tv/update-requests", async (original) => ({
    ...(await original<typeof import("@/lib/tv/update-requests")>()),
    reportTvUpdate: async () => true
}));
vi.mock("@/lib/domain-service", () => ({ requestOrigin: () => "https://polaris.example" }));
vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findUnique: async () => ({ name: "Sample Person" }) },
        notification: { count: async () => 0 },
        tvUpdateRequest: { findUnique: async () => null },
        tvPreference: {
            findUnique: async () => ({
                desired: { blocking: true },
                choice: "0190a000-0000-7000-8000-0000000000aa",
                applied: null
            }),
            updateMany: async () => ({ count: 1 })
        }
    }
}));

const { authenticateApiKey, requireApiKey } = await import("@/lib/api-key-auth");
const networkFilter = await import("@/app/api/tv/network-filter/route");
const stateRoute = await import("@/app/api/tv/state/route");
const updateRoute = await import("@/app/api/tv/update/route");
const apkRoute = await import("@/app/api/tv/update/apk/route");
const reportRoute = await import("@/app/api/tv/update/report/route");
const catalogRoute = await import("@/app/api/tv/catalog/route");

/** Each state and update route, called the way a TV calls it. */
const TV_ROUTES: [string, () => Promise<Response>][] = [
    ["GET /api/tv/state", () => stateRoute.GET(onRoute("/api/tv/state"))],
    [
        "GET /api/tv/state reporting what it did",
        () => stateRoute.GET(onRoute("/api/tv/state?blocking=on"))
    ],
    ["GET /api/tv/update", () => updateRoute.GET(onRoute("/api/tv/update"))],
    ["GET /api/tv/update/apk", () => apkRoute.GET(onRoute("/api/tv/update/apk"))],
    ["GET /api/tv/catalog", () => catalogRoute.GET(onRoute("/api/tv/catalog"))],
    [
        "GET /api/tv/catalog for one file",
        () => catalogRoute.GET(onRoute("/api/tv/catalog?name=theme-aerial.zip"))
    ],
    [
        "POST /api/tv/update/report",
        () =>
            reportRoute.POST(
                onRoute("/api/tv/update/report", {
                    method: "POST",
                    body: JSON.stringify({
                        id: "0190a000-0000-7000-8000-000000000001",
                        state: "done"
                    })
                })
            )
    ]
];

function onRoute(path: string, init: RequestInit = {}): Request {
    return new Request(`https://polaris.example${path}`, {
        ...init,
        headers: { authorization: "Bearer key" }
    });
}

function asked(): Request {
    return new Request("https://polaris.example/api/mcp", {
        headers: { authorization: "Bearer key" }
    });
}

beforeEach(() => {
    kind = "tv";
});

describe("how far a TV's key reaches", () => {
    it("is no key to anything but a TV route", async () => {
        expect(await authenticateApiKey(asked())).toBeNull();
        const refused = await requireApiKey(asked());
        expect((refused as Response).status).toBe(401);
    });

    it("is a key to a TV route", async () => {
        expect(await authenticateApiKey(asked(), { tv: true })).toMatchObject({ kind: "tv" });
    });

    it("is a key to the network filter's TV route, and no other kind is", async () => {
        expect((await networkFilter.GET(asked())).status).toBe(200);
        kind = "cli";
        expect((await networkFilter.GET(asked())).status).toBe(401);
        kind = "key";
        expect((await networkFilter.GET(asked())).status).toBe(401);
    });

    it("leaves every other kind as it was", async () => {
        kind = "cli";
        expect(await authenticateApiKey(asked())).toMatchObject({ kind: "cli" });
    });
});

describe("the catalog route", () => {
    it("answers no release with 204 and a name that is not a catalog file with 404", async () => {
        expect((await catalogRoute.GET(onRoute("/api/tv/catalog"))).status).toBe(204);
        const refused = await catalogRoute.GET(onRoute("/api/tv/catalog?name=polaris-tv.apk"));
        expect(refused.status).toBe(404);
        const climbing = await catalogRoute.GET(onRoute("/api/tv/catalog?name=..%2Fcatalog.json"));
        expect(climbing.status).toBe(404);
    });
});

describe("the state and update routes", () => {
    it.each(TV_ROUTES)("%s opens to a TV's key", async (_, call) => {
        expect((await call()).status).not.toBe(401);
    });

    it("hands a TV's key what its owner asked, and nothing of anybody else's", async () => {
        const body = (await (await stateRoute.GET(onRoute("/api/tv/state"))).json()) as Record<
            string,
            unknown
        >;
        expect(Object.keys(body).sort()).toEqual([
            "account",
            "alerts",
            "desired",
            "instance",
            "unread",
            "updateRequest"
        ]);
        expect(body.desired).toEqual({
            blocking: true,
            choice: "0190a000-0000-7000-8000-0000000000aa"
        });
    });

    it.each(TV_ROUTES)("%s stays shut to any other kind", async (_, call) => {
        for (const other of ["key", "cli", "streamdeck"]) {
            kind = other;
            expect((await call()).status).toBe(401);
        }
    });
});
