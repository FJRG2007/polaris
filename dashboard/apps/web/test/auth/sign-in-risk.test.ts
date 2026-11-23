/**
 * The risk check a password-only sign-in may owe: impossible travel read by
 * continent and time, a datacenter address only when Criminal IP is connected,
 * and the one-code plan that is never a dead end.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    sessionState: { findFirst: vi.fn() },
    accountDevice: { count: vi.fn() }
}));
const integrations = vi.hoisted(() => ({ getIntegrationState: vi.fn(), getIntegrationSecret: vi.fn() }));
const reputation = vi.hoisted(() => ({ rememberedVerdict: vi.fn(), rememberVerdict: vi.fn() }));
const lookups = vi.hoisted(() => ({ takeServedLookup: vi.fn() }));
const criminalIp = vi.hoisted(() => ({ checkCriminalIp: vi.fn() }));

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/integration-service", () => integrations);
vi.mock("@/lib/address-reputation", () => reputation);
vi.mock("@/lib/integrations/provider-pause", () => lookups);
vi.mock("@/lib/integrations/criminalip", () => criminalIp);

const { impossibleTravel, signInRisk, TRAVEL_WINDOW_MS } = await import("@/lib/sign-in-risk");
const { planRiskCheck, parseStepUp, serializeStepUp } = await import("@/lib/two-factor-policy");

const NOW = new Date("2026-11-23T12:00:00Z");

describe("impossibleTravel", () => {
    it("flags another continent within the window", () => {
        expect(impossibleTravel({ country: "ES", at: new Date(NOW.getTime() - 60_000) }, "US", NOW)).toBe(true);
    });

    it("lets a neighbouring country, a long gap, or an unknown place through", () => {
        expect(impossibleTravel({ country: "ES", at: new Date(NOW.getTime() - 60_000) }, "FR", NOW)).toBe(false);
        expect(impossibleTravel({ country: "ES", at: new Date(NOW.getTime() - TRAVEL_WINDOW_MS - 1) }, "US", NOW)).toBe(false);
        expect(impossibleTravel(null, "US", NOW)).toBe(false);
        expect(impossibleTravel({ country: "ES", at: NOW }, null, NOW)).toBe(false);
    });
});

describe("planRiskCheck", () => {
    it("asks for one code from any reachable method", () => {
        const plan = planRiskCheck({ available: ["email", "whatsapp"], reason: "new-device" });
        expect(plan).toMatchObject({ need: 1, done: [], accepted: ["email", "whatsapp"], reason: "new-device" });
        expect(parseStepUp(serializeStepUp(plan!))).toEqual(plan);
    });

    it("asks nothing when no code can be delivered", () => {
        expect(planRiskCheck({ available: [], reason: "impossible-travel" })).toBeNull();
    });
});

describe("signInRisk datacenter address", () => {
    const input = { userId: "user-1", sessionId: "session-1", country: "ES", userAgent: null, ip: "203.0.113.7" };

    beforeEach(() => {
        vi.clearAllMocks();
        db.sessionState.findFirst.mockResolvedValue(null);
        db.accountDevice.count.mockResolvedValue(0);
        integrations.getIntegrationState.mockResolvedValue({ enabled: true, config: {} });
        integrations.getIntegrationSecret.mockResolvedValue("key");
        reputation.rememberedVerdict.mockResolvedValue(null);
        lookups.takeServedLookup.mockResolvedValue(true);
    });

    it("is not a signal when Criminal IP is not connected", async () => {
        integrations.getIntegrationState.mockResolvedValue(null);
        expect(await signInRisk(input)).toBeNull();
        expect(criminalIp.checkCriminalIp).not.toHaveBeenCalled();
    });

    it("asks Criminal IP only about hosting, and remembers the answer", async () => {
        criminalIp.checkCriminalIp.mockResolvedValue({ allow: false, reasons: ["Hosting or datacenter"] });
        expect(await signInRisk(input)).toBe("datacenter");
        expect(criminalIp.checkCriminalIp).toHaveBeenCalledWith("key", "203.0.113.7", ["is_hosting"]);
        expect(reputation.rememberVerdict).toHaveBeenCalledWith("203.0.113.7", "criminalip", ["is_hosting"], {
            allow: false,
            reason: "Hosting or datacenter"
        });
    });

    it("reads a remembered answer without a lookup", async () => {
        reputation.rememberedVerdict.mockResolvedValue({ allow: true, reason: null });
        expect(await signInRisk(input)).toBeNull();
        expect(criminalIp.checkCriminalIp).not.toHaveBeenCalled();
    });

    it("is not a signal when the budget is spent or the lookup fails", async () => {
        lookups.takeServedLookup.mockResolvedValue(false);
        expect(await signInRisk(input)).toBeNull();
        lookups.takeServedLookup.mockResolvedValue(true);
        criminalIp.checkCriminalIp.mockRejectedValue(new Error("down"));
        expect(await signInRisk(input)).toBeNull();
    });
});
