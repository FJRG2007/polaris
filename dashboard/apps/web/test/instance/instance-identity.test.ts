/**
 * The instance identity and the two public routes that publish and prove it.
 *
 * What has to hold: an install with no identity gets one on first use and keeps
 * it, the private key is only ever stored sealed, a challenge is signed for the
 * origin it was asked on so `@polaris/core`'s verifier accepts it, and malformed
 * or excessive requests are refused.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createFailover, freshNonce, verifyChallenge } from "@polaris/core/instance-fallback";

const rows = new Map<string, string>();
let limited = false;

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
                rows.has(where.key) ? { value: rows.get(where.key) } : null
            ),
            create: vi.fn(async ({ data }: { data: { key: string; value: string } }) => {
                if (rows.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
                rows.set(data.key, data.value);
                return data;
            })
        }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: MASTER_KEY }) }));
vi.mock("@/lib/request-context", () => ({ clientIp: async () => "192.168.1.50" }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => (limited ? { ok: false, retryAfterMs: 30_000 } : { ok: true, retryAfterMs: 0 })
}));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: async () => "192.168.1.20" }));
vi.mock("@/lib/domain-edge", () => ({ dashboardHosts: async () => ["polaris.example.com"] }));
vi.mock("@/lib/domain-service", () => ({
    appBaseUrl: async () => "https://polaris.example.com",
    requestOrigin: (request: Request) => `https://${request.headers.get("host")}`
}));

const MASTER_KEY = randomBytes(32).toString("base64");

const identityModule = await import("@/lib/instance-identity");
const instanceRoute = await import("@/app/api/instance/route");
const challengeRoute = await import("@/app/api/instance/challenge/route");

function challenge(host: string, body: unknown): Request {
    return new Request(`http://0.0.0.0:3000/api/instance/challenge`, {
        method: "POST",
        headers: { host, "content-type": "application/json" },
        body: JSON.stringify(body)
    });
}

beforeEach(() => {
    rows.clear();
    limited = false;
    identityModule.forgetInstanceIdentity();
});

describe("instance identity", () => {
    it("is made on an install that has none, sealed, and kept", async () => {
        const first = await identityModule.ensureInstanceIdentity();
        expect(first?.id).toMatch(/^plr_/);
        const stored = rows.get(identityModule.IDENTITY_KEY) ?? "";
        expect(stored).not.toContain("PRIVATE KEY");
        expect(JSON.parse(stored)).toMatchObject({ id: first?.id, publicKey: first?.publicKey });

        identityModule.forgetInstanceIdentity();
        const again = await identityModule.ensureInstanceIdentity();
        expect(again?.id).toBe(first?.id);
        expect(again?.publicKey).toBe(first?.publicKey);
    });

    it("is never replaced when the stored one cannot be read", async () => {
        rows.set(identityModule.IDENTITY_KEY, "not json");
        expect(await identityModule.ensureInstanceIdentity()).toBeNull();
        expect(rows.get(identityModule.IDENTITY_KEY)).toBe("not json");
    });
});

describe("GET /api/instance", () => {
    it("answers the id, the key and the https addresses, readable from any origin", async () => {
        const response = await instanceRoute.GET();
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        const body = (await response.json()) as { id: string; publicKey: string; addresses: string[] };
        expect(body.addresses).toEqual([
            "https://polaris.example.com",
            "https://polaris.local",
            "https://192.168.1.20"
        ]);
        expect(body.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it("is rate-limited", async () => {
        limited = true;
        expect((await instanceRoute.GET()).status).toBe(429);
    });
});

describe("POST /api/instance/challenge", () => {
    it("signs the nonce for the origin it was asked on", async () => {
        const record = (await (await instanceRoute.GET()).json()) as {
            id: string;
            publicKey: string;
            addresses: string[];
        };
        const nonce = freshNonce();
        const answer = (await (await challengeRoute.POST(challenge("polaris.local", { nonce }))).json()) as {
            id: string;
            signature: string;
        };
        expect(answer.id).toBe(record.id);
        expect(await verifyChallenge(record, "https://polaris.local", nonce, answer.signature)).toBe(true);
        // The same signature does not vouch for another address.
        expect(await verifyChallenge(record, "https://192.168.1.20", nonce, answer.signature)).toBe(false);
    });

    it("refuses a missing or malformed nonce", async () => {
        expect((await challengeRoute.POST(challenge("polaris.local", {}))).status).toBe(400);
        expect((await challengeRoute.POST(challenge("polaris.local", { nonce: "short" }))).status).toBe(400);
        expect((await challengeRoute.POST(challenge("polaris.local", { nonce: freshNonce(), extra: 1 }))).status).toBe(
            400
        );
    });

    it("is rate-limited", async () => {
        limited = true;
        expect((await challengeRoute.POST(challenge("polaris.local", { nonce: freshNonce() }))).status).toBe(429);
    });

    it("is what the shared client verifier accepts end to end", async () => {
        const record = (await (await instanceRoute.GET()).json()) as never;
        const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
            const parsed = new URL(url);
            if (parsed.origin === "https://polaris.example.com") throw new TypeError("fetch failed");
            if (parsed.pathname === "/api/instance/challenge") {
                return challengeRoute.POST(
                    new Request(url, { method: "POST", headers: { host: parsed.host }, body: init.body as string })
                );
            }
            return Response.json({ ok: true });
        };
        const failover = createFailover({ primary: "https://polaris.example.com", instance: record, fetch: fetchImpl });
        expect((await failover.request("/api/v1/me")).status).toBe(200);
        expect(failover.status().origin).toBe("https://polaris.local");
    });
});
