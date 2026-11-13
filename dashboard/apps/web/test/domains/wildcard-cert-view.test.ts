/**
 * What the Certificates screen says about the deploy addresses' wildcard: nothing
 * on a magic-DNS base nobody here owns, and otherwise which of DNS access or the
 * order itself is what stands between an unused address and a trusted certificate.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    base: "plr.example.test",
    zone: null as string | null,
    token: null as string | null,
    settings: new Map<string, string | null>()
}));

vi.mock("@/lib/domain-service", () => ({ deployBase: async () => state.base }));
vi.mock("@/lib/domain-zones", () => ({ deployZoneBase: async () => state.zone }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => state.settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => void state.settings.set(key, value)
}));
vi.mock("@/lib/integrations/cloudflare-account-service", () => ({
    loadCloudflareToken: async () => state.token
}));
vi.mock("@/lib/traefik-dynamic", () => ({
    dynamicDir: () => join(tmpdir(), "polaris-wildcard-view-test-none"),
    writeDynamicFile: async () => undefined
}));
vi.mock("@/lib/tls/dns01", () => ({ cloudflareDns01: () => ({}) }));
vi.mock("@/lib/tls/acme-dns01", () => ({ orderDns01Certificate: async () => ({}) }));

const { wildcardCertView } = await import("@/lib/wildcard-cert-service");

beforeEach(() => {
    state.base = "plr.example.test";
    state.zone = null;
    state.token = null;
    state.settings.clear();
});

describe("the wildcard card's view", () => {
    it("is not shown on a magic-DNS base, which nobody here can order for", async () => {
        state.base = "sslip.io";
        expect(await wildcardCertView()).toEqual({ needed: false, base: null, expiresAt: null, problem: null });
    });

    it("covers the zone layout's deploy base, which leaves the legacy one on its default", async () => {
        state.base = "sslip.io";
        state.zone = "plr.zones.example.test";
        expect(await wildcardCertView()).toMatchObject({ needed: true, base: "plr.zones.example.test" });
    });

    it("names DNS access as what is missing when no token can write the zone", async () => {
        expect(await wildcardCertView()).toMatchObject({
            needed: true,
            base: "plr.example.test",
            problem: "no-dns-access"
        });
    });

    it("says the order failed when the last one did", async () => {
        state.token = "token";
        state.settings.set("tls.wildcard.lastError", "the zone was not found");
        expect((await wildcardCertView()).problem).toBe("order-failed");
    });

    it("is pending with a token and no order yet", async () => {
        state.token = "token";
        expect((await wildcardCertView()).problem).toBe("pending");
    });
});
