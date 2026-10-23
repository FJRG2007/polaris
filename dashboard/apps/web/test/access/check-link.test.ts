/**
 * The one verdict every public link acts on (`checkLink`): each rule a link can
 * carry refuses on its own, and liveness is judged before the address, so a link
 * that is off says so to everyone rather than "not from here".
 */

import { describe, expect, it, vi } from "vitest";

// Region lookups reach a geo service; here a caller's country is read from a
// table so the country rule can be exercised without it.
const COUNTRY: Record<string, string> = { "198.51.100.7": "ES", "203.0.113.9": "US" };
vi.mock("@/lib/geo-service", () => ({
    geoAllowedForIp: vi.fn(async (ip: string | undefined, countries: string[]) => {
        if (countries.length === 0) return true;
        return Boolean(ip && countries.includes(COUNTRY[ip] ?? ""));
    })
}));

const { checkLink, readAddressRules, storedAddressRules } = await import("@/lib/link-guards");

const NOW = new Date("2026-06-01T00:00:00Z");
const open = { revokedAt: null, expiresAt: null, startsAt: null, maxUses: null, useCount: 0 };
const anywhere = storedAddressRules({});

describe("checkLink", () => {
    it("serves a link with no limits to anyone", async () => {
        expect(await checkLink({ limits: open, rules: anywhere }, undefined, NOW)).toEqual({
            ok: true
        });
    });

    it("refuses a revoked link", async () => {
        const limits = { ...open, revokedAt: new Date("2026-05-01T00:00:00Z") };
        expect(await checkLink({ limits, rules: anywhere }, "198.51.100.7", NOW)).toEqual({
            ok: false,
            reason: "revoked"
        });
    });

    it("refuses an expired link", async () => {
        const limits = { ...open, expiresAt: new Date("2026-05-31T23:59:59Z") };
        expect(await checkLink({ limits, rules: anywhere }, "198.51.100.7", NOW)).toEqual({
            ok: false,
            reason: "expired"
        });
    });

    it("refuses a link whose uses are spent", async () => {
        const limits = { ...open, maxUses: 3, useCount: 3 };
        expect(await checkLink({ limits, rules: anywhere }, "198.51.100.7", NOW)).toEqual({
            ok: false,
            reason: "exhausted"
        });
    });

    it("refuses an address outside its IP/CIDR allowlist and lets one inside through", async () => {
        const rules = storedAddressRules({ allowedCidrs: ["198.51.100.0/24"] });
        expect(await checkLink({ limits: open, rules }, "203.0.113.9", NOW)).toEqual({
            ok: false,
            reason: "ip_not_allowed"
        });
        expect(await checkLink({ limits: open, rules }, "198.51.100.7", NOW)).toEqual({ ok: true });
    });

    it("refuses a caller whose address is unknown once an IP rule exists", async () => {
        const rules = storedAddressRules({ allowedCidrs: ["198.51.100.7"] });
        expect(await checkLink({ limits: open, rules }, undefined, NOW)).toEqual({
            ok: false,
            reason: "ip_not_allowed"
        });
    });

    it("refuses a caller from a country the link does not accept", async () => {
        const rules = storedAddressRules({ allowedCountries: ["ES"] });
        expect(await checkLink({ limits: open, rules }, "203.0.113.9", NOW)).toEqual({
            ok: false,
            reason: "country_not_allowed"
        });
        expect(await checkLink({ limits: open, rules }, "198.51.100.7", NOW)).toEqual({ ok: true });
    });

    it("says a dead link is dead before it says the caller is in the wrong place", async () => {
        const limits = { ...open, revokedAt: new Date("2026-05-01T00:00:00Z") };
        const rules = storedAddressRules({ allowedCountries: ["ES"] });
        expect(await checkLink({ limits, rules }, "203.0.113.9", NOW)).toEqual({
            ok: false,
            reason: "revoked"
        });
    });
});

describe("stored address rules", () => {
    it("round-trip through the JSON columns every link table uses", () => {
        const lists = {
            allowedCidrs: ["10.0.0.0/8"],
            allowedCountries: ["ES"],
            allowedContinents: ["EU"]
        };
        expect(readAddressRules(storedAddressRules(lists))).toEqual(lists);
    });

    it("store nothing as no restriction", () => {
        expect(storedAddressRules({})).toEqual({
            allowedCidrs: "[]",
            allowedCountries: "[]",
            allowedContinents: "[]"
        });
    });
});
