/**
 * A shared Polar chat's public link runs the same gates as every other public link:
 * usable (expiry, cap on opens), address rules, then the password. A link with
 * none of them set, as every existing one is, opens for anyone holding it.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_AUTH_SECRET: "one-secret-for-every-signature-here" })
}));

const findUnique = vi.fn();
vi.mock("@polaris/db", () => ({ prisma: { polarThreadShare: { findUnique } } }));

let ip: string | undefined = "198.51.100.7";
vi.mock("@/lib/request-context", () => ({ clientIp: async () => ip }));
vi.mock("@/lib/dymo-service", () => ({ dymoIpAllowed: async () => ({ allowed: true }) }));
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => true }));

let cookie: string | undefined;
vi.mock("next/headers", () => ({
    cookies: async () => ({ get: () => (cookie === undefined ? undefined : { value: cookie }) })
}));

const gate = await import("@/lib/polar/share-access");

const SHARE = "01a081bf-94a6-76c1-9907-ab70aa5f6471";
const TOKEN = "t".repeat(43);
const HASH = "scrypt$salt-one$hash-one";
const row = (overrides: Record<string, unknown> = {}) => ({
    id: SHARE,
    linkEnabled: true,
    passwordHash: null,
    expiresAt: null,
    maxViews: null,
    views: 0,
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    ...overrides
});

describe("a shared Polar chat's link", () => {
    it("opens with no limits, as every existing link has", async () => {
        findUnique.mockResolvedValueOnce(row());
        expect(await gate.gatePolarShare(TOKEN)).toEqual({ ok: true, shareId: SHARE });
    });

    it("answers not_found for a token that names nothing", async () => {
        findUnique.mockResolvedValueOnce(null);
        expect(await gate.gatePolarShare(TOKEN)).toEqual({ ok: false, reason: "not_found" });
    });

    it("stops once it has expired", async () => {
        findUnique.mockResolvedValueOnce(row({ expiresAt: new Date(Date.now() - 1000) }));
        expect(await gate.gatePolarShare(TOKEN)).toEqual({ ok: false, reason: "expired" });
    });

    it("stops once it has been opened as often as it allows", async () => {
        findUnique.mockResolvedValueOnce(row({ maxViews: 3, views: 3 }));
        expect(await gate.gatePolarShare(TOKEN)).toEqual({ ok: false, reason: "exhausted" });
    });

    it("still serves a file on the page that took the last view", async () => {
        findUnique.mockResolvedValueOnce(row({ maxViews: 1, views: 1 }));
        expect(await gate.gatePolarShare(TOKEN, { withinCap: false })).toEqual({ ok: true, shareId: SHARE });
        findUnique.mockResolvedValueOnce(row({ maxViews: 1, views: 1, expiresAt: new Date(Date.now() - 1000) }));
        expect(await gate.gatePolarShare(TOKEN, { withinCap: false })).toEqual({ ok: false, reason: "expired" });
    });

    it("refuses an address outside its list", async () => {
        ip = "203.0.113.9";
        findUnique.mockResolvedValueOnce(row({ allowedCidrs: '["198.51.100.0/24"]' }));
        expect(await gate.gatePolarShare(TOKEN)).toEqual({ ok: false, reason: "ip_not_allowed" });
        ip = "198.51.100.7";
        findUnique.mockResolvedValueOnce(row({ allowedCidrs: '["198.51.100.0/24"]' }));
        expect(await gate.gatePolarShare(TOKEN)).toEqual({ ok: true, shareId: SHARE });
    });

    it("asks for the password until it is solved, and again once it changes", async () => {
        cookie = undefined;
        findUnique.mockResolvedValueOnce(row({ passwordHash: HASH }));
        expect(await gate.gatePolarShare(TOKEN)).toEqual({ ok: false, reason: "password_required" });

        cookie = gate.signPolarUnlock(SHARE, HASH);
        findUnique.mockResolvedValueOnce(row({ passwordHash: HASH }));
        expect(await gate.gatePolarShare(TOKEN)).toEqual({ ok: true, shareId: SHARE });

        findUnique.mockResolvedValueOnce(row({ passwordHash: "scrypt$salt-two$hash-two" }));
        expect(await gate.gatePolarShare(TOKEN)).toEqual({ ok: false, reason: "password_required" });
        cookie = undefined;
    });

    it("answers not_found when the link is switched off, or the token is malformed", async () => {
        findUnique.mockResolvedValueOnce(row({ linkEnabled: false }));
        expect(await gate.gatePolarShare(TOKEN)).toEqual({ ok: false, reason: "not_found" });
        expect(await gate.gatePolarShare("short")).toEqual({ ok: false, reason: "not_found" });
    });

    it("does not take a cookie solved for another kind of link", async () => {
        const { signUnlock } = await import("@/lib/link-guards");
        cookie = signUnlock("task", SHARE, { passwordHash: HASH }, "one-secret-for-every-signature-here");
        findUnique.mockResolvedValueOnce(row({ passwordHash: HASH }));
        expect(await gate.gatePolarShare(TOKEN)).toEqual({ ok: false, reason: "password_required" });
        cookie = undefined;
    });
});
