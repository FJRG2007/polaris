/**
 * Deciding, when a session is first seen, what its sign-in still owes: from the
 * account's stored policy (or none at all), its usual countries, and the country
 * this sign-in came from.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    userSecurity: { findUnique: vi.fn(), upsert: vi.fn() },
    sessionState: { findMany: vi.fn() },
    securityQuestion: { count: vi.fn() }
}));
const geo = vi.hoisted(() => ({ resolveGeo: vi.fn() }));
const delivery = vi.hoisted(() => ({ describeTwoFactorMethods: vi.fn() }));

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/geo-service", () => geo);
vi.mock("@/lib/two-factor-delivery", () => delivery);

import { beginSignInStepUp } from "@/lib/two-factor-policy-service";
import { parseStepUp, stepUpRemaining } from "@/lib/two-factor-policy";

function status(method: string, on = true) {
    return { method, enabled: on, available: on, target: null, blocker: null };
}

const signIn = { userId: "user-1", sessionId: "session-1", ip: "203.0.113.7", country: null, factor: "totp" as const };

beforeEach(() => {
    vi.clearAllMocks();
    delivery.describeTwoFactorMethods.mockResolvedValue([status("totp"), status("email"), status("whatsapp", false)]);
    db.securityQuestion.count.mockResolvedValue(0);
    db.sessionState.findMany.mockResolvedValue([]);
    db.userSecurity.upsert.mockResolvedValue({});
});

describe("an account that never set a policy", () => {
    beforeEach(() => {
        db.userSecurity.findUnique.mockImplementation(async ({ select }: { select: Record<string, boolean> }) =>
            select.signInCountries ? { signInCountries: ["ES"] } : null
        );
    });

    it("signs in exactly as before from its usual country, and remembers it", async () => {
        geo.resolveGeo.mockResolvedValue({ countryCode: "ES" });
        expect(await beginSignInStepUp(signIn)).toEqual({ stepUp: null, country: "ES" });
        expect(db.userSecurity.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ update: { signInCountries: ["ES"] } })
        );
    });

    it("is asked for a second method from another country", async () => {
        geo.resolveGeo.mockResolvedValue({ countryCode: "US" });
        const result = await beginSignInStepUp(signIn);
        const state = parseStepUp(result.stepUp)!;
        expect(state.reason).toBe("unusual-country");
        expect(stepUpRemaining(state)).toEqual({ factorsLeft: 1, methods: ["email"], questionLeft: false });
        // A sign-in that has not finished does not become a usual country.
        expect(db.userSecurity.upsert).not.toHaveBeenCalled();
    });

    it("adds the security questions when the account has them", async () => {
        geo.resolveGeo.mockResolvedValue({ countryCode: "US" });
        db.securityQuestion.count.mockResolvedValue(2);
        expect(stepUpRemaining(parseStepUp((await beginSignInStepUp(signIn)).stepUp)!).questionLeft).toBe(true);
    });

    it("is never asked for more when the country cannot be told", async () => {
        geo.resolveGeo.mockResolvedValue({ countryCode: null });
        expect((await beginSignInStepUp(signIn)).stepUp).toBeNull();
        geo.resolveGeo.mockRejectedValue(new Error("lookup down"));
        expect((await beginSignInStepUp(signIn)).stepUp).toBeNull();
    });

    it("costs nothing for a sign-in that answered no challenge", async () => {
        expect(await beginSignInStepUp({ ...signIn, factor: null })).toEqual({ stepUp: null, country: null });
        expect(geo.resolveGeo).not.toHaveBeenCalled();
        expect(delivery.describeTwoFactorMethods).not.toHaveBeenCalled();
    });
});

describe("an account with history only in its open sessions", () => {
    it("uses the countries those sessions were seen in", async () => {
        db.userSecurity.findUnique.mockResolvedValue(null);
        db.sessionState.findMany.mockResolvedValue([{ country: "es" }]);
        geo.resolveGeo.mockResolvedValue({ countryCode: "FR" });
        expect((await beginSignInStepUp(signIn)).stepUp).not.toBeNull();
        expect(db.sessionState.findMany.mock.calls[0]![0].take).toBe(50);
    });

    it("treats a first sign-in with no history at all as usual", async () => {
        db.userSecurity.findUnique.mockResolvedValue(null);
        geo.resolveGeo.mockResolvedValue({ countryCode: "FR" });
        expect((await beginSignInStepUp(signIn)).stepUp).toBeNull();
    });
});

describe("an account that chose its policy", () => {
    it("standard never looks the country up", async () => {
        db.userSecurity.findUnique.mockResolvedValue({ twoFactorRefused: "[]", twoFactorStrictness: "standard", signInCountries: ["ES"] });
        expect((await beginSignInStepUp(signIn)).stepUp).toBeNull();
        expect(geo.resolveGeo).not.toHaveBeenCalled();
    });

    it("all asks for every accepted method even at home", async () => {
        db.userSecurity.findUnique.mockResolvedValue({ twoFactorRefused: "[]", twoFactorStrictness: "all", signInCountries: ["ES"] });
        geo.resolveGeo.mockResolvedValue({ countryCode: "ES" });
        const state = parseStepUp((await beginSignInStepUp(signIn)).stepUp)!;
        expect(state.reason).toBe("all-methods");
        expect(stepUpRemaining(state).methods).toEqual(["email"]);
    });

    it("a refused authenticator does not count as the factor", async () => {
        db.userSecurity.findUnique.mockResolvedValue({ twoFactorRefused: '["totp"]', twoFactorStrictness: "standard", signInCountries: [] });
        const state = parseStepUp((await beginSignInStepUp(signIn)).stepUp)!;
        expect(state.reason).toBe("not-accepted");
        expect(stepUpRemaining(state).methods).toEqual(["email"]);
    });
});
