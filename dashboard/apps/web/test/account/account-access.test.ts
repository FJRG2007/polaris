/**
 * The verdict on one address. Two allowlists govern an account - the limits an
 * administrator imposed and the rules the account wrote for itself - and they
 * are judged separately on purpose: folded into one union, adding a rule of your
 * own would widen a limit somebody else set for you.
 *
 * The other property worth pinning: an IP allowlist is a hard boundary (no
 * resolvable address means no entry) while a location allowlist fails open on an
 * unresolved country, so a geolocation outage cannot lock everybody out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let enforced = { allowedCidrs: [] as string[], allowedCountries: [] as string[], allowedContinents: [] as string[] };
let country: string | null = null;

vi.mock("@polaris/auth", () => ({ resolveEnforcedRules: async () => enforced }));
vi.mock("@/lib/geo-service", () => ({ resolveGeo: async () => ({ countryCode: country }) }));

const { evaluateAccountAccess, evaluateNetworkRules } = await import("../../src/lib/network-rules");

const OPEN = { allowedCidrs: [], allowedCountries: [], allowedContinents: [] };

beforeEach(() => {
    enforced = { allowedCidrs: [], allowedCountries: [], allowedContinents: [] };
    country = null;
});

describe("an account with no restrictions anywhere", () => {
    it("is reachable from any address", async () => {
        const decision = await evaluateAccountAccess("user-1", "203.0.113.7", OPEN);
        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBeNull();
    });
});

describe("limits an administrator imposed", () => {
    it("refuse an address the account itself would have allowed", async () => {
        enforced = { allowedCidrs: ["10.0.0.0/8"], allowedCountries: [], allowedContinents: [] };
        const decision = await evaluateAccountAccess("user-1", "203.0.113.7", {
            ...OPEN,
            allowedCidrs: ["203.0.113.0/24"]
        });
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe("ip");
    });

    it("are not enough on their own: the account's own rules still apply", async () => {
        enforced = { allowedCidrs: ["10.0.0.0/8"], allowedCountries: [], allowedContinents: [] };
        const allowed = await evaluateAccountAccess("user-1", "10.1.2.3", {
            ...OPEN,
            allowedCidrs: ["203.0.113.0/24"]
        });
        // Inside the imposed range, but outside what the account allows itself.
        expect(allowed.allowed).toBe(false);
        expect(allowed.reason).toBe("ip");
    });

    it("let an address through when both sets are satisfied", async () => {
        enforced = { allowedCidrs: ["10.0.0.0/8"], allowedCountries: [], allowedContinents: [] };
        const decision = await evaluateAccountAccess("user-1", "10.1.2.3", {
            ...OPEN,
            allowedCidrs: ["10.1.0.0/16"]
        });
        expect(decision.allowed).toBe(true);
    });

    it("keep the country resolved by whichever set looked it up", async () => {
        country = "ES";
        enforced = { allowedCidrs: [], allowedCountries: ["ES"], allowedContinents: [] };
        const decision = await evaluateAccountAccess("user-1", "203.0.113.7", OPEN);
        expect(decision.allowed).toBe(true);
        expect(decision.country).toBe("ES");
    });

    it("refuse a country outside the imposed list", async () => {
        country = "FR";
        enforced = { allowedCidrs: [], allowedCountries: ["ES"], allowedContinents: [] };
        const decision = await evaluateAccountAccess("user-1", "203.0.113.7", OPEN);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe("geo");
    });
});

describe("an address that cannot be resolved", () => {
    it("is refused by an IP allowlist, which exists to name where access comes from", async () => {
        const decision = await evaluateNetworkRules(
            { allowedCidrs: ["10.0.0.0/8"], allowedCountries: [], allowedContinents: [] },
            undefined
        );
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe("ip");
    });

    it("is let through by a location allowlist, so an outage is not a lockout", async () => {
        country = null;
        const decision = await evaluateNetworkRules(
            { allowedCidrs: [], allowedCountries: ["ES"], allowedContinents: [] },
            undefined
        );
        expect(decision.allowed).toBe(true);
    });
});
