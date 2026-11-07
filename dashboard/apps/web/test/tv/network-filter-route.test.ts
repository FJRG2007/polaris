/**
 * What a TV reads to set Private DNS: a hostname only while the network filter
 * runs, serves encrypted DNS, and answers on 853 - never a name that would cut
 * the set off - and nothing at all for a key that is not a TV's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Dot = {
    enabled: boolean;
    hostname: string | null;
    blocker: string | null;
    listening: boolean;
};

let principal: { keyId: string; userId: string; kind: string; scopes: string[] } | null = null;
let engine: { status: string } | null = null;
let dot: Dot = { enabled: true, hostname: "dns.plr.example.com", blocker: null, listening: true };
let address: string | null = "192.168.1.10";

vi.mock("@/lib/api-key-auth", () => ({ authenticateApiKey: async () => principal }));
vi.mock("@/lib/api-usage/recorder", () => ({ withKeyUsage: (handler: unknown) => handler }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: true, retryAfterMs: 0 })
}));
vi.mock("@/lib/host-address", () => ({ getHostLanIp: async () => address }));
vi.mock("@/lib/dns-blocker/service", () => ({
    readSettings: async () => ({}),
    engineRow: async () => engine,
    encryptedDnsStatus: async () => dot
}));

const { GET } = await import("@/app/api/tv/network-filter/route");

function asked(): Request {
    return new Request("https://polaris.example/api/tv/network-filter", {
        headers: { authorization: "Bearer key" }
    });
}

beforeEach(() => {
    principal = { keyId: "key-1", userId: "user-1", kind: "tv", scopes: [] };
    engine = { status: "running" };
    dot = { enabled: true, hostname: "dns.plr.example.com", blocker: null, listening: true };
    address = "192.168.1.10";
});

describe("the network filter a TV reads", () => {
    it("gives the hostname and address while encrypted DNS answers", async () => {
        const response = await GET(asked());
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual({
            available: true,
            dotHostname: "dns.plr.example.com",
            lanAddress: "192.168.1.10"
        });
    });

    it.each<[string, Partial<Dot>]>([
        ["is off", { enabled: false }],
        ["has no certificate", { hostname: null, blocker: "noCertificate" }],
        ["does not answer on 853", { listening: false }]
    ])("names no hostname while it %s", async (_, patch) => {
        dot = { ...dot, ...patch };
        expect(await (await GET(asked())).json()).toEqual({
            available: false,
            dotHostname: null,
            lanAddress: "192.168.1.10"
        });
    });

    it("says nothing is there while the filter does not run", async () => {
        engine = { status: "failed" };
        expect(await (await GET(asked())).json()).toEqual({
            available: false,
            dotHostname: null,
            lanAddress: null
        });
        engine = null;
        expect((await (await GET(asked())).json()).available).toBe(false);
    });

    it.each(["key", "cli", "streamdeck"])("refuses a key of kind %s", async (kind) => {
        principal = { keyId: "key-1", userId: "user-1", kind, scopes: ["deploy.read"] };
        expect((await GET(asked())).status).toBe(401);
    });

    it("refuses no key at all", async () => {
        principal = null;
        expect((await GET(asked())).status).toBe(401);
    });
});
