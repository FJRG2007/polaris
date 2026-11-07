/**
 * Polaris TV's HTTP edges: only a key of kind "tv" opens them, what they answer
 * is counts and a name, and connecting opens a device grant of the TV's kind
 * asking for no scope at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let principal: { keyId: string; userId: string; kind: string; scopes: string[] } | null = null;
let throttled = false;
const opened: { kind?: string; scopes: readonly string[] }[] = [];
const revoked: { userId: string; id: string }[] = [];
const counted: unknown[] = [];
const noted: { keyId: string; version: unknown }[] = [];
let pendingUpdate: { id: string; versionName: string } | null = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findUnique: async () => ({ name: "Sample Person" }) },
        notification: {
            count: async (query: { where: { OR?: unknown } }) => {
                counted.push(query.where);
                return query.where.OR ? 1 : 4;
            }
        }
    }
}));
vi.mock("@polaris/auth", () => ({
    revokeApiKey: async (userId: string, id: string) => void revoked.push({ userId, id })
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/api-key-auth", () => ({ authenticateApiKey: async () => principal }));
vi.mock("@/lib/api-usage/recorder", () => ({ withKeyUsage: (handler: unknown) => handler }));
vi.mock("@/lib/domain-service", () => ({ requestOrigin: () => "https://polaris.example" }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: !throttled, retryAfterMs: 30_000 })
}));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.4",
    clientUserAgent: async () => "polaris-tv/3.3",
    clientHost: async () => "polaris.example",
    hashForLog: (value: string | undefined) => value
}));
vi.mock("@/lib/tv/update-requests", async (original) => ({
    ...(await original<typeof import("@/lib/tv/update-requests")>()),
    noteTvVersion: async (keyId: string, version: unknown) => void noted.push({ keyId, version }),
    pendingTvUpdate: async () => pendingUpdate
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/cli/sign-in", () => ({
    openCliSignIn: async (input: { kind?: string; scopes: readonly string[] }) => {
        opened.push(input);
        return {
            userCode: "ABCD2345",
            deviceCode: "device-code",
            expiresAt: new Date("2026-11-02T12:00:00Z"),
            pollMs: 3000
        };
    }
}));

const { GET } = await import("@/app/api/tv/state/route");
const { DELETE } = await import("@/app/api/tv/session/route");
const { POST } = await import("@/app/api/tv/authorize/route");

function asked(method = "GET", query = "", agent?: string): Request {
    return new Request(`https://polaris.example/api/tv/state${query}`, {
        method,
        headers: { authorization: "Bearer key", ...(agent ? { "user-agent": agent } : {}) }
    });
}

beforeEach(() => {
    principal = { keyId: "key-1", userId: "user-1", kind: "tv", scopes: [] };
    throttled = false;
    opened.length = 0;
    revoked.length = 0;
    counted.length = 0;
    noted.length = 0;
    pendingUpdate = null;
});

describe("the state a TV reads", () => {
    it("answers with a name and counts, scoped to the key's owner", async () => {
        const response = await GET(asked());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            instance: { name: "polaris.example" },
            account: { name: "Sample Person" },
            unread: 4,
            alerts: 1,
            updateRequest: null
        });
        expect(counted).toContainEqual({ userId: "user-1", readAt: null });
    });

    it("hands over a pending update request", async () => {
        pendingUpdate = { id: "0190a000-0000-7000-8000-000000000001", versionName: "3.5" };
        const body = (await (await GET(asked())).json()) as { updateRequest: unknown };
        expect(body.updateRequest).toEqual(pendingUpdate);
    });

    it("keeps the version a TV reports, from the query first", async () => {
        await GET(asked("GET", "?versionName=3.5&versionCode=14", "polaris-tv/3.4"));
        expect(noted).toEqual([
            { keyId: "key-1", version: { versionName: "3.5", versionCode: 14 } }
        ]);
    });

    it("falls back to the version in the user agent", async () => {
        await GET(asked("GET", "", "polaris-tv/3.4"));
        expect(noted).toEqual([{ keyId: "key-1", version: { versionName: "3.4" } }]);
    });

    it("ignores a malformed version without refusing the poll", async () => {
        const response = await GET(asked("GET", "?versionName=3.5%3Bx%3D1&versionCode=-1"));
        expect(response.status).toBe(200);
        expect(noted).toEqual([]);
        await GET(asked("GET", "?versionName=3.5&versionCode=abc"));
        expect(noted).toEqual([{ keyId: "key-1", version: { versionName: "3.5" } }]);
    });

    it.each(["key", "cli", "streamdeck"])("refuses a key of kind %s", async (kind) => {
        principal = { keyId: "key-1", userId: "user-1", kind, scopes: ["deploy.read"] };
        expect((await GET(asked())).status).toBe(401);
    });

    it("refuses no key at all", async () => {
        principal = null;
        expect((await GET(asked())).status).toBe(401);
    });

    it("throttles per key", async () => {
        throttled = true;
        expect((await GET(asked())).status).toBe(429);
    });
});

describe("a TV disconnecting", () => {
    it("ends its own key", async () => {
        expect((await DELETE(asked("DELETE"))).status).toBe(204);
        expect(revoked).toEqual([{ userId: "user-1", id: "key-1" }]);
    });

    it("cannot end somebody else's kind of key", async () => {
        principal = { keyId: "key-2", userId: "user-1", kind: "cli", scopes: [] };
        expect((await DELETE(asked("DELETE"))).status).toBe(401);
        expect(revoked).toEqual([]);
    });
});

describe("a TV asking to connect", () => {
    function ask(body: unknown): Request {
        return new Request("https://polaris.example/api/tv/authorize", {
            method: "POST",
            body: JSON.stringify(body)
        });
    }

    it("opens a request of the TV's kind with no scope", async () => {
        const response = await POST(ask({ deviceName: "Sample TV", clientVersion: "3.3" }));
        expect(response.status).toBe(200);
        expect(opened[0]).toMatchObject({ kind: "tv", scopes: [] });
        expect(await response.json()).toMatchObject({
            userCode: "ABCD2345",
            verificationPath: "/account/tv",
            approvePath: "/account/tv?code=ABCD2345"
        });
    });

    it("refuses a request with no device name", async () => {
        expect((await POST(ask({}))).status).toBe(400);
        expect(opened).toEqual([]);
    });
});
